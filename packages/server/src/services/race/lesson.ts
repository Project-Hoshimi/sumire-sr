// `Race:ReceiveActivityLesson`: claim the idle ("activity lesson") race points.
//
// The lesson accrues one step every 10 seconds while the player is away, capped
// at `activityLesson.maxHours` hours. Each step pays `StepRewardRacePoint` race
// points and `StepRewardRaceMedal` medals, scaled by the number of cleared tiers
// of the pt / medal area quests. The clock starts when the race state is created
// (see `markRaceInitialLogin`), so time spent on the board accrues too; a state
// that somehow still has no clock only gets it started here.
import { register, type RpcContext } from '../handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { withPlayerTx } from '../../db/tx.ts';
import { applyGrants, type Grant } from '../../master/reward.ts';
import { commonResponse } from '../activity.ts';
import { compactUpdated, withQuestPlayer } from '../quest.ts';
import { raceConfigFor, raceWindowFor } from './catalog.ts';
import { loadRaceState, markRaceInitialLogin, saveRaceState } from './state.ts';
import { itemReward, grantInitialRacePoints, mergeUpdated } from './updated.ts';
import { raceConditionInvalid } from './errors.ts';
import {
  RACE_STEP_INTERVAL_MS,
  buildRaceEffectiveClearedTiers,
  loadRaceAreaQuestTiers,
  loadRaceUserRaceInfo,
  raceLessonStepReward,
} from './userRaceInfo.ts';
import { tallyStepSegments } from './tally.ts';

const RPC = 'Race:ReceiveActivityLesson';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const HOUR_MS = 60 * 60 * 1000;

function s(value: unknown): string {
  return value == null ? '' : String(value);
}

register(
  RPC,
  async (ctx: RpcContext) => {
    const req = (ctx.request ?? {}) as Decoded;
    const raceId = s(req.RaceId);
    const config = raceConfigFor(raceId);
    if (config === undefined) throw new Error(`${RPC}: unknown race ${raceId}`);
    const now = Date.now();
    const window = raceWindowFor(raceId, now);
    if (window === undefined) raceConditionInvalid(`${RPC}: race ${raceId} is not open`);
    return withQuestPlayer(ctx, RPC, async (playerId) => {
      const payload = await withPlayerTx(playerId, async (tx) => {
        const updated = { __msg: UPDATED_DATA_MSG } as Decoded;
        const state = await loadRaceState(playerId, raceId, tx);
        const hadActivityClock = state.lastActivityReceiveMs > 0;
        const firstLogin = markRaceInitialLogin(state, now);
        const rewards: Decoded[] = firstLogin
          ? await grantInitialRacePoints(playerId, config, updated, tx)
          : [];
        if (!hadActivityClock) {
          // The clock started with the state (stamped above); nothing has
          // accrued yet. The starting race points were granted with the state.
          await saveRaceState(playerId, raceId, state, tx);
        } else {
          // A claim can span tally boundaries: the rate only changes at 0:00 JST
          // every 2 days, so pay each stretch at the tier tallied for it.
          const questTiers = await loadRaceAreaQuestTiers(config);
          const tiers = buildRaceEffectiveClearedTiers(
            config,
            state,
            questTiers,
            window.startTime,
            now,
          );
          const rate = raceLessonStepReward(config, tiers);
          const maxRewardTime =
            state.lastActivityReceiveMs + config.activityLesson.maxHours * HOUR_MS;
          // The 36 h cap trims the newest time, as before: only steps inside
          // `[lastActivityReceiveMs, maxRewardTime]` are paid.
          const until = Math.min(now, maxRewardTime);
          const steps = Math.max(
            0,
            Math.floor((until - state.lastActivityReceiveMs) / RACE_STEP_INTERVAL_MS),
          );
          const segments =
            steps > 0
              ? tallyStepSegments({
                  startMs: window.startTime,
                  windowStartMs: state.lastActivityReceiveMs,
                  steps,
                  stepMs: RACE_STEP_INTERVAL_MS,
                })
              : [];
          const grants: Grant[] = [];
          let stepPoint = 0;
          let stepMedal = 0;
          for (const segment of segments) {
            const segmentRate = raceLessonStepReward(
              config,
              buildRaceEffectiveClearedTiers(
                config,
                state,
                questTiers,
                window.startTime,
                segment.atMs,
              ),
            );
            stepPoint += segmentRate.racePoint * segment.steps;
            stepMedal += segmentRate.raceMedal * segment.steps;
          }
          if (stepPoint > 0 && config.racePointItemId !== '') {
            grants.push({
              resourceType: 1,
              resourceId: config.racePointItemId,
              amount: stepPoint,
            });
          }
          if (stepMedal > 0 && config.raceMedalItemId !== '') {
            grants.push({
              resourceType: 1,
              resourceId: config.raceMedalItemId,
              amount: stepMedal,
            });
          }
          if (grants.length > 0) {
            const applied = await applyGrants(playerId, grants, tx);
            mergeUpdated(updated, applied.updated);
            for (const grant of grants) rewards.push(itemReward(grant.resourceId ?? '', grant.amount));
          }
          // A capped accrual restarts the clock at now. Otherwise advance by the
          // paid steps so the sub-step remainder carries over; zero steps leave it.
          if (now >= maxRewardTime) {
            state.lastActivityReceiveMs = now;
          } else if (steps > 0) {
            state.lastActivityReceiveMs += steps * RACE_STEP_INTERVAL_MS;
          }
          await saveRaceState(playerId, raceId, state, tx);
          ctx.fastifyReq.log.info(
            {
              playerId,
              raceId,
              steps,
              segments: segments.length,
              stepPoint,
              stepMedal,
              tiers,
              rate,
            },
            'race activity lesson',
          );
        }

        return {
          __msg: 'Solis.Common.Proto.Api.RaceReceiveActivityLessonResponse',
          Rewards: rewards,
          UserRaceInfo: await loadRaceUserRaceInfo(
            playerId,
            config,
            state,
            now,
            window.startTime,
            tx,
          ),
          CommonResponse: commonResponse(compactUpdated(updated)),
        } as Decoded;
      });
      return payload;
    });
  },
  { ownsState: true },
);
