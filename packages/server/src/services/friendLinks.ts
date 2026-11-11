import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import type { Executor } from '../db/tx.ts';
import { accounts, players, playerFriendLinks } from '../db/schema.ts';
import { getSingleton, listElements } from './playerState.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/** Server limits. The official values are unknown; these are this server's own. */
export const FRIEND_LIMIT = 50;
export const FRIEND_OFFER_LIMIT = 50;

export type PlayerRow = typeof players.$inferSelect;
export type FriendTarget = { player: PlayerRow; isBanned: boolean; isDeleted: boolean };

const PROFILE_INFO_MSG = 'Solis.Common.Proto.Api.ProfileInfo';
const FAVORITE_CARD_INFO_MSG = 'Solis.Common.Proto.Api.FavoriteCardInfo';
const FAVORITE_PHOTO_INFO_MSG = 'Solis.Common.Proto.Api.FavoritePhotoInfo';
const BUDDY_CARD_INFO_MSG = 'Solis.Common.Proto.Api.BuddyCardInfo';

/** The public user id a player advertises, falling back to its server id. */
export function publicUserIdOf(pl: PlayerRow): string {
  return String((pl.data as { publicUserId?: string } | null)?.publicUserId ?? '') || pl.id;
}

/** Resolve a public user id or server user id to a player and its account flags. */
export async function findFriendTarget(
  userId: string,
  exec: Executor = db,
): Promise<FriendTarget | null> {
  if (!userId) return null;
  const [row] = await exec
    .select({ player: players, account: accounts })
    .from(players)
    .innerJoin(accounts, eq(accounts.id, players.accountId))
    .where(or(eq(players.id, userId), sql`${players.data}->>'publicUserId' = ${userId}`))
    .limit(1);
  if (!row) return null;
  return {
    player: row.player,
    isBanned: row.account.isBanned,
    isDeleted: row.account.deletedAt != null,
  };
}

/** Accepted friends of a player, in either direction. */
export async function friendIds(playerId: string, exec: Executor = db): Promise<string[]> {
  const rows = await exec
    .select()
    .from(playerFriendLinks)
    .where(
      and(
        eq(playerFriendLinks.status, 'friend'),
        or(
          eq(playerFriendLinks.fromPlayerId, playerId),
          eq(playerFriendLinks.toPlayerId, playerId),
        ),
      ),
    );
  return rows.map((r) => (r.fromPlayerId === playerId ? r.toPlayerId : r.fromPlayerId));
}

/** Pending requests sent by a player. */
export async function outgoingIds(playerId: string, exec: Executor = db): Promise<string[]> {
  const rows = await exec
    .select()
    .from(playerFriendLinks)
    .where(
      and(
        eq(playerFriendLinks.status, 'pending'),
        eq(playerFriendLinks.fromPlayerId, playerId),
      ),
    );
  return rows.map((r) => r.toPlayerId);
}

/** Pending requests received by a player. */
export async function incomingIds(playerId: string, exec: Executor = db): Promise<string[]> {
  const rows = await exec
    .select()
    .from(playerFriendLinks)
    .where(
      and(
        eq(playerFriendLinks.status, 'pending'),
        eq(playerFriendLinks.toPlayerId, playerId),
      ),
    );
  return rows.map((r) => r.fromPlayerId);
}

/** Number of pending requests received by a player. */
export async function countIncoming(playerId: string, exec: Executor = db): Promise<number> {
  return (await incomingIds(playerId, exec)).length;
}

/** The single link between two players, in either direction. */
export async function linkBetween(a: string, b: string, exec: Executor = db) {
  const [row] = await exec
    .select()
    .from(playerFriendLinks)
    .where(
      or(
        and(eq(playerFriendLinks.fromPlayerId, a), eq(playerFriendLinks.toPlayerId, b)),
        and(eq(playerFriendLinks.fromPlayerId, b), eq(playerFriendLinks.toPlayerId, a)),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertPending(fromId: string, toId: string, exec: Executor = db): Promise<void> {
  await exec
    .insert(playerFriendLinks)
    .values({ fromPlayerId: fromId, toPlayerId: toId, status: 'pending' });
}

export async function markFriend(fromId: string, toId: string, exec: Executor = db): Promise<void> {
  await exec
    .update(playerFriendLinks)
    .set({ status: 'friend' })
    .where(
      and(
        eq(playerFriendLinks.fromPlayerId, fromId),
        eq(playerFriendLinks.toPlayerId, toId),
      ),
    );
}

/** Delete the link with exactly that direction; returns the number of rows removed. */
export async function deleteLink(fromId: string, toId: string, exec: Executor = db): Promise<number> {
  const rows = await exec
    .delete(playerFriendLinks)
    .where(
      and(
        eq(playerFriendLinks.fromPlayerId, fromId),
        eq(playerFriendLinks.toPlayerId, toId),
      ),
    )
    .returning();
  return rows.length;
}

/** Delete an accepted friendship between two players, in either direction. */
export async function deleteFriendship(a: string, b: string, exec: Executor = db): Promise<void> {
  await exec
    .delete(playerFriendLinks)
    .where(
      and(
        eq(playerFriendLinks.status, 'friend'),
        or(
          and(eq(playerFriendLinks.fromPlayerId, a), eq(playerFriendLinks.toPlayerId, b)),
          and(eq(playerFriendLinks.fromPlayerId, b), eq(playerFriendLinks.toPlayerId, a)),
        ),
      ),
    );
}

/** Delete every pending request a player sent. */
export async function deleteAllOutgoing(playerId: string, exec: Executor = db): Promise<void> {
  await exec
    .delete(playerFriendLinks)
    .where(
      and(
        eq(playerFriendLinks.status, 'pending'),
        eq(playerFriendLinks.fromPlayerId, playerId),
      ),
    );
}

/** ProfileInfo entries for the given players, skipping deleted accounts. */
/**
 * The favourite card, favourite photo and buddy card shown on a player's
 * business card, resolved from the ids stored on `Profile` / `User` against
 * the player's own `Cards` and `Photos`. An unset or no-longer-owned id gives
 * an empty info message.
 */
export async function profileShowpieces(
  playerId: string,
  user: Decoded | null,
  profile: Decoded | null,
  exec: Executor = db,
): Promise<{ FavoriteCard: Decoded; FavoritePhoto: Decoded; BuddyCardInfo: Decoded }> {
  const favoriteCardId = String(profile?.FavoriteCardId ?? '');
  const favoritePhotoId = String(profile?.FavoritePhotoId ?? '');
  const buddyCardId = String(user?.BuddyCardId ?? '');

  const cards = favoriteCardId || buddyCardId ? await listElements(playerId, 'Cards', exec) : [];
  const cardById = (id: string) => (id ? cards.find((c) => String(c.CardId ?? '') === id) : undefined);
  const photo = favoritePhotoId
    ? (await listElements(playerId, 'Photos', exec)).find((p) => String(p.PhotoId ?? '') === favoritePhotoId)
    : undefined;

  const favoriteCard = cardById(favoriteCardId);
  const buddyCard = cardById(buddyCardId);
  return {
    FavoriteCard: (favoriteCard
      ? {
          __msg: FAVORITE_CARD_INFO_MSG,
          CardId: favoriteCardId,
          Rarity: Number(favoriteCard.Rarity ?? 0),
          DisplayType: Number(profile?.FavoriteCardDisplayType ?? favoriteCard.DisplayType ?? 0),
          EvolutionLevel: Number(favoriteCard.EvolutionLevel ?? 0),
        }
      : { __msg: FAVORITE_CARD_INFO_MSG }) as Decoded,
    FavoritePhoto: (photo
      ? {
          __msg: FAVORITE_PHOTO_INFO_MSG,
          PhotoId: favoritePhotoId,
          AssetId: String(photo.AssetId ?? ''),
          ImageType: Number(photo.ImageType ?? 0),
        }
      : { __msg: FAVORITE_PHOTO_INFO_MSG }) as Decoded,
    BuddyCardInfo: (buddyCard
      ? {
          __msg: BUDDY_CARD_INFO_MSG,
          CardId: buddyCardId,
          Rarity: Number(buddyCard.Rarity ?? 0),
          Level: Number(buddyCard.Level ?? 0),
          EvolutionLevel: Number(buddyCard.EvolutionLevel ?? 0),
        }
      : { __msg: BUDDY_CARD_INFO_MSG }) as Decoded,
  };
}

export async function profileInfosFor(
  playerIds: string[],
  exec: Executor = db,
): Promise<Decoded[]> {
  if (playerIds.length === 0) return [];
  const rows = await exec
    .select({ player: players, account: accounts })
    .from(players)
    .innerJoin(accounts, eq(accounts.id, players.accountId))
    .where(inArray(players.id, playerIds));

  const byId = new Map(
    rows.filter((r) => r.account.deletedAt == null).map((r) => [r.player.id, r] as const),
  );
  const out: Decoded[] = [];
  for (const id of playerIds) {
    const row = byId.get(id);
    if (!row) continue;
    const pl = row.player;
    const account = row.account;
    const user = await getSingleton(pl.id, 'User', exec);
    const profile = await getSingleton(pl.id, 'Profile', exec);
    const showpieces = await profileShowpieces(pl.id, user, profile, exec);
    out.push({
      __msg: PROFILE_INFO_MSG,
      UserId: publicUserIdOf(pl),
      Name: pl.name,
      ManagerExp: pl.exp,
      ManagerLevel: pl.level,
      EmblemId: String(user?.EmblemId ?? ''),
      FavoriteCard: showpieces.FavoriteCard,
      FavoritePhoto: showpieces.FavoritePhoto,
      FavoriteCharacterIds: (profile?.FavoriteCharacterIds as string[] | undefined) ?? [],
      BackgroundType: Number(profile?.BackgroundType ?? 0),
      LayoutType: Number(profile?.LayoutType ?? 0),
      LastLoginTime: account.lastLoginAt ? account.lastLoginAt.getTime() : 0,
      DecorationId: String(profile?.DecorationId ?? ''),
      InformationType: Number(profile?.InformationType ?? 0),
      ColorType: Number(profile?.ColorType ?? 0),
      BuddyCardInfo: showpieces.BuddyCardInfo,
    } as Decoded);
  }
  return out;
}
