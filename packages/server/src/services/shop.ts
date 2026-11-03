import { eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import { getCorpusResponses } from './replay/corpus.ts';
import { applyRewardRefs } from '../master/reward.ts';
import { consume } from './consumption.ts';
import { getPurchaseCount, incrementPurchase, listPurchaseCounts } from './purchases.ts';
import { msgRegistry, decodeMessage, Reader } from '@sumire-sr/protocol/runtime/proto.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

const LIST_RESPONSE_MSG = 'Solis.Common.Proto.Api.ShopListResponse';
const LIST_ITEM_RESPONSE_MSG = 'Solis.Common.Proto.Api.ShopListItemResponse';
const PURCHASE_RESPONSE_MSG = 'Solis.Common.Proto.Api.ShopPurchaseResponse';
const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';

const PURCHASE_KIND = 'shop';

function emptyCommon(): Decoded {
  return {
    __msg: COMMON_RESPONSE_MSG,
    UpdatedData: { __msg: UPDATED_DATA_MSG },
    DeletedData: { __msg: DELETED_DATA_MSG },
  } as Decoded;
}

function decodeCaptured(name: string, bytes: Buffer): Decoded {
  const shape = msgRegistry.get(name);
  if (!shape) throw new Error(`unknown shape ${name}`);
  return decodeMessage(shape, new Reader(Uint8Array.from(bytes)));
}

/** First captured Shop:List response that actually lists shops. */
function shopListDecoded(): Decoded | null {
  for (const b of getCorpusResponses('Shop:List')) {
    const decoded = decodeCaptured(LIST_RESPONSE_MSG, b);
    const shops = (decoded.Shops as Decoded[] | undefined) ?? [];
    if (shops.length) return decoded;
  }
  return null;
}

/** First captured Shop:ListItem response that actually lists items. */
function shopItemsDecoded(): Decoded | null {
  for (const b of getCorpusResponses('Shop:ListItem')) {
    const decoded = decodeCaptured(LIST_ITEM_RESPONSE_MSG, b);
    const items = (decoded.ShopItems as Decoded[] | undefined) ?? [];
    if (items.length) return decoded;
  }
  return null;
}

function catalogItems(): Decoded[] {
  return ((shopItemsDecoded()?.ShopItems as Decoded[] | undefined) ?? []) as Decoded[];
}

async function resolvePlayer(accountId: string | undefined) {
  if (!accountId) throw new Error('unauthenticated');
  const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  if (!pl) throw new Error('no player');
  return pl;
}

function accountIdOf(ctx: { auth: { ok: boolean; claims?: { sub?: string } | null } }): string | undefined {
  return ctx.auth.ok ? (ctx.auth.claims?.sub ?? undefined) : undefined;
}

register(
  'Shop:List',
  async (ctx) => {
    await resolvePlayer(accountIdOf(ctx));
    const decoded = shopListDecoded();
    const shops = (decoded?.Shops as Decoded[] | undefined) ?? [];
    return { __msg: LIST_RESPONSE_MSG, Shops: shops, CommonResponse: emptyCommon() } as Decoded;
  },
  { ownsState: true },
);

register(
  'Shop:ListItem',
  async (ctx) => {
    const pl = await resolvePlayer(accountIdOf(ctx));
    const items = catalogItems();
    const counts = await listPurchaseCounts(pl.id, PURCHASE_KIND);
    const adjusted = items.map((it) => {
      const limit = Number(it.PurchaseLimit ?? 0);
      if (limit <= 0) return it;
      const purchased = counts.get(String(it.Id)) ?? 0;
      return { ...it, LeftCount: Math.max(0, limit - purchased) } as Decoded;
    });
    return { __msg: LIST_ITEM_RESPONSE_MSG, ShopItems: adjusted, CommonResponse: emptyCommon() } as Decoded;
  },
  { ownsState: true },
);

register(
  'Shop:Purchase',
  async (ctx) => {
    const pl = await resolvePlayer(accountIdOf(ctx));
    const shopItemId = String(ctx.request?.ShopItemId ?? '');
    if (!shopItemId) throw new Error('missing ShopItemId');

    const item = catalogItems().find((it) => String(it.Id) === shopItemId);
    if (!item) throw new Error(`unknown shop item ${shopItemId}`);

    const applied = await withPlayerTx(pl.id, async (tx) => {
      const purchased = await getPurchaseCount(pl.id, PURCHASE_KIND, shopItemId, tx);
      const limit = Number(item.PurchaseLimit ?? 0);
      if (limit > 0 && purchased >= limit) throw new Error(`purchase limit reached ${shopItemId}`);

      if (item.ConsumptionId) await consume(pl.id, item.ConsumptionId, 1, tx);
      const result = await applyRewardRefs(pl.id, [String(item.RewardId)], tx);
      await incrementPurchase(pl.id, PURCHASE_KIND, shopItemId, tx);
      return result;
    });

    ctx.fastifyReq.log.info({ playerId: pl.id, shopItemId }, 'shop purchase (server-authoritative)');
    return {
      __msg: PURCHASE_RESPONSE_MSG,
      Rewards: applied.results,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: applied.updated ?? ({ __msg: UPDATED_DATA_MSG } as Decoded),
        DeletedData: { __msg: DELETED_DATA_MSG } as Decoded,
      },
    } as Decoded;
  },
  { ownsState: true },
);
