/**
 * Marathon:UseQuestStaminaRecoveryItem. Spends `Amount` of the marathon's
 * stamina recovery item (`config.staminaRecoveryItemId`) to refill the quest
 * stamina pool. Each item restores its master `Value`; the last item may take
 * stamina past `config.initialStamina`.
 */
import { register, type RpcContext } from '../handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { withPlayerTx } from '../../db/tx.ts';
import { getItem } from '../../master/index.ts';
import { commonResponse } from '../activity.ts';
import { compactUpdated, pushUpdated, withQuestPlayer } from '../quest.ts';
import { getItemAmount, spendItem } from '../inventory.ts';
import { activeMarathon } from './catalog.ts';
import { buildUserMarathonInfo } from './index.ts';
import { AppRpcError, ERROR_ACTION, ERROR_CODE, GRPC_STATUS } from '../errors.ts';
import {
  ALREADY_MAX_STAMINA_MESSAGE,
  applyStaminaItems,
  currentStamina,
  loadMarathonState,
  saveMarathonState,
} from './state.ts';

const RPC = 'Marathon:UseQuestStaminaRecoveryItem';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const USE_RESPONSE_MSG = 'Solis.Common.Proto.Api.MarathonUseQuestStaminaRecoveryItemResponse';
const USER_ITEM_MSG = 'Solis.Common.Proto.Transaction.UserItem';

function s(value: unknown): string {
  return value == null ? '' : String(value);
}

register(
  RPC,
  async (ctx: RpcContext) => {
    const req = (ctx.request ?? {}) as Decoded;
    const now = Date.now();
    return withQuestPlayer(ctx, RPC, async (playerId) => {
      let before = 0;
      let after = 0;
      let amount = 0;
      const payload = await withPlayerTx(playerId, async (tx) => {
        const config = activeMarathon();
        if (!config) throw new Error(`${RPC}: no marathon is active`);

        const marathonId = s(req.MarathonId);
        if (marathonId === '' || marathonId !== config.id) {
          throw new Error(`${RPC}: marathon ${marathonId} is not the active marathon`);
        }

        amount = Number(req.Amount ?? 0);
        const itemId = config.staminaRecoveryItemId;
        if (itemId === '') throw new Error(`${RPC}: no stamina recovery item is configured`);
        const item = await getItem(itemId);
        const perItem = Number(item?.Value ?? 0);
        const max = config.initialStamina;

        const state = await loadMarathonState(playerId, config, now, tx);
        const cur = currentStamina(state, config, now);
        let next: { stamina: number };
        try {
          next = applyStaminaItems({ stamina: cur.stamina, max, perItem, amount });
        } catch (err) {
          if (err instanceof Error && err.message === ALREADY_MAX_STAMINA_MESSAGE) {
            throw new AppRpcError(
              ERROR_CODE.ALREADY_MAXIMUM_STAMINA,
              ERROR_ACTION.HOME,
              `${RPC}: already maximum stamina`,
              GRPC_STATUS.INVALID_ARGUMENT,
            );
          }
          throw err;
        }
        before = cur.stamina;
        after = next.stamina;

        const updated = { __msg: UPDATED_DATA_MSG } as Decoded;
        await spendItem(playerId, itemId, amount, tx);
        pushUpdated(updated, 'Items', {
          __msg: USER_ITEM_MSG,
          ItemId: itemId,
          Amount: await getItemAmount(playerId, itemId, tx),
        } as Decoded);

        state.stamina = next.stamina;
        state.staminaUpdatedTime = next.stamina >= max ? now : cur.updated;
        await saveMarathonState(playerId, config.id, state, tx);

        return {
          __msg: USE_RESPONSE_MSG,
          UserMarathonInfo: buildUserMarathonInfo(state, {
            stamina: state.stamina,
            updated: state.staminaUpdatedTime,
          }),
          CommonResponse: commonResponse(compactUpdated(updated)),
        } as Decoded;
      });

      ctx.fastifyReq.log.info(
        { playerId, marathonId: activeMarathon()?.id, amount, before, after },
        'marathon quest stamina recovery item used',
      );
      return payload;
    });
  },
  { ownsState: true },
);
