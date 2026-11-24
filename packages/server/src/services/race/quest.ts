// `Race:StartLivePanelQuest` and `Race:StartLiveAreaQuest`: run a race live and
// apply the clear accounting.
//
// Panel quests (RPC 5) unlock the board again after a VENUS panel and put the
// deck's cards on cool time (cleared or failed); area quests (RPC 6, pt / medal
// tiers) grant race points or medals scaled by the tier number.
import { register, type RpcContext } from '../handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { withPlayerTx } from '../../db/tx.ts';
import { applyGrants } from '../../master/reward.ts';
import { commonResponse } from '../activity.ts';
import { compactUpdated, withQuestPlayer } from '../quest.ts';
import { raceConfigFor, raceWindowFor } from './catalog.ts';
import { formationCardIds, loadRaceFormation, runRaceLive } from './live.ts';
import { getRacePanel, listRaceQuestDifficulties, managerLevelUnlockConditions } from './master.ts';
import { buildRaceOpponentProgressInfos } from './rivals.ts';
import { loadRaceState, markRaceInitialLogin, recordAreaQuestTierReached, saveRaceState } from './state.ts';
import { clearedTierCount, nearestTier, tierUnlocked } from './tiers.ts';
import { ensureRaceDifficulty, raceDifficultyNumber } from './difficulty.ts';
import { grantInitialRacePoints, itemReward, mergeUpdated } from './updated.ts';
import { raceConditionInvalid } from './errors.ts';
import { loadRaceUserRaceInfo } from './userRaceInfo.ts';

const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const MINUTE_MS = 60 * 1000;

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function s(value: unknown): string {
  return value == null ? '' : String(value);
}

register(
  'Race:StartLivePanelQuest',
  async (ctx: RpcContext) => {
    const RPC = 'Race:StartLivePanelQuest';
    const req = (ctx.request ?? {}) as Decoded;
    const raceId = s(req.RaceId);
    const config = raceConfigFor(raceId);
    if (config === undefined) throw new Error(`${RPC}: unknown race ${raceId}`);
    const deckNumber = n(req.DeckNumber);
    if (deckNumber < 0) throw new Error(`${RPC}: deckNumber is required`);
    const now = Date.now();
    const window = raceWindowFor(raceId, now);
    if (window === undefined) raceConditionInvalid(`${RPC}: race ${raceId} is not open`);
    return withQuestPlayer(ctx, RPC, async (playerId) => {
      const payload = await withPlayerTx(playerId, async (tx) => {
        const updated = { __msg: UPDATED_DATA_MSG } as Decoded;
        const state = await loadRaceState(playerId, raceId, tx);
        const firstLogin = markRaceInitialLogin(state, now);
        if (firstLogin) await grantInitialRacePoints(playerId, config, updated, tx);
        if (!state.pendingVenus) raceConditionInvalid(`${RPC}: there is no pending VENUS panel`);
        // A player who reached the panel without opening the race still gets
        // the difficulty frozen from their grade here (saved at the end).
        await ensureRaceDifficulty(playerId, state, config, tx);

        const areaId = config.areaIds[state.areaIndex] ?? '';
        const panel = (await getRacePanel(areaId, state.panelNumber)) as unknown as Decoded | null;
        if (!panel) throw new Error(`${RPC}: panel ${state.panelNumber} not found in area ${areaId}`);
        const raceQuestId = s(panel.RaceQuestId);
        if (raceQuestId === '') throw new Error(`${RPC}: panel ${state.panelNumber} has no live quest`);
        const difficulties = (await listRaceQuestDifficulties(raceQuestId)) as unknown as Decoded[];
        if (difficulties.length === 0) {
          throw new Error(`${RPC}: race quest ${raceQuestId} has no difficulty rows`);
        }
        // The board authors one difficulty per VENUS grade; clamp the player's
        // frozen number to the nearest tier the quest actually defines.
        const difficultyNumber = nearestTier(difficulties, raceDifficultyNumber(state, config));

        const formation = await loadRaceFormation(playerId, raceId, deckNumber, tx);
        const cardIds = formationCardIds(formation);
        for (const cardId of cardIds) {
          if (n(state.cardCoolTimes[cardId]) > now) {
            raceConditionInvalid(`${RPC}: card ${cardId} is on cool time`);
          }
        }

        const run = await runRaceLive({
          playerId,
          raceId,
          config,
          raceQuestId,
          difficultyNumber,
          deckNumber,
          isSkip: req.IsSkip === true,
          exec: tx,
          formation,
        });

        // A VENUS panel is cleared by the sum of every attempt on it: each
        // `StartLivePanelQuest` adds its live score to the running total and
        // the panel clears once that total reaches the difficulty row's
        // ClearScore. `BeforeScore` is the total carried in by this attempt and
        // `UserRaceInfo.CurrentLivePanelScore` the total after it.
        const beforeScore = state.currentLivePanelScore;
        const afterScore = beforeScore + run.score;
        // The engine compares a single attempt's score with `ClearScore`; the
        // panel quest re-decides on the cumulative total. `questLike` is the
        // race quest merged with the player's difficulty row, so this is the
        // same ClearScore the engine compared against. A ClearScore of 0 is a
        // versus quest (the engine compared the two sides instead), so keep the
        // engine's verdict there.
        const clearScore = n(run.questLike.ClearScore);
        const cleared = clearScore > 0 ? afterScore >= clearScore : run.cleared;
        state.currentLivePanelScore = afterScore;
        // The live result screen reads `Result.Cleared`; report the panel's
        // decision, not just this attempt's score.
        if (run.result.Cleared !== cleared) run.result.Cleared = cleared;
        // Officially every card used in a VENUS panel live goes on cool time,
        // whether the live cleared or failed: a retry must use other cards or
        // wait / pay ResetCardCoolTime, so a failed live cannot hand the deck
        // straight back. Everything else below stays clear-only.
        const coolTime = now + config.cardCoolTimeMinutes * MINUTE_MS;
        for (const cardId of cardIds) state.cardCoolTimes[cardId] = coolTime;
        if (cleared) {
          state.pendingVenus = false;
          state.totalClearPanelCount += 1;
        }
        // Build the response while the cumulative total is still in the state
        // (`UserRaceInfo.CurrentLivePanelScore` must report `afterScore`). The
        // total stays stored after a clear so the client can compare it with the
        // panel's `ClearScore` and show the panel as cleared; it restarts from 0
        // when the walk lands on the next VENUS panel (`board.ts`).
        const userRaceInfo = await loadRaceUserRaceInfo(playerId, config, state, now, window.startTime, tx);
        const opponentProgressInfos = await buildRaceOpponentProgressInfos(playerId, config, state, tx);
        await saveRaceState(playerId, raceId, state, tx);
        ctx.fastifyReq.log.info(
          {
            playerId,
            raceId,
            raceQuestId,
            difficultyNumber,
            deckNumber,
            score: run.score,
            beforeScore,
            afterScore,
            cleared,
          },
          'race panel quest live',
        );
        return {
          __msg: 'Solis.Common.Proto.Api.RaceStartLivePanelQuestResponse',
          Result: run.result,
          UserRaceInfo: userRaceInfo,
          OpponentProgressInfos: opponentProgressInfos,
          BeforeScore: beforeScore,
          RankPatterns: run.patterns,
          CommonResponse: commonResponse(compactUpdated(updated)),
        } as Decoded;
      });
      return payload;
    });
  },
  { ownsState: true },
);

register(
  'Race:StartLiveAreaQuest',
  async (ctx: RpcContext) => {
    const RPC = 'Race:StartLiveAreaQuest';
    const req = (ctx.request ?? {}) as Decoded;
    const raceId = s(req.RaceId);
    const config = raceConfigFor(raceId);
    if (config === undefined) throw new Error(`${RPC}: unknown race ${raceId}`);
    const raceQuestId = s(req.RaceQuestId);
    const difficultyNumber = n(req.DifficultyNumber);
    const deckNumber = n(req.DeckNumber);
    if (raceQuestId === '' || difficultyNumber <= 0 || deckNumber < 0) {
      throw new Error(`${RPC}: raceQuestId, difficultyNumber and deckNumber are required`);
    }
    const ptQuestId = config.areaQuestIds.pt;
    const medalQuestId = config.areaQuestIds.medal;
    if (raceQuestId !== ptQuestId && raceQuestId !== medalQuestId) {
      throw new Error(`${RPC}: ${raceQuestId} is not an area quest of ${raceId}`);
    }
    const now = Date.now();
    const window = raceWindowFor(raceId, now);
    if (window === undefined) raceConditionInvalid(`${RPC}: race ${raceId} is not open`);
    return withQuestPlayer(ctx, RPC, async (playerId) => {
      const payload = await withPlayerTx(playerId, async (tx) => {
        const updated = { __msg: UPDATED_DATA_MSG } as Decoded;
        const state = await loadRaceState(playerId, raceId, tx);
        const firstLogin = markRaceInitialLogin(state, now);
        if (firstLogin) await grantInitialRacePoints(playerId, config, updated, tx);
        const difficulties = (await listRaceQuestDifficulties(raceQuestId)) as unknown as Decoded[];
        if (difficulties.length === 0) {
          throw new Error(`${RPC}: race quest ${raceQuestId} has no difficulty rows`);
        }
        const currentClear = state.areaQuestClear[raceQuestId] ?? 0;
        const managerLevelConditions = await managerLevelUnlockConditions(
          playerId,
          difficulties,
          now,
          tx,
        );
        if (!tierUnlocked(difficulties, currentClear, difficultyNumber, { managerLevelConditions })) {
          raceConditionInvalid(`${RPC}: difficulty ${difficultyNumber} of ${raceQuestId} is locked`);
        }

        const formation = await loadRaceFormation(playerId, raceId, deckNumber, tx);
        const run = await runRaceLive({
          playerId,
          raceId,
          config,
          raceQuestId,
          difficultyNumber,
          deckNumber,
          isSkip: req.IsSkip === true,
          exec: tx,
          formation,
        });

        const rewards: Decoded[] = [];
        if (run.cleared) {
          const isPointQuest = raceQuestId === ptQuestId;
          const perTier = isPointQuest
            ? config.areaQuestReward.racePointPerTier
            : config.areaQuestReward.raceMedalPerTier;
          const itemId = isPointQuest ? config.racePointItemId : config.raceMedalItemId;
          const amount = perTier * difficultyNumber;
          if (amount > 0 && itemId !== '') {
            const applied = await applyGrants(
              playerId,
              [{ resourceType: 1, resourceId: itemId, amount }],
              tx,
            );
            mergeUpdated(updated, applied.updated);
            rewards.push(itemReward(itemId, amount));
          }
          if (difficultyNumber > currentClear) {
            state.areaQuestClear[raceQuestId] = difficultyNumber;
            // The new lesson rate only applies at the next 2-day tally
            // boundary; keep the clear time so the tally can pick it up.
            recordAreaQuestTierReached(
              state,
              isPointQuest ? 'pt' : 'medal',
              currentClear,
              difficultyNumber,
              now,
            );
          }
          const highScores = state.areaQuestHighScore[raceQuestId] ?? {};
          const key = String(difficultyNumber);
          if (run.score > n(highScores[key])) highScores[key] = run.score;
          state.areaQuestHighScore[raceQuestId] = highScores;
        }
        await saveRaceState(playerId, raceId, state, tx);
        ctx.fastifyReq.log.info(
          {
            playerId,
            raceId,
            raceQuestId,
            difficultyNumber,
            deckNumber,
            score: run.score,
            cleared: run.cleared,
            clearedTierCount: clearedTierCount(difficulties, state.areaQuestClear[raceQuestId] ?? 0),
          },
          'race area quest live',
        );
        return {
          __msg: 'Solis.Common.Proto.Api.RaceStartLiveAreaQuestResponse',
          Result: run.result,
          UserRaceInfo: await loadRaceUserRaceInfo(playerId, config, state, now, window.startTime, tx),
          RankPatterns: run.patterns,
          CommonResponse: commonResponse(compactUpdated(updated)),
        } as Decoded;
      });
      return payload;
    });
  },
  { ownsState: true },
);
