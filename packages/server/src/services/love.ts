import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import type { RpcContext } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { players, playerLoveProgress, type LoveSaveSlot, type LoveStorySelection } from '../db/schema.ts';
import { claimOnce } from '../db/claims.ts';
import {
  getCharacter,
  getItem,
  getLoveLevel,
  getLoveStoryEpisode,
  getStory,
  listLoveLevels,
  listLoveStoryEpisodes,
  listLoveHomeActions,
} from '../master/index.ts';
import { applyRewardRefs } from '../master/reward.ts';
import { firstEpisodeId, loveConfig, loveRoutes, supportedLoveIds, episodeIdPrefix, MoshikoiError, type EventConfig } from './moshikoi/catalog.ts';
import {
  allEndingsUnlocked,
  branchInfos,
  choiceInfos,
  favorability,
  resolve,
  selectChoices,
  type StoryChoiceSelection,
} from './moshikoi/routes.ts';
import { getItemAmount, grantItem, spendItem } from './inventory.ts';
import { listElements, putElements } from './playerState.ts';
import { isSandbox } from '../profile.ts';
import { SANDBOX_CURRENCY } from '../profiles/sandbox/seed.ts';
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

/**
 * Master `Setting.LoveSaveSlotNum` (5 in the ported master data). The sumire
 * master schema only maps the `master_Setting` columns the services read, and
 * love save slots never needed it before stage 2b.
 */
const LOVE_SAVE_SLOT_NUM = 5;

const LOVE_TYPE_NORMAL = 1;
const LOVE_TYPE_EVENT = 2;

/**
 * Multi-character love events expose one LoveId but several characters; master
 * data has no featured-character field. Pick which one the lobby/menu shows.
 */
const PREFERRED_LOVE_CHARACTER: Record<string, string> = {
  'love-extra-25-0426': 'char-smr',
};

/**
 * Master `LoveCharacterInfo` has no `TitleAssetId`, so the extra story's title
 * asset is supplied here instead.
 */
export const LOVE_TITLE_ASSET_ID: Record<string, string> = {
  'love-extra-25-0426': 'love-25-0426',
};

/**
 * Extra routes reuse a standard series' content assets; the Top screen needs
 * the banner and EXP asset ids from that series, not the route's event id.
 */
export const LOVE_TOP_ASSETS: Record<string, { banner: string; exp: string }> = {
  'love-extra-25-0426': { banner: 'img_banner_l_event-love-25-0426', exp: 'exp-love-25-0426' },
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
  storyEpisodeIds: string[];
  selections: LoveStorySelection[];
  pastSelections: LoveStorySelection[];
  activeStoryEpisodeId: string;
  saveSlots: LoveSaveSlot[];
  saveUnlocked: boolean;
  lastPlayTime: number;
};

function loveProgressFromRow(
  row: typeof playerLoveProgress.$inferSelect | undefined,
  loveId: string,
): LoveProgress {
  // solis `moshikoi.LoadState`: a fresh (or legacy empty) route always starts
  // with the event's first episode.
  const storyEpisodeIds = Array.isArray(row?.storyEpisodeIds) ? row.storyEpisodeIds : [];
  return {
    name: row?.name ?? null,
    exp: Number(row?.exp ?? 0),
    lastReceiveTime: Number(row?.lastReceiveTime ?? 0),
    readEpisodeIds: Array.isArray(row?.readEpisodeIds) ? row.readEpisodeIds : [],
    storyEpisodeIds:
      storyEpisodeIds.length > 0 ? storyEpisodeIds : [firstEpisodeId(loveId)],
    selections: Array.isArray(row?.selections) ? row.selections : [],
    pastSelections: Array.isArray(row?.pastSelections) ? row.pastSelections : [],
    activeStoryEpisodeId: row?.activeStoryEpisodeId ?? '',
    saveSlots: (Array.isArray(row?.saveSlots) ? row.saveSlots : []).map((slot) => ({
      ...slot,
      // Slots written before route state was captured have no route payload.
      storyEpisodeIds: Array.isArray(slot.storyEpisodeIds) ? slot.storyEpisodeIds : [],
      selections: Array.isArray(slot.selections) ? slot.selections : [],
    })),
    saveUnlocked: row?.saveUnlocked ?? false,
    lastPlayTime: Number(row?.lastPlayTime ?? 0),
  };
}

/**
 * Load the player's love + progress state, repairing legacy rows written before
 * migration 0033 backfilled `active_story_episode_id` (and before route state was
 * captured):
 *  - an existing row with no route ids is seeded with the event's first episode;
 *  - `IsReadingStory` with no active episode is stale, so it is cleared.
 *
 * Both repairs persist, so every Love RPC observes (and leaves behind) a
 * consistent state before the client can decide to call `Love:Restart`.
 */
async function repairLoveState(
  playerId: string,
  loveId: string,
  exec: Executor = db,
): Promise<{
  userLove: Decoded;
  row: typeof playerLoveProgress.$inferSelect | undefined;
}> {
  const [loves, [row]] = await Promise.all([
    listElements(playerId, 'Loves', exec),
    exec
      .select()
      .from(playerLoveProgress)
      .where(and(eq(playerLoveProgress.playerId, playerId), eq(playerLoveProgress.loveId, loveId)))
      .limit(1),
  ]);
  const stored = loves.find((l) => String(l.LoveId ?? '') === loveId);
  let userLove = stored ?? newUserLove(loveId);
  if (!row) return { userLove, row };

  if (!Array.isArray(row.storyEpisodeIds) || row.storyEpisodeIds.length === 0) {
    await saveProgress(playerId, loveId, { storyEpisodeIds: [firstEpisodeId(loveId)] }, exec);
  }
  if (stored && userLove.IsReadingStory && (row.activeStoryEpisodeId ?? '') === '') {
    userLove = { ...userLove, IsReadingStory: false };
    await putUserLove(playerId, userLove, exec);
  }
  return { userLove, row };
}

async function getProgress(
  playerId: string,
  loveId: string,
  exec: Executor = db,
): Promise<LoveProgress> {
  const { row } = await repairLoveState(playerId, loveId, exec);
  return loveProgressFromRow(row, loveId);
}

async function saveProgress(
  playerId: string,
  loveId: string,
  patch: {
    name?: string | null;
    exp?: number;
    lastReceiveTime?: number;
    readEpisodeIds?: string[];
    storyEpisodeIds?: string[];
    selections?: LoveStorySelection[];
    pastSelections?: LoveStorySelection[];
    activeStoryEpisodeId?: string;
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
        storyEpisodeIds: patch.storyEpisodeIds ?? [firstEpisodeId(loveId)],
        selections: patch.selections ?? [],
        pastSelections: patch.pastSelections ?? [],
        activeStoryEpisodeId: patch.activeStoryEpisodeId ?? '',
        saveSlots: patch.saveSlots ?? [],
        saveUnlocked: patch.saveUnlocked ?? false,
        lastPlayTime: patch.lastPlayTime ?? 0,
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
  const { userLove } = await repairLoveState(playerId, loveId, exec);
  return userLove;
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

/**
 * Solis `catalog.MainCharacterInfo` (`internal/makino/moshikoi/catalog.go:197-205`):
 * extra events carry several heroines and pick one uniformly at random per call,
 * while single-heroine events fall back to the configured character fields.
 */
function mainCharacterForConfig(cfg: EventConfig): Decoded {
  const pick =
    cfg.mainCharacters.length > 0
      ? cfg.mainCharacters[Math.floor(Math.random() * cfg.mainCharacters.length)]
      : null;
  return {
    __msg: LOVE_MAIN_CHARACTER_MSG,
    CharacterId: pick?.characterId ?? cfg.characterId,
    CostumeId: pick?.costumeId ?? cfg.costumeId,
    AssetId: pick?.assetId ?? cfg.characterAssetId,
    Color: pick?.color ?? cfg.color,
  } as Decoded;
}

async function mainCharacterFor(loveId: string): Promise<Decoded> {
  return mainCharacterForConfig(loveConfig(loveId));
}

/**
 * Single source of truth for the save-slot gate: solis `love/top.go:40` and
 * `common.go:141-157` derive everything from `UserLove.UnlockedLoveStoryEndIDs`,
 * never from a stored flag.
 */
function hasUnlockedEnding(userLove: Decoded): boolean {
  return ((userLove.UnlockedLoveStoryEndIDs as string[] | null) ?? []).length > 0;
}

/**
 * Solis `viber.BuildLoveInfo` (`love_catalog.go:15-69`): ending rows come from
 * the route catalogue and stay hidden until at least one ending is unlocked.
 *
 * Deliberate deviation from solis (`love_catalog.go:44-48`): always return every
 * catalogue ending, marking only unlocked ones as `Unlocked`. The client disables
 * the character-select "Details" button when `StoryEndInfos` is empty and never
 * re-enables it on reused list cells, so hiding endings before the first clear
 * leaves "Ending Not Cleared" stale even for loves with cleared endings.
 */
function storyEndInfos(loveId: string, userLove: Decoded): Decoded[] {
  const unlocked = new Set((userLove.UnlockedLoveStoryEndIDs as string[] | null) ?? []);
  return loveRoutes(loveId).endings.map((ending) => {
    const info = {
      __msg: LOVE_STORY_END_MSG,
      Id: ending.id,
      Name: ending.name,
    } as Decoded;
    if (unlocked.has(ending.id)) info.Unlocked = true;
    return info;
  });
}

/**
 * Solis `love/top.go:44-64`: reveal roadmap rows in five-level windows and attach
 * the story/hint unlocks configured for the row's level. `current` is the level
 * derived from the player's exp (`catalog.Level`).
 */
async function loveLevelInfos(loveId: string, current: number): Promise<Decoded[]> {
  const cfg = loveConfig(loveId);
  const windowEnd = Math.floor((current + 5) / 5) * 5;
  return (await listLoveLevels(loveId))
    .sort((a, b) => Number(a.Level ?? 0) - Number(b.Level ?? 0))
    .filter((l) => Number(l.Level ?? 0) <= windowEnd)
    .map((l) => {
      const level = Number(l.Level ?? 0);
      let unlockStoryEpisode = 0;
      for (const [episode, unlockLevel] of Object.entries(cfg.episodeUnlockLevels)) {
        if (Number(unlockLevel) === level) unlockStoryEpisode = Number(episode);
      }
      let unlockLoveHintType = 0;
      for (const [hint, unlockLevel] of Object.entries(cfg.hintUnlockLevels)) {
        if (Number(unlockLevel) === level) unlockLoveHintType = Number(hint);
      }
      return {
        __msg: LOVE_LEVEL_INFO_MSG,
        Level: level,
        UnlockStoryEpisode: unlockStoryEpisode,
        UnlockLoveHintType: unlockLoveHintType,
        IsTextViewable: level <= current + 1,
      } as Decoded;
    });
}

async function itemInfoFor(loveId: string): Promise<Decoded> {
  const base = loveItemBase(loveId);
  const info: Decoded = { __msg: LOVE_ITEM_INFO_MSG } as Decoded;
  if (await getItem(`${base}-story`)) info.StoryReadItemId = `${base}-story`;
  if (await getItem(`${base}-present`)) info.HiddenFavorabilityObtainItemId = `${base}-present`;
  if (await getItem(`${base}-lesson-boost`)) info.LessonPromoteItemId = `${base}-lesson-boost`;
  return info;
}

/**
 * Build `LoveSaveInfo` from the persisted save slots (proto field 6 of
 * LoveTopResponse). `unlocked` is derived from `UnlockedLoveStoryEndIDs`; the
 * stored `save_unlocked` column is never consulted.
 */
function loveSaveInfo(slots: LoveSaveSlot[], unlocked: boolean): Decoded {
  const sorted = [...slots].sort((a, b) => a.slotNumber - b.slotNumber);
  return {
    __msg: LOVE_SAVE_INFO_MSG,
    Unlocked: unlocked,
    SaveDataInfos: sorted.map((s) => ({
      __msg: LOVE_SAVE_DATA_INFO_MSG,
      SlotNumber: s.slotNumber,
      SaveTime: s.saveTime,
      LatestStoryEpisodeId: s.latestStoryEpisodeId,
      Name: s.name,
    })),
  } as Decoded;
}

/** True when the player owns a non-expired stack of `itemId`. */
async function hasUnexpiredItem(playerId: string, itemId: string): Promise<boolean> {
  if (!itemId) return false;
  const item = (await listElements(playerId, 'Items')).find(
    (i) => String(i.ItemId ?? '') === itemId,
  );
  if (!item || Number(item.Amount ?? 0) <= 0) return false;
  const expires = Number(item.ExpiredTime ?? 0);
  return expires === 0 || expires > Date.now();
}

/**
 * Solis `viber.BuildLoveInfo` (`internal/server/rpc/servers/internal/viber/love_catalog.go:15-69`).
 * Sumire keeps its `LOVE_TITLE_ASSET_ID` override for `AssetId` and its
 * `IsUnplayed = !progress.name` definition. Like solis, it deliberately omits
 * `CharacterId`/`CostumeId`: sending them made the client's character-select
 * card read the default-route profile (which has no description) for
 * `love-extra-25-0426`.
 */
async function buildLoveInfo(
  loveId: string,
  userLove: Decoded,
  order: number,
  ctx: CharCtx,
  progress: LoveProgress | null,
  playerId: string,
): Promise<Decoded> {
  const cfg = loveConfig(loveId);
  const isExtra = loveId.startsWith('love-extra-');
  const ends = await storyEndInfos(loveId, userLove);
  const slots = progress?.saveSlots ?? [];
  const lastSaveTime = slots.reduce((m, s) => Math.max(m, s.saveTime), 0);
  const lastPlayTime = Math.max(lastSaveTime, progress?.lastPlayTime ?? 0);
  // Solis falls back to the event start time when the lesson anchor is unset.
  const lessonAnchor =
    progress?.lastReceiveTime && progress.lastReceiveTime > 0
      ? progress.lastReceiveTime
      : cfg.startTime;
  return {
    __msg: LOVE_INFO_MSG,
    LoveId: loveId,
    Description: cfg.description,
    AssetId: LOVE_TITLE_ASSET_ID[loveId] ?? ctx.assetId,
    StoryEndInfos: ends,
    Type: isExtra ? LOVE_TYPE_EVENT : LOVE_TYPE_NORMAL,
    StartTime: cfg.startTime,
    UnlockConditionId: cfg.unlockConditionId,
    // TODO: sumire has no commerce-condition evaluator, so the catalog unlock
    // condition cannot be evaluated here yet. Solis evaluates
    // `cfg.UnlockConditionID` via `NewCommerceConditionEvaluator`.
    IsUnlocked: true,
    EventMissionIds: [...cfg.eventMissionIds],
    LimitedEventMissionIds: [...cfg.limitedEventMissionIds],
    IsLessonRewardMax:
      Boolean(progress?.name) &&
      Date.now() >= lessonAnchor + cfg.lessonMaxHours * 60 * 60 * 1000,
    IsUnplayed: !progress?.name,
    HasHiddenFavorabilityObtainItem: await hasUnexpiredItem(playerId, cfg.presentItemId),
    Order: order,
    LastPlayTime: lastPlayTime,
    MainCharacterInfo: mainCharacterForConfig(cfg),
    BaseType: cfg.baseType,
    IsHideManagerVoiceSwitch: cfg.hideManagerVoiceSwitch,
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
    // Solis `love/title.go:12-33` enumerates the supported ids; unlike solis,
    // sumire deliberately includes extras in `Love:Title` because it has no
    // `Home:Enter` `LoveEventInfos` (solis `home/enter.go:646-695`) to surface
    // them. The client still keys this list by LoveId, so each id appears once.
    const ids = supportedLoveIds();
    const loveInfos: Decoded[] = [];
    // 1-based: proto omits a zero-valued Order, which would read back as absent.
    let order = 1;
    for (const loveId of ids) {
      const userLove = await getUserLove(pl.id, loveId);
      const charCtx = await resolveCharacter(loveId);
      const progress = await getProgress(pl.id, loveId);
      loveInfos.push(await buildLoveInfo(loveId, userLove, order++, charCtx, progress, pl.id));
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
    const loveInfo = await buildLoveInfo(loveId, userLove, 1, charCtx, progress, pl.id);
    const cfg = loveConfig(loveId);
    return {
      __msg: '',
      LoveInfo: loveInfo,
      TitleAssetId: String(cfg.titleAssetId || LOVE_TITLE_ASSET_ID[loveId] || ''),
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
    const currentLevel = await levelForExp(loveId, progress.exp);
    const levelInfos = await loveLevelInfos(loveId, currentLevel);
    const last = progress.lastReceiveTime;
    // Sandbox: heal existing accounts the moment a Love screen opens, before
    // the player taps an episode. Only master-defined Love items are touched.
    let updated: Decoded | null = null;
    if (isSandbox()) {
      const itemIds = [
        String(itemInfo.StoryReadItemId ?? ''),
        String(itemInfo.HiddenFavorabilityObtainItemId ?? ''),
        String(itemInfo.LessonPromoteItemId ?? ''),
      ].filter((id) => id !== '');
      const items = await withPlayerTx(pl.id, async (tx) => {
        const out: Decoded[] = [];
        for (const itemId of itemIds) {
          const amount = await getItemAmount(pl.id, itemId, tx);
          if (amount < SANDBOX_CURRENCY) {
            await grantItem(pl.id, itemId, SANDBOX_CURRENCY - amount, tx);
          }
          out.push({
            __msg: USER_ITEM_MSG,
            ItemId: itemId,
            Amount: await getItemAmount(pl.id, itemId, tx),
          } as Decoded);
        }
        return out;
      });
      if (items.length > 0) updated = updatedData(['Items', items]);
    }
    return {
      __msg: '',
      LoveName: String(charCtx.loveChar?.Name ?? charCtx.character?.Name ?? loveId),
      PlayerName: String(progress.name ?? pl.name ?? ''),
      Exp: progress.exp,
      LessonProgress: {
        __msg: LOVE_LESSON_PROGRESS_MSG,
        LastReceiveTime: last,
        MaxRewardTime: last + LESSON_REWARD_WINDOW_MS,
      },
      StoryEpisodeIds: progress.storyEpisodeIds,
      SaveInfo: loveSaveInfo(progress.saveSlots, hasUnlockedEnding(userLove)),
      ItemInfo: itemInfo,
      EventMissionInfos: [],
      LimitedEventMissionInfos: [],
      HiddenFavorability: Number(userLove.HiddenFavorability ?? 0),
      StoryEndInfos: storyEnds,
      LoveLevelInfos: levelInfos,
      BannerAssetId: LOVE_TOP_ASSETS[loveId]?.banner ?? '',
      ExpAssetId: LOVE_TOP_ASSETS[loveId]?.exp ?? '',
      MainCharacterInfo: mainCharacterFromCtx(charCtx),
      LoveSimpleName: String(charCtx.loveChar?.Name ?? charCtx.character?.Name ?? ''),
      CommonResponse: commonResponse(updated),
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

// ---------------------------------------------------------------------------
// Route helpers (solis `common.go` / `finish.go`)
// ---------------------------------------------------------------------------

/** solis `lifecycle.go`: map an episode id back to the love event that owns it. */
function loveIdForEpisode(episodeId: string): string | null {
  for (const loveId of supportedLoveIds()) {
    if (episodeId.startsWith(episodeIdPrefix(loveId))) return loveId;
  }
  return null;
}

/** solis `common.go:59-78` `loadLoveStory`. */
async function loadLoveStory(rpc: string, episodeId: string) {
  const loveId = loveIdForEpisode(episodeId);
  if (!loveId) throw new Error(`${rpc}: love story episode does not exist`);
  const config = loveConfig(loveId);
  const routes = loveRoutes(loveId);
  const episode = await getLoveStoryEpisode(episodeId);
  if (!episode || routes.episodes[episodeId] === undefined) {
    throw new Error(`${rpc}: love story episode does not exist`);
  }
  return { loveId, config, routes, episode };
}

/** solis `common.go:34-36` `loadLove`: the event must be registered first. */
function requireRegistered(rpc: string, progress: LoveProgress): void {
  if (!progress.name || progress.name.trim() === '') {
    throw new Error(`${rpc}: register for the love event first`);
  }
}

/** solis `common.go:80-91` `loveHintLevel`. */
async function loveHintLevel(
  rpc: string,
  config: EventConfig,
  loveId: string,
  exp: number,
  requested: number,
): Promise<number> {
  const level = await levelForExp(loveId, exp);
  let unlocked = 0;
  for (const [hint, required] of Object.entries(config.hintUnlockLevels)) {
    const hintLevel = Number(hint);
    if (level >= Number(required) && hintLevel > unlocked) unlocked = hintLevel;
  }
  if (isSandbox()) {
    // Sandbox profiles allow any hint level (no gate).
    return requested;
  }
  if (requested < 0 || requested > unlocked) {
    throw new Error(`${rpc}: love hint level is not unlocked`);
  }
  return unlocked;
}

/** Wire `LoveSelectStoryChoiceInfo[]` -> route engine selections. */
function parseChoiceSelections(request: Decoded | null): StoryChoiceSelection[] {
  const list = request?.SelectStoryChoiceInfos;
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    const item = entry as Decoded;
    return {
      groupIndex: Number(item?.GroupIndex ?? 0),
      index: Number(item?.Index ?? 0),
      isValid: item?.IsValid === true || Number(item?.IsValid ?? 0) !== 0,
    };
  });
}

/** solis `finish.go:102-109` `truncateLoveRoute`. */
function truncateLoveRoute(
  storyEpisodeIds: string[],
  selections: LoveStorySelection[],
  episodeId: string,
): { storyEpisodeIds: string[]; selections: LoveStorySelection[] } {
  const index = storyEpisodeIds.indexOf(episodeId);
  if (index < 0) return { storyEpisodeIds: [...storyEpisodeIds], selections: [...selections] };
  const previousEpisodes = new Set(storyEpisodeIds.slice(0, index));
  return {
    storyEpisodeIds: storyEpisodeIds.slice(0, index + 1),
    selections: selections.filter((selection) => previousEpisodes.has(selection.storyEpisodeId)),
  };
}

/** solis `common.go:159-165` `adjustLoveFavorability` (safe-integer check). */
function addFavorability(userLove: Decoded, delta: number): void {
  const current = Number(userLove.HiddenFavorability ?? 0);
  const next = current + delta;
  if (!Number.isSafeInteger(next)) throw new Error('love favorability overflows');
  userLove.HiddenFavorability = next;
}

function asRpcError(rpc: string, err: unknown): Error {
  if (err instanceof MoshikoiError) return new Error(`${rpc}: ${err.message}`);
  return err instanceof Error ? err : new Error(`${rpc}: ${String(err)}`);
}

/** `Love:Start` / `Love:Restart` — solis `common.go:93-139`. */
async function startHandler(ctx: RpcContext): Promise<Decoded> {
  const accountId = accountOf(ctx);
  const episodeId = String(ctx.request?.StoryEpisodeId ?? '');
  const restart = ctx.name === 'Love:Restart';
  const pl = await playerForAccount(accountId, ctx.name);
  const { loveId, config, routes, episode } = await loadLoveStory(ctx.name, episodeId);

  const out = await withPlayerTx(pl.id, async (tx) => {
    const progress = await getProgress(pl.id, loveId, tx);
    requireRegistered(ctx.name, progress);
    const requestedHint = Number(ctx.request?.HintLevel ?? 0);
    const hintLevel = await loveHintLevel(ctx.name, config, loveId, progress.exp, requestedHint);
    const userLove = await getUserLove(pl.id, loveId, tx);

    if (!progress.storyEpisodeIds.includes(episodeId)) {
      throw new Error(`${ctx.name}: story episode is not on the current route`);
    }
    if (!isSandbox()) {
      const required = config.episodeUnlockLevels[Number(episode.Episode ?? 0)];
      const level = await levelForExp(loveId, progress.exp);
      if (required === undefined || level < required) {
        throw new Error(`${ctx.name}: love level is too low for this episode`);
      }
    }
    if (restart) {
      if (!userLove.IsReadingStory || progress.activeStoryEpisodeId !== episodeId) {
        throw new Error(`${ctx.name}: story episode is not being read`);
      }
    } else if (userLove.IsReadingStory && progress.activeStoryEpisodeId !== episodeId) {
      throw new Error(`${ctx.name}: another story episode is being read`);
    }

    let items: Decoded | null = null;
    if (!restart && !userLove.IsReadingStory) {
      const cost = episode.ConsumptionItemAmount == null ? 0 : Number(episode.ConsumptionItemAmount);
      const itemId = `${loveItemBase(loveId)}-story`;
      const unlocked = (userLove.UnlockedLoveStoryEndIDs as string[] | null) ?? [];
      if (cost > 0 && !allEndingsUnlocked(routes, unlocked)) {
        if (isSandbox()) {
          // Sandbox: reading never spends Love story keys. Top the key up to the
          // sandbox ceiling (only when master defines the item) and report the
          // resulting amount, matching the paid path's response shape.
          if (await getItem(itemId)) {
            const current = await getItemAmount(pl.id, itemId, tx);
            if (current < SANDBOX_CURRENCY) {
              await grantItem(pl.id, itemId, SANDBOX_CURRENCY - current, tx);
            }
            items = {
              __msg: USER_ITEM_MSG,
              ItemId: itemId,
              Amount: await getItemAmount(pl.id, itemId, tx),
            } as Decoded;
          }
        } else {
          const current = await getItemAmount(pl.id, itemId, tx);
          if (current < cost) {
            throw new Error(`${ctx.name}: love story points are insufficient`);
          }
          await spendItem(pl.id, itemId, cost, tx);
          items = {
            __msg: USER_ITEM_MSG,
            ItemId: itemId,
            Amount: await getItemAmount(pl.id, itemId, tx),
          } as Decoded;
        }
      }
      userLove.IsReadingStory = true;
      await putUserLove(pl.id, userLove, tx);
      await saveProgress(
        pl.id,
        loveId,
        {
          storyEpisodeIds: progress.storyEpisodeIds,
          activeStoryEpisodeId: episodeId,
          lastPlayTime: Date.now(),
        },
        tx,
      );
    }

    return {
      userLove,
      items,
      hintLevel,
      pastSelections: progress.pastSelections,
      selections: progress.selections,
    };
  });

  const choiceGroupInfos = choiceInfos(routes, episodeId, out.pastSelections, out.hintLevel);
  const advBranchInfos = branchInfos(routes, episodeId, out.selections);
  ctx.fastifyReq.log.info({ accountId, loveId, episodeId, restart }, 'love adv start');
  return {
    __msg: '',
    StoryChoiceGroupInfos: choiceGroupInfos,
    AdvBranchInfos: advBranchInfos,
    CommonResponse: commonResponse(
      out.items
        ? updatedData(['Loves', [out.userLove]], ['Items', [out.items]])
        : updatedData(['Loves', [out.userLove]]),
    ),
  } as Decoded;
}

register('Love:Start', startHandler, { ownsState: true });
register('Love:Restart', startHandler, { ownsState: true });

/** `Love:Finish` — solis `finish.go:20-98`, plus sumire's existing story reward. */
register(
  'Love:Finish',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const episodeId = String(ctx.request?.StoryEpisodeId ?? '');
    if (!episodeId) throw new Error('Love:Finish: missing StoryEpisodeId');
    const pl = await playerForAccount(accountId, 'Love:Finish');
    const { loveId, config, routes, episode } = await loadLoveStory('Love:Finish', episodeId);
    const storyId = episode.StoryId == null ? '' : String(episode.StoryId);
    const story = storyId ? await getStory(storyId) : null;

    const out = await withPlayerTx(pl.id, async (tx) => {
      const progress = await getProgress(pl.id, loveId, tx);
      requireRegistered('Love:Finish', progress);
      const requestedHint = Number(ctx.request?.HintLevel ?? 0);
      await loveHintLevel('Love:Finish', config, loveId, progress.exp, requestedHint);
      const userLove = await getUserLove(pl.id, loveId, tx);

      if (!userLove.IsReadingStory || progress.activeStoryEpisodeId !== episodeId) {
        throw new Error('Love:Finish: story episode is not being read');
      }
      if (!progress.storyEpisodeIds.includes(episodeId)) {
        throw new Error('Love:Finish: active episode is not on the current route');
      }

      let selected: LoveStorySelection[];
      try {
        selected = selectChoices(routes, episodeId, parseChoiceSelections(ctx.request)).map(
          (choice) => ({
            storyEpisodeId: episodeId,
            groupIndex: choice.groupIndex,
            index: choice.index,
          }),
        );
      } catch (err) {
        throw asRpcError('Love:Finish', err);
      }

      const previousScore = favorability(routes, progress.selections);
      const truncated = truncateLoveRoute(progress.storyEpisodeIds, progress.selections, episodeId);
      const selections = [...truncated.selections, ...selected];
      const pastSelections = [...progress.pastSelections];
      for (const selection of selected) {
        const known = pastSelections.some(
          (past) =>
            past.storyEpisodeId === selection.storyEpisodeId &&
            past.groupIndex === selection.groupIndex &&
            past.index === selection.index,
        );
        if (!known) pastSelections.push(selection);
      }

      let nextEpisodeId = '';
      let endingId = '';
      try {
        ({ nextEpisodeId, endingId } = resolve(routes, episodeId, selections));
      } catch (err) {
        throw asRpcError('Love:Finish', err);
      }

      let storyEndName = '';
      let endRollAssetId = '';
      let unlockNow = false;
      let finalSelections = selections;
      let storyEpisodeIds: string[];
      if (endingId !== '') {
        const ending = routes.endings.find((candidate) => candidate.id === endingId);
        if (!ending) throw new Error('Love:Finish: story ending is not configured');
        storyEndName = ending.name;
        endRollAssetId = ending.endRollAssetId ?? '';
        const unlocked = (userLove.UnlockedLoveStoryEndIDs as string[] | null) ?? [];
        if (!unlocked.includes(endingId)) {
          unlockNow = unlocked.length === 0;
          userLove.UnlockedLoveStoryEndIDs = [...unlocked, endingId];
          addFavorability(userLove, ending.favorability);
        }
        // solis `finish.go:65-67`: an ending restarts the route at episode 1.
        finalSelections = [];
        storyEpisodeIds = [firstEpisodeId(loveId)];
      } else {
        storyEpisodeIds = nextEpisodeId
          ? [...truncated.storyEpisodeIds, nextEpisodeId]
          : truncated.storyEpisodeIds;
      }

      addFavorability(userLove, favorability(routes, finalSelections) - previousScore);

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
      await putUserLove(pl.id, userLove, tx);
      updated.Loves = [userLove];

      let readEpisodeIds = progress.readEpisodeIds.includes(episodeId)
        ? progress.readEpisodeIds
        : [...progress.readEpisodeIds, episodeId];
      let saveUnlocked = progress.saveUnlocked;
      if (unlockNow) {
        saveUnlocked = true;
        readEpisodeIds = [];
      }
      await saveProgress(
        pl.id,
        loveId,
        {
          storyEpisodeIds,
          selections: finalSelections,
          pastSelections,
          activeStoryEpisodeId: '',
          readEpisodeIds,
          saveUnlocked,
          lastPlayTime: Date.now(),
        },
        tx,
      );
      return {
        rewards,
        updated,
        isEnding: endingId !== '',
        storyEndName,
        endRollAssetId,
        unlockNow,
      };
    });

    ctx.fastifyReq.log.info(
      { accountId, loveId, episodeId, isEnding: out.isEnding, rewarded: out.rewards.length > 0 },
      'love adv finish',
    );
    return {
      __msg: '',
      Rewards: out.rewards,
      StoryEndName: out.storyEndName,
      UnlockSave: out.unlockNow,
      EndRollAssetId: out.endRollAssetId,
      CommonResponse: commonResponse(out.updated),
    } as Decoded;
  },
  { ownsState: true },
);

/** solis `common.go:141-157` `validateLoveSave`. */
function validateLoveSave(rpc: string, userLove: Decoded, slotNumber: number): void {
  if (!hasUnlockedEnding(userLove)) {
    throw new Error(`${rpc}: clear an ending to unlock save slots`);
  }
  if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > LOVE_SAVE_SLOT_NUM) {
    throw new Error(`${rpc}: invalid love save slot`);
  }
}

/** `Love:Save` — solis `save.go:15-48`: snapshot the whole current route. */
register(
  'Love:Save',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const loveId = String(ctx.request?.LoveId ?? '');
    const slotNumber = Number(ctx.request?.SlotNumber ?? 0);
    if (!loveId) throw new Error('Love:Save: missing LoveId');
    const pl = await playerForAccount(accountId, 'Love:Save');
    await withPlayerTx(pl.id, async (tx) => {
      const progress = await getProgress(pl.id, loveId, tx);
      requireRegistered('Love:Save', progress);
      const userLove = await getUserLove(pl.id, loveId, tx);
      validateLoveSave('Love:Save', userLove, slotNumber);
      if (userLove.IsReadingStory) {
        throw new Error('Love:Save: finish reading before saving');
      }
      const slots = [...progress.saveSlots];
      const existing = slots.find((s) => s.slotNumber === slotNumber);
      const slot: LoveSaveSlot = {
        slotNumber,
        saveTime: Date.now(),
        latestStoryEpisodeId:
          progress.storyEpisodeIds[progress.storyEpisodeIds.length - 1] ?? '',
        // solis keeps an existing slot name when overwriting.
        name: existing?.name ?? '',
        storyEpisodeIds: [...progress.storyEpisodeIds],
        selections: [...progress.selections],
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

/** `Love:Load` — solis `load.go:17-55`: restore the saved route and choices. */
register(
  'Love:Load',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const loveId = String(ctx.request?.LoveId ?? '');
    const slotNumber = Number(ctx.request?.SlotNumber ?? 0);
    if (!loveId) throw new Error('Love:Load: missing LoveId');
    const pl = await playerForAccount(accountId, 'Love:Load');
    const out = await withPlayerTx(pl.id, async (tx) => {
      const progress = await getProgress(pl.id, loveId, tx);
      requireRegistered('Love:Load', progress);
      const userLove = await getUserLove(pl.id, loveId, tx);
      validateLoveSave('Love:Load', userLove, slotNumber);
      const slot = progress.saveSlots.find((s) => s.slotNumber === slotNumber);
      if (!slot) throw new Error('Love:Load: save slot is empty');
      if (slot.storyEpisodeIds.length === 0) {
        throw new Error('Love:Load: save slot has no story route');
      }
      const routes = loveRoutes(loveId);
      // solis `load.go:40-46`: only the route-earned favorability is reversed.
      addFavorability(
        userLove,
        favorability(routes, slot.selections) - favorability(routes, progress.selections),
      );
      const storyEpisodeIds = [...slot.storyEpisodeIds];
      userLove.IsReadingStory = false;
      await putUserLove(pl.id, userLove, tx);
      await saveProgress(
        pl.id,
        loveId,
        {
          storyEpisodeIds,
          selections: [...slot.selections],
          activeStoryEpisodeId: '',
          lastPlayTime: Date.now(),
        },
        tx,
      );
      return { storyEpisodeIds, userLove };
    });
    ctx.fastifyReq.log.info({ accountId, loveId, slotNumber }, 'love adv load');
    return {
      __msg: '',
      StoryEpisodeIds: out.storyEpisodeIds,
      CommonResponse: commonResponse(updatedData(['Loves', [out.userLove]])),
    } as Decoded;
  },
  { ownsState: true },
);

/** `Love:Reset` — solis `reset.go:13-41`: rewind the route, keep saves/endings. */
register(
  'Love:Reset',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const loveId = String(ctx.request?.LoveId ?? '');
    if (!loveId) throw new Error('Love:Reset: missing LoveId');
    const pl = await playerForAccount(accountId, 'Love:Reset');
    const out = await withPlayerTx(pl.id, async (tx) => {
      const progress = await getProgress(pl.id, loveId, tx);
      requireRegistered('Love:Reset', progress);
      const userLove = await getUserLove(pl.id, loveId, tx);
      const routes = loveRoutes(loveId);
      // solis `reset.go:25-27`: reverse the route's favorability, nothing else.
      addFavorability(userLove, -favorability(routes, progress.selections));
      const storyEpisodeIds = [firstEpisodeId(loveId)];
      userLove.IsReadingStory = false;
      await putUserLove(pl.id, userLove, tx);
      await saveProgress(
        pl.id,
        loveId,
        {
          storyEpisodeIds,
          selections: [],
          activeStoryEpisodeId: '',
          lastPlayTime: Date.now(),
        },
        tx,
      );
      return { storyEpisodeIds, userLove };
    });
    ctx.fastifyReq.log.info({ accountId, loveId }, 'love adv reset');
    return {
      __msg: '',
      StoryEpisodeIds: out.storyEpisodeIds,
      CommonResponse: commonResponse(updatedData(['Loves', [out.userLove]])),
    } as Decoded;
  },
  { ownsState: true },
);

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
