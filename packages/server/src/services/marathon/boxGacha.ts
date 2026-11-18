/**
 * Marathon:DrawBoxGacha and Marathon:ResetBoxGacha.
 *
 * Box contents are catalogue-authored (`MarathonConfig.boxGachas`), the
 * per-player draw counters live in the marathon state singleton, and the
 * resource cost comes from the master `BoxGacha` / `BoxGachaGroup` rows.
 */
import { randomBytes } from 'node:crypto';
import { register, type RpcContext } from '../handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { withPlayerTx } from '../../db/tx.ts';
import { getBoxGacha, getBoxGachaGroup, listMarathonBoxGachaSettings, listMarathonLiveBonusIds } from '../../master/index.ts';
import { commonResponse } from '../activity.ts';
import {
  compactUpdated,
  grantQuestReward,
  pushUpdated,
  withQuestPlayer,
} from '../quest.ts';
import { getItemAmount, spendItem } from '../inventory.ts';
import { PCG, Rand } from '../../live/pcg.ts';
import { activeMarathon, type MarathonConfig } from './catalog.ts';
import { buildBoxGachaInfo, marathonPoints } from './boxInfo.ts';
import { canResetBox, pickBoxDraws, remainingStock, resolveDrawCount } from './box.ts';
import { addLiveBonus, pickLiveBonusId } from './liveBonus.ts';
import { loadMarathonState, saveMarathonState } from './state.ts';
import { ConditionEvaluator } from '../conditions.ts';

const RPC_DRAW = 'Marathon:DrawBoxGacha';
const RPC_RESET = 'Marathon:ResetBoxGacha';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DRAW_RESULT_MSG = 'Solis.Common.Proto.Api.BoxGachaDrawResult';
const DRAW_RESPONSE_MSG = 'Solis.Common.Proto.Api.MarathonBoxGachaDrawResponse';
const RESET_RESPONSE_MSG = 'Solis.Common.Proto.Api.MarathonBoxGachaResetResponse';
const USER_ITEM_MSG = 'Solis.Common.Proto.Transaction.UserItem';

/**
 * Safety bound on draws per request when the catalogue does not set one. It is
 * not a gameplay limit; the request's ExecCount is honoured up to this value.
 */
const DEFAULT_BOX_DRAW_MAX = 100;

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function s(value: unknown): string {
  return value == null ? '' : String(value);
}

/** Validate the request's marathon/box ids and load the master `BoxGacha` row. */
async function resolveBox(rpc: string, req: Decoded): Promise<{
  config: MarathonConfig;
  boxGachaId: string;
  setting: Decoded;
  boxGacha: Awaited<ReturnType<typeof getBoxGacha>>;
}> {
  const marathonId = s(req.MarathonId);
  if (marathonId === '') throw new Error(`${rpc}: marathonId is required`);
  const config = activeMarathon();
  if (!config) throw new Error(`${rpc}: no marathon is active`);
  if (marathonId !== config.id) throw new Error(`${rpc}: marathon ${marathonId} is not active`);

  const boxGachaId = s(req.BoxGachaId);
  if (boxGachaId === '') throw new Error(`${rpc}: boxGachaId is required`);
  const settings = await listMarathonBoxGachaSettings(config.id);
  const setting = settings.find((row) => s(row.BoxGachaId) === boxGachaId);
  if (!setting) throw new Error(`${rpc}: box gacha not found: ${boxGachaId}`);

  const boxGacha = await getBoxGacha(boxGachaId);
  return { config, boxGachaId, setting: setting as unknown as Decoded, boxGacha };
}

register(
  RPC_DRAW,
  async (ctx: RpcContext) => {
    const req = (ctx.request ?? {}) as Decoded;
    const seed = randomBytes(8).readBigUInt64BE();
    const now = Date.now();
    let requestedForLog = 0;
    let drawnForLog = 0;
    return withQuestPlayer(ctx, RPC_DRAW, async (playerId) => {
      const payload = await withPlayerTx(playerId, async (tx) => {
        const { config, boxGachaId, setting, boxGacha } = await resolveBox(RPC_DRAW, req);
        const updated = { __msg: UPDATED_DATA_MSG } as Decoded;
        const evaluator = new ConditionEvaluator(playerId, now, tx);
        const state = await loadMarathonState(playerId, config, now, tx);
        const point = await marathonPoints(playerId, config.id, tx);

        const info = await buildBoxGachaInfo(playerId, config, setting, state, point, tx, evaluator);
        if (info.Unlocked !== true) throw new Error(`${RPC_DRAW}: box gacha is locked`);

        // Catalogue group takes precedence; the master BoxGacha row is the fallback.
        const groupId = config.boxGachaGroupId !== '' ? config.boxGachaGroupId : s(boxGacha?.BoxGachaGroupId);
        const group = groupId === '' ? null : await getBoxGachaGroup(groupId);
        if (!group) throw new Error(`${RPC_DRAW}: box gacha group not found: ${groupId}`);
        const itemId = s(group.RequiredResourceId);
        if (itemId === '') throw new Error(`${RPC_DRAW}: box gacha group ${groupId} has no required resource`);
        const cost = n(boxGacha?.RequiredResourceAmount);

        const items = config.boxGachas?.[boxGachaId]?.items ?? [];
        const boxState = state.boxes?.[boxGachaId];
        const drawn = boxState?.drawn ?? {};
        const owned = await getItemAmount(playerId, itemId, tx);
        const affordable = cost > 0 ? Math.floor(owned / cost) : Number.POSITIVE_INFINITY;
        const requested = n(req.ExecCount);
        const maxDraw = config.boxDrawMax ?? DEFAULT_BOX_DRAW_MAX;
        const hasInfinite = items.some((def) => def.isLimited !== true && def.initialStock > 0);
        let count: number;
        try {
          count = resolveDrawCount({
            requested,
            maxDraw,
            affordable,
            finiteRemaining: remainingStock(items, drawn),
            hasInfinite,
          });
        } catch (err) {
          throw new Error(`${RPC_DRAW}: ${(err as Error).message}`);
        }

        const orders = pickBoxDraws(items, drawn, count, Math.random, config.boxInfiniteRate);
        if (orders.length !== count) {
          throw new Error(`${RPC_DRAW}: picked ${orders.length} of ${count} draws`);
        }

        if (cost > 0) {
          await spendItem(playerId, itemId, cost * count, tx);
          pushUpdated(updated, 'Items', {
            __msg: USER_ITEM_MSG,
            ItemId: itemId,
            Amount: await getItemAmount(playerId, itemId, tx),
          } as Decoded);
        }

        const boxes = (state.boxes ??= {});
        const progress = boxes[boxGachaId] ?? { drawn: {}, resetCount: 0 };
        boxes[boxGachaId] = progress;
        const byOrder = new Map(items.map((item) => [item.order, item]));
        const rng = new Rand(new PCG(seed ^ 0x626f786761636861n, seed));
        const drawResults: Decoded[] = [];
        const pickupResults: Decoded[] = [];
        for (const order of orders) {
          const item = byOrder.get(order);
          if (!item) continue;
          const key = String(order);
          progress.drawn[key] = (progress.drawn[key] ?? 0) + 1;
          // Item type 2 hands out an owned live bonus from a master group;
          // item type 1 grants a master Reward. Adding owned live bonuses to the
          // live score calculation is not implemented yet.
          let rewards: Decoded[] = [];
          let liveBonusId = '';
          if (item.itemType === 2) {
            const groupId = item.liveBonusGroupId ?? '';
            if (groupId === '') {
              throw new Error(`${RPC_DRAW}: box item ${order} has no live bonus group`);
            }
            const ids = await listMarathonLiveBonusIds(groupId);
            if (ids.length === 0) {
              throw new Error(`${RPC_DRAW}: live bonus group not found: ${groupId}`);
            }
            const picked = pickLiveBonusId(ids, Math.random);
            if (picked === null) {
              throw new Error(`${RPC_DRAW}: live bonus group ${groupId} has no ids`);
            }
            addLiveBonus(state, picked);
            liveBonusId = picked;
          } else {
            rewards = item.rewardId
              ? await grantQuestReward(playerId, item.rewardId, 1, 0, rng, updated, tx)
              : [];
          }
          const result = {
            __msg: DRAW_RESULT_MSG,
            ItemType: item.itemType,
            Rewards: rewards,
            LiveBonusId: liveBonusId,
          } as Decoded;
          drawResults.push(result);
          if (item.isPickup === true) pickupResults.push(result);
        }

        await saveMarathonState(playerId, config.id, state, tx);
        requestedForLog = requested;
        drawnForLog = drawResults.length;

        return {
          __msg: DRAW_RESPONSE_MSG,
          DrawResults: drawResults,
          PickupResults: pickupResults,
          CommonResponse: commonResponse(compactUpdated(updated)),
        } as Decoded;
      });

      ctx.fastifyReq.log.info(
        { playerId, execCount: requestedForLog, drawn: drawnForLog },
        'marathon box gacha draw',
      );
      return payload;
    });
  },
  { ownsState: true },
);

register(
  RPC_RESET,
  async (ctx: RpcContext) => {
    const req = (ctx.request ?? {}) as Decoded;
    const now = Date.now();
    return withQuestPlayer(ctx, RPC_RESET, async (playerId) => {
      const payload = await withPlayerTx(playerId, async (tx) => {
        const { config, boxGachaId, setting, boxGacha } = await resolveBox(RPC_RESET, req);
        const evaluator = new ConditionEvaluator(playerId, now, tx);
        const state = await loadMarathonState(playerId, config, now, tx);
        const point = await marathonPoints(playerId, config.id, tx);

        const items = config.boxGachas?.[boxGachaId]?.items ?? [];
        const boxState = state.boxes?.[boxGachaId];
        const drawn = boxState?.drawn ?? {};
        const resetCount = boxState?.resetCount ?? 0;
        const resettable = canResetBox(
          {
            canReset: boxGacha?.CanReset === true,
            resetLimitCount: n(boxGacha?.ResetLimitCount),
          },
          items,
          drawn,
          resetCount,
        );
        if (!resettable) throw new Error(`${RPC_RESET}: box gacha cannot be reset`);

        const boxes = (state.boxes ??= {});
        boxes[boxGachaId] = { drawn: {}, resetCount: resetCount + 1 };
        await saveMarathonState(playerId, config.id, state, tx);

        const info = await buildBoxGachaInfo(playerId, config, setting, state, point, tx, evaluator);
        const updated = { __msg: UPDATED_DATA_MSG } as Decoded;
        return {
          __msg: RESET_RESPONSE_MSG,
          BoxGachaInfo: info,
          CommonResponse: commonResponse(compactUpdated(updated)),
        } as Decoded;
      });

      ctx.fastifyReq.log.info({ playerId }, 'marathon box gacha reset');
      return payload;
    });
  },
  { ownsState: true },
);
