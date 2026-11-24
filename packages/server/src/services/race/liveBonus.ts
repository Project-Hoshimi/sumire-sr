// `Race:EnhanceLiveBonus` / `Race:ResetLiveBonus`.
//
// Levels are bought in order with race medals: the requested level must be
// above the current one (the UI can raise several levels in one call), and
// every level row from current+1 through the target must exist in the race's
// live-bonus group. Each row's `UnlockConditionId`, when authored, is evaluated
// with the shared condition evaluator, and the total `RequiredRaceMedalAmount`
// of those rows is charged once. Resetting spends one eraser item and refunds
// every medal spent.
import { register, type RpcContext } from '../handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { withPlayerTx } from '../../db/tx.ts';
import { applyGrants, type Grant } from '../../master/reward.ts';
import { commonResponse } from '../activity.ts';
import { ConditionEvaluator } from '../conditions.ts';
import { getItemAmount, spendItem } from '../inventory.ts';
import { compactUpdated, withQuestPlayer } from '../quest.ts';
import { raceConfigFor, raceWindowFor } from './catalog.ts';
import { getRaceLiveBonus, listRaceLiveBonusGroupIds } from './master.ts';
import { loadRaceState, markRaceInitialLogin, saveRaceState } from './state.ts';
import { grantInitialRacePoints, mergeUpdated, pushItemAmount } from './updated.ts';
import { raceConditionInvalid, raceResourceNotEnough } from './errors.ts';
import { loadRaceUserRaceInfo } from './userRaceInfo.ts';

const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function s(value: unknown): string {
  return value == null ? '' : String(value);
}

register(
  'Race:EnhanceLiveBonus',
  async (ctx: RpcContext) => {
    const RPC = 'Race:EnhanceLiveBonus';
    const req = (ctx.request ?? {}) as Decoded;
    const raceId = s(req.RaceId);
    const config = raceConfigFor(raceId);
    if (config === undefined) throw new Error(`${RPC}: unknown race ${raceId}`);
    const liveBonusId = s(req.LiveBonusId);
    const level = n(req.Level);
    if (liveBonusId === '' || level <= 0) {
      throw new Error(`${RPC}: liveBonusId and level are required`);
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

        const group = await listRaceLiveBonusGroupIds(config.raceLiveBonusGroupId);
        if (!group.includes(liveBonusId)) {
          raceConditionInvalid(`${RPC}: live bonus ${liveBonusId} is not part of ${config.raceLiveBonusGroupId}`);
        }
        const currentLevel = n(state.liveBonuses[liveBonusId]);
        if (level <= currentLevel) {
          raceConditionInvalid(`${RPC}: live bonus ${liveBonusId} is already at level ${currentLevel}`);
        }
        // Charge every level from current+1 through the requested target: each
        // row must exist and be unlocked, and the total is spent in one go.
        let cost = 0;
        for (let target = currentLevel + 1; target <= level; target += 1) {
          const row = (await getRaceLiveBonus(liveBonusId, target)) as unknown as Decoded | null;
          if (!row) raceConditionInvalid(`${RPC}: live bonus ${liveBonusId} level ${target} does not exist`);
          const conditionId = s(row.UnlockConditionId);
          if (conditionId !== '') {
            const evaluator = new ConditionEvaluator(playerId, now, tx);
            if (!(await evaluator.satisfied(conditionId))) {
              raceConditionInvalid(`${RPC}: live bonus ${liveBonusId} level ${target} is locked`);
            }
          }
          cost += n(row.RequiredRaceMedalAmount);
        }
        const have = await getItemAmount(playerId, config.raceMedalItemId, tx);
        if (have < cost) {
          raceResourceNotEnough(
            `${RPC}: insufficient race medal ${config.raceMedalItemId}: have ${have}, need ${cost}`,
          );
        }
        if (cost > 0) await spendItem(playerId, config.raceMedalItemId, cost, tx);
        await pushItemAmount(playerId, updated, config.raceMedalItemId, tx);
        state.liveBonuses[liveBonusId] = level;
        state.medalsSpentOnBonuses += cost;
        await saveRaceState(playerId, raceId, state, tx);
        ctx.fastifyReq.log.info(
          { playerId, raceId, liveBonusId, fromLevel: currentLevel, toLevel: level, cost },
          'race enhance live bonus',
        );
        return {
          __msg: 'Solis.Common.Proto.Api.RaceEnhanceLiveBonusResponse',
          UserRaceInfo: await loadRaceUserRaceInfo(playerId, config, state, now, window.startTime, tx),
          CommonResponse: commonResponse(compactUpdated(updated)),
        } as Decoded;
      });
      return payload;
    });
  },
  { ownsState: true },
);

register(
  'Race:ResetLiveBonus',
  async (ctx: RpcContext) => {
    const RPC = 'Race:ResetLiveBonus';
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
        const firstLogin = markRaceInitialLogin(state, now);
        if (firstLogin) await grantInitialRacePoints(playerId, config, updated, tx);

        const have = await getItemAmount(playerId, config.raceLiveBonusResetItemId, tx);
        if (have < 1) {
          raceResourceNotEnough(
            `${RPC}: insufficient item ${config.raceLiveBonusResetItemId}: have ${have}, need 1`,
          );
        }
        await spendItem(playerId, config.raceLiveBonusResetItemId, 1, tx);

        const refund = state.medalsSpentOnBonuses;
        if (refund > 0 && config.raceMedalItemId !== '') {
          const grants: Grant[] = [
            { resourceType: 1, resourceId: config.raceMedalItemId, amount: refund },
          ];
          const applied = await applyGrants(playerId, grants, tx);
          mergeUpdated(updated, applied.updated);
        }
        // After the refund: the eraser's absolute amount wins over any stale row.
        await pushItemAmount(playerId, updated, config.raceLiveBonusResetItemId, tx);
        state.medalsSpentOnBonuses = 0;
        state.liveBonuses = {};
        await saveRaceState(playerId, raceId, state, tx);
        ctx.fastifyReq.log.info({ playerId, raceId, refund }, 'race reset live bonus');
        return {
          __msg: 'Solis.Common.Proto.Api.RaceResetLiveBonusResponse',
          UserRaceInfo: await loadRaceUserRaceInfo(playerId, config, state, now, window.startTime, tx),
          CommonResponse: commonResponse(compactUpdated(updated)),
        } as Decoded;
      });
      return payload;
    });
  },
  { ownsState: true },
);
