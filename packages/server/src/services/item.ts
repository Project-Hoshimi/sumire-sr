import { eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import { getItem } from '../master/index.ts';
import { getCurrency, grantCurrency } from './currency.ts';
import { getItemAmount, spendItem } from './inventory.ts';
import { GRPC_STATUS, RpcError } from './errors.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

const SELL_RESPONSE_MSG = 'Solis.Common.Proto.Api.ItemSellResponse';
const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';
const USER_ITEM_MSG = 'Solis.Common.Proto.Transaction.UserItem';

/**
 * `Item:Sell` — sells `Amount` copies of an owned item for gold at the item's
 * master `SalePrice`. The remaining stack is reported in `UpdatedData.Items`,
 * or in `DeletedData.Items` when the stack is emptied, together with the new
 * gold total in `UpdatedData.Points`. Follows solis-server item/sell.go.
 */
register(
  'Item:Sell',
  async (ctx) => {
    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('Item:Sell: unauthenticated');

    const itemId = ctx.request?.ItemId ? String(ctx.request.ItemId) : '';
    const amount = Number(ctx.request?.Amount ?? 0);
    if (!itemId || !Number.isSafeInteger(amount) || amount <= 0) {
      throw new RpcError('Item:Sell: itemId and a positive amount are required', GRPC_STATUS.INVALID_ARGUMENT);
    }

    const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
    if (!pl) throw new Error('Item:Sell: no player for account');

    const master = await getItem(itemId);
    const salePrice = Number(master?.SalePrice ?? 0);
    if (salePrice <= 0) throw new Error(`Item:Sell: ${itemId} cannot be sold`);
    if (!Number.isSafeInteger(salePrice * amount)) {
      throw new RpcError('Item:Sell: sale proceeds overflow', GRPC_STATUS.INVALID_ARGUMENT);
    }

    const out = await withPlayerTx(pl.id, async (tx) => {
      const owned = await getItemAmount(pl.id, itemId, tx);
      if (owned < amount) {
        throw new Error(`Item:Sell: have ${owned}, cannot sell ${amount} of ${itemId}`);
      }

      await spendItem(pl.id, itemId, amount, tx);
      const gold = salePrice * amount;
      await grantCurrency(pl.id, 'gold', gold, tx);

      const remaining = owned - amount;
      const updated: Decoded = { __msg: UPDATED_DATA_MSG };
      const deleted: Decoded = { __msg: DELETED_DATA_MSG };
      const item = { __msg: USER_ITEM_MSG, ItemId: itemId } as Decoded;
      if (remaining > 0) {
        updated.Items = [{ ...item, Amount: remaining } as Decoded];
      } else {
        deleted.Items = [item];
      }

      updated.Points = [{ PointType: 1, Amount: await getCurrency(pl.id, 'gold', tx) } as Decoded];

      return { updated, deleted, gold };
    });

    ctx.fastifyReq.log.info(
      { playerId: pl.id, itemId, sold: amount, gold: out.gold },
      'item sell (server-authoritative)',
    );

    return {
      __msg: SELL_RESPONSE_MSG,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: out.updated,
        DeletedData: out.deleted,
      },
    } as Decoded;
  },
  { ownsState: true },
);
