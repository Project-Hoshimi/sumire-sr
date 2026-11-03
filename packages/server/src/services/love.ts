import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import type { RpcContext } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { players, playerLoveProgress, type LoveSaveSlot } from '../db/schema.ts';
import { claimOnce } from '../db/claims.ts';
import {
  getCharacter,
  getItem,
  getLoveLevel,
  getLoveStoryEpisode,
  getStory,
  listLoveIds,
  listLoveLevels,
  listLoveStoryEpisodes,
  listLoveHomeActions,
} from '../master/index.ts';
import { applyRewardRefs } from '../master/reward.ts';
import { getItemAmount, grantItem, spendItem } from './inventory.ts';
import { listElements, putElements } from './playerState.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * もし恋 (Love ADV) — native implementation.
 *
 * The ADV is linear from the server's point of view: choice/branch data lives
 * inside the CDN ADV asset (`love_*`), so Start/Restart return empty choice and
 * branch lists. The server is authoritative for:
 *  - the `Loves` collection (`UserLove`: unlocked endings + hidden favorability
 *    + reading flag),
 *  - per-love lesson exp / protagonist name (`player_love_progress`),
 *  - story completion rewards (granted once per episode).
 */

const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';
const LOVE_INFO_MSG = 'Solis.Common.Proto.Api.LoveInfo';
const LOVE_MAIN_CHARACTER_MSG = 'Solis.Common.Proto.Api.LoveMainCharacterInfo';
const LOVE_STORY_END_MSG = 'Solis.Common.Proto.Api.LoveStoryEndInfo';
const LOVE_LEVEL_INFO_MSG = 'Solis.Common.Proto.Api.LoveLevelInfo';
const LOVE_ITEM_INFO_MSG = 'Solis.Common.Proto.Api.LoveItemInfo';
const LOVE_LESSON_PROGRESS_MSG = 'Solis.Common.Proto.Api.LoveLessonProgress';
const LOVE_SAVE_INFO_MSG = 'Solis.Common.Proto.Api.LoveSaveInfo';
const REWARD_MSG = 'Solis.Common.Proto.Transaction.Reward';
const USER_LOVE_MSG = 'Solis.Common.Proto.Transaction.UserLove';
const USER_STORY_MSG = 'Solis.Common.Proto.Transaction.UserStory';
const USER_ITEM_MSG = 'Solis.Common.Proto.Transaction.UserItem';

const LOVE_SAVE_DATA_INFO_MSG = 'Solis.Common.Proto.Api.LoveSaveDataInfo';

const STORY_STATUS_READ = 2;
const RES_ITEM = 1;
const LESSON_REWARD_WINDOW_MS = 12 * 60 * 60 * 1000;
const LESSON_STEP_MS = 10 * 1000;

const LOVE_TYPE_NORMAL = 1;
const LOVE_TYPE_EVENT = 2;
const LOVE_BASE_STANDARD = 1;
const LOVE_BASE_EXTRA = 2;

/**
 * Multi-character love events expose one LoveId but several characters; master
 * data has no featured-character field. Pick which one the lobby/menu shows.
 */
const PREFERRED_LOVE_CHARACTER: Record<string, string> = {
  'love-extra-25-0426': 'char-smr',
};

function accountOf(ctx: RpcContext): string {
  const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
  if (!accountId) throw new Error('unauthenticated');
  return accountId;
}

async function playerForAccount(accountId: string, rpc: string, exec: Executor = db) {
  const [pl] = await exec.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  if (!pl) throw new Error(`${rpc}: no player for account`);
  return pl;
}

function commonResponse(updated: Decoded | null = null, deleted: Decoded | null = null): Decoded {
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

function commonOnly(updated: Decoded | null = null): Decoded {
  return { __msg: '', CommonResponse: commonResponse(updated) } as Decoded;
}

/** `love-extra-25-0426` -> `item-love-25-0426`; base ids pass through. */
function loveItemBase(loveId: string): string {
  return 'item-' + loveId.replace(/^love-extra-/, 'love-');
}

// ---------------------------------------------------------------------------
// Player love state
// ---------------------------------------------------------------------------

type LoveProgress = {
  name: string | null;
  exp: number;
  lastReceiveTime: number;
  readEpisodeIds: string[];
  saveSlots: LoveSaveSlot[];
  saveUnlocked: boolean;
  lastPlayTime: number;
};

async function getProgress(
  playerId: string,
  loveId: string,
  exec: Executor = db,
): Promise<LoveProgress> {
  const [row] = await exec
    .select()
    .from(playerLoveProgress)
    .where(and(eq(playerLoveProgress.playerId, playerId), eq(playerLoveProgress.loveId, loveId)))
    .limit(1);
  return {
    name: row?.name ?? null,
    exp: Number(row?.exp ?? 0),
    lastReceiveTime: Number(row?.lastReceiveTime ?? 0),
    readEpisodeIds: Array.isArray(row?.readEpisodeIds) ? row.readEpisodeIds : [],
    saveSlots: Array.isArray(row?.saveSlots) ? row.saveSlots : [],
    saveUnlocked: row?.saveUnlocked ?? false,
    lastPlayTime: Number(row?.lastPlayTime ?? 0),
  };
}

async function saveProgress(
  playerId: string,
  loveId: string,
  patch: {
    name?: string | null;
    exp?: number;
    lastReceiveTime?: number;
    readEpisodeIds?: string[];
    saveSlots?: LoveSaveSlot[];
    saveUnlocked?: boolean;
    lastPlayTime?: number;
  },
  exec: Executor,
): Promise<void> {
  const [row] = await exec
    .select({ id: playerLoveProgress.id })
    .from(playerLoveProgress)
    .where(and(eq(playerLoveProgress.playerId, playerId), eq(playerLoveProgress.loveId, loveId)))
    .limit(1);
  if (!row) {
    await exec
      .insert(playerLoveProgress)
      .values({
        id: randomUUID(),
        playerId,
        loveId,
        name: patch.name ?? null,
        exp: patch.exp ?? 0,
        lastReceiveTime: patch.lastReceiveTime ?? 0,
        readEpisodeIds: patch.readEpisodeIds ?? [],
      })
      .onConflictDoNothing();
    return;
  }
  await exec
    .update(playerLoveProgress)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(playerLoveProgress.playerId, playerId), eq(playerLoveProgress.loveId, loveId)));
}

function newUserLove(loveId: string): Decoded {
  return {
    __msg: USER_LOVE_MSG,
    LoveId: loveId,
    UnlockedLoveStoryEndIDs: [],
    HiddenFavorability: 0,
    IsReadingStory: false,
  } as Decoded;
}

async function getUserLove(playerId: string, loveId: string, exec: Executor = db): Promise<Decoded> {
  const loves = await listElements(playerId, 'Loves', exec);
  return loves.find((l) => String(l.LoveId ?? '') === loveId) ?? newUserLove(loveId);
}

async function putUserLove(playerId: string, love: Decoded, exec: Executor): Promise<void> {
  await putElements(playerId, 'Loves', [love], exec);
}

// ---------------------------------------------------------------------------
// Master-derived views
// ---------------------------------------------------------------------------

type CharCtx = {
  characterId: string;
  character: Decoded | null;
  loveChar: Decoded | null;
  costumeId: string;
  assetId: string;
  color: string;
};

const EMPTY_CHAR_CTX: CharCtx = {
  characterId: '',
  character: null,
  loveChar: null,
  costumeId: '',
  assetId: '',
  color: '',
};

/**
 * Multi-character events share a single LoveId, so the master data carries no
 * "featured" character. Return every route character (one `CharCtx` per character
 * that has a love profile for this event) so the title list can expand a multi-route
 * event into one entry per route. A preferred character (if configured) is moved to
 * the front so the lobby/main-character view matches the featured route. Single-route
 * events fall back to the first home-action character.
 */
async function routeCharacters(loveId: string): Promise<CharCtx[]> {
  const actions = await listLoveHomeActions(loveId);
  const costumeByChar = new Map<string, string>();
  const order: string[] = [];
  for (const a of actions) {
    const cid = String(a.CharacterId ?? '');
    if (!cid || costumeByChar.has(cid)) continue;
    costumeByChar.set(cid, String(a.CostumeId ?? ''));
    order.push(cid);
  }
  const preferred = PREFERRED_LOVE_CHARACTER[loveId];
  if (preferred) {
    const i = order.indexOf(preferred);
    if (i > 0) {
      order.splice(i, 1);
      order.unshift(preferred);
    }
  }
  const ctxs: CharCtx[] = [];
  for (const cid of order) {
    const c = await getCharacter(cid);
    const infos = (c?.LoveInfos as Decoded[] | null) ?? [];
    const single = (c?.LoveInfo as Decoded | null) ?? null;
    const li =
      infos.find((i) => String(i.LoveId ?? '') === loveId) ??
      (String(single?.LoveId ?? '') === loveId ? single : null);
    ctxs.push({
      characterId: cid,
      character: c,
      loveChar: li,
      costumeId: String(costumeByChar.get(cid) ?? li?.DefaultCostumeId ?? c?.DefaultCostumeId ?? ''),
      assetId: String(c?.AssetId ?? ''),
      color: String(li?.ColorCode ?? c?.Color ?? ''),
    });
  }
  const routes = ctxs.filter((c) => c.loveChar);
  if (routes.length > 0) return routes;
  return ctxs.length > 0 ? [ctxs[0]] : [];
}

async function resolveCharacter(loveId: string): Promise<CharCtx> {
  const routes = await routeCharacters(loveId);
  return routes[0] ?? EMPTY_CHAR_CTX;
}

function mainCharacterFromCtx(c: CharCtx): Decoded {
  return {
    __msg: LOVE_MAIN_CHARACTER_MSG,
    CharacterId: c.characterId,
    CostumeId: c.costumeId,
    AssetId: c.assetId,
    Color: c.color,
  } as Decoded;
}

async function mainCharacterFor(loveId: string): Promise<Decoded> {
  return mainCharacterFromCtx(await resolveCharacter(loveId));
}

async function endingEpisodes(loveId: string): Promise<Decoded[]> {
  const episodes = await listLoveStoryEpisodes(loveId);
  if (episodes.length === 0) return [];
  const max = Math.max(...episodes.map((e) => Number(e.Episode ?? 0)));
  return episodes
    .filter((e) => Number(e.Episode ?? 0) === max)
    .sort((a, b) => String(a.Id ?? '').localeCompare(String(b.Id ?? ''))) as Decoded[];
}

async function storyEndInfos(loveId: string, userLove: Decoded): Promise<Decoded[]> {
  const unlocked = new Set((userLove.UnlockedLoveStoryEndIDs as string[] | null) ?? []);
  const out: Decoded[] = [];
  for (const e of await endingEpisodes(loveId)) {
    const id = String(e.Id ?? '');
    const story = e.StoryId ? await getStory(String(e.StoryId)) : null;
    out.push({
      __msg: LOVE_STORY_END_MSG,
      Id: id,
      Name: String(story?.Name ?? id),
      Unlocked: unlocked.has(id),
    } as Decoded);
  }
  return out;
}

async function loveLevelInfos(loveId: string, frontier = 1): Promise<Decoded[]> {
  const [levels, episodes] = await Promise.all([
    listLoveLevels(loveId),
    listLoveStoryEpisodes(loveId),
  ]);
  const maxEpisode = episodes.reduce((m, e) => Math.max(m, Number(e.Episode ?? 0)), 0);
  return levels
    .sort((a, b) => Number(a.Level ?? 0) - Number(b.Level ?? 0))
    .map((l) => {
      const level = Number(l.Level ?? 0);
      const unlocked = Math.max(level, frontier);
      return {
        __msg: LOVE_LEVEL_INFO_MSG,
        Level: level,
        UnlockStoryEpisode: maxEpisode > 0 ? Math.min(unlocked, maxEpisode) : unlocked,
        UnlockLoveHintType: 0,
        IsTextViewable: true,
      } as Decoded;
    });
}

/**
 * The client derives `LoveTopResponse.StoryEpisodes` from `StoryEpisodeIds`, so the
 * server must send the ordered set of episodes currently unlocked for play. The
 * frontier chapter is derived from the highest episode the player has already read
 * (falls back to chapter 1). All master episodes at or before the frontier are
 * returned so branch chapters keep their alternative routes.
 */
async function unlockedEpisodes(
  loveId: string,
  readEpisodeIds: string[],
): Promise<{ episodes: string[]; frontier: number }> {
  const all = (await listLoveStoryEpisodes(loveId)) as Decoded[];
  const maxEpisode = all.reduce((m, e) => Math.max(m, Number(e.Episode ?? 0)), 0);
  const readSet = new Set(readEpisodeIds);
  const readNums = all
    .filter((e) => readSet.has(String(e.Id ?? '')))
    .map((e) => Number(e.Episode ?? 0));
  let frontier = readNums.length > 0 ? Math.max(...readNums) + 1 : 1;
  if (maxEpisode > 0) frontier = Math.min(frontier, maxEpisode);
  const episodes = all
    .filter((e) => Number(e.Episode ?? 0) <= frontier)
    .map((e) => String(e.Id ?? ''))
    .filter((id) => id !== '');
  return { episodes, frontier };
}

async function itemInfoFor(loveId: string): Promise<Decoded> {
  const base = loveItemBase(loveId);
  const info: Decoded = { __msg: LOVE_ITEM_INFO_MSG } as Decoded;
  if (await getItem(`${base}-story`)) info.StoryReadItemId = `${base}-story`;
  if (await getItem(`${base}-present`)) info.HiddenFavorabilityObtainItemId = `${base}-present`;
  if (await getItem(`${base}-lesson-boost`)) info.LessonPromoteItemId = `${base}-lesson-boost`;
  return info;
}

/** Build `LoveSaveInfo` from the persisted save slots (proto field 6 of LoveTopResponse). */
function loveSaveInfo(slots: LoveSaveSlot[], saveUnlocked = false): Decoded {
  const sorted = [...slots].sort((a, b) => a.slotNumber - b.slotNumber);
  return {
    __msg: LOVE_SAVE_INFO_MSG,
    Unlocked: saveUnlocked,
    SaveDataInfos: sorted.map((s) => ({
      __msg: LOVE_SAVE_DATA_INFO_MSG,
      SlotNumber: s.slotNumber,
      SaveTime: s.saveTime,
      LatestStoryEpisodeId: s.latestStoryEpisodeId,
      Name: s.name,
    })),
  } as Decoded;
}

async function buildLoveInfo(
  loveId: string,
  userLove: Decoded,
  order: number,
  ctx: CharCtx,
  progress: LoveProgress | null = null,
): Promise<Decoded> {
  const isExtra = loveId.startsWith('love-extra-');
  const ends = await storyEndInfos(loveId, userLove);
  const unlockedCount = ends.filter((e) => e.Unlocked).length;
  const slots = progress?.saveSlots ?? [];
  const lastSaveTime = slots.reduce((m, s) => Math.max(m, s.saveTime), 0);
  const lastPlayTime = Math.max(lastSaveTime, progress?.lastPlayTime ?? 0);
  return {
    __msg: LOVE_INFO_MSG,
    LoveId: loveId,
    Description: String(ctx.loveChar?.Description ?? ''),
    CharacterId: ctx.characterId,
    CostumeId: ctx.costumeId,
    AssetId: ctx.assetId,
    StoryEndInfos: ends,
    Type: isExtra ? LOVE_TYPE_EVENT : LOVE_TYPE_NORMAL,
    BaseType: isExtra ? LOVE_BASE_EXTRA : LOVE_BASE_STANDARD,
    IsUnlocked: true,
    IsUnplayed: unlockedCount === 0,
    LastPlayTime: lastPlayTime,
    Order: order,
    MainCharacterInfo: mainCharacterFromCtx(ctx),
  } as Decoded;
}

async function levelForExp(loveId: string, exp: number): Promise<number> {
  const levels = (await listLoveLevels(loveId)).sort(
    (a, b) => Number(a.Level ?? 0) - Number(b.Level ?? 0),
  );
  let level = 1;
  for (const l of levels) {
    const req = l.RequiredExp == null ? null : Number(l.RequiredExp);
    if (req != null && exp >= req) level = Number(l.Level ?? 1);
  }
  return level;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `Love:Title` — exactly ONE `LoveInfo` per `LoveId`.
 *
 * The client's `LoveTitleScreenPresenter.OnClickedTitleButtonAsync` does
 * `LoveInfos.ToDictionary(key => LoveId)`, which throws
 * `ArgumentException: An item with the same key has already been added` if the
 * same LoveId appears twice (the click handler then aborts and the title screen
 * appears frozen). Multi-route events still yield a single entry; the featured
 * route character is chosen via {@link resolveCharacter}.
 */
register(
  'Love:Title',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const pl = await playerForAccount(accountId, 'Love:Title');
    const ids = await listLoveIds();
    const loveInfos: Decoded[] = [];
    let order = 0;
    for (const loveId of ids) {
      const userLove = await getUserLove(pl.id, loveId);
      const charCtx = await resolveCharacter(loveId);
      const progress = await getProgress(pl.id, loveId);
      loveInfos.push(await buildLoveInfo(loveId, userLove, order++, charCtx, progress));
    }
    return { __msg: '', LoveInfos: loveInfos, CommonResponse: commonResponse() } as Decoded;
  },
  { ownsState: true },
);

/** `Love:TitleExtra` — one `LoveInfo` for a specific extra event. */
register(
  'Love:TitleExtra',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const loveId = String(ctx.request?.LoveId ?? '');
    if (!loveId) throw new Error('Love:TitleExtra: missing LoveId');
    const pl = await playerForAccount(accountId, 'Love:TitleExtra');
    const userLove = await getUserLove(pl.id, loveId);
    const charCtx = await resolveCharacter(loveId);
    const progress = await getProgress(pl.id, loveId);
    const loveInfo = await buildLoveInfo(loveId, userLove, 0, charCtx, progress);
    return {
      __msg: '',
      LoveInfo: loveInfo,
      TitleAssetId: String((charCtx.loveChar?.TitleAssetId as string | null) ?? ''),
      CommonResponse: commonResponse(),
    } as Decoded;
  },
  { ownsState: true },
);

/** `Love:Top` — full love top screen payload. */
register(
  'Love:Top',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const loveId = String(ctx.request?.LoveId ?? '');
    if (!loveId) throw new Error('Love:Top: missing LoveId');
    const pl = await playerForAccount(accountId, 'Love:Top');
    const userLove = await getUserLove(pl.id, loveId);
    const [progress, charCtx, itemInfo, storyEnds] = await Promise.all([
      getProgress(pl.id, loveId),
      resolveCharacter(loveId),
      itemInfoFor(loveId),
      storyEndInfos(loveId, userLove),
    ]);
    const { episodes, frontier } = await unlockedEpisodes(loveId, progress.readEpisodeIds);
    const levelInfos = await loveLevelInfos(loveId, frontier);
    const last = progress.lastReceiveTime;
    return {
      __msg: '',
      LoveName: String(charCtx.loveChar?.Name ?? charCtx.character?.Name ?? loveId),
      PlayerName: String(pl.name ?? ''),
      Exp: progress.exp,
      LessonProgress: {
        __msg: LOVE_LESSON_PROGRESS_MSG,
        LastReceiveTime: last,
        MaxRewardTime: last + LESSON_REWARD_WINDOW_MS,
      },
      StoryEpisodeIds: episodes,
      SaveInfo: loveSaveInfo(progress.saveSlots, progress.saveUnlocked),
      ItemInfo: itemInfo,
      EventMissionInfos: [],
      LimitedEventMissionInfos: [],
      HiddenFavorability: Number(userLove.HiddenFavorability ?? 0),
      StoryEndInfos: storyEnds,
      LoveLevelInfos: levelInfos,
      BannerAssetId: '',
      ExpAssetId: '',
      MainCharacterInfo: mainCharacterFromCtx(charCtx),
      LoveSimpleName: String(charCtx.loveChar?.Name ?? charCtx.character?.Name ?? ''),
      CommonResponse: commonResponse(),
    } as Decoded;
  },
  { ownsState: true },
);

/** `Love:GetMainCharacter` — main character portrait info. */
register(
  'Love:GetMainCharacter',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const loveId = String(ctx.request?.LoveId ?? '');
    if (!loveId) throw new Error('Love:GetMainCharacter: missing LoveId');
    await playerForAccount(accountId, 'Love:GetMainCharacter');
    return {
      __msg: '',
      MainCharacterInfo: await mainCharacterFor(loveId),
      CommonResponse: commonResponse(),
    } as Decoded;
  },
  { ownsState: true },
);

/** `Love:Register` / `Love:UpdateName` — store the protagonist name. */
async function setNameHandler(ctx: RpcContext): Promise<Decoded> {
  const accountId = accountOf(ctx);
  const loveId = String(ctx.request?.LoveId ?? '');
  const name = String(ctx.request?.Name ?? '');
  if (!loveId) throw new Error(`${ctx.name}: missing LoveId`);
  const pl = await playerForAccount(accountId, ctx.name);
  await withPlayerTx(pl.id, async (tx) => {
    await getUserLove(pl.id, loveId, tx);
    // Register anchors the lesson clock (Solis love/register.go); UpdateName must not reset it.
    const anchor = ctx.name === 'Love:Register' ? { lastReceiveTime: Date.now() } : {};
    await saveProgress(pl.id, loveId, { name, ...anchor }, tx);
  });
  ctx.fastifyReq.log.info({ accountId, loveId, name }, 'love name set');
  return commonOnly();
}

register('Love:Register', setNameHandler, { ownsState: true });
register('Love:UpdateName', setNameHandler, { ownsState: true });

/** `Love:Present` — add one hidden favorability point. */
register(
  'Love:Present',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const loveId = String(ctx.request?.LoveId ?? '');
    if (!loveId) throw new Error('Love:Present: missing LoveId');
    const pl = await playerForAccount(accountId, 'Love:Present');
    const out = await withPlayerTx(pl.id, async (tx) => {
      const userLove = await getUserLove(pl.id, loveId, tx);
      userLove.HiddenFavorability = Number(userLove.HiddenFavorability ?? 0) + 1;
      await putUserLove(pl.id, userLove, tx);
      return { value: Number(userLove.HiddenFavorability), updated: updatedData(['Loves', [userLove]]) };
    });
    return {
      __msg: '',
      HiddenFavorability: out.value,
      CommonResponse: commonResponse(out.updated),
    } as Decoded;
  },
  { ownsState: true },
);

/** `Love:Start` / `Love:Restart` — enter the ADV (choices live in the asset). */
async function startHandler(ctx: RpcContext): Promise<Decoded> {
  const accountId = accountOf(ctx);
  const episodeId = String(ctx.request?.StoryEpisodeId ?? '');
  const episode = episodeId ? await getLoveStoryEpisode(episodeId) : null;
  if (!episode) throw new Error(`${ctx.name}: unknown StoryEpisodeId ${episodeId}`);
  const loveId = String(episode.LoveId ?? '');
  const pl = await playerForAccount(accountId, ctx.name);
  const cost = episode.ConsumptionItemAmount == null ? 0 : Number(episode.ConsumptionItemAmount);
  const itemId = `${loveItemBase(loveId)}-story`;
  const updated = await withPlayerTx(pl.id, async (tx) => {
    const userLove = await getUserLove(pl.id, loveId, tx);
    userLove.IsReadingStory = true;
    await putUserLove(pl.id, userLove, tx);
    let items: Decoded | null = null;
    if (cost > 0 && ctx.name === 'Love:Start') {
      const progress = await getProgress(pl.id, loveId, tx);
      if (!progress.readEpisodeIds.includes(episodeId)) {
        await spendItem(pl.id, itemId, cost, tx);
        items = {
          __msg: USER_ITEM_MSG,
          ItemId: itemId,
          Amount: await getItemAmount(pl.id, itemId, tx),
        } as Decoded;
      }
    }
    return items ? updatedData(['Loves', [userLove]], ['Items', [items]]) : updatedData(['Loves', [userLove]]);
  });
  ctx.fastifyReq.log.info({ accountId, loveId, episodeId }, 'love adv start');
  return {
    __msg: '',
    StoryChoiceGroupInfos: [],
    AdvBranchInfos: [],
    CommonResponse: commonResponse(updated),
  } as Decoded;
}

register('Love:Start', startHandler, { ownsState: true });
register('Love:Restart', startHandler, { ownsState: true });

/** `Love:Finish` — grant the episode reward once, record ending/read state. */
register(
  'Love:Finish',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const episodeId = String(ctx.request?.StoryEpisodeId ?? '');
    if (!episodeId) throw new Error('Love:Finish: missing StoryEpisodeId');
    const episode = await getLoveStoryEpisode(episodeId);
    if (!episode) throw new Error(`Love:Finish: unknown StoryEpisodeId ${episodeId}`);
    const loveId = String(episode.LoveId ?? '');
    const storyId = episode.StoryId == null ? '' : String(episode.StoryId);
    const story = storyId ? await getStory(storyId) : null;
    const ends = await endingEpisodes(loveId);
    const isEnding = ends.some((e) => String(e.Id ?? '') === episodeId);

    const pl = await playerForAccount(accountId, 'Love:Finish');
    const out = await withPlayerTx(pl.id, async (tx) => {
      const userLove = await getUserLove(pl.id, loveId, tx);
      const updated: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
      let rewards: Decoded[] = [];

      const rewardRef = story?.RewardId == null ? '' : String(story.RewardId);
      if (await claimOnce(pl.id, 'love_story', episodeId, tx)) {
        if (rewardRef) {
          const applied = await applyRewardRefs(pl.id, [rewardRef], tx);
          if (applied.updated) {
            for (const key of ['Items', 'Points', 'Balance', 'Characters', 'Costumes']) {
              if (applied.updated[key] !== undefined) updated[key] = applied.updated[key];
            }
          }
          rewards = applied.results;
        }
      }

      if (storyId) {
        const userStory = {
          __msg: USER_STORY_MSG,
          StoryId: storyId,
          StatusType: STORY_STATUS_READ,
        } as Decoded;
        await putElements(pl.id, 'Stories', [userStory], tx);
        updated.Stories = [userStory];
      }

      userLove.IsReadingStory = false;
      if (isEnding) {
        const list = (userLove.UnlockedLoveStoryEndIDs as string[] | null) ?? [];
        if (!list.includes(episodeId)) {
          list.push(episodeId);
          userLove.UnlockedLoveStoryEndIDs = list;
        }
      }
      await putUserLove(pl.id, userLove, tx);
      updated.Loves = [userLove];

      const progress = await getProgress(pl.id, loveId, tx);
      const unlockNow = isEnding && !progress.saveUnlocked;
      const patch: {
        readEpisodeIds: string[];
        saveUnlocked?: boolean;
        lastPlayTime?: number;
      } = { readEpisodeIds: [...progress.readEpisodeIds, episodeId] };
      if (unlockNow) {
        patch.saveUnlocked = true;
        patch.lastPlayTime = Date.now();
        patch.readEpisodeIds = [];
      } else if (!progress.readEpisodeIds.includes(episodeId)) {
        patch.lastPlayTime = Date.now();
      }
      await saveProgress(pl.id, loveId, patch, tx);
      return {
        rewards,
        updated,
        isEnding,
        storyName: String(story?.Name ?? ''),
        unlockNow,
      };
    });

    ctx.fastifyReq.log.info(
      { accountId, loveId, episodeId, isEnding, rewarded: out.rewards.length > 0 },
      'love adv finish',
    );
    return {
      __msg: '',
      Rewards: out.rewards,
      StoryEndName: out.isEnding ? out.storyName : '',
      UnlockSave: out.unlockNow,
      EndRollAssetId: '',
      CommonResponse: commonResponse(out.updated),
    } as Decoded;
  },
  { ownsState: true },
);

/** `Love:Save` — persist (or overwrite) one save slot. */
register(
  'Love:Save',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const loveId = String(ctx.request?.LoveId ?? '');
    const slotNumber = Number(ctx.request?.SlotNumber ?? 0);
    if (!loveId) throw new Error('Love:Save: missing LoveId');
    const pl = await playerForAccount(accountId, 'Love:Save');
    const updated = await withPlayerTx(pl.id, async (tx) => {
      const progress = await getProgress(pl.id, loveId, tx);
      const slots = [...progress.saveSlots];
      const existing = slots.find((s) => s.slotNumber === slotNumber);
      const latest = progress.readEpisodeIds[progress.readEpisodeIds.length - 1] ?? '';
      const slot: LoveSaveSlot = {
        slotNumber,
        saveTime: Date.now(),
        latestStoryEpisodeId: latest,
        name: existing?.name ?? `セーブ${slotNumber}`,
      };
      if (existing) {
        Object.assign(existing, slot);
      } else {
        slots.push(slot);
      }
      await saveProgress(pl.id, loveId, { saveSlots: slots }, tx);
    });
    ctx.fastifyReq.log.info({ accountId, loveId, slotNumber }, 'love adv save');
    return commonOnly();
  },
  { ownsState: true },
);

/** `Love:UpdateSaveName` — rename one save slot. */
register(
  'Love:UpdateSaveName',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const loveId = String(ctx.request?.LoveId ?? '');
    const slotNumber = Number(ctx.request?.SlotNumber ?? 0);
    const name = String(ctx.request?.Name ?? '');
    if (!loveId) throw new Error('Love:UpdateSaveName: missing LoveId');
    const pl = await playerForAccount(accountId, 'Love:UpdateSaveName');
    const updated = await withPlayerTx(pl.id, async (tx) => {
      const progress = await getProgress(pl.id, loveId, tx);
      const slots = progress.saveSlots.map((s) =>
        s.slotNumber === slotNumber ? { ...s, name } : s,
      );
      await saveProgress(pl.id, loveId, { saveSlots: slots }, tx);
    });
    ctx.fastifyReq.log.info({ accountId, loveId, slotNumber, name }, 'love adv save name');
    return commonOnly();
  },
  { ownsState: true },
);

/** `Love:Load` / `Love:Reset` — return the episode list for the love. */
async function episodeListHandler(ctx: RpcContext): Promise<Decoded> {
  const accountId = accountOf(ctx);
  const loveId = String(ctx.request?.LoveId ?? '');
  if (!loveId) throw new Error(`${ctx.name}: missing LoveId`);
  const pl = await playerForAccount(accountId, ctx.name);
  let episodes: string[];
  if (ctx.name === 'Love:Reset') {
    episodes = await withPlayerTx(pl.id, async (tx) => {
      const userLove = await getUserLove(pl.id, loveId, tx);
      userLove.IsReadingStory = false;
      await putUserLove(pl.id, userLove, tx);
      await saveProgress(pl.id, loveId, { readEpisodeIds: [], saveSlots: [] }, tx);
      return (await unlockedEpisodes(loveId, [])).episodes;
    });
  } else if (ctx.name === 'Love:Load') {
    const slotNumber = Number(ctx.request?.SlotNumber ?? 0);
    episodes = await withPlayerTx(pl.id, async (tx) => {
      const progress = await getProgress(pl.id, loveId, tx);
      const slot = progress.saveSlots.find((s) => s.slotNumber === slotNumber);
      const target = slot?.latestStoryEpisodeId ?? '';
      let readIds: string[];
      if (target) {
        const all = (await listLoveStoryEpisodes(loveId)) as Decoded[];
        const targetEpisode = Number(
          all.find((e) => String(e.Id ?? '') === target)?.Episode ?? 0,
        );
        readIds = all
          .filter((e) => Number(e.Episode ?? 0) <= targetEpisode)
          .map((e) => String(e.Id ?? ''));
      } else {
        readIds = progress.readEpisodeIds;
      }
      await saveProgress(pl.id, loveId, { readEpisodeIds: readIds }, tx);
      return (await unlockedEpisodes(loveId, readIds)).episodes;
    });
  } else {
    episodes = (await unlockedEpisodes(loveId, (await getProgress(pl.id, loveId)).readEpisodeIds)).episodes;
  }
  return {
    __msg: '',
    StoryEpisodeIds: episodes,
    CommonResponse: commonResponse(),
  } as Decoded;
}

register('Love:Load', episodeListHandler, { ownsState: true });
register('Love:Reset', episodeListHandler, { ownsState: true });

/** `Love:ResetReadingStoryStatus` — clear the reading flag. */
register(
  'Love:ResetReadingStoryStatus',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const loveId = String(ctx.request?.LoveId ?? '');
    if (!loveId) throw new Error('Love:ResetReadingStoryStatus: missing LoveId');
    const pl = await playerForAccount(accountId, 'Love:ResetReadingStoryStatus');
    const updated = await withPlayerTx(pl.id, async (tx) => {
      const userLove = await getUserLove(pl.id, loveId, tx);
      userLove.IsReadingStory = false;
      await putUserLove(pl.id, userLove, tx);
      return updatedData(['Loves', [userLove]]);
    });
    return commonOnly(updated);
  },
  { ownsState: true },
);

/** `Love:ReceiveLessonReward` — time-windowed (2h) lesson step reward. */
register(
  'Love:ReceiveLessonReward',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const loveId = String(ctx.request?.LoveId ?? '');
    if (!loveId) throw new Error('Love:ReceiveLessonReward: missing LoveId');
    const pl = await playerForAccount(accountId, 'Love:ReceiveLessonReward');
    const out = await withPlayerTx(pl.id, async (tx) => {
      const progress = await getProgress(pl.id, loveId, tx);
      const now = Date.now();
      const last = progress.lastReceiveTime;
      const level = await levelForExp(loveId, progress.exp);
      const master = await getLoveLevel(loveId, level);
      const rewardExp = Number(master?.LessonStepRewardExp ?? 0);
      const itemAmount = Number(master?.LessonStepRewardStoryReadItemAmount ?? 0);
      const storyItemId = `${loveItemBase(loveId)}-story`;

      // Anchor logic: if no valid anchor yet, create one and return zero.
      if (last <= 0) {
        await saveProgress(pl.id, loveId, { lastReceiveTime: now }, tx);
        return {
          obtainExp: 0,
          totalExp: progress.exp,
          rewards: [] as Decoded[],
          updated: updatedData() as Decoded,
          progress: { lastReceiveTime: now, maxRewardTime: now + LESSON_REWARD_WINDOW_MS },
        };
      }

      const anchor = last;
      const cappedNow = Math.min(now, anchor + LESSON_REWARD_WINDOW_MS);
      const steps = Math.floor((cappedNow - anchor) / LESSON_STEP_MS);

      if (steps <= 0) {
        return {
          obtainExp: 0,
          totalExp: progress.exp,
          rewards: [] as Decoded[],
          updated: updatedData() as Decoded,
          progress: { lastReceiveTime: last, maxRewardTime: anchor + LESSON_REWARD_WINDOW_MS },
        };
      }

      const grantExp = steps * rewardExp;
      const grantItemAmount = steps * itemAmount;
      const totalExp = progress.exp + grantExp;
      const updated: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
      const rewards: Decoded[] = [];
      if (grantItemAmount > 0 && (await getItem(storyItemId))) {
        const before = await getItemAmount(pl.id, storyItemId, tx);
        await grantItem(pl.id, storyItemId, grantItemAmount, tx);
        updated.Items = [
          { __msg: USER_ITEM_MSG, ItemId: storyItemId, Amount: before + grantItemAmount },
        ] as Decoded[];
        rewards.push({
          __msg: REWARD_MSG,
          ResourceType: RES_ITEM,
          ResourceId: storyItemId,
          Amount: grantItemAmount,
        } as Decoded);
      }
      // Anchor: snap to the last completed step within the window.
      const newAnchor = now >= anchor + LESSON_REWARD_WINDOW_MS
        ? now
        : now - ((now - anchor) % LESSON_STEP_MS);
      await saveProgress(pl.id, loveId, { exp: totalExp, lastReceiveTime: newAnchor }, tx);
      return {
        obtainExp: grantExp,
        totalExp,
        rewards,
        updated,
        progress: { lastReceiveTime: newAnchor, maxRewardTime: newAnchor + LESSON_REWARD_WINDOW_MS },
      };
    });
    return {
      __msg: '',
      Rewards: out.rewards,
      ObtainExp: out.obtainExp,
      TotalExp: out.totalExp,
      LessonProgress: {
        __msg: LOVE_LESSON_PROGRESS_MSG,
        LastReceiveTime: out.progress.lastReceiveTime,
        MaxRewardTime: out.progress.maxRewardTime,
      },
      CommonResponse: commonResponse(out.updated),
    } as Decoded;
  },
  { ownsState: true },
);

/** `Love:PromoteLesson` — promote one lesson level (once per level). */
register(
  'Love:PromoteLesson',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const loveId = String(ctx.request?.LoveId ?? '');
    if (!loveId) throw new Error('Love:PromoteLesson: missing LoveId');
    const pl = await playerForAccount(accountId, 'Love:PromoteLesson');
    const out = await withPlayerTx(pl.id, async (tx) => {
      const progress = await getProgress(pl.id, loveId, tx);
      const level = await levelForExp(loveId, progress.exp);
      const nextMaster = await getLoveLevel(loveId, level + 1);
      const noop = {
        obtainExp: 0,
        totalExp: progress.exp,
        rewards: [] as Decoded[],
        updated: updatedData() as Decoded,
        progress: {
          lastReceiveTime: progress.lastReceiveTime,
          maxRewardTime: progress.lastReceiveTime + LESSON_REWARD_WINDOW_MS,
        },
      };
      if (!nextMaster) return noop;

      const won = await claimOnce(pl.id, 'love_lesson', `${loveId}:${level}`, tx);
      if (!won) return noop;

      const required = nextMaster.RequiredExp == null ? progress.exp : Number(nextMaster.RequiredExp);
      const rewardExp = Number(nextMaster.LessonStepRewardExp ?? 0);
      const itemAmount = Number(nextMaster.LessonStepRewardStoryReadItemAmount ?? 0);
      const storyItemId = `${loveItemBase(loveId)}-story`;
      const totalExp = Math.max(progress.exp, required) + rewardExp;
      const updated: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
      const rewards: Decoded[] = [];
      if (itemAmount > 0 && (await getItem(storyItemId))) {
        const before = await getItemAmount(pl.id, storyItemId, tx);
        await grantItem(pl.id, storyItemId, itemAmount, tx);
        updated.Items = [
          { __msg: USER_ITEM_MSG, ItemId: storyItemId, Amount: before + itemAmount },
        ] as Decoded[];
        rewards.push({
          __msg: REWARD_MSG,
          ResourceType: RES_ITEM,
          ResourceId: storyItemId,
          Amount: itemAmount,
        } as Decoded);
      }
      await saveProgress(pl.id, loveId, { exp: totalExp }, tx);
      return {
        obtainExp: totalExp - progress.exp,
        totalExp,
        rewards,
        updated,
        progress: {
          lastReceiveTime: progress.lastReceiveTime,
          maxRewardTime: progress.lastReceiveTime + LESSON_REWARD_WINDOW_MS,
        },
      };
    });
    return {
      __msg: '',
      Rewards: out.rewards,
      ObtainExp: out.obtainExp,
      TotalExp: out.totalExp,
      LessonProgress: {
        __msg: LOVE_LESSON_PROGRESS_MSG,
        LastReceiveTime: out.progress.lastReceiveTime,
        MaxRewardTime: out.progress.maxRewardTime,
      },
      CommonResponse: commonResponse(out.updated),
    } as Decoded;
  },
  { ownsState: true },
);
