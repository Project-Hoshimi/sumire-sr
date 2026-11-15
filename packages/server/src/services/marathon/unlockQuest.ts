/**
 * Marathon:UnlockQuest. Spends `config.questUnlockItemId` to pay a quest's
 * `RequiredUnlockItemAmount` gate once; the payment is remembered in the
 * marathon state singleton (`unlockedQuests`).
 */
import { register, type RpcContext } from '../handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { withPlayerTx } from '../../db/tx.ts';
import { getMarathonQuest } from '../../master/index.ts';
import { commonResponse } from '../activity.ts';
import { compactUpdated, pushUpdated, withQuestPlayer } from '../quest.ts';
import { getItemAmount, spendItem } from '../inventory.ts';
import { activeMarathon } from './catalog.ts';
import { buildMarathonQuestInfo } from './questInfo.ts';
import { loadMarathonState, saveMarathonState } from './state.ts';
import { marathonQuestAccess } from './unlock.ts';
import { ConditionEvaluator } from '../conditions.ts';

const RPC = 'Marathon:UnlockQuest';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const UNLOCK_RESPONSE_MSG = 'Solis.Common.Proto.Api.MarathonQuestUnlockResponse';
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
      const payload = await withPlayerTx(playerId, async (tx) => {
        const config = activeMarathon();
        if (!config) throw new Error(`${RPC}: no marathon is active`);

        const questId = s(req.MarathonQuestId);
        if (questId === '') throw new Error(`${RPC}: marathonQuestId is required`);
        const quest = await getMarathonQuest(questId);
        if (!quest) throw new Error(`${RPC}: marathon quest not found: ${questId}`);
        if (s(quest.MarathonId) !== config.id) {
          throw new Error(`${RPC}: marathon quest ${questId} is not in the active marathon`);
        }

        const evaluator = new ConditionEvaluator(playerId, now, tx);
        const state = await loadMarathonState(playerId, config, now, tx);
        const access = await marathonQuestAccess(playerId, quest, config, state, tx, evaluator);
        if (access.unlocked) throw new Error(`${RPC}: marathon quest is already unlocked`);
        if (!access.conditionMet) throw new Error(`${RPC}: marathon quest is locked`);
        if (!access.unlockable) {
          const owned = await getItemAmount(playerId, config.questUnlockItemId, tx);
          throw new Error(
            `insufficient item ${config.questUnlockItemId}: have ${owned}, need ${access.requiredAmount}`,
          );
        }

        const updated = { __msg: UPDATED_DATA_MSG } as Decoded;
        await spendItem(playerId, config.questUnlockItemId, access.requiredAmount, tx);
        pushUpdated(updated, 'Items', {
          __msg: USER_ITEM_MSG,
          ItemId: config.questUnlockItemId,
          Amount: await getItemAmount(playerId, config.questUnlockItemId, tx),
        } as Decoded);

        (state.unlockedQuests ??= {})[questId] = true;
        await saveMarathonState(playerId, config.id, state, tx);

        return {
          __msg: UNLOCK_RESPONSE_MSG,
          UnlockedQuestInfo: await buildMarathonQuestInfo(playerId, config, quest, state, tx, evaluator),
          CommonResponse: commonResponse(compactUpdated(updated)),
        } as Decoded;
      });

      ctx.fastifyReq.log.info({ playerId }, 'marathon quest unlock');
      return payload;
    });
  },
  { ownsState: true },
);
