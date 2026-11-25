// `Race:ResetCardCoolTime`: pay race points to clear one card's cool time.
//
// A cleared VENUS panel puts every card of the deck on cool time; this RPC is
// the paid shortcut back into the live.
import { register, type RpcContext } from '../handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { withPlayerTx } from '../../db/tx.ts';
import { commonResponse } from '../activity.ts';
import { getItemAmount, spendItem } from '../inventory.ts';
import { compactUpdated, withQuestPlayer } from '../quest.ts';
import { raceConfigFor, raceWindowFor } from './catalog.ts';
import { loadRaceState, markRaceInitialLogin, saveRaceState } from './state.ts';
import { grantInitialRacePoints, pushItemAmount } from './updated.ts';
import { raceConditionInvalid, raceNotInCoolTime, raceResourceNotEnough } from './errors.ts';
import { loadRaceUserRaceInfo } from './userRaceInfo.ts';

const RPC = 'Race:ResetCardCoolTime';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

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
    const cardId = s(req.CardId);
    if (cardId === '') throw new Error(`${RPC}: cardId is required`);
    const now = Date.now();
    const window = raceWindowFor(raceId, now);
    if (window === undefined) raceConditionInvalid(`${RPC}: race ${raceId} is not open`);
    return withQuestPlayer(ctx, RPC, async (playerId) => {
      const payload = await withPlayerTx(playerId, async (tx) => {
        const updated = { __msg: UPDATED_DATA_MSG } as Decoded;
        const state = await loadRaceState(playerId, raceId, tx);
        const firstLogin = markRaceInitialLogin(state, now);
        if (firstLogin) await grantInitialRacePoints(playerId, config, updated, tx);

        const coolTime = n(state.cardCoolTimes[cardId]);
        if (coolTime <= now) raceNotInCoolTime(`${RPC}: card ${cardId} is not on cool time`);
        const cost = config.requiredCardCoolTimeRacePointAmount;
        const have = await getItemAmount(playerId, config.racePointItemId, tx);
        if (have < cost) {
          raceResourceNotEnough(
            `${RPC}: insufficient race point ${config.racePointItemId}: have ${have}, need ${cost}`,
          );
        }
        if (cost > 0) await spendItem(playerId, config.racePointItemId, cost, tx);
        await pushItemAmount(playerId, updated, config.racePointItemId, tx);
        delete state.cardCoolTimes[cardId];
        await saveRaceState(playerId, raceId, state, tx);
        ctx.fastifyReq.log.info({ playerId, raceId, cardId, cost }, 'race reset card cool time');
        return {
          __msg: 'Solis.Common.Proto.Api.RaceResetCardCoolTimeResponse',
          UserRaceInfo: await loadRaceUserRaceInfo(playerId, config, state, now, window.startTime, tx),
          CommonResponse: commonResponse(compactUpdated(updated)),
        } as Decoded;
      });
      return payload;
    });
  },
  { ownsState: true },
);
