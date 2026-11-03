import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { players, playerEntities } from '../db/schema.ts';
import { getCorpusResponses } from './replay/corpus.ts';
import { endpoints } from '@sumire-sr/protocol/gen/endpoints.ts';
import { applyGrants, type Grant } from '../master/reward.ts';
import { listElements, replaceElements } from './playerState.ts';
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
const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';
const USER_GIFT_MSG = 'Solis.Common.Proto.Transaction.UserGift';

const GIFT_KIND = 'Gifts';
const NOTIFICATIONS_KIND = 'Notifications';
/** `Solis.Common.Proto.NotificationType.Gift`. */
const GIFT_NOTIFICATION_TYPE = 3;
const GIFT_SEED_MARKER = 'GiftBoxSeeded';

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
 * Whether `Gift:List` would currently show at least one gift for this player.
 * Mirrors what Gift:List serves: the stored box if it has rows, an empty box
 * for a player whose seed ran but received everything, else the capture seed
 * (`capturedGifts`, with no extra validity/expiry filter — Gift:List applies
 * none). Does not seed as a side effect.
 */
export async function hasReceivableGift(playerId: string, exec: Executor = db): Promise<boolean> {
  if ((await loadGifts(exec, playerId)).length > 0) return true;
  if (await isGiftSeeded(exec, playerId)) return false;
  return capturedGifts().length > 0;
}

/** `Gift:List` — serve the player's gift box (lazily seeded from the capture). */
register(
  'Gift:List',
  async (ctx) => {
    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('Gift:List: unauthenticated');
    const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
    if (!pl) throw new Error('Gift:List: no player for account');

    const gifts = await withPlayerTx(pl.id, async (tx) => {
      const existing = await loadGifts(tx, pl.id);
      if (existing.length > 0) return existing;
      if (await isGiftSeeded(tx, pl.id)) return [];
      return seedGifts(tx, pl.id);
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

    const requested = ((req.GiftIds as string[] | undefined) ?? []).map(String);
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

      const grants: Grant[] = [];
      const received: string[] = [];
      const unreceived: string[] = [];
      for (const id of requested) {
        const hit = byId.get(id);
        if (!hit) {
          unreceived.push(id);
          continue;
        }
        grants.push({
          resourceType: Number(hit.gift.ResourceType ?? 0),
          resourceId: hit.gift.ResourceId == null ? '' : String(hit.gift.ResourceId),
          amount: Number(hit.gift.Amount ?? 0),
        });
        received.push(id);
      }

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
      }

      const applied = await applyGrants(pl.id, grants, tx);
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
