/**
 * Marathon:StartQuest. Modelled on Quest:Start (`../quest.ts`): the live is run
 * server-side from the marathon quest and difficulty master rows, rewards come
 * from the same grant helpers, and per-player progress lives in `state.ts`.
 *
 * The engine's result decides the clear; a failed attempt still spends stamina but grants no rewards or points.
 *
 * Owned marathon live bonuses (`state.liveBonuses`) are resolved to `LiveAbility`
 * levels and handed to `prepareLiveInput` as deck-wide effects, so they are routed
 * like the cards' own live abilities and land before the card stat pass. Type-13
 * (passive skill) rows take the owned-ability passive route: they join the card's
 * `passives` list, one entry per owned copy.
 *
 * Still not implemented: the latest-clear singleton, the gold reward bonus
 * (`LiveAbility` type 15) on clear rewards, per-area quest counters (marathon
 * quests have no `UserArea`/`UserQuest` rows) and support-card level sync.
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { register, type RpcContext } from '../handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { withPlayerTx } from '../../db/tx.ts';
import { playerMarathonPoint } from '../../db/schema.ts';
import {
  getLiveAbility,
  getMarathonLiveBonus,
  getMarathonQuest,
  getMarathonQuestDifficulty,
  getSetting,
} from '../../master/index.ts';
import { addManagerExp } from '../../master/reward.ts';
import { commonResponse } from '../activity.ts';
import { liveAbilityPhotoType, liveResultCharacterIds, loadLiveFormation, prepareLiveInput } from '../liveInput.ts';
import type { PrepareLiveInputReport } from '../liveInput.ts';
import { maxActorSkills } from '../../live/engine.ts';
import { MissionType, advanceUserMissions, reachUserMissions } from '../missionProgress.ts';
import {
  compactUpdated,
  grantQuestReward,
  pushUpdated,
  questBoostedAmount,
  questRepeatedAmount,
  questStartRankReward,
  questStartRankPatterns,
  questStartScoreRank,
  settleQuestCharacters,
  withQuestPlayer,
} from '../quest.ts';
import { unlockLiveMusic } from '../liveMusic.ts';
import { PCG, Rand } from '../../live/pcg.ts';
import { simulate } from '../../live/engine.ts';
import type { Input } from '../../live/input.ts';
import type { LiveResult } from '../../live/types.ts';
import { marathonConfig, marathonWindowFor } from './catalog.ts';
import { ensureMarathonMissionRows } from './eventInfo.ts';
import { liveBonusInfos } from './liveBonus.ts';
import { marathonBonusEffects, marathonLiveAbilityLevel, marathonPassiveEffects } from './liveBonusEffect.ts';
import { marathonDifficultyConditionMet, marathonQuestAccess } from './unlock.ts';
import { ConditionEvaluator } from '../conditions.ts';
import { currentStamina, loadMarathonState, saveMarathonState, type MarathonState } from './state.ts';

const RPC = 'Marathon:StartQuest';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const QUEST_REWARD_MSG = 'Solis.Common.Proto.Api.QuestReward';
const MARATHON_QUEST_START_RESPONSE_MSG = 'Solis.Common.Proto.Api.MarathonQuestStartResponse';

/** `AREA_DAILY` in `../quest.ts`: selects the daily score-rank branch for rank patterns. */
const RANK_PATTERN_AREA_TYPE_DAILY = 3;

/** `PhotoAbilityType.ManagerExp` in `../quest.ts`: card manager-exp bonus. */
const PHOTO_ABILITY_MANAGER_EXP = 14;

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function s(value: unknown): string {
  return value == null ? '' : String(value);
}

/** Difficulty-level fields copied onto the quest object the live engine reads. */
export function liveQuestFromMarathonRows(questId: string, quest: Decoded, diff: Decoded): Decoded {
  return {
    Id: questId,
    StageId: quest.StageId,
    MusicId: quest.MusicId,
    MusicChartPatternId: quest.MusicChartPatternId,
    Position1AttributeType: quest.Position1AttributeType,
    Position2AttributeType: quest.Position2AttributeType,
    Position3AttributeType: quest.Position3AttributeType,
    Position4AttributeType: quest.Position4AttributeType,
    Position5AttributeType: quest.Position5AttributeType,
    ActiveSkillWeightPermil: quest.ActiveSkillWeightPermil,
    SpecialSkillWeightPermil: quest.SpecialSkillWeightPermil,
    SkillStaminaWeightPermil: quest.SkillStaminaWeightPermil,
    StaminaRecoveryWeightPermil: quest.StaminaRecoveryWeightPermil,
    BeatDanceWeightPermil: quest.BeatDanceWeightPermil,
    BeatVocalWeightPermil: quest.BeatVocalWeightPermil,
    BeatVisualWeightPermil: quest.BeatVisualWeightPermil,
    MaxCapacity: quest.MaxCapacity,
    QuestPressureId: quest.QuestPressureId,
    QuestCharacterAdvantageId: quest.QuestCharacterAdvantageId,
    QuestAudienceAdvantageId: quest.QuestAudienceAdvantageId,
    MoodType: quest.MoodType,
    DifficultyLevel: diff.DifficultyLevel,
    MentalThreshold: diff.MentalThreshold,
    ClearScore: diff.ClearScore,
    RewardManagerExp: diff.RewardManagerExp,
    RewardCardExp: diff.RewardCardExp,
    ClearRewardId: diff.ClearRewardId,
    RankAdditionalRewardId: diff.RankAdditionalRewardId,
    RankSRewardId: diff.RankSRewardId,
    RankARewardId: diff.RankARewardId,
    RankBRewardId: diff.RankBRewardId,
    RankCRewardId: diff.RankCRewardId,
    LiveBonusGroupId: diff.LiveBonusGroupId,
  } as Decoded;
}

register(
  RPC,
  async (ctx: RpcContext) => {
    const req = (ctx.request ?? {}) as Decoded;
    return withQuestPlayer(ctx, RPC, async (playerId) => {
      const marathonQuestId = s(req.MarathonQuestId);
      const difficultyNumber = n(req.MarathonQuestDifficultyNumber);
      const deckNumber = n(req.DeckNumber);
      const requestedExec = n(req.ExecCount);
      const execCount = requestedExec === 0 ? 1 : requestedExec;
      if (marathonQuestId === '' || difficultyNumber <= 0 || deckNumber <= 0) {
        throw new Error(`${RPC}: marathonQuestId, difficulty number and deckNumber are required`);
      }
      if (execCount < 1) throw new Error(`${RPC}: execCount must be at least 1`);
      if (Array.isArray(req.UserBuddyDeckPositions) && req.UserBuddyDeckPositions.length > 0) {
        throw new Error(`${RPC}: friend rental is unavailable in this private server`);
      }
      const seed = randomBytes(8).readBigUInt64BE();
      const now = Date.now();

      const payload = await withPlayerTx(playerId, async (tx) => {
        const updated = { __msg: UPDATED_DATA_MSG } as Decoded;
        const quest = (await getMarathonQuest(marathonQuestId)) as unknown as Decoded | null;
        if (!quest) throw new Error(`${RPC}: marathon quest not found: ${marathonQuestId}`);
        const marathonId = s(quest.MarathonId);
        const config = marathonId === '' ? undefined : marathonConfig(marathonId);
        if (!config) throw new Error(`${RPC}: no marathon is active`);
        const window = marathonWindowFor(marathonId, now);
        if (!window || !(now < window.endTime)) {
          throw new Error(`${RPC}: marathon quest ${marathonQuestId} is not in the active marathon`);
        }
        const diff = (await getMarathonQuestDifficulty(marathonQuestId, difficultyNumber)) as unknown as Decoded | null;
        if (!diff) throw new Error(`${RPC}: difficulty ${difficultyNumber} not found for ${marathonQuestId}`);
        const unlockEvaluator = new ConditionEvaluator(playerId, now, tx);
        const state: MarathonState = await loadMarathonState(playerId, config, now, tx);
        const access = await marathonQuestAccess(playerId, quest, config, state, tx, unlockEvaluator);
        if (!access.unlocked) {
          throw new Error(`${RPC}: marathon quest is locked`);
        }
        if (!(await marathonDifficultyConditionMet(
          playerId,
          marathonQuestId,
          s(diff.UnlockConditionId),
          state,
          tx,
          unlockEvaluator,
        ))) {
          throw new Error(`${RPC}: marathon quest difficulty is locked`);
        }

        const cost = n(quest.RequiredStamina) * execCount;
        const stamina = currentStamina(state, config, now);
        if (stamina.stamina < cost) throw new Error(`${RPC}: insufficient stamina`);
        state.stamina = stamina.stamina - cost;
        state.staminaUpdatedTime = stamina.updated;

        const questLike = liveQuestFromMarathonRows(marathonQuestId, quest, diff);
        const formation = await loadLiveFormation(playerId, deckNumber, tx);
        const reqLike = {
          QuestId: marathonQuestId,
          DeckNumber: deckNumber,
          PlayCount: execCount,
          IsSkip: req.IsSkip === true,
          UserBuddyDeckPositions: [],
        } as Decoded;
        const ownedBonuses = liveBonusInfos(state).map((row) => ({
          LiveBonusId: s(row.LiveBonusId),
          Amount: n(row.Amount),
        }));
        const resolvedBonusEffects = new Map<string, ReturnType<typeof marathonLiveAbilityLevel>>();
        for (const ownedBonus of ownedBonuses) {
          if (resolvedBonusEffects.has(ownedBonus.LiveBonusId)) continue;
          const bonusMaster = await getMarathonLiveBonus(ownedBonus.LiveBonusId);
          if (bonusMaster === null) continue;
          const abilityId = s(bonusMaster.LiveAbilityId);
          if (abilityId === '') continue;
          const ability = await getLiveAbility(abilityId);
          if (ability === null) continue;
          const selected = marathonLiveAbilityLevel(
            (ability.Levels as Decoded[] | null) ?? [],
            n(bonusMaster.LiveAbilityLevel),
          );
          // A level row does not carry its parent id; keep it for the passive
          // entry's `LiveAbilityId`, exactly like an owned live ability.
          if (selected !== undefined) resolvedBonusEffects.set(ownedBonus.LiveBonusId, { ...selected, liveAbilityId: abilityId });
        }
        // Type-13 rows are deck-level event bonus skills; every other supported
        // type joins the card bonus map.
        const effects = marathonBonusEffects(ownedBonuses, (id) => resolvedBonusEffects.get(id));
        const bonusSkills = marathonPassiveEffects(ownedBonuses, (id) => resolvedBonusEffects.get(id));
        // Handed to input preparation so they are routed like the cards' own
        // live abilities and land before the card stat pass.
        const inputReport: PrepareLiveInputReport = { droppedBonusSkills: 0 };
        const npcRosterId = config.npcRosters?.[marathonQuestId];
        const input = await prepareLiveInput(
          playerId,
          reqLike,
          questLike as unknown as Parameters<typeof prepareLiveInput>[2],
          seed,
          formation,
          tx,
          {
            extraDeckBonuses: effects,
            extraBonusSkills: bonusSkills,
            report: inputReport,
            npcRosterId,
            // A mapped roster keeps its authored levels; scale them to this
            // difficulty so the opponent matches the stage.
            ...(npcRosterId === undefined ? {} : { npcLevel: n(diff.DifficultyLevel) }),
          },
        );
        if (inputReport.droppedBonusSkills > 0) {
          ctx.fastifyReq.log.warn(
            { playerId, dropped: inputReport.droppedBonusSkills, cap: maxActorSkills },
            'marathon passive bonus skills truncated to the engine skill cap',
          );
        }
        const skipped = [
          ...new Set(
            effects.filter((effect) => !liveAbilityPhotoType(effect.type)[1]).map((effect) => effect.type),
          ),
        ];
        ctx.fastifyReq.log.info(
          { playerId, effects, bonusSkills, skipped },
          'marathon live bonus effects',
        );
        const result = simulate(input as Input) as LiveResult;
        const playerResult = result.UserInfos?.[0]?.UserResult;
        if (!playerResult) throw new Error('live produced no player result');
        const score = n(playerResult.Score);
        if (score < 0) throw new Error('live score is negative');

        const patterns = questStartRankPatterns(questLike, RANK_PATTERN_AREA_TYPE_DAILY);
        const { rankType, plus } = questStartScoreRank(patterns, score);
        const reward = { __msg: QUEST_REWARD_MSG } as Decoded;
        const cleared = result.Cleared === true;
        let addPoint = 0;

        if (cleared) {
          const rng = new Rand(new PCG(seed ^ 0x7175657374727764n, seed));
          reward.ClearRewards = await grantQuestReward(
            playerId, s(questLike.ClearRewardId), execCount, 0, rng, updated, tx,
          );
          reward.ScoreRankRewards = await grantQuestReward(
            playerId, questStartRankReward(questLike, rankType), execCount, 0, rng, updated, tx,
          );
          if (plus > 0) {
            reward.ScoreRankAdditionalRewards = await grantQuestReward(
              playerId, s(questLike.RankAdditionalRewardId), execCount * plus, 0, rng, updated, tx,
            );
          }
          addPoint = n(diff.RewardMarathonPoint) * execCount;
          await tx
            .insert(playerMarathonPoint)
            .values({ id: randomUUID(), playerId, marathonId: config.id, point: addPoint })
            .onConflictDoUpdate({
              target: [playerMarathonPoint.playerId, playerMarathonPoint.marathonId],
              set: {
                point: sql`${playerMarathonPoint.point} + ${addPoint}`,
                updatedAt: new Date(),
              },
            });

          let managerBonus = 0;
          for (const card of result.UserInfos?.[0]?.UserDeck?.Cards ?? []) {
            managerBonus += n(input.Cards.get(n(card.Index))?.Bonuses.get(PHOTO_ABILITY_MANAGER_EXP));
          }
          if (n(diff.RewardManagerExp) > 0) {
            const amount = questRepeatedAmount(questBoostedAmount(n(diff.RewardManagerExp), managerBonus), execCount);
            const granted = await addManagerExp(playerId, amount, tx);
            if (granted.user) updated.User = granted.user;
            for (const photo of granted.photos) pushUpdated(updated, 'Photos', photo);
          }

          await ensureMarathonMissionRows(playerId, config.eventMissionId, now, tx);
          for (const row of await advanceUserMissions(
            playerId,
            MissionType.MarathonQuestClearCount,
            execCount,
            [],
            tx,
          )) {
            pushUpdated(updated, 'Missions', row);
          }
          for (const row of await reachUserMissions(
            playerId,
            MissionType.MarathonQuestClearDifficulty,
            difficultyNumber,
            [marathonQuestId],
            tx,
          )) {
            pushUpdated(updated, 'Missions', row);
          }

          // Marathon quests have no area row, so the area clear/achievement
          // missions of `settleQuestMissions` cannot fire; only the quest-wide
          // counters and the score achievement advance here. Targets mirror
          // Quest:Start's `[quest.Id, area.Id, quest.MusicId, ...characterIds]`
          // (`../quest.ts:738`) without the area id.
          const setting = (await getSetting()) as unknown as Decoded | null;
          await settleQuestCharacters(playerId, reqLike, questLike, setting, input, result, reward, updated, tx);
          const missionTargets = [marathonQuestId, s(quest.MusicId), ...liveResultCharacterIds(input, result)];
          for (const type of [MissionType.QuestAllClearCount, MissionType.CharacterQuestAllClearCount]) {
            for (const row of await advanceUserMissions(playerId, type, execCount, missionTargets, tx)) {
              pushUpdated(updated, 'Missions', row);
            }
          }
          if (score > 0) {
            for (const row of await reachUserMissions(
              playerId,
              MissionType.QuestAllScoreAchievement,
              score,
              missionTargets,
              tx,
            )) {
              pushUpdated(updated, 'Missions', row);
            }
          }
          await unlockLiveMusic(playerId, s(quest.MusicId), updated, tx);
        }

        const quests = state.quests;
        const questRecord = quests[marathonQuestId] ?? { last: difficultyNumber, diffs: {} };
        questRecord.last = difficultyNumber;
        const key = String(difficultyNumber);
        const diffRecord = questRecord.diffs[key] ?? { cleared: false, highestScore: 0, rankType: 0, plus: 0 };
        if (cleared) {
          diffRecord.cleared = true;
          if (score > diffRecord.highestScore) {
            diffRecord.highestScore = score;
            diffRecord.rankType = rankType;
            diffRecord.plus = plus;
          }
        }
        questRecord.diffs[key] = diffRecord;
        quests[marathonQuestId] = questRecord;
        await saveMarathonState(playerId, config.id, state, tx);

        return {
          __msg: MARATHON_QUEST_START_RESPONSE_MSG,
          MarathonId: config.id,
          MarathonQuestId: marathonQuestId,
          MarathonQuestDifficultyNumber: difficultyNumber,
          Result: result as unknown as Decoded,
          Reward: reward,
          RankType: rankType,
          RankPlus: plus,
          RankPatterns: patterns,
          HighestClearRankType: diffRecord.rankType,
          HighestScore: diffRecord.highestScore,
          AddMarathonPoint: addPoint,
          CommonResponse: commonResponse(compactUpdated(updated)),
        } as Decoded;
      });

      ctx.fastifyReq.log.info({ playerId, marathonQuestId, difficultyNumber, deckNumber, execCount }, 'marathon quest start');
      return payload;
    });
  },
  { ownsState: true },
);
