import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { players, playerEntities } from '../db/schema.ts';
import { getCostume } from '../master/index.ts';
import { STARTER_GIFTS } from './starterGifts.ts';
import { getCorpusResponses } from './replay/corpus.ts';
import { endpoints } from '@sumire-sr/protocol/gen/endpoints.ts';
import { isSandbox } from '../profile.ts';
import { applyGrants, type Grant } from '../master/reward.ts';
import { applyUpdatedData, listElements, readPlayerBalance, replaceElements } from './playerState.ts';
import {
  decodeMessage,
  encodeMessage,
  msgRegistry,
  Reader,
  Writer,
  type Decoded,
} from '@sumire-sr/protocol/runtime/proto.ts';

const LIST_RESPONSE_MSG = 'Solis.Common.Proto.Api.GiftListResponse';
const RECEIVE_RESPONSE_MSG = 'Solis.Common.Proto.Api.GiftReceiveResponse';
const HISTORY_RESPONSE_MSG = 'Solis.Common.Proto.Api.GiftHistoryListResponse';
const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';
const USER_GIFT_MSG = 'Solis.Common.Proto.Transaction.UserGift';
const USER_GIFT_HISTORY_MSG = 'Solis.Common.Proto.Transaction.UserGiftHistory';
const PHOTO_GIFT_HISTORY_MSG = 'Solis.Common.Proto.Transaction.PhotoGiftHistory';

const GIFT_KIND = 'Gifts';
const NOTIFICATIONS_KIND = 'Notifications';
/** `Solis.Common.Proto.NotificationType.Gift`. */
const GIFT_NOTIFICATION_TYPE = 3;
const GIFT_HISTORY_KIND = 'GiftHistory';
const GIFT_SEED_MARKER = 'GiftBoxSeeded';
const RES_COSTUME = 5;
const RES_HAIR = 28;

/**
 * `Gift:ListHistory` page size. The official client caps the received-gift
 * history and the captures contain no `Gift:ListHistory` exchange, so this is
 * sumire's own bound: the newest 100 received gifts, newest first.
 */
const HISTORY_LIMIT = 100;

function giftShape() {
  return msgRegistry.get(USER_GIFT_MSG)!;
}

async function isGiftSeeded(exec: Executor, playerId: string): Promise<boolean> {
  const rows = await exec
    .select({ id: playerEntities.id })
    .from(playerEntities)
    .where(
      and(
        eq(playerEntities.playerId, playerId),
        eq(playerEntities.kind, GIFT_SEED_MARKER),
        eq(playerEntities.entityKey, '1'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function loadGifts(exec: Executor, playerId: string): Promise<Decoded[]> {
  const rows = await exec
    .select()
    .from(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, GIFT_KIND)))
    .orderBy(asc(playerEntities.ordinal));
  const shape = giftShape();
  return rows.map((r) =>
    decodeMessage(shape, new Reader(Uint8Array.from(Buffer.from(r.blob, 'base64')))),
  );
}

/** The first captured `Gift:List` body that actually carries gifts. */
function capturedGifts(): Decoded[] {
  const listShape = msgRegistry.get(endpoints.Gift.List.response)!;
  for (const raw of getCorpusResponses('Gift:List')) {
    const template = decodeMessage(listShape, new Reader(Uint8Array.from(raw)));
    const gifts = (template.Gifts as Decoded[] | undefined) ?? [];
    if (gifts.length > 0) return gifts;
  }
  return [];
}

/** Seed the player's gift box from the captured template on first access. */
async function seedGifts(exec: Executor, playerId: string): Promise<Decoded[]> {
  const shape = giftShape();
  const best = capturedGifts();
  if (best.length === 0) return [];
  const values = best.map((g, i) => {
    const w = new Writer();
    encodeMessage(shape, g, w);
    return {
      id: randomUUID(),
      playerId,
      kind: GIFT_KIND,
      entityKey: String(g.GiftId),
      ordinal: i,
      blob: Buffer.from(w.toBytes()).toString('base64'),
    };
  });
  values.push({
    id: randomUUID(),
    playerId,
    kind: GIFT_SEED_MARKER,
    entityKey: '1',
    ordinal: 0,
    blob: '',
  } as (typeof values)[number]);
  await exec.insert(playerEntities).values(values);
  return best;
}

/**
 * Append `gifts` to the player's gift box, one `Gifts` row per gift, with
 * ordinals continuing after the current maximum. Returns the new GiftIds in
 * posting order.
 */
export async function postGifts(
  exec: Executor,
  playerId: string,
  gifts: Decoded[],
): Promise<string[]> {
  if (gifts.length === 0) return [];
  const [max] = await exec
    .select({ ordinal: playerEntities.ordinal })
    .from(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, GIFT_KIND)))
    .orderBy(desc(playerEntities.ordinal))
    .limit(1);
  let ordinal = Number(max?.ordinal ?? -1);
  const shape = giftShape();
  const values = gifts.map((g) => {
    const giftId = String(g.GiftId);
    const w = new Writer();
    encodeMessage(shape, g, w);
    return {
      id: randomUUID(),
      playerId,
      kind: GIFT_KIND,
      entityKey: giftId,
      ordinal: ++ordinal,
      blob: Buffer.from(w.toBytes()).toString('base64'),
    };
  });
  await exec.insert(playerEntities).values(values);
  return values.map((v) => v.entityKey);
}

/**
 * Post the official new-account gift set (`STARTER_GIFTS`) to the player's gift
 * box once. This is official-game behaviour (the official server posts it on the
 * first login); the sandbox keeps its captured gift-box seed (`seedGifts`). The
 * seed marker makes repeat calls (and a box emptied by `Gift:Receive`) no-ops.
 */
export async function postStarterGifts(
  exec: Executor,
  playerId: string,
  postedTime = Date.now(),
): Promise<boolean> {
  if (await isGiftSeeded(exec, playerId)) return false;
  // The official list is ordered by GiftId (all gifts share one PostedTime).
  const gifts = STARTER_GIFTS.map(
    (g) =>
      ({
        __msg: USER_GIFT_MSG,
        GiftId: randomUUID(),
        ResourceType: g.ResourceType,
        ...(g.ResourceId ? { ResourceId: g.ResourceId } : {}),
        Amount: g.Amount,
        Message: g.Message,
        PostedTime: postedTime,
      }) as Decoded,
  ).sort((a, b) => String(a.GiftId).localeCompare(String(b.GiftId)));
  await postGifts(exec, playerId, gifts);
  await exec.insert(playerEntities).values({
    id: randomUUID(),
    playerId,
    kind: GIFT_SEED_MARKER,
    entityKey: '1',
    ordinal: 0,
    blob: '',
  });
  return true;
}

/** Project a `UserGift` into the `UserGiftHistory` row shape. */
function toGiftHistory(gift: Decoded, receivedTime: number): Decoded {
  return {
    __msg: USER_GIFT_HISTORY_MSG,
    GiftId: String(gift.GiftId),
    ResourceType: Number(gift.ResourceType ?? 0),
    ...(gift.ResourceId != null && gift.ResourceId !== ''
      ? { ResourceId: String(gift.ResourceId) }
      : {}),
    Amount: Number(gift.Amount ?? 0),
    ...(gift.Message != null ? { Message: String(gift.Message) } : {}),
    PostedTime: Number(gift.PostedTime ?? 0),
    ReceivedTime: receivedTime,
    ...(gift.PhotoGift?.Name
      ? { PhotoGift: { __msg: PHOTO_GIFT_HISTORY_MSG, Name: String(gift.PhotoGift.Name) } }
      : {}),
  };
}

/**
 * Record received gifts in the player's gift history (`GiftHistory` rows, one
 * per GiftId). Called from `Gift:Receive` in the same transaction that deletes
 * the pending rows, so the history reflects exactly what was granted.
 */
async function recordGiftHistory(
  exec: Executor,
  playerId: string,
  gifts: Decoded[],
  receivedTime: number,
): Promise<void> {
  if (gifts.length === 0) return;
  const [max] = await exec
    .select({ ordinal: playerEntities.ordinal })
    .from(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, GIFT_HISTORY_KIND)))
    .orderBy(desc(playerEntities.ordinal))
    .limit(1);
  let ordinal = Number(max?.ordinal ?? -1);
  const shape = msgRegistry.get(USER_GIFT_HISTORY_MSG)!;
  const values = gifts.map((g) => {
    const entry = toGiftHistory(g, receivedTime);
    const w = new Writer();
    encodeMessage(shape, entry, w);
    return {
      id: randomUUID(),
      playerId,
      kind: GIFT_HISTORY_KIND,
      entityKey: String(entry.GiftId),
      ordinal: ++ordinal,
      blob: Buffer.from(w.toBytes()).toString('base64'),
    };
  });
  await exec.insert(playerEntities).values(values);
}

/** Load the player's gift history, newest first, capped at `HISTORY_LIMIT`. */
async function loadGiftHistory(exec: Executor, playerId: string): Promise<Decoded[]> {
  const rows = await exec
    .select()
    .from(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, GIFT_HISTORY_KIND)))
    .orderBy(desc(playerEntities.ordinal))
    .limit(HISTORY_LIMIT);
  const shape = msgRegistry.get(USER_GIFT_HISTORY_MSG)!;
  return rows.map((r) =>
    decodeMessage(shape, new Reader(Uint8Array.from(Buffer.from(r.blob, 'base64')))),
  );
}

/**
 * Turn received gifts into grants the way the official Gift:Receive reports
 * them (captures/2026-10-26_lesson_rate_official 00082): a costume also grants
 * its default hair (listed right after it), repeated resources merge into one
 * result, and results are grouped by resource type in ascending order.
 */
async function giftGrants(gifts: Decoded[]): Promise<Grant[]> {
  const merged = new Map<string, Grant>();
  const add = (g: Grant) => {
    const key = `${g.resourceType}|${g.resourceId}`;
    const hit = merged.get(key);
    if (hit) hit.amount += g.amount;
    else merged.set(key, { ...g });
  };
  for (const gift of gifts) {
    const grant: Grant = {
      resourceType: Number(gift.ResourceType ?? 0),
      resourceId: gift.ResourceId == null ? '' : String(gift.ResourceId),
      amount: Number(gift.Amount ?? 0),
    };
    add(grant);
    if (grant.resourceType === RES_COSTUME) {
      const hairId = (await getCostume(grant.resourceId))?.DefaultHairId;
      if (hairId) add({ resourceType: RES_HAIR, resourceId: hairId, amount: 1 });
    }
  }
  const rank = (t: number) => (t === RES_HAIR ? RES_COSTUME : t);
  return [...merged.values()].sort((a, b) => rank(a.resourceType) - rank(b.resourceType));
}

/**
 * Whether `Gift:List` would currently show at least one gift for this player.
 * Mirrors what Gift:List serves: the stored box if it has rows, an empty box
 * for a player whose seed ran but received everything, else the profile's seed
 * source — the starter set in official, the captured box in sandbox — with no
 * extra validity/expiry filter (Gift:List applies none). Does not seed as a
 * side effect.
 */
export async function hasReceivableGift(playerId: string, exec: Executor = db): Promise<boolean> {
  if ((await loadGifts(exec, playerId)).length > 0) return true;
  if (await isGiftSeeded(exec, playerId)) return false;
  return isSandbox() ? capturedGifts().length > 0 : STARTER_GIFTS.length > 0;
}

/**
 * `Gift:List` — serve the player's gift box. Official posts the starter set
 * once; sandbox keeps main's lazy captured-box seed.
 */
register(
  'Gift:List',
  async (ctx) => {
    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('Gift:List: unauthenticated');
    const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
    if (!pl) throw new Error('Gift:List: no player for account');

    const gifts = await withPlayerTx(pl.id, async (tx) => {
      if (isSandbox()) {
        const existing = await loadGifts(tx, pl.id);
        if (existing.length > 0) return existing;
        if (await isGiftSeeded(tx, pl.id)) return [];
        return seedGifts(tx, pl.id);
      }
      await postStarterGifts(tx, pl.id);
      return loadGifts(tx, pl.id);
    });

    ctx.fastifyReq.log.info(
      { accountId, serverUserId: pl.id, gifts: gifts.length },
      'gift list (server-authoritative)',
    );

    return {
      __msg: LIST_RESPONSE_MSG,
      Gifts: gifts,
      HasNext: false,
      Count: gifts.length,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: { __msg: UPDATED_DATA_MSG } as Decoded,
        DeletedData: { __msg: DELETED_DATA_MSG } as Decoded,
      },
    } as Decoded;
  },
  { ownsState: true },
);

/** `Gift:Receive` — grant the requested gifts once, then remove them. */
register(
  'Gift:Receive',
  async (ctx) => {
    const req = ctx.request;
    if (!req) throw new Error('Gift:Receive: missing request');
    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('Gift:Receive: unauthenticated');
    const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
    if (!pl) throw new Error('Gift:Receive: no player for account');

    const requested = [...new Set(((req.GiftIds as string[] | undefined) ?? []).map(String))];
    if (requested.length === 0) {
      return {
        __msg: RECEIVE_RESPONSE_MSG,
        Results: [],
        HasUnreceivedGift: false,
        ReceivedGiftIds: [],
        UnreceivedGiftIds: [],
        CommonResponse: {
          __msg: COMMON_RESPONSE_MSG,
          UpdatedData: { __msg: UPDATED_DATA_MSG } as Decoded,
          DeletedData: { __msg: DELETED_DATA_MSG } as Decoded,
        },
      } as Decoded;
    }

    const out = await withPlayerTx(pl.id, async (tx) => {
      const rows = await tx
        .select()
        .from(playerEntities)
        .where(
          and(
            eq(playerEntities.playerId, pl.id),
            eq(playerEntities.kind, GIFT_KIND),
            inArray(playerEntities.entityKey, requested),
          ),
        );
      const shape = giftShape();
      const byId = new Map<string, { entityKey: string; gift: Decoded }>();
      for (const r of rows) {
        byId.set(r.entityKey, {
          entityKey: r.entityKey,
          gift: decodeMessage(shape, new Reader(Uint8Array.from(Buffer.from(r.blob, 'base64')))),
        });
      }

      const gifts: Decoded[] = [];
      const received: string[] = [];
      const unreceived: string[] = [];
      for (const id of requested) {
        const hit = byId.get(id);
        if (!hit) {
          unreceived.push(id);
          continue;
        }
        gifts.push(hit.gift);
        received.push(id);
      }
      const grants = await giftGrants(gifts);

      if (received.length > 0) {
        await tx
          .delete(playerEntities)
          .where(
            and(
              eq(playerEntities.playerId, pl.id),
              eq(playerEntities.kind, GIFT_KIND),
              inArray(playerEntities.entityKey, received),
            ),
          );
        await recordGiftHistory(tx, pl.id, gifts, Date.now());
      }

      const applied = await applyGrants(pl.id, grants, tx);
      // The player columns are the single source of truth for stones: the grants
      // above already moved them, and `applyUpdatedData` re-reads them for fresh
      // accounts, so the stored Balance entity converges on the same value.
      await applyUpdatedData(pl.id, applied.updated, null, tx);
      const remaining = await loadGifts(tx, pl.id);

      // Clear the present-box badge once the box is empty. `Notifications` has
      // no identity key (positional `#N` rows), so rewrite the whole collection.
      let notification: Decoded | null = null;
      if (remaining.length === 0) {
        const notifications = await listElements(pl.id, NOTIFICATIONS_KIND, tx);
        const index = notifications.findIndex(
          (n) => Number(n.NotificationType) === GIFT_NOTIFICATION_TYPE,
        );
        if (index >= 0 && notifications[index]!.Valid) {
          notification = { ...notifications[index]!, Valid: false } as Decoded;
          notifications[index] = notification;
          await replaceElements(pl.id, NOTIFICATIONS_KIND, notifications, tx);
        }
      }

      return {
        applied,
        received,
        unreceived,
        remaining: remaining.length,
        notification,
      };
    });

    ctx.fastifyReq.log.info(
      { accountId, serverUserId: pl.id, received: out.received.length, granted: out.applied.results.length },
      'gift receive (server-authoritative)',
    );

    const updated: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
    if (out.applied.updated) {
      for (const [k, v] of Object.entries(out.applied.updated)) {
        if (k === '__msg' || k === '__unknown') continue;
        updated[k] = v as Decoded;
      }
    }
    if (out.notification) updated.Notifications = [out.notification];
    // Stones: serve the players columns as of response time, never a stale
    // projection of them.
    if (updated.Balance) updated.Balance = await readPlayerBalance(pl.id);

    return {
      __msg: RECEIVE_RESPONSE_MSG,
      Results: out.applied.results,
      HasUnreceivedGift: out.remaining > 0,
      ReceivedGiftIds: out.received,
      UnreceivedGiftIds: out.unreceived,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: updated,
        DeletedData: { __msg: DELETED_DATA_MSG } as Decoded,
      },
    } as Decoded;
  },
  { ownsState: true },
);

/**
 * `Gift:ListHistory` — serve the gifts this player has already received,
 * newest first. The captures contain no `Gift:ListHistory` exchange, so the
 * window is sumire's own choice: the last 100 entries, no expiry.
 */
register(
  'Gift:ListHistory',
  async (ctx) => {
    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('Gift:ListHistory: unauthenticated');
    const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
    if (!pl) throw new Error('Gift:ListHistory: no player for account');

    const gifts = await loadGiftHistory(db, pl.id);

    ctx.fastifyReq.log.info(
      { accountId, serverUserId: pl.id, gifts: gifts.length },
      'gift history (server-authoritative)',
    );

    return {
      __msg: HISTORY_RESPONSE_MSG,
      Gifts: gifts,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: { __msg: UPDATED_DATA_MSG } as Decoded,
        DeletedData: { __msg: DELETED_DATA_MSG } as Decoded,
      },
    } as Decoded;
  },
  { ownsState: true },
);
