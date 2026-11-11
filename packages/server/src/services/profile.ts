import { eq, or, sql } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import { getSingleton, listElements, putSingleton } from './playerState.ts';
import { getLowestHierarchyDetailGrade } from '../master/index.ts';
import { type Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { isSandbox } from '../profile.ts';
import { birthdayBadRequest, loadReconciledBirthday } from './birthday.ts';
import { birthdayClock, isValidBirthDate, nextAdv, reminder } from './birthdayLogic.ts';
import { SANDBOX_HIERARCHY_DETAIL_GRADE_ID, SANDBOX_HIERARCHY_RANK } from '../profiles/sandbox/hierarchy.ts';
import { GRPC_STATUS, RpcError } from './errors.ts';
import { friendIds, profileInfosFor, profileShowpieces } from './friendLinks.ts';

/**
 * Server-authoritative profile customization / equip.
 *
 * The editable profile surface lives in two singletons of the `User:Get`
 * response: `Profile` (`Solis.Common.Proto.Transaction.UserProfile`) holds the
 * message, background, favorite characters, decoration, layout and birthday;
 * `User` (`Solis.Common.Proto.Transaction.User`) holds the player name, emblem
 * and buddy card. Ownership of every referenced asset is checked against the
 * player's collections (`Photos`, `Decorations`, `Emblems`, `Characters`,
 * `Cards`); an empty id clears the slot.
 *
 * None of these endpoints were captured, so they are built from the generated
 * schema and validated with `dbtest.ts` only (no byte-exact verification).
 */

const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';
const PROFILE_MSG = 'Solis.Common.Proto.Transaction.UserProfile';
const USER_MSG = 'Solis.Common.Proto.Transaction.User';
const FIND_USER_RESPONSE_MSG = 'Solis.Common.Proto.Api.ProfileFindUserResponse';

async function playerForAccount(accountId: string, rpc: string, exec: Executor = db) {
  const [pl] = await exec.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  if (!pl) throw new Error(`${rpc}: no player for account`);
  return pl;
}

function commonResponse(updated: Decoded | null, deleted: Decoded | null = null): Decoded {
  return {
    __msg: COMMON_RESPONSE_MSG,
    UpdatedData: (updated ?? { __msg: UPDATED_DATA_MSG }) as Decoded,
    DeletedData: (deleted ?? { __msg: DELETED_DATA_MSG }) as Decoded,
  } as Decoded;
}

function updatedData(...entries: Array<[string, unknown]>): Decoded {
  const out: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
  for (const [k, v] of entries) {
    if (v !== undefined && v !== null) out[k] = v as Decoded;
  }
  return out;
}

/** Run a profile mutation inside a row-locked transaction and wrap the result. */
async function runProfile(
  accountId: string,
  rpc: string,
  fn: (tx: Executor, playerId: string) => Promise<Decoded>,
): Promise<Decoded> {
  const pl = await playerForAccount(accountId, rpc);
  const updated = await withPlayerTx(pl.id, (tx) => fn(tx, pl.id));
  return { __msg: '', CommonResponse: commonResponse(updated) } as Decoded;
}

async function loadProfile(exec: Executor, playerId: string): Promise<Decoded> {
  return (await getSingleton(playerId, 'Profile', exec)) ?? ({ __msg: PROFILE_MSG } as Decoded);
}

async function loadUser(exec: Executor, playerId: string): Promise<Decoded> {
  return (await getSingleton(playerId, 'User', exec)) ?? ({ __msg: USER_MSG } as Decoded);
}

/** Ownership set for a collection, keyed by the given field. */
async function ownedIds(
  exec: Executor,
  playerId: string,
  field: string,
  key: string,
): Promise<Set<string>> {
  const els = (await listElements(playerId, field, exec)) as Decoded[];
  return new Set(els.map((e) => String(e[key] ?? '')).filter(Boolean));
}

/** Validate that a non-empty referenced id is owned; empty id clears the slot. */
function assertOwned(set: Set<string>, id: string, rpc: string, label: string): void {
  if (id && !set.has(id)) throw new Error(`${rpc}: ${label} ${id} not owned`);
}

function accountOf(ctx: { auth: { ok: boolean; claims?: { sub?: string } } }): string {
  const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
  if (!accountId) throw new Error('unauthenticated');
  return accountId;
}

register(
  'Profile:UpdateName',
  (ctx) => {
    const accountId = accountOf(ctx);
    const name = ctx.request?.Name != null ? String(ctx.request.Name) : '';
    if (!name) throw new Error('Profile:UpdateName: missing Name');
    return runProfile(accountId, 'Profile:UpdateName', async (tx, playerId) => {
      const user = await loadUser(tx, playerId);
      user.Name = name;
      await putSingleton(playerId, 'User', user, tx);
      await tx.update(players).set({ name }).where(eq(players.id, playerId));
      return updatedData(['User', user]);
    });
  },
  { ownsState: true },
);

register(
  'Profile:UpdateMessage',
  (ctx) => {
    const accountId = accountOf(ctx);
    const message = ctx.request?.Message != null ? String(ctx.request.Message) : '';
    return runProfile(accountId, 'Profile:UpdateMessage', async (tx, playerId) => {
      const profile = await loadProfile(tx, playerId);
      profile.Message = message;
      await putSingleton(playerId, 'Profile', profile, tx);
      return updatedData(['Profile', profile]);
    });
  },
  { ownsState: true },
);

register(
  'Profile:UpdateBackground',
  (ctx) => {
    const accountId = accountOf(ctx);
    const req = ctx.request;
    return runProfile(accountId, 'Profile:UpdateBackground', async (tx, playerId) => {
      const profile = await loadProfile(tx, playerId);
      if (req?.BackgroundType != null) profile.BackgroundType = Number(req.BackgroundType);
      if (req?.FavoriteCardDisplayType != null) {
        profile.FavoriteCardDisplayType = Number(req.FavoriteCardDisplayType);
      }
      if (req?.FavoriteCardId !== undefined) {
        const id = String(req.FavoriteCardId ?? '');
        assertOwned(await ownedIds(tx, playerId, 'Cards', 'CardId'), id, 'Profile:UpdateBackground', 'card');
        profile.FavoriteCardId = id;
      }
      if (req?.FavoritePhotoId !== undefined) {
        const id = String(req.FavoritePhotoId ?? '');
        assertOwned(await ownedIds(tx, playerId, 'Photos', 'PhotoId'), id, 'Profile:UpdateBackground', 'photo');
        profile.FavoritePhotoId = id;
      }
      await putSingleton(playerId, 'Profile', profile, tx);
      return updatedData(['Profile', profile]);
    });
  },
  { ownsState: true },
);

register(
  'Profile:UpdateFavoriteCharacters',
  (ctx) => {
    const accountId = accountOf(ctx);
    return runProfile(accountId, 'Profile:UpdateFavoriteCharacters', async (tx, playerId) => {
      const ids = ((ctx.request?.FavoriteCharacterIds as unknown[] | undefined) ?? [])
        .map((v) => String(v))
        .filter(Boolean);
      const owned = await ownedIds(tx, playerId, 'Characters', 'CharacterId');
      for (const id of ids) assertOwned(owned, id, 'Profile:UpdateFavoriteCharacters', 'character');
      const profile = await loadProfile(tx, playerId);
      profile.FavoriteCharacterIds = ids;
      await putSingleton(playerId, 'Profile', profile, tx);
      return updatedData(['Profile', profile]);
    });
  },
  { ownsState: true },
);

register(
  'Profile:UpdateDecoration',
  (ctx) => {
    const accountId = accountOf(ctx);
    const id = ctx.request?.DecorationId != null ? String(ctx.request.DecorationId) : '';
    return runProfile(accountId, 'Profile:UpdateDecoration', async (tx, playerId) => {
      assertOwned(await ownedIds(tx, playerId, 'Decorations', 'DecorationId'), id, 'Profile:UpdateDecoration', 'decoration');
      const profile = await loadProfile(tx, playerId);
      profile.DecorationId = id;
      await putSingleton(playerId, 'Profile', profile, tx);
      return updatedData(['Profile', profile]);
    });
  },
  { ownsState: true },
);

register(
  'Profile:UpdateEmblem',
  (ctx) => {
    const accountId = accountOf(ctx);
    const id = ctx.request?.EmblemId != null ? String(ctx.request.EmblemId) : '';
    return runProfile(accountId, 'Profile:UpdateEmblem', async (tx, playerId) => {
      assertOwned(await ownedIds(tx, playerId, 'Emblems', 'EmblemId'), id, 'Profile:UpdateEmblem', 'emblem');
      const user = await loadUser(tx, playerId);
      user.EmblemId = id;
      await putSingleton(playerId, 'User', user, tx);
      return updatedData(['User', user]);
    });
  },
  { ownsState: true },
);

register(
  'Profile:UpdateLayout',
  (ctx) => {
    const accountId = accountOf(ctx);
    const req = ctx.request;
    return runProfile(accountId, 'Profile:UpdateLayout', async (tx, playerId) => {
      const profile = await loadProfile(tx, playerId);
      if (req?.LayoutType != null) profile.LayoutType = Number(req.LayoutType);
      if (req?.InformationType != null) profile.InformationType = Number(req.InformationType);
      if (req?.ColorType != null) profile.ColorType = Number(req.ColorType);
      await putSingleton(playerId, 'Profile', profile, tx);
      return updatedData(['Profile', profile]);
    });
  },
  { ownsState: true },
);

register(
  'Profile:UpdateBuddyCard',
  (ctx) => {
    const accountId = accountOf(ctx);
    const id = ctx.request?.CardId != null ? String(ctx.request.CardId) : '';
    return runProfile(accountId, 'Profile:UpdateBuddyCard', async (tx, playerId) => {
      assertOwned(await ownedIds(tx, playerId, 'Cards', 'CardId'), id, 'Profile:UpdateBuddyCard', 'card');
      const user = await loadUser(tx, playerId);
      user.BuddyCardId = id;
      await putSingleton(playerId, 'User', user, tx);
      return updatedData(['User', user]);
    });
  },
  { ownsState: true },
);

register(
  'Profile:UpdateBirthday',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const month = ctx.request?.Month != null ? Number(ctx.request.Month) : 0;
    const day = ctx.request?.Day != null ? Number(ctx.request.Day) : 0;
    const pl = await playerForAccount(accountId, 'Profile:UpdateBirthday');
    return withPlayerTx(pl.id, async (tx) => {
      if (!isValidBirthDate(month, day)) birthdayBadRequest('invalid birth date');
      const profile = await loadProfile(tx, pl.id);
      if (Number(profile.BirthMonth ?? 0) !== 0 || Number(profile.BirthDay ?? 0) !== 0) {
        birthdayBadRequest('birthday has already been set');
      }
      profile.BirthMonth = month;
      profile.BirthDay = day;
      await putSingleton(pl.id, 'Profile', profile, tx);

      const now = birthdayClock();
      const { state, month: m, day: d } = await loadReconciledBirthday(pl.id, tx, now);
      const adv = nextAdv(state, m, d, now);
      const remind = reminder(state, m, d, now);
      return {
        __msg: '',
        ...(adv ? { BirthdayAdvInfo: adv } : {}),
        ...(remind ? { BirthdayRemindInfo: remind } : {}),
        CommonResponse: commonResponse(updatedData(['Profile', profile])),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/**
 * Hierarchy grade and rank shown on a profile. The player has no stored
 * grade/rank: report the lowest master detail grade and rank 0, or the fixed
 * sandbox grade and rank in the sandbox profile.
 */
async function currentHierarchy(rpc: string): Promise<{ gradeId: string; rank: number }> {
  let gradeId = SANDBOX_HIERARCHY_DETAIL_GRADE_ID;
  let rank = SANDBOX_HIERARCHY_RANK;
  if (!isSandbox()) {
    const grade = await getLowestHierarchyDetailGrade();
    if (!grade) throw new Error(`${rpc}: no hierarchy detail grade master data`);
    gradeId = String(grade.Id);
    rank = 0;
  }
  return { gradeId, rank };
}

/**
 * `Profile:Top` — business card (profile) screen.
 *
 * The player has no stored hierarchy grade/rank, so report the lowest master
 * detail grade (where a fresh player starts) and rank 0. The sandbox shows
 * every player at BIG4 instead. `FriendProfiles` is the player's friend list.
 */
register(
  'Profile:Top',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const me = await playerForAccount(accountId, 'Profile:Top');
    const { gradeId, rank } = await currentHierarchy('Profile:Top');
    return {
      __msg: '',
      HierarchyCurrentDetailGradeId: gradeId,
      HierarchyCurrentRank: rank,
      // The friend page is drawn from this list, not from `Friend:List`.
      FriendProfiles: await profileInfosFor(await friendIds(me.id)),
      CommonResponse: commonResponse(null),
    } as Decoded;
  },
  { ownsState: true },
);

/**
 * `Profile:FindUser` — user search on the profile screen.
 *
 * Finds any player on this server by public user id or server user id. The
 * client shows its own message when the result is the caller. An id that
 * matches nobody gets a default (empty) profile with a `CommonResponse`, which
 * the client shows as "no matching user"; an error would not take that path
 * (solis-server profile/find_user.go, which only ever finds the caller).
 */
register(
  'Profile:FindUser',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const userId = ctx.request?.UserId ? String(ctx.request.UserId) : '';
    if (!userId) throw new RpcError('Profile:FindUser: userId is required', GRPC_STATUS.INVALID_ARGUMENT);
    await playerForAccount(accountId, 'Profile:FindUser');
    const [pl] = await db
      .select()
      .from(players)
      .where(or(eq(players.id, userId), sql`${players.data}->>'publicUserId' = ${userId}`))
      .limit(1);
    if (!pl) {
      return { __msg: FIND_USER_RESPONSE_MSG, CommonResponse: commonResponse(null) } as Decoded;
    }
    const user = await loadUser(db, pl.id);
    const profile = await loadProfile(db, pl.id);
    const { gradeId, rank } = await currentHierarchy('Profile:FindUser');
    const showpieces = await profileShowpieces(pl.id, user, profile);
    return {
      __msg: FIND_USER_RESPONSE_MSG,
      UserId: pl.id,
      // Player-row scalars are authoritative over the stored `User` blob, as
      // in `User:Get`.
      Name: pl.name,
      ManagerExp: pl.exp,
      ManagerLevel: pl.level,
      DivisionId: String(user.DivisionId ?? ''),
      GuildId: String(user.GuildId ?? ''),
      EmblemId: String(user.EmblemId ?? ''),
      FavoriteCard: showpieces.FavoriteCard,
      FavoritePhoto: showpieces.FavoritePhoto,
      FavoriteCharacterIds: (profile.FavoriteCharacterIds as string[] | undefined) ?? [],
      Message: String(profile.Message ?? ''),
      BirthMonth: Number(profile.BirthMonth ?? 0),
      BirthDay: Number(profile.BirthDay ?? 0),
      BackgroundType: Number(profile.BackgroundType ?? 0),
      LayoutType: Number(profile.LayoutType ?? 0),
      HierarchyCurrentDetailGradeId: gradeId,
      HierarchyCurrentRank: rank,
      DecorationId: String(profile.DecorationId ?? ''),
      InformationType: Number(profile.InformationType ?? 0),
      ColorType: Number(profile.ColorType ?? 0),
      CommonResponse: commonResponse(null),
    } as Decoded;
  },
  { ownsState: true },
);
