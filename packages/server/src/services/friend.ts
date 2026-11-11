/**
 * Friend service: requests and friendships between players on this server.
 *
 * The solis-server reference only stubs these RPCs, so the behaviour here is
 * built from the generated schema: each response flag is set for the case its
 * name describes. `UserId` in requests may be a public user id or a server
 * user id. `Friend:Search` (suggested users) stays an empty list.
 */
import { eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import { GRPC_STATUS, RpcError } from './errors.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import {
  FRIEND_LIMIT,
  FRIEND_OFFER_LIMIT,
  deleteAllOutgoing,
  deleteFriendship,
  deleteLink,
  findFriendTarget,
  friendIds,
  incomingIds,
  insertPending,
  linkBetween,
  markFriend,
  outgoingIds,
  profileInfosFor,
} from './friendLinks.ts';

function commonResponse(): Decoded {
  return {
    __msg: 'Solis.Common.Proto.Api.CommonResponse',
    UpdatedData: { __msg: 'Solis.Common.Proto.Api.UpdatedData' },
    DeletedData: { __msg: 'Solis.Common.Proto.Api.DeletedData' },
  } as Decoded;
}

function baseResponse(): Decoded {
  return { __msg: '', CommonResponse: commonResponse() } as Decoded;
}

function accountOf(
  ctx: { auth: { ok: boolean; claims?: { sub?: string } } },
  rpc: string,
): string {
  const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
  if (!accountId) throw new Error(`${rpc}: unauthenticated`);
  return accountId;
}

async function playerForAccount(accountId: string, rpc: string) {
  const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  if (!pl) throw new Error(`${rpc}: no player for account`);
  return pl;
}

function requestUserId(ctx: { request?: Decoded | null }, rpc: string): string {
  const userId = ctx.request?.UserId ? String(ctx.request.UserId) : '';
  if (!userId) throw new RpcError(`${rpc}: userId is required`, GRPC_STATUS.INVALID_ARGUMENT);
  return userId;
}

register(
  'Friend:List',
  async (ctx) => {
    const me = await playerForAccount(accountOf(ctx, 'Friend:List'), 'Friend:List');
    return {
      ...baseResponse(),
      Profiles: await profileInfosFor(await friendIds(me.id)),
    } as Decoded;
  },
  { ownsState: true },
);

register(
  'Friend:ListApplying',
  async (ctx) => {
    const me = await playerForAccount(accountOf(ctx, 'Friend:ListApplying'), 'Friend:ListApplying');
    return {
      ...baseResponse(),
      Profiles: await profileInfosFor(await outgoingIds(me.id)),
    } as Decoded;
  },
  { ownsState: true },
);

register(
  'Friend:ListApplied',
  async (ctx) => {
    const me = await playerForAccount(accountOf(ctx, 'Friend:ListApplied'), 'Friend:ListApplied');
    return {
      ...baseResponse(),
      Profiles: await profileInfosFor(await incomingIds(me.id)),
    } as Decoded;
  },
  { ownsState: true },
);

register('Friend:Search', () => ({ ...baseResponse(), Profiles: [] }) as Decoded, {
  ownsState: true,
});

register(
  'Friend:Apply',
  async (ctx) => {
    const me = await playerForAccount(accountOf(ctx, 'Friend:Apply'), 'Friend:Apply');
    const userId = requestUserId(ctx, 'Friend:Apply');
    return withPlayerTx(me.id, async (tx) => {
      const target = await findFriendTarget(userId, tx);
      if (!target || target.isDeleted || target.player.id === me.id) {
        return { ...baseResponse(), IsAccountDeleted: true } as Decoded;
      }
      if (target.isBanned) return { ...baseResponse(), IsAccountBan: true } as Decoded;

      const link = await linkBetween(me.id, target.player.id, tx);
      if (link && link.status === 'friend') {
        return { ...baseResponse(), IsAlreadyFriend: true } as Decoded;
      }
      if (link && link.status === 'pending' && link.fromPlayerId === me.id) {
        return { ...baseResponse(), IsAlreadyOffering: true } as Decoded;
      }
      if (link && link.status === 'pending' && link.fromPlayerId === target.player.id) {
        return { ...baseResponse(), IsAlreadyOffered: true } as Decoded;
      }
      if ((await incomingIds(target.player.id, tx)).length >= FRIEND_OFFER_LIMIT) {
        return { ...baseResponse(), IsTargetOfferedLimit: true } as Decoded;
      }

      await insertPending(me.id, target.player.id, tx);
      return { ...baseResponse(), Applied: true } as Decoded;
    });
  },
  { ownsState: true },
);

register(
  'Friend:Approve',
  async (ctx) => {
    const me = await playerForAccount(accountOf(ctx, 'Friend:Approve'), 'Friend:Approve');
    const userId = requestUserId(ctx, 'Friend:Approve');
    return withPlayerTx(me.id, async (tx) => {
      const target = await findFriendTarget(userId, tx);
      if (!target || target.isDeleted) {
        return { ...baseResponse(), IsAccountDeleted: true } as Decoded;
      }
      if (target.isBanned) return { ...baseResponse(), IsAccountBan: true } as Decoded;

      const link = await linkBetween(me.id, target.player.id, tx);
      if (!(link && link.status === 'pending' && link.fromPlayerId === target.player.id)) {
        return { ...baseResponse(), IsOfferDeleted: true } as Decoded;
      }
      if ((await friendIds(me.id, tx)).length >= FRIEND_LIMIT) {
        return { ...baseResponse(), IsFriendLimit: true } as Decoded;
      }
      if ((await friendIds(target.player.id, tx)).length >= FRIEND_LIMIT) {
        return { ...baseResponse(), IsTargetFriendLimit: true } as Decoded;
      }

      await markFriend(target.player.id, me.id, tx);
      return { ...baseResponse(), Approved: true } as Decoded;
    });
  },
  { ownsState: true },
);

register(
  'Friend:Reject',
  async (ctx) => {
    const me = await playerForAccount(accountOf(ctx, 'Friend:Reject'), 'Friend:Reject');
    const userId = requestUserId(ctx, 'Friend:Reject');
    return withPlayerTx(me.id, async (tx) => {
      const target = await findFriendTarget(userId, tx);
      let removed = 0;
      if (target) {
        const link = await linkBetween(me.id, target.player.id, tx);
        if (link && link.status === 'pending') {
          removed = await deleteLink(target.player.id, me.id, tx);
        }
      }
      return { ...baseResponse(), IsOfferDeleted: removed === 0 } as Decoded;
    });
  },
  { ownsState: true },
);

register(
  'Friend:Cancel',
  async (ctx) => {
    const me = await playerForAccount(accountOf(ctx, 'Friend:Cancel'), 'Friend:Cancel');
    const userId = requestUserId(ctx, 'Friend:Cancel');
    return withPlayerTx(me.id, async (tx) => {
      const target = await findFriendTarget(userId, tx);
      if (target) {
        const link = await linkBetween(me.id, target.player.id, tx);
        if (link && link.status === 'pending' && link.fromPlayerId === me.id) {
          await deleteLink(me.id, target.player.id, tx);
        }
      }
      return baseResponse();
    });
  },
  { ownsState: true },
);

register(
  'Friend:CancelAll',
  async (ctx) => {
    const me = await playerForAccount(accountOf(ctx, 'Friend:CancelAll'), 'Friend:CancelAll');
    await withPlayerTx(me.id, async (tx) => {
      await deleteAllOutgoing(me.id, tx);
    });
    return baseResponse();
  },
  { ownsState: true },
);

register(
  'Friend:Delete',
  async (ctx) => {
    const me = await playerForAccount(accountOf(ctx, 'Friend:Delete'), 'Friend:Delete');
    const ids = Array.isArray(ctx.request?.UserIds)
      ? (ctx.request.UserIds as unknown[]).map(String)
      : [];
    await withPlayerTx(me.id, async (tx) => {
      for (const id of ids) {
        const target = await findFriendTarget(id, tx);
        if (target) await deleteFriendship(me.id, target.player.id, tx);
      }
    });
    return baseResponse();
  },
  { ownsState: true },
);
