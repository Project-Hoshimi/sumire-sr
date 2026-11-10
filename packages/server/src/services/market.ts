import { eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import { getCorpusResponses } from './replay/corpus.ts';
import { applyRewardRefs } from '../master/reward.ts';
import { spendCurrency } from './currency.ts';
import { attachPlayerBalance } from './playerState.ts';
import { getPurchaseCount, incrementPurchase, listPurchaseCounts } from './purchases.ts';
import { msgRegistry, decodeMessage, Reader } from '@sumire-sr/protocol/runtime/proto.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

const LIST_RESPONSE_MSG = 'Solis.Common.Proto.Api.MarketListItemResponse';
const PURCHASE_RESPONSE_MSG = 'Solis.Common.Proto.Api.MarketPurchaseResponse';
const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';

const PURCHASE_KIND = 'market';
const RESOURCE_GOLD = 8;
const RESOURCE_STONE = 15;

function emptyCommon(): Decoded {
  return {
    __msg: COMMON_RESPONSE_MSG,
    UpdatedData: { __msg: UPDATED_DATA_MSG },
    DeletedData: { __msg: DELETED_DATA_MSG },
  } as Decoded;
}

/** First captured Market:ListItem response that actually lists items. */
function marketListDecoded(): Decoded | null {
  for (const b of getCorpusResponses('Market:ListItem')) {
    const shape = msgRegistry.get(LIST_RESPONSE_MSG);
    if (!shape) throw new Error(`unknown shape ${LIST_RESPONSE_MSG}`);
    const decoded = decodeMessage(shape, new Reader(Uint8Array.from(b)));
    const items = (decoded.MarketItems as Decoded[] | undefined) ?? [];
    if (items.length) return decoded;
  }
  return null;
}

function catalogItems(): Decoded[] {
  return ((marketListDecoded()?.MarketItems as Decoded[] | undefined) ?? []) as Decoded[];
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

function spent(type: number, amount: number, playerId: string, tx: Parameters<typeof spendCurrency>[3]) {
  if (type === RESOURCE_GOLD) return spendCurrency(playerId, 'gold', amount, tx);
  if (type === RESOURCE_STONE) return spendCurrency(playerId, 'freeJewel', amount, tx);
  throw new Error(`market: unsupported consumption resource type ${type}`);
}

register(
  'Market:ListItem',
  async (ctx) => {
    const pl = await resolvePlayer(accountIdOf(ctx));
    const decoded = marketListDecoded();
    const items = (decoded?.MarketItems as Decoded[] | undefined) ?? [];
    const counts = await listPurchaseCounts(pl.id, PURCHASE_KIND);
    const adjusted = items.map((it) => {
      const soldOut = (counts.get(String(it.Number)) ?? 0) > 0;
      return { ...it, SoldOut: soldOut || undefined } as Decoded;
    });
    return {
      __msg: LIST_RESPONSE_MSG,
      MarketItems: adjusted,
      NextResetTime: decoded?.NextResetTime,
      FreeResetRemainCount: decoded?.FreeResetRemainCount,
      ResetRemainCount: decoded?.ResetRemainCount,
      RequiredResetStoneAmount: decoded?.RequiredResetStoneAmount,
      CommonResponse: emptyCommon(),
    } as Decoded;
  },
  { ownsState: true },
);

register(
  'Market:Purchase',
  async (ctx) => {
    const pl = await resolvePlayer(accountIdOf(ctx));
    const number = Number(ctx.request?.Number ?? 0);
    if (!number) throw new Error('missing market Number');

    const items = catalogItems();
    const item = items.find((it) => Number(it.Number) === number);
    if (!item) throw new Error(`unknown market item ${number}`);

    const applied = await withPlayerTx(pl.id, async (tx) => {
      const purchased = await getPurchaseCount(pl.id, PURCHASE_KIND, String(number), tx);
      if (purchased > 0) throw new Error(`market item ${number} already sold out`);

      const type = Number(item.ConsumptionResourceType ?? 0);
      const cost = Number(item.DiscountAmount ?? item.BaseAmount ?? 0);
      if (type && cost > 0) await spent(type, cost, pl.id, tx);

      const result = await applyRewardRefs(pl.id, [String(item.RewardId)], tx);
      if (type === RESOURCE_STONE && cost > 0) {
        result.updated = result.updated ?? ({ __msg: UPDATED_DATA_MSG } as Decoded);
        await attachPlayerBalance(pl.id, result.updated, tx);
      }
      await incrementPurchase(pl.id, PURCHASE_KIND, String(number), tx);
      return result;
    });

    ctx.fastifyReq.log.info({ playerId: pl.id, number }, 'market purchase (server-authoritative)');
    const updatedItems = items.map((it) =>
      Number(it.Number) === number ? ({ ...it, SoldOut: true } as Decoded) : it,
    );
    return {
      __msg: PURCHASE_RESPONSE_MSG,
      MarketItems: updatedItems,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: applied.updated ?? ({ __msg: UPDATED_DATA_MSG } as Decoded),
        DeletedData: { __msg: DELETED_DATA_MSG } as Decoded,
      },
    } as Decoded;
  },
  { ownsState: true },
);