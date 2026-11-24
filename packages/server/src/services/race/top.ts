// `Race:Top`: the race home payload (race info, area board, player state,
// area-quest (pt / medal) progress, opponents).
import { register, type RpcContext } from '../handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { db } from '../../db/client.ts';
import { withPlayerTx } from '../../db/tx.ts';
import type { Executor } from '../../db/tx.ts';
import { commonResponse } from '../activity.ts';
import { compactUpdated, withQuestPlayer } from '../quest.ts';
import { buildEventStoryInfo, loadMarathonEventStory, marathonEventMissionInfo } from '../marathon/eventInfo.ts';
import { marathonOpponentInfo, emptyOpponentInfo } from '../opponent.ts';
import { raceConfigFor, raceWindowFor } from './catalog.ts';
import type { RaceWindow } from './catalog.ts';
import { countRacePanels, listRaceQuestDifficulties, managerLevelUnlockConditions } from './master.ts';
import { buildRaceOpponentProgressInfos } from './rivals.ts';
import { loadRaceState, markRaceInitialLogin, saveRaceState } from './state.ts';
import { ensureRaceDifficulty, raceDifficultyNumber } from './difficulty.ts';
import type { RaceState } from './state.ts';
import { clientClearLevel, tierUnlocked } from './tiers.ts';
import { grantInitialRacePoints, pushItemAmount } from './updated.ts';
import { stepOntoAdjacentVenus } from './venusStep.ts';
import { raceConditionInvalid } from './errors.ts';
import { loadRaceUserRaceInfo } from './userRaceInfo.ts';
import { nextTallyAt } from './tally.ts';
import type { RaceConfig } from './types.ts';
import RaceTopResponse from '@sumire-sr/protocol/gen/Solis_Common_Proto_Api_RaceTopResponse.ts';
import RaceInfoShape from '@sumire-sr/protocol/gen/Solis_Common_Proto_Api_RaceInfo.ts';

const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const RACE_INFO_MSG = RaceInfoShape.name;
const RACE_AREA_INFO_MSG = 'Solis.Common.Proto.Api.RaceAreaInfo';
const RACE_RANK_GRADE_INFO_MSG = 'Solis.Common.Proto.Api.RaceRankGradeInfo';
const RACE_LIVE_QUEST_INFO_MSG = 'Solis.Common.Proto.Api.RaceLiveQuestInfo';
const RACE_LIVE_QUEST_DIFFICULTY_MSG = 'Solis.Common.Proto.Api.RaceLiveQuestDifficultyLevelInfo';
/** Activity-lesson efficiency level is tallied every 2 days at 0:00 JST. */

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function s(value: unknown): string {
  return value == null ? '' : String(value);
}

function emptyUpdated(): Decoded {
  return { __msg: UPDATED_DATA_MSG } as Decoded;
}

/** Proto `RaceInfo` for `Race:Top`. */
export function buildRaceInfo(
  config: RaceConfig,
  window: RaceWindow,
  panelCounts: Map<string, number>,
  extras: {
    eventStoryInfo: Decoded | null;
    eventMissionInfo: Decoded | null;
    /** Player-frozen VENUS difficulty; defaults to the race-wide fallback. */
    difficultyNumber?: number;
  },
): Decoded {
  return {
    __msg: RACE_INFO_MSG,
    Id: config.raceId,
    Name: config.name,
    StartTime: window.startTime,
    EndTime: window.endTime,
    ExchangeEndTime: window.exchangeEndTime,
    AggregateEndTime: window.endTime,
    AssetId: config.assetId,
    EventStoryInfo: extras.eventStoryInfo ?? undefined,
    EventMissionInfo: extras.eventMissionInfo ?? undefined,
    RacePointItemId: config.racePointItemId,
    RaceMedalItemId: config.raceMedalItemId,
    RaceLiveBonusResetItemId: config.raceLiveBonusResetItemId,
    RaceAreaInfos: config.areaIds.map((areaId, index) => ({
      __msg: RACE_AREA_INFO_MSG,
      RaceAreaId: areaId,
      Order: index + 1,
      PanelCount: panelCounts.get(areaId) ?? 0,
    })),
    RequiredCardCoolTimeRacePointAmount: config.requiredCardCoolTimeRacePointAmount,
    RaceRankGradeInfos: config.rankGrades.map((grade) => ({
      __msg: RACE_RANK_GRADE_INFO_MSG,
      Id: grade.id,
      HierarchyPointFrom: grade.hierarchyPointFrom,
      Name: grade.name,
      TopColorCode: grade.topColorCode,
      BottomColorCode: grade.bottomColorCode,
    })),
    LivePanelDifficultyNumber: extras.difficultyNumber ?? config.livePanelDifficultyNumber,
    CardCoolTimeMinutes: config.cardCoolTimeMinutes,
    RaceLiveBonusGroupId: config.raceLiveBonusGroupId,
  } as Decoded;
}

/**
 * Roster played by `raceQuestId`: the per-quest override, else the race
 * default. Same resolution order as `runRaceLive`, so the opponent shown on the
 * quest list is the one the versus live fights.
 */
export function raceNpcRosterId(config: RaceConfig, raceQuestId: string): string | undefined {
  return config.npcRosterByQuest[raceQuestId] ?? (config.npcRosterId || undefined);
}

/**
 * `RaceLiveQuestInfo` for one area quest (pt or medal) from already-loaded
 * difficulty rows: every tier with its clear / unlock / high-score state.
 *
 * Race area-quest tiers are versus quests (no `ClearScore`), so each tier
 * carries the opponent the live will play: `npcRosterId` (or the per-quest
 * override) scaled to the tier's `DifficultyLevel`. VENUS panel difficulties do
 * have a `ClearScore`, and `marathonOpponentInfo` keeps those opponent infos
 * empty, matching marathon.
 */
export function buildRaceLiveQuestInfoFromRows(
  raceQuestId: string,
  difficulties: readonly Decoded[],
  state: RaceState,
  npcRosterId: string | undefined = undefined,
  managerLevelConditions: ReadonlySet<string> = new Set(),
): Decoded {
  const currentClear = raceQuestId === '' ? 0 : (state.areaQuestClear[raceQuestId] ?? 0);
  const highScores = raceQuestId === '' ? {} : (state.areaQuestHighScore[raceQuestId] ?? {});
  // The client resolves the quest icon with `FindByKey(RaceQuestId,
  // NextLevel)` (bumped by one tier when that tier exists), so the reported
  // clear level must be one the client's RaceQuestDifficulty master can
  // resolve; 0 has no row because area-quest tiers start at 2.
  const clearLevel = clientClearLevel(difficulties, currentClear);
  const npcRosters =
    npcRosterId === undefined ? undefined : { [raceQuestId]: npcRosterId };
  return {
    __msg: RACE_LIVE_QUEST_INFO_MSG,
    RaceQuestId: raceQuestId,
    CurrentClearDifficultyNumber: clearLevel,
    BeforeClearDifficultyNumber: clearLevel,
    DifficultyLevelInfos: difficulties.map((difficulty) => {
      const difficultyNumber = n(difficulty.DifficultyNumber);
      return {
        __msg: RACE_LIVE_QUEST_DIFFICULTY_MSG,
        RaceLiveQuestDifficultyNumber: difficultyNumber,
        Cleared: difficultyNumber <= currentClear,
        OpponentInfo:
          npcRosters === undefined
            ? emptyOpponentInfo()
            : marathonOpponentInfo(
                raceQuestId,
                difficulty,
                npcRosters,
                n(difficulty.DifficultyLevel),
              ),
        HighestScore: n(highScores[String(difficultyNumber)]),
        Unlocked: tierUnlocked(difficulties, currentClear, difficultyNumber, {
          managerLevelConditions,
        }),
      } as Decoded;
    }),
  } as Decoded;
}

/** `RaceLiveQuestInfo` for one area quest, loading its difficulty rows. */
export async function buildRaceLiveQuestInfo(
  playerId: string,
  config: RaceConfig,
  raceQuestId: string,
  state: RaceState,
  exec: Executor = db,
): Promise<Decoded> {
  const difficulties =
    raceQuestId === '' ? [] : ((await listRaceQuestDifficulties(raceQuestId)) as unknown as Decoded[]);
  const managerLevelConditions = await managerLevelUnlockConditions(
    playerId,
    difficulties,
    Date.now(),
    exec,
  );
  return buildRaceLiveQuestInfoFromRows(
    raceQuestId,
    difficulties,
    state,
    raceNpcRosterId(config, raceQuestId),
    managerLevelConditions,
  );
}

/** Pt and medal area quests of `config`, in request order. */
export async function buildRaceLiveQuestInfos(
  playerId: string,
  config: RaceConfig,
  state: RaceState,
  exec: Executor = db,
): Promise<Decoded[]> {
  const infos: Decoded[] = [];
  infos.push(await buildRaceLiveQuestInfo(playerId, config, config.areaQuestIds.pt, state, exec));
  infos.push(await buildRaceLiveQuestInfo(playerId, config, config.areaQuestIds.medal, state, exec));
  return infos;
}

register(
  'Race:Top',
  async (ctx: RpcContext) => {
    const req = (ctx.request ?? {}) as Decoded;
    const raceId = s(req.RaceId);
    const config = raceConfigFor(raceId);
    if (config === undefined) throw new Error(`Race:Top: unknown race ${raceId}`);
    const now = Date.now();
    const window = raceWindowFor(raceId, now);
    if (window === undefined) raceConditionInvalid(`Race:Top: race ${raceId} is not open`);
    return withQuestPlayer(ctx, 'Race:Top', async (playerId) => {
      const updated = emptyUpdated();
      let isInitialLogin = false;
      const state = await withPlayerTx(playerId, async (tx) => {
        const loaded = await loadRaceState(playerId, raceId, tx);
        const hadActivityClock = loaded.lastActivityReceiveMs > 0;
        // `Home:Enter` already initialises every open race it advertises, so this
        // is the fallback for a race opened without a fresh home payload: the
        // first login grants the starting points exactly once.
        isInitialLogin = markRaceInitialLogin(loaded, now);
        if (isInitialLogin) await grantInitialRacePoints(playerId, config, updated, tx);
        // The VENUS difficulty is frozen from the player's grade on the first
        // open; every later open keeps the stored value.
        const difficultyFrozen = await ensureRaceDifficulty(playerId, loaded, config, tx);
        // A walk stops on the panel right before a VENUS panel when the player
        // cannot pay for it, and the client never offers a move onto the VENUS
        // panel itself: it would show "Advance 0 tile" forever after the player
        // earns enough race points. Step onto it here, exactly as the walk
        // would, and report the spent race pt.
        const steppedVenus = await stepOntoAdjacentVenus(config, loaded, playerId, tx, (entry) => {
          ctx.fastifyReq.log.info(
            {
              playerId: entry.playerId,
              raceId: entry.raceId,
              areaId: entry.areaId,
              fromPanel: entry.fromPanel,
              toPanel: entry.toPanel,
              cost: entry.cost,
            },
            'race step onto adjacent venus panel',
          );
        });
        if (steppedVenus) await pushItemAmount(playerId, updated, config.racePointItemId, tx);
        if (isInitialLogin || !hadActivityClock || difficultyFrozen || steppedVenus) {
          await saveRaceState(playerId, raceId, loaded, tx);
        }
        return loaded;
      });
      const panelCounts = await countRacePanels(config.areaIds);
      const story = await loadMarathonEventStory({ assetId: config.assetId });
      const raceInfo = buildRaceInfo(config, window, panelCounts, {
        difficultyNumber: raceDifficultyNumber(state, config),
        eventStoryInfo: (buildEventStoryInfo(story as never) ?? null) as Decoded | null,
        eventMissionInfo: (await marathonEventMissionInfo(
          playerId,
          { eventMissionId: config.eventMissionId },
          db,
        )) as Decoded | null,
      });
      const userRaceInfo = await loadRaceUserRaceInfo(
        playerId,
        config,
        state,
        now,
        window.startTime,
        db,
      );
      const liveQuestInfos = await buildRaceLiveQuestInfos(playerId, config, state, db);
      const opponentProgressInfos = await buildRaceOpponentProgressInfos(playerId, config, state, db);
      return {
        __msg: RaceTopResponse.name,
        RaceInfo: raceInfo,
        UserRaceInfo: userRaceInfo,
        LiveQuestInfos: liveQuestInfos,
        IsInitialLogin: isInitialLogin,
        DokanInfos: [],
        OpponentProgressInfos: opponentProgressInfos,
        IsFirstLoginInDailyAggregationPeriod: false,
        NextDailyAggregationTime: nextTallyAt(window.startTime, now),
        CommonResponse: commonResponse(compactUpdated(updated)),
      } as Decoded;
    });
  },
  { ownsState: true },
);
