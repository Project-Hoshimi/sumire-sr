import { desc, eq, lte, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { type Executor } from '../../db/tx.ts';
import { getMaxCardLevel, listCardReleaseDates, master } from '../../master/index.ts';
import { playerLoveProgress, players } from '../../db/schema.ts';
import { getCurrency, grantCurrency, type Currency } from '../../services/currency.ts';
import { newUserCard } from '../../services/inventory.ts';
import {
  collectionElementMsg,
  getSingleton,
  listElements,
  putElements,
  putSingleton,
  removeElements,
  replaceElements,
} from '../../services/playerState.ts';
import {
  existingHistoryPath,
  firstPath,
  terminalMessageDetailId,
  type MessageMaster,
} from '../../services/messagePath.ts';
import { messageReleaseTime } from './messageDates.ts';
import { isSandbox } from '../../profile.ts';
import { clientUnresolvableIds, isClientResolvable } from './clientDenylist.ts';
import { SANDBOX_SHELF_PHOTO_CREATING_ITEM_ID } from './shelf.ts';
import { SANDBOX_SHOWCASE_TOY_AMOUNT } from './showcase.ts';
import {
  applyCardRelease,
  cardReleaseFromRows,
  maxEnhancementLevel,
  type CardReleaseRow,
} from '../../services/cardRelease.ts';
import { applyCardStatsFromParam } from '../../services/card.ts';
import { cardStoryIdsFromRelease } from '../../services/cardStories.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Sandbox account seeding.
 *
 * Grants a maxed-out account from master data:
 *  - every card at the highest level/rarity/rank/evolution the master allows,
 *  - every card skill / live ability / activity ability at the highest level
 *    its master `Levels[]` exposes for that card level,
 *  - every costume, hair, emblem, photo pose/recipe, showcase toy/music, music,
 *    character, with every showcase toy owned SANDBOX_SHOWCASE_TOY_AMOUNT
 *    times,
 *  - no accessories: they are removed from the inventory because the sandbox
 *    does not serve the accessory screens; decorations are granted for every id
 *    a master reward references (decorations have no master table of their own),
 *  - a large amount of every currency (gold, free/paid jewels, stamina).
 *
 * Every step is idempotent: collections are filled by delta, currency is topped
 * up to a cap, and cards are only rewritten when their state is below the
 * master maximum. Calling this twice is safe.
 *
 * The implementation is written for a cold Auth:Create path: master tables are
 * prefetched once and player_entities writes are batched per kind, so seeding
 * ~500 cards does not issue one query per card.
 */

/** Currency / stamina ceiling. The spec permits a named large constant. */
export const SANDBOX_CURRENCY = 9_999_999;

/** Cleared-quest count stamped on every area the sandbox unlocks. */
export const SANDBOX_AREA_CLEAR_COUNT = 9999;

/**
 * Tutorial progress of a real account that has finished the opening tutorial
 * (decoded from `captures/2026-10-09_photo_official/.../User:Get`, a veteran
 * account). Type 1 Step 150 is the opening tutorial; the other entries are the
 * feature-intro tutorials (photo shooting, activities, ...) that must not be
 * replayed on the sandbox account.
 */
const COMPLETED_TUTORIALS: ReadonlyArray<readonly [type: number, step: number]> = [
  [1, 150],
  [2, 1],
  [3, 1],
  [4, 120],
  [5, 1],
  [6, 2],
  [8, 2],
  [9, 2],
  [10, 2],
  [12, 1],
  [16, 1],
  [19, 1],
  [22, 1],
  [38, 1],
  [46, 1],
  [48, 1],
];

/**
 * `master_Item.Type` values a maxed account needs stocked. Type 8 is the
 * gacha-ticket category; the rest are the base crafting/consumable items plus
 * the quest/PvP tickets. Event-only categories (activity boosts, medals,
 * marathon/race points, ...) are deliberately left alone.
 */
const SANDBOX_ITEM_TYPES: ReadonlySet<number> = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 2001, 2002, 2003, 2004, 2005, 2006,
]);

/** Master rows that are placeholders rather than real item ids. */
const INVALID_ITEM_IDS: ReadonlySet<string> = new Set(['-', 'item-FALSE']);

const USER_MSG = 'Solis.Common.Proto.Transaction.User';
const USER_BALANCE_MSG = 'Solis.Common.Proto.Transaction.UserBalance';
const USER_POINT_MSG = 'Solis.Common.Proto.Transaction.UserPoint';
const USER_AREA_MSG = 'Solis.Common.Proto.Transaction.UserArea';
const USER_TUTORIAL_MSG = 'Solis.Common.Proto.Transaction.UserTutorial';
const USER_ITEM_MSG = 'Solis.Common.Proto.Transaction.UserItem';

/** `UserStory.StatusType` value that marks a story as read. */
const STORY_STATUS_READ = 2;

const POINT_GOLD = 1;
const POINT_STAMINA = 4;
/** `PointType.ActivatePhotoShootingStoryTicket`: the photo "Shoot Unlock Ticket". */
const POINT_PHOTO_STORY_TICKET = 7;

/** Card limit-break stops at ★10 in the official implementation. */
const MAX_CARD_RARITY = 10;

const CARD_SKILL_SLOTS = [1, 2, 3, 4] as const;

export const COLLECTION_RESOURCE_TYPES = {
  accessory: 3,
  character: 4,
  costume: 5,
  emblem: 17,
  decoration: 26,
  photoRecipe: 27,
  hair: 28,
  showcaseToy: 32,
  showcaseMusic: 33,
  photoPose: 34,
} as const;

export type SandboxSeedSummary = {
  playerId: string;
  /** Manager level written to the player row / `User` singleton (master max). */
  managerLevel: number;
  /** Tutorial rows added or upgraded to the post-tutorial state. */
  tutorials: number;
  /** Areas added/upgraded to the cleared state. */
  areas: number;
  /** Items topped up to `SANDBOX_CURRENCY`. */
  items: number;
  /** Message rows written as finished (new or upgraded). */
  messages: number;
  /** Telephone rows written as finished (new or upgraded). */
  telephones: number;
  /** Rows removed because the real client cannot resolve them (heal path). */
  unresolvableRemoved: number;
  cardsAdded: number;
  cardsUpdated: number;
  /** Story rows added or upgraded to read (`StatusType = 2`). */
  storiesRead: number;
  costumes: number;
  hairs: number;
  /** `Accessories` rows removed: the sandbox inventory keeps none. */
  accessories: number;
  characters: number;
  charactersRemoved: number;
  companyBond: boolean;
  loveLevels: number;
  emblems: number;
  decorations: number;
  photoRecipes: number;
  photoPoses: number;
  showcaseToys: number;
  showcaseToyAmounts: number;
  showcaseMusics: number;
  musics: number;
  /** `UserHomeTalk` rows added (one per master home talk). */
  homeTalks: number;
  /** `UserExcursionGazeReaction` rows added (one per non-default master row). */
  excursionGazeReactions: number;
};

type CardTarget = {
  level: number;
  rarity: number;
  rank: number;
  evolution: number;
  skillLevels: Record<number, number>;
  liveAbilityLevel: number;
  activityAbilityLevel: number;
};

function idsOf(rows: readonly Record<string, unknown>[], key: string): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const value = row[key];
    if (value != null && String(value)) out.push(String(value));
  }
  return out;
}

export function collectRewardIds(rows: readonly { Resources: unknown }[]): Map<number, Set<string>> {
  const byType = new Map<number, Set<string>>();
  for (const row of rows) {
    for (const resource of (row.Resources as Decoded[] | null) ?? []) {
      const type = Number(resource.ResourceType ?? 0);
      const id = resource.ResourceId == null ? '' : String(resource.ResourceId);
      if (!type || !id) continue;
      const set = byType.get(type) ?? new Set<string>();
      set.add(id);
      byType.set(type, set);
    }
  }
  return byType;
}

function union(...sets: (Iterable<string> | undefined)[]): string[] {
  const out = new Set<string>();
  for (const set of sets) {
    if (!set) continue;
    for (const id of set) if (id) out.add(id);
  }
  return [...out];
}

/** `StoryId`s referenced by a master `Episodes` / `Chapters` jsonb value. */
function storyIdsFromEpisodes(value: unknown): string[] {
  const out: string[] = [];
  for (const episode of Array.isArray(value) ? (value as Decoded[]) : []) {
    const storyId = episode?.StoryId == null ? '' : String(episode.StoryId);
    if (storyId) out.push(storyId);
  }
  return out;
}

/**
 * Fill one player collection (keyed by `key`) with any missing ids.
 *
 * Ids whose master row the real client cannot resolve are skipped: the client
 * throws `NullReferenceException` in `<Type>Master.FindByKey` while
 * initialising user data and never reaches the home screen
 * (`./clientDenylist.ts` has the evidence).
 *
 * Returns the number of elements that were added.
 */
async function ensureCollection(
  exec: Executor,
  playerId: string,
  field: string,
  key: string,
  ids: Iterable<string>,
): Promise<number> {
  const wanted = [...new Set(ids)].filter((id) => id && isClientResolvable(field, id));
  if (!wanted.length) return 0;
  const existing = new Set(
    (await listElements(playerId, field, exec)).map((e) => String(e[key] ?? '')),
  );
  const missing = wanted.filter((id) => !existing.has(id));
  if (!missing.length) return 0;
  const msg = collectionElementMsg(field) ?? undefined;
  await putElements(
    playerId,
    field,
    missing.map((id) => ({ __msg: msg, [key]: id }) as Decoded),
    exec,
  );
  return missing.length;
}

/**
 * `ensureCollection` for showcase toys, which also carry a stack size: add the
 * missing ids and raise every owned toy below `amount` copies, in one write.
 * Returns the rows added and the existing rows raised.
 */
async function ensureShowcaseToys(
  exec: Executor,
  playerId: string,
  ids: Iterable<string>,
  amount: number,
): Promise<{ added: number; raised: number }> {
  const wanted = [...new Set(ids)].filter((id) => id && isClientResolvable('ShowcaseToys', id));
  const msg = collectionElementMsg('ShowcaseToys') ?? undefined;
  const owned = await listElements(playerId, 'ShowcaseToys', exec);
  const existing = new Set(owned.map((e) => String(e.ShowcaseToyId ?? '')));
  const added = wanted
    .filter((id) => !existing.has(id))
    .map((id) => ({ __msg: msg, ShowcaseToyId: id, Amount: amount }) as Decoded);
  const raised = owned
    .filter((toy) => Number(toy.Amount ?? 0) < amount)
    .map((toy) => ({ ...toy, __msg: msg, Amount: amount }) as Decoded);
  if (added.length || raised.length) {
    await putElements(playerId, 'ShowcaseToys', [...added, ...raised], exec);
  }
  return { added: added.length, raised: raised.length };
}

/** Deck-position fields that reference an accessory. */
const DECK_ACCESSORY_FIELDS = ['Part1AccessoryId', 'Part2AccessoryId'] as const;

/**
 * Remove every accessory from the sandbox inventory and clear the accessory
 * references on the player's decks. The sandbox blocks the accessory screens,
 * so an owned accessory could never be viewed or used.
 *
 * Returns the number of `Accessories` rows removed.
 */
async function removeSandboxAccessories(exec: Executor, playerId: string): Promise<number> {
  const accessories = await listElements(playerId, 'Accessories', exec);
  if (accessories.length) await replaceElements(playerId, 'Accessories', [], exec);

  // Deck positions live in `DeckPositions` (normal decks) and
  // `LeagueDeckPositions` (league decks); `Decks` only holds deck metadata.
  for (const field of ['DeckPositions', 'LeagueDeckPositions']) {
    const positions = await listElements(playerId, field, exec);
    const cleared = positions
      .map((position) => {
        const next = { ...position } as Decoded;
        let changed = false;
        for (const key of DECK_ACCESSORY_FIELDS) {
          if (next[key] == null || String(next[key]) === '') continue;
          delete next[key];
          changed = true;
        }
        return changed ? next : null;
      })
      .filter((position): position is Decoded => position !== null);
    if (cleared.length) await putElements(playerId, field, cleared, exec);
  }

  return accessories.length;
}

/**
 * Unlock every master home talk. `UserHomeTalk` only carries `HomeTalkId`; the
 * client treats the element as "already seen", so `Home:ReadTalk` and the home
 * screen never show an unreachable talk in the sandbox.
 */
async function ensureHomeTalks(exec: Executor, playerId: string): Promise<number> {
  const rows = await exec
    .select({ HomeTalkId: master.masterHomeTalk.HomeTalkId })
    .from(master.masterHomeTalk);
  return ensureCollection(
    exec,
    playerId,
    'HomeTalks',
    'HomeTalkId',
    rows.map((row) => String(row.HomeTalkId ?? '')),
  );
}

/**
 * Unlock every non-default excursion gaze reaction. The client only needs the
 * `(CharacterId, ExcursionPlaceId, GazeReactionNumber)` key; `Number = 0` is the
 * implicit idle reaction and is deliberately left unseeded.
 */
async function ensureExcursionGazeReactions(exec: Executor, playerId: string): Promise<number> {
  const rows = await exec
    .select({
      CharacterId: master.masterExcursionGazeReaction.CharacterId,
      ExcursionPlaceId: master.masterExcursionGazeReaction.ExcursionPlaceId,
      Number: master.masterExcursionGazeReaction.Number,
    })
    .from(master.masterExcursionGazeReaction);

  const wanted = rows
    .filter((row) => Number(row.Number) > 0)
    .map((row) => ({
      CharacterId: String(row.CharacterId ?? ''),
      ExcursionPlaceId: String(row.ExcursionPlaceId ?? ''),
      GazeReactionNumber: Number(row.Number),
    }))
    .filter(
      (row) =>
        row.CharacterId !== '' &&
        row.ExcursionPlaceId !== '' &&
        Number.isInteger(row.GazeReactionNumber),
    );
  if (!wanted.length) return 0;

  const keyOf = (row: {
    CharacterId: string;
    ExcursionPlaceId: string;
    GazeReactionNumber: number;
  }) => `${row.CharacterId}\u0001${row.ExcursionPlaceId}\u0001${row.GazeReactionNumber}`;

  const existing = new Set(
    (await listElements(playerId, 'ExcursionGazeReactions', exec)).map((row) =>
      keyOf({
        CharacterId: String(row.CharacterId ?? ''),
        ExcursionPlaceId: String(row.ExcursionPlaceId ?? ''),
        GazeReactionNumber: Number(row.GazeReactionNumber ?? 0),
      }),
    ),
  );
  const missing = wanted.filter((row) => !existing.has(keyOf(row)));
  if (!missing.length) return 0;

  const msg = collectionElementMsg('ExcursionGazeReactions') ?? undefined;
  await putElements(
    playerId,
    'ExcursionGazeReactions',
    missing.map((row) => ({ __msg: msg, ...row }) as Decoded),
    exec,
  );
  return missing.length;
}

/**
 * Drop collection elements that are already seeded but that the client cannot
 * resolve, so accounts created by an older seed heal on re-seed.
 */
async function pruneUnresolvable(
  exec: Executor,
  playerId: string,
  field: string,
  key: string,
): Promise<number> {
  const ids = clientUnresolvableIds(field);
  if (!ids.length) return 0;
  const owned = new Set(
    (await listElements(playerId, field, exec)).map((e) => String(e[key] ?? '')),
  );
  const present = ids.filter((id) => owned.has(id));
  if (!present.length) return 0;
  await removeElements(
    playerId,
    field,
    present.map((id) => ({ __msg: collectionElementMsg(field) ?? undefined, [key]: id }) as Decoded),
    exec,
  );
  return present.length;
}

/**
 * Seed every master character with its default outfit.
 *
 * Characters hold the equipped cosmetics (`Favorite*` for the home outfit,
 * `Live*` for the live outfit). A row carrying only `CharacterId` makes the
 * client's `UserCharacter.GetHair` fall back to the default hair of a null
 * costume, which throws during home actor creation and leaves the client stuck
 * on the loading screen. Existing choices are never overwritten: only empty
 * fields are filled, so a re-seed stays a no-op.
 *
 * Idols below activity level 1 are raised to the top level with full stamina:
 * the client looks up `CharacterActivityLevel` by `ActivityLevel` to compute
 * `CurrentActivityStamina`, and level 0 has no row, so the Promotion, Refresh
 * and Fan Event idol-select screens throw and freeze.
 *
 * Trust and bond are raised to the master maximum so every trust-gated home
 * voiceline, message and bond page is unlocked (see SANDBOX_RELIABILITY).
 */
/**
 * Per-idol trust (`UserCharacter.Reliability`, 信頼度). It is a raw counter:
 * HomeTalk, MessageDetail and the `ConditionReliability` gates compare against
 * it, and the highest master threshold is 900.
 */
const SANDBOX_RELIABILITY = 900;
/** Per-idol bond (交流) points: CompanyEnjoyCharacterLevel Lv60 needs 8325. */
const SANDBOX_BOND_POINTS = 8325;
/** Overall company bond: CompanyEnjoyLevel Lv50 needs 56800. */
const SANDBOX_COMPANY_ENJOY_POINTS = 56800;

/**
 * Raise every もし恋 (Love) route to its top `LoveLevel` by setting its lesson
 * exp to that level's `RequiredExp`. The level gates which episode can be
 * played; episodes still open one by one as they are read. The protagonist
 * name stays unset, so the client still runs Love:Register first.
 */
async function ensureLoveLevels(exec: Executor, playerId: string): Promise<number> {
  const tops = await exec
    .select({
      LoveId: master.masterLoveLevel.LoveId,
      exp: sql<number>`max(${master.masterLoveLevel.RequiredExp})`.mapWith(Number),
    })
    .from(master.masterLoveLevel)
    .groupBy(master.masterLoveLevel.LoveId);
  const rows = tops.filter((t) => t.LoveId && t.exp > 0);
  if (rows.length === 0) return 0;
  const written = await exec
    .insert(playerLoveProgress)
    .values(rows.map((t) => ({ id: randomUUID(), playerId, loveId: t.LoveId, exp: t.exp })))
    .onConflictDoUpdate({
      target: [playerLoveProgress.playerId, playerLoveProgress.loveId],
      set: { exp: sql`excluded.exp`, updatedAt: new Date() },
      where: sql`${playerLoveProgress.exp} < excluded.exp`,
    })
    .returning({ id: playerLoveProgress.id });
  return written.length;
}

/** Raise the company-wide bond to the top `CompanyEnjoyLevel`. */
async function ensureCompanyBond(exec: Executor, playerId: string): Promise<boolean> {
  const company =
    (await getSingleton(playerId, 'Company', exec)) ??
    ({ __msg: 'Solis.Common.Proto.Transaction.UserCompany' } as Decoded);
  if (Number(company.EnjoyPoint ?? 0) >= SANDBOX_COMPANY_ENJOY_POINTS) return false;
  company.EnjoyPoint = SANDBOX_COMPANY_ENJOY_POINTS;
  await putSingleton(playerId, 'Company', company, exec);
  return true;
}

/**
 * Master `Character.Type`: 1 = main idols, 3 = Mana, 4 = collab idols
 * (Miku, Aqours, GochiUsa); 2 = story NPCs and one-off guests. Owning an NPC
 * row puts it in the trust list and the lobby idol picker as a faceless or
 * duplicate entry (Satomi alone has six rows), so the sandbox owns only the
 * idols plus Satomi's base row and her first idol row (`char-stm1`, so players
 * can pick either look) and `char-koh` (Kohei, the other story NPC with a 3D
 * body of his own). Satomi's other four rows (`stm2`-`stm5`) stay out because
 * they would show as duplicates. `char-mng`, the story's ghost Mana, stays
 * out: owned, she shows up broken in game. The Dorikyun duo (`char-lmn`,
 * `char-lim`) is owned too: they have no official master rows but the client
 * ships their 3D model bundles, and master rows are synthesized in Phase A2.
 */
const SANDBOX_IDOL_TYPES: ReadonlySet<number> = new Set([1, 3, 4]);
const SANDBOX_EXTRA_CHARACTERS: ReadonlySet<string> = new Set([
  'char-stm',
  'char-stm1',
  'char-koh',
  'char-lmn',
  'char-lim',
]);

/** Whether the sandbox account should own master character `row`. */
export function isSandboxCharacter(row: { Id: unknown; Type: unknown }): boolean {
  const id = row.Id == null ? '' : String(row.Id);
  if (!id || !isClientResolvable('Characters', id)) return false;
  return SANDBOX_IDOL_TYPES.has(Number(row.Type)) || SANDBOX_EXTRA_CHARACTERS.has(id);
}

/** Drop owned characters the sandbox no longer grants (older seeds owned all). */
async function pruneCharacters(
  exec: Executor,
  playerId: string,
  keep: ReadonlySet<string>,
): Promise<number> {
  const extra = (await listElements(playerId, 'Characters', exec)).filter(
    (c) => !keep.has(String(c.CharacterId ?? '')),
  );
  if (extra.length) await removeElements(playerId, 'Characters', extra, exec);
  return extra.length;
}

async function ensureCharacters(
  exec: Executor,
  playerId: string,
  rows: readonly { Id: unknown; DefaultCostumeId: unknown }[],
  defaultHairByCostume: ReadonlyMap<string, string>,
  topActivityLevel: { Level: number; RequiredExp: number; MaxStamina: number } | undefined,
  fanFloors: ReadonlyMap<string, number>,
): Promise<number> {
  const existing = new Map(
    (await listElements(playerId, 'Characters', exec)).map((c) => [
      String(c.CharacterId ?? ''),
      c,
    ]),
  );
  const msg = collectionElementMsg('Characters') ?? undefined;
  const writes: Decoded[] = [];
  for (const row of rows) {
    const characterId = row.Id == null ? '' : String(row.Id);
    if (!characterId) continue;
    const costumeId = row.DefaultCostumeId == null ? '' : String(row.DefaultCostumeId);
    const hairId = costumeId ? (defaultHairByCostume.get(costumeId) ?? '') : '';
    const current = existing.get(characterId);
    const next = (current ? { ...current } : { __msg: msg, CharacterId: characterId }) as Decoded;
    let changed = !current;
    const defaults: Array<[string, string]> = [
      ['FavoriteCostumeId', costumeId],
      ['LiveCostumeId', costumeId],
      ['FavoriteHairId', hairId],
      ['LiveHairId', hairId],
    ];
    for (const [field, value] of defaults) {
      if (!value || String(next[field] ?? '')) continue;
      next[field] = value;
      changed = true;
    }
    if (topActivityLevel && Number(next.ActivityLevel ?? 0) < 1) {
      next.ActivityLevel = topActivityLevel.Level;
      next.ActivityExp = topActivityLevel.RequiredExp;
      next.ActivityStamina = topActivityLevel.MaxStamina;
      next.StaminaUpdatedTime = Date.now();
      changed = true;
    }
    if (Number(next.Reliability ?? 0) < SANDBOX_RELIABILITY) {
      next.Reliability = SANDBOX_RELIABILITY;
      changed = true;
    }
    if (Number(next.CompanyEnjoyPoint ?? 0) < SANDBOX_BOND_POINTS) {
      next.CompanyEnjoyPoint = SANDBOX_BOND_POINTS;
      changed = true;
    }
    // Fan gates: keep any larger existing count, raise all three tiers to the
    // character's highest master threshold. See fanAmountFloors for the
    // single-tier-vs-sum ambiguity.
    const fanFloor = Math.min(fanFloors.get(characterId) ?? 0, INT32_MAX);
    if (fanFloor > 0) {
      for (const field of FAN_AMOUNT_FIELDS) {
        if (Number(next[field] ?? 0) >= fanFloor) continue;
        next[field] = fanFloor;
        changed = true;
      }
    }
    if (changed) writes.push(next);
  }
  if (writes.length) await putElements(playerId, 'Characters', writes, exec);
  return writes.length;
}

/**
 * Highest `ConditionFanAmount.AmountGte` required for each character across
 * `master_Condition`. The client dump (`phase3d_603/dump_net/dump.cs`) only has
 * an empty `GetTotalFanAmount()` stub, so it is impossible to tell whether the
 * condition reads a single fan tier or their sum. Giving Light/Middle/Heavy the
 * same floor passes either interpretation. The master maximum is 100000.
 */
const FAN_AMOUNT_FIELDS = ['LightFanAmount', 'MiddleFanAmount', 'HeavyFanAmount'] as const;
const INT32_MAX = 2_147_483_647;

async function fanAmountFloors(exec: Executor): Promise<Map<string, number>> {
  // `master_Condition` is not part of the curated Drizzle master schema.
  const rows = (await exec.execute(
    sql`select "Settings" from "master_Condition"`,
  )) as unknown as Array<{ Settings: unknown }>;
  const floors = new Map<string, number>();
  for (const row of rows) {
    if (!Array.isArray(row.Settings)) continue;
    for (const rawSetting of row.Settings) {
      const fan = (rawSetting as Decoded | null)?.FanAmount as Decoded | undefined;
      if (!fan) continue;
      const characterId = String(fan.CharacterId ?? '');
      const amount = Number(fan.AmountGte ?? 0);
      if (!characterId || !Number.isFinite(amount)) continue;
      floors.set(characterId, Math.max(floors.get(characterId) ?? 0, amount));
    }
  }
  return floors;
}

/** Highest master row for a numeric key. */
function maxRow<T extends Record<string, unknown>>(rows: readonly T[], key: string): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (best === null || Number(row[key] ?? 0) > Number(best[key] ?? 0)) best = row;
  }
  return best;
}

/** Per-card evolution maximum from `CardEvolutionLevel` (rows without Exp are level 0). */
function evolutionMaxima(
  rows: readonly Record<string, unknown>[],
): Map<string, { level: number; exp: number }> {
  const out = new Map<string, { level: number; exp: number }>();
  for (const row of rows) {
    const group = row.GroupId == null ? '' : String(row.GroupId);
    const level = Number(row.Level ?? 0);
    const exp = row.Exp == null ? null : Number(row.Exp);
    if (!group || exp === null) continue;
    const current = out.get(group);
    if (!current || level > current.level) out.set(group, { level, exp });
  }
  return out;
}

/** Group release rows by their `Id` / `GroupId`. */
function groupById<T extends Record<string, unknown>>(
  rows: readonly T[],
  key: string,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const id = row[key] == null ? '' : String(row[key]);
    if (!id) continue;
    const list = out.get(id) ?? [];
    list.push(row);
    out.set(id, list);
  }
  return out;
}

/** Highest card parameter row at or below `level`, keyed by parameter id. */
function parameterMaxima(
  rows: readonly Record<string, unknown>[],
  level: number,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (Number(row.Level ?? 0) > level) continue;
    const id = row.Id == null ? '' : String(row.Id);
    if (!id) continue;
    const current = out.get(id);
    if (!current || Number(row.Level ?? 0) > Number(current.Level ?? 0)) out.set(id, row);
  }
  return out;
}

function enhancementLevels(row: Decoded | undefined): Record<string, unknown>[] {
  return ((row?.Levels as Record<string, unknown>[] | null) ?? []).filter(
    (l) => l && typeof l === 'object',
  );
}

/**
 * Whether an owned card is still below any of the master maxima. The skill /
 * ability checks are what upgrade accounts seeded by the previous version
 * (max level/rarity/rank, but all enhancement levels stuck at 1).
 */
function belowMaximum(card: Decoded, target: CardTarget): boolean {
  if (
    Number(card.Level ?? 1) < target.level ||
    Number(card.BaseLevel ?? 1) < target.level ||
    Number(card.Rarity ?? 0) < target.rarity ||
    Number(card.Rank ?? 0) < target.rank ||
    Number(card.EvolutionLevel ?? 0) < target.evolution
  ) {
    return true;
  }
  for (const slot of CARD_SKILL_SLOTS) {
    const wanted = target.skillLevels[slot] ?? 0;
    if (wanted <= 0) continue;
    if (
      Number(card[`SkillLevel${slot}`] ?? 0) < wanted ||
      Number(card[`BaseSkillLevel${slot}`] ?? 0) < wanted
    ) {
      return true;
    }
  }
  if (target.liveAbilityLevel > 0) {
    if (
      Number(card.LiveAbilityLevel ?? 0) < target.liveAbilityLevel ||
      Number(card.BaseLiveAbilityLevel ?? 0) < target.liveAbilityLevel
    ) {
      return true;
    }
  }
  if (target.activityAbilityLevel > 0) {
    if (
      Number(card.ActivityAbilityLevel ?? 0) < target.activityAbilityLevel ||
      Number(card.BaseActivityAbilityLevel ?? 0) < target.activityAbilityLevel
    ) {
      return true;
    }
  }
  return false;
}

/** Highest manager level in the master table (`master_ManagerLevel`). */
async function maxManagerLevel(exec: Executor): Promise<number> {
  // The table is not part of the Drizzle master schema (only the tables the
  // handlers need are modelled), so read it with raw SQL.
  const rows = (await exec.execute(
    sql`select coalesce(max("Level"), 1) as level from "master_ManagerLevel"`,
  )) as unknown as Array<{ level: number | string | null }>;
  const level = Number(rows[0]?.level ?? 0);
  return Number.isFinite(level) && level > 0 ? level : 1;
}

/** Every area id in `master_Area`. */
async function allAreaIds(exec: Executor): Promise<string[]> {
  const rows = (await exec.execute(
    sql`select "Id" from "master_Area"`,
  )) as unknown as Array<{ Id: string | null }>;
  return rows.map((row) => String(row.Id ?? '')).filter(Boolean);
}

type AccountProgressSummary = {
  managerLevel: number;
  tutorials: number;
  areas: number;
  items: number;
  messages: number;
  telephones: number;
  homeTalks: number;
  excursionGazeReactions: number;
};

const MESSAGE_STATUS_FINISHED = 4;
const TELEPHONE_STATUS_FINISHED = 4;
const MESSAGE_PROGRESS_FIELD = 'MessageProgress';

function messageDetailIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function findMessageDetail(master: MessageMaster, detailId: string) {
  return master.Details?.find((detail) => String(detail.MessageDetailId ?? '') === detailId) ?? null;
}

function isTerminalDetail(master: MessageMaster, detailId: string): boolean {
  const detail = findMessageDetail(master, detailId);
  return Boolean(detail && (detail.NextMessageDetailIds?.length ?? 0) === 0);
}

/**
 * Sandbox equivalent of Solis' god "all" narrative branch: every master message
 * is finished with its first-path choices and every master telephone is
 * finished. Existing rows are preserved when they are still valid, so a re-run
 * neither changes selections nor rewrites timestamps.
 */
async function ensureMessagesAndTelephones(
  exec: Executor,
  playerId: string,
  now: number,
): Promise<{ messages: number; telephones: number }> {
  const existingMessages = await listElements(playerId, 'Messages', exec);
  const existingMessagesById = new Map(
    existingMessages.map((message) => [String(message.MessageId ?? ''), message]),
  );

  const rawProgress = await getSingleton(playerId, MESSAGE_PROGRESS_FIELD, exec);
  const progress: Record<string, { LastMessageDetailId: string; LastMessageDetailTime: number }> = {};
  if (rawProgress) {
    for (const [messageId, value] of Object.entries(rawProgress)) {
      if (messageId === '__msg' || messageId === '__unknown') continue;
      if (!value || typeof value !== 'object') continue;
      const entry = value as { LastMessageDetailId?: unknown; LastMessageDetailTime?: unknown };
      progress[messageId] = {
        LastMessageDetailId: String(entry.LastMessageDetailId ?? ''),
        LastMessageDetailTime: Number(entry.LastMessageDetailTime ?? 0),
      };
    }
  }
  let progressChanged = false;

  // Master order is by id, so the launch fallback's per-group minutes are
  // stable across seeds. Card release dates and embedded-call owners come from
  // master data too; the pure resolver only sees plain maps.
  const cardReleaseDates = await listCardReleaseDates();
  const messageMasters = await exec
    .select()
    .from(master.masterMessage)
    .orderBy(master.masterMessage.Id);
  const messageGroupIndexes = new Map<string, number>();
  const messageTimes = new Map<string, number>();
  const telephoneParents = new Map<string, string>();
  for (const row of messageMasters) {
    const messageMaster = row as unknown as MessageMaster;
    const messageId = String(messageMaster.Id ?? '');
    if (!messageId) continue;
    const groupId = String(messageMaster.MessageGroupId ?? '');
    const groupIndex = (messageGroupIndexes.get(groupId) ?? 0) + 1;
    messageGroupIndexes.set(groupId, groupIndex);
    messageTimes.set(
      messageId,
      messageReleaseTime(messageId, { now, cardReleaseDates, messageTimes, groupIndex }),
    );
    for (const detail of messageMaster.Details ?? []) {
      const telephoneId = String(detail.TelephoneId ?? '');
      if (telephoneId) telephoneParents.set(telephoneId, messageId);
    }
  }

  const messageWrites: Decoded[] = [];
  for (const row of messageMasters) {
    const messageMaster = row as unknown as MessageMaster;
    const messageId = String(messageMaster.Id ?? '');
    if (!messageId) continue;

    const existing = existingMessagesById.get(messageId);
    const arrivedTime = messageTimes.get(messageId) ?? now;

    let selections: string[] = [];
    let terminalId = '';
    const finishedTime = arrivedTime;

    if (existing && Number(existing.MessageStatusType ?? 0) === MESSAGE_STATUS_FINISHED) {
      try {
        const terminal = existingHistoryPath(
          messageMaster,
          messageDetailIds(existing.SelectMessageDetailIds),
        );
        selections = messageDetailIds(existing.SelectMessageDetailIds);
        terminalId = String(terminal.MessageDetailId ?? '');
        const saved = progress[messageId];
        if (saved && isTerminalDetail(messageMaster, saved.LastMessageDetailId)) {
          terminalId = saved.LastMessageDetailId;
        }
      } catch {
        const path = firstPath(messageMaster);
        selections = path.selections;
        terminalId = String(path.terminal.MessageDetailId ?? '');
      }
    } else {
      const path = firstPath(messageMaster);
      selections = path.selections;
      terminalId = String(path.terminal.MessageDetailId ?? '');
    }
    if (!terminalId) terminalId = terminalMessageDetailId(messageMaster);

    const target: Decoded = {
      __msg: 'Solis.Common.Proto.Transaction.UserMessage',
      MessageId: messageId,
      MessageStatusType: MESSAGE_STATUS_FINISHED,
      SelectMessageDetailIds: selections,
      ArrivedTime: arrivedTime,
    };
    const unchanged =
      existing !== undefined &&
      Number(existing.MessageStatusType ?? 0) === MESSAGE_STATUS_FINISHED &&
      Number(existing.ArrivedTime ?? 0) === arrivedTime &&
      sameStringList(messageDetailIds(existing.SelectMessageDetailIds), selections);
    if (!unchanged) messageWrites.push(target);

    const saved = progress[messageId];
    if (
      !saved ||
      saved.LastMessageDetailId !== terminalId ||
      saved.LastMessageDetailTime !== finishedTime
    ) {
      progress[messageId] = {
        LastMessageDetailId: terminalId,
        LastMessageDetailTime: finishedTime,
      };
      progressChanged = true;
    }
  }
  if (messageWrites.length) await putElements(playerId, 'Messages', messageWrites, exec);
  if (progressChanged) {
    await putSingleton(playerId, MESSAGE_PROGRESS_FIELD, progress as Decoded, exec);
  }

  const telephoneMasters = await exec
    .select()
    .from(master.masterTelephone)
    .orderBy(master.masterTelephone.Id);
  const telephoneGroupIndexes = new Map<string, number>();
  const telephoneTimes = new Map<string, number>();
  for (const row of telephoneMasters) {
    const telephoneId = String(row.Id ?? '');
    if (!telephoneId) continue;
    const groupId = String(row.MessageGroupId ?? '');
    const groupIndex = (telephoneGroupIndexes.get(groupId) ?? 0) + 1;
    telephoneGroupIndexes.set(groupId, groupIndex);
    telephoneTimes.set(
      telephoneId,
      messageReleaseTime(telephoneId, {
        now,
        cardReleaseDates,
        messageTimes,
        telephoneParents,
        groupIndex,
      }),
    );
  }

  const existingTelephones = await listElements(playerId, 'Telephones', exec);
  const existingTelephonesById = new Map(
    existingTelephones.map((telephone) => [String(telephone.TelephoneId ?? ''), telephone]),
  );
  const telephoneWrites: Decoded[] = [];
  for (const row of telephoneMasters) {
    const telephoneId = String(row.Id ?? '');
    if (!telephoneId) continue;

    const existing = existingTelephonesById.get(telephoneId);
    const unlockedTime = telephoneTimes.get(telephoneId) ?? now;
    const scheduledTime = unlockedTime;

    const target: Decoded = {
      __msg: 'Solis.Common.Proto.Transaction.UserTelephone',
      TelephoneId: telephoneId,
      UnlockedTime: unlockedTime,
      ScheduledTime: scheduledTime,
      TelephoneStatusType: TELEPHONE_STATUS_FINISHED,
    };
    const unchanged =
      existing !== undefined &&
      Number(existing.TelephoneStatusType ?? 0) === TELEPHONE_STATUS_FINISHED &&
      Number(existing.UnlockedTime ?? 0) === unlockedTime &&
      Number(existing.ScheduledTime ?? 0) === scheduledTime;
    if (!unchanged) telephoneWrites.push(target);
  }
  if (telephoneWrites.length) {
    await putElements(playerId, 'Telephones', telephoneWrites, exec);
  }

  // Every message is finished, so no schedule may remain queued.
  await replaceElements(playerId, 'MessageSchedules', [], exec);

  return { messages: messageWrites.length, telephones: telephoneWrites.length };
}

/**
 * Put a sandbox account in the state of a real account that has finished the
 * opening tutorial and unlocked the end-game menus:
 *
 *  - `User.TutorialClearedTime` + the veteran `Tutorials` list, so the client
 *    neither replays the opening Live nor any feature-intro tutorial,
 *  - the master-max manager level (satisfies every `ManagerLevel` condition in
 *    `master_FunctionLock` / `master_Condition`),
 *  - every master area cleared (most `FunctionLock`s are `ClearArea` gates),
 *  - `Balance` / `Points` persisted, because a fresh sandbox account serves the
 *    fresh `User:Get` template (empty balance, no points) and the fresh path in
 *    `user.ts` does not copy the player row into them,
 *  - the base consumables and every gacha ticket stocked to the ceiling.
 *
 * Idempotent: only rows below the target state are written.
 */
async function seedAccountProgress(
  exec: Executor,
  playerId: string,
  playerName: string,
): Promise<AccountProgressSummary> {
  const now = Date.now();
  const managerLevel = await maxManagerLevel(exec);

  // The player row is authoritative for the non-fresh `User:Get` path and for
  // the manager-level master conditions.
  await exec.update(players).set({ level: managerLevel, exp: 0 }).where(eq(players.id, playerId));

  // `User` singleton: a fresh sandbox account serves this instead of the
  // captured tutorial template, so `TutorialClearedTime` must live here for
  // `Home:Enter` to pick the post-tutorial payload. Existing values (chosen
  // name, game start, photo ids) are preserved on re-seed.
  const existingUser = await getSingleton(playerId, 'User', exec);
  const existingPhotoIds = Array.isArray(existingUser?.NextPhotoImageIds)
    ? (existingUser.NextPhotoImageIds as unknown[]).map(String)
    : [];
  const user: Decoded = {
    ...(existingUser ?? {}),
    __msg: USER_MSG,
    Name: String(existingUser?.Name ?? playerName ?? ''),
    DeckSequence: Number(existingUser?.DeckSequence ?? 1) || 1,
    EmblemId: String(existingUser?.EmblemId ?? 'emb-001'),
    GameStartTime: Number(existingUser?.GameStartTime ?? now) || now,
    LastLoginTime: Number(existingUser?.LastLoginTime ?? now) || now,
    CardSupportLevel: Number(existingUser?.CardSupportLevel ?? 1) || 1,
    NextPhotoImageId: String(existingUser?.NextPhotoImageId ?? randomUUID()),
    // Fields the tutorial's final step (Tutorial:Progress Type 1 Step 150) sets.
    NextPhotoImageIds: existingPhotoIds.length
      ? existingPhotoIds
      : Array.from({ length: 20 }, () => randomUUID()),
    BuddyCardId: String(existingUser?.BuddyCardId ?? 'card-ai-03-schl-00'),
    LastHomeTalkDrawTime: Number(existingUser?.LastHomeTalkDrawTime ?? now) || now,
    ManagerLevel: managerLevel,
    ManagerExp: 0,
    CardSupportMaxNumber: Number(existingUser?.CardSupportMaxNumber ?? 3) || 3,
    TutorialClearedTime: Number(existingUser?.TutorialClearedTime ?? now) || now,
  };
  const userChanged =
    !existingUser ||
    Object.entries(user).some(
      ([key, value]) => JSON.stringify(existingUser[key]) !== JSON.stringify(value),
    );
  if (userChanged) await putSingleton(playerId, 'User', user, exec);

  // Opening + feature-intro tutorials from the veteran reference account.
  const existingTutorials = new Map(
    (await listElements(playerId, 'Tutorials', exec)).map((t) => [
      Number(t.TutorialType ?? 0),
      Number(t.Step ?? 0),
    ]),
  );
  const tutorialMsg = collectionElementMsg('Tutorials') ?? USER_TUTORIAL_MSG;
  const tutorialWrites = COMPLETED_TUTORIALS.filter(
    ([type, step]) => (existingTutorials.get(type) ?? -1) < step,
  ).map(([TutorialType, Step]) => ({ __msg: tutorialMsg, TutorialType, Step }) as Decoded);
  if (tutorialWrites.length) await putElements(playerId, 'Tutorials', tutorialWrites, exec);

  // Areas: `master_FunctionLock` mostly gates on `ClearArea`, so clearing every
  // master area unlocks photo/story/showcase/company without per-menu flags.
  const areaIds = await allAreaIds(exec);
  const existingAreas = new Map(
    (await listElements(playerId, 'Areas', exec)).map((a) => [
      String(a.AreaId ?? ''),
      Number(a.ClearQuestCount ?? 0),
    ]),
  );
  const areaWrites = areaIds
    .filter((areaId) => (existingAreas.get(areaId) ?? 0) < SANDBOX_AREA_CLEAR_COUNT)
    .map(
      (AreaId) =>
        ({
          __msg: USER_AREA_MSG,
          AreaId,
          ClearQuestCount: SANDBOX_AREA_CLEAR_COUNT,
          LastClearedTime: now,
        }) as Decoded,
    );
  if (areaWrites.length) await putElements(playerId, 'Areas', areaWrites, exec);

  // Balance / Points: the values the client header renders.
  const balance = await getSingleton(playerId, 'Balance', exec);
  if (
    Number(balance?.FreeBalance ?? -1) !== SANDBOX_CURRENCY ||
    Number(balance?.PaidBalance ?? -1) !== 0
  ) {
    await putSingleton(
      playerId,
      'Balance',
      {
        __msg: USER_BALANCE_MSG,
        FreeBalance: SANDBOX_CURRENCY,
        PaidBalance: 0,
      } as Decoded,
      exec,
    );
  }

  const pointAmounts = new Map(
    (await listElements(playerId, 'Points', exec)).map((p) => [
      Number(p.PointType ?? 0),
      Number(p.Amount ?? 0),
    ]),
  );
  const pointWrites: Decoded[] = [];
  for (const PointType of [POINT_GOLD, POINT_STAMINA, POINT_PHOTO_STORY_TICKET]) {
    if ((pointAmounts.get(PointType) ?? 0) < SANDBOX_CURRENCY) {
      pointWrites.push({ __msg: USER_POINT_MSG, PointType, Amount: SANDBOX_CURRENCY });
    }
  }
  if (pointWrites.length) await putElements(playerId, 'Points', pointWrites, exec);

  // Items: base consumables + every gacha ticket, topped up to the ceiling.
  // Love key items (Type 9001-9003) are event-only categories, so they are
  // matched by id instead of SANDBOX_ITEM_TYPES; this keeps MoshiKoi episodes
  // readable for free in the sandbox.
  const itemRows = await exec
    .select({ Id: master.masterItem.Id, Type: master.masterItem.Type })
    .from(master.masterItem);
  const itemIds = new Set<string>();
  for (const row of itemRows) {
    const id = String(row.Id ?? '');
    if (!id || INVALID_ITEM_IDS.has(id)) continue;
    const isLoveKey =
      id.startsWith('item-love-') &&
      (id.endsWith('-story') || id.endsWith('-present') || id.endsWith('-lesson-boost'));
    if (!SANDBOX_ITEM_TYPES.has(Number(row.Type ?? 0)) && !isLoveKey) continue;
    if (!isClientResolvable('Items', id)) continue;
    itemIds.add(id);
  }
  // The Photo Album (Shelf) develop film is an event-only item type (12001),
  // so stock the one film the reopened event asks for.
  itemIds.add(SANDBOX_SHELF_PHOTO_CREATING_ITEM_ID);
  const existingItems = new Map(
    (await listElements(playerId, 'Items', exec)).map((i) => [
      String(i.ItemId ?? ''),
      Number(i.Amount ?? 0),
    ]),
  );
  const itemMsg = collectionElementMsg('Items') ?? USER_ITEM_MSG;
  const itemWrites = [...itemIds]
    .filter((id) => (existingItems.get(id) ?? 0) < SANDBOX_CURRENCY)
    .map((ItemId) => ({ __msg: itemMsg, ItemId, Amount: SANDBOX_CURRENCY }) as Decoded);
  if (itemWrites.length) await putElements(playerId, 'Items', itemWrites, exec);

  // Messages and the telephone calls embedded in their detail graphs.
  const narrative = await ensureMessagesAndTelephones(exec, playerId, now);
  // Home talks are already seen/unlocked: the home screen authorises the talk
  // picker from this collection rather than from condition evaluation.
  const homeTalks = await ensureHomeTalks(exec, playerId);
  // Excursion gaze reactions are already watched: the outing scene can offer
  // every non-default reaction without replaying the unlock flow.
  const excursionGazeReactions = await ensureExcursionGazeReactions(exec, playerId);

  return {
    managerLevel,
    tutorials: tutorialWrites.length,
    areas: areaWrites.length,
    items: itemWrites.length,
    messages: narrative.messages,
    telephones: narrative.telephones,
    homeTalks,
    excursionGazeReactions,
  };
}

export async function seedSandboxAccount(
  exec: Executor,
  userId: string,
): Promise<SandboxSeedSummary> {
  // Official accounts must never receive the sandbox grant set; the profile
  // check keeps the seed safe even if a caller forgets to guard.
  if (!isSandbox()) {
    throw new Error('seedSandboxAccount: sandbox seed invoked outside the sandbox profile');
  }

  const [player] = await exec
    .select({ id: players.id, name: players.name })
    .from(players)
    .where(or(eq(players.id, userId), eq(players.accountId, userId)))
    .limit(1);
  if (!player) throw new Error(`seedSandboxAccount: no player matching ${userId}`);
  const playerId = player.id;

  // ---------------------------------------------------------------------
  // Currency (idempotent: only top up the delta to SANDBOX_CURRENCY)
  // ---------------------------------------------------------------------
  const currencies: readonly Currency[] = ['gold', 'freeJewel', 'paidJewel', 'stamina'];
  for (const currency of currencies) {
    const current = await getCurrency(playerId, currency, exec);
    if (current < SANDBOX_CURRENCY) {
      await grantCurrency(playerId, currency, SANDBOX_CURRENCY - current, exec);
    }
  }
  const [playerRow] = await exec
    .select({ staminaMax: players.staminaMax })
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1);
  if (Number(playerRow?.staminaMax ?? 0) < SANDBOX_CURRENCY) {
    await exec.update(players).set({ staminaMax: SANDBOX_CURRENCY }).where(eq(players.id, playerId));
  }

  // ---------------------------------------------------------------------
  // Tutorial / manager level / balance / items (post-tutorial state)
  // ---------------------------------------------------------------------
  const progress = await seedAccountProgress(exec, playerId, String(player.name ?? ''));

  // ---------------------------------------------------------------------
  // Cards: max level/rarity/rank/evolution/enhancements allowed by master
  // ---------------------------------------------------------------------
  const masterCards = await exec.select().from(master.masterCard);
  const rarityRows = await exec.select().from(master.masterCardRarity);
  const rankRows = await exec.select().from(master.masterCardRank);
  const evoRows = await exec.select().from(master.masterCardEvolutionLevel);
  const evolutionByGroup = evolutionMaxima(evoRows as unknown as Record<string, unknown>[]);

  const rarityRow = maxRow(rarityRows as unknown as Record<string, unknown>[], 'Rarity');
  const rankRow = maxRow(rankRows as unknown as Record<string, unknown>[], 'Rank');
  const cardRarity = Math.max(
    Number(rarityRow?.Rarity ?? 0) > 0
      ? Math.min(MAX_CARD_RARITY, Number(rarityRow?.Rarity))
      : MAX_CARD_RARITY,
    1,
  );
  const rank = rankRow ? Number(rankRow.Rank ?? 0) : 0;
  const rankExp = Number(rankRow?.RequiredExp ?? 0);
  const levelCap = Number(rarityRow?.LevelLimit ?? 200) + Number(rankRow?.LevelLimitUpAmount ?? 0);
  const globalMaxLevel = await getMaxCardLevel();
  const maxLevel = Math.max(1, Math.min(globalMaxLevel > 0 ? globalMaxLevel : levelCap, levelCap));

  const [levelRow] = await exec
    .select()
    .from(master.masterCardLevel)
    .where(eq(master.masterCardLevel.Level, maxLevel))
    .limit(1);
  const levelExp = Number(levelRow?.RequiredExp ?? 0);
  const rarityRowAtMax = rarityRows.find((r) => Number(r.Rarity) === cardRarity) ?? null;
  const rarityExp = Number(rarityRowAtMax?.RequiredExp ?? 0);

  const existingCards = new Map(
    (await listElements(playerId, 'Cards', exec)).map((c) => [String(c.CardId ?? ''), c]),
  );

  // Prefetch the release tables once. `CardLevelRelease` and
  // `CardEvolutionLevelRelease` are tiny (8 + 1 rows today) but were queried
  // twice per card before.
  const levelReleaseRows = (await exec
    .select()
    .from(master.masterCardLevelRelease)) as unknown as CardReleaseRow[];
  const evoReleaseRows = (await exec
    .select()
    .from(master.masterCardEvolutionLevelRelease)) as unknown as CardReleaseRow[];
  const levelReleasesByReleaseId = groupById(
    levelReleaseRows as unknown as Record<string, unknown>[],
    'Id',
  );
  const evoReleasesByGroup = groupById(
    evoReleaseRows as unknown as Record<string, unknown>[],
    'GroupId',
  );

  // Card parameters and enhancement tables are also prefetched. Parameter ids
  // are shared across cards, so this is only three ids × 260 levels today.
  const parameterRows = await exec
    .select()
    .from(master.masterCardParameter)
    .where(lte(master.masterCardParameter.Level, maxLevel));
  const parametersById = parameterMaxima(
    parameterRows as unknown as Record<string, unknown>[],
    maxLevel,
  );

  const skillRows = await exec.select().from(master.masterSkill);
  const liveAbilityRows = await exec.select().from(master.masterLiveAbility);
  const activityAbilityRows = await exec.select().from(master.masterActivityAbility);
  const skillsById = new Map(skillRows.map((row) => [String(row.Id), row as Decoded]));
  const liveAbilitiesById = new Map(
    liveAbilityRows.map((row) => [String(row.Id), row as Decoded]),
  );
  const activityAbilitiesById = new Map(
    activityAbilityRows.map((row) => [String(row.Id), row as Decoded]),
  );

  const pendingCards: Decoded[] = [];
  const desiredStories = new Map<string, string>();
  let cardsAdded = 0;
  let cardsUpdated = 0;

  for (const masterCard of masterCards) {
    const cardId = masterCard.Id == null ? '' : String(masterCard.Id);
    if (!cardId) continue;
    const mc = masterCard as unknown as Decoded;
    const evolution = evolutionByGroup.get(String(mc.CardEvolutionLevelGroupId ?? '')) ?? {
      level: 0,
      exp: 0,
    };
    const release = cardReleaseFromRows(
      mc,
      maxLevel,
      evolution.level,
      levelReleasesByReleaseId.get(String(mc.CardLevelReleaseId ?? '')) ?? [],
      evoReleasesByGroup.get(String(mc.CardEvolutionLevelReleaseGroupId ?? '')) ?? [],
    );

    const skillLevels: Record<number, number> = {};
    for (const slot of CARD_SKILL_SLOTS) {
      const skillId = String(mc[`SkillId${slot}`] ?? '');
      if (!skillId || !release.skillSlots.includes(slot)) continue;
      const levels = enhancementLevels(skillsById.get(skillId));
      skillLevels[slot] = maxEnhancementLevel(levels, maxLevel);
    }

    const liveAbilityId = release.liveAbility ? String(mc.LiveAbilityId ?? '') : '';
    const liveAbilityLevel = liveAbilityId
      ? maxEnhancementLevel(enhancementLevels(liveAbilitiesById.get(liveAbilityId)), maxLevel)
      : 0;

    const activityAbilityId = release.activityAbility
      ? String(mc.ActivityAbilityId ?? '')
      : '';
    const activityAbilityLevel = activityAbilityId
      ? maxEnhancementLevel(
          enhancementLevels(activityAbilitiesById.get(activityAbilityId)),
          maxLevel,
        )
      : 0;

    const target: CardTarget = {
      level: maxLevel,
      rarity: cardRarity,
      rank,
      evolution: evolution.level,
      skillLevels,
      liveAbilityLevel,
      activityAbilityLevel,
    };

    const existing = existingCards.get(cardId);
    if (existing && !belowMaximum(existing, target)) continue;

    const param = parametersById.get(String(mc.CardParameterId ?? '')) ?? null;
    const card = existing
      ? ({ ...existing } as Decoded)
      : newUserCard(
          cardId,
          mc,
          rarityRowAtMax as unknown as Decoded | null,
          param as unknown as Decoded | null,
        );

    card.__msg ??= 'Solis.Common.Proto.Transaction.UserCard';
    card.CardId = cardId;
    card.Level = target.level;
    card.BaseLevel = target.level;
    card.Rarity = target.rarity;
    card.RarityTotalExp = rarityExp;
    card.TotalExp = levelExp;
    card.Rank = rank;
    card.RankTotalExp = rankExp;
    card.EvolutionLevel = evolution.level;
    card.EvolutionLevelTotalExp = evolution.exp;
    card.ObtainedTime ??= Date.now();
    card.Mental ??= 100;
    card.Technique ??= 100;

    applyCardStatsFromParam(card, mc, param as unknown as Decoded | null);
    applyCardRelease(card, mc, release);

    // applyCardRelease defaults levels to 1; overwrite with the master cap for
    // exactly the skills/abilities this card has unlocked.
    for (const slot of CARD_SKILL_SLOTS) {
      const level = skillLevels[slot] ?? 0;
      if (level <= 0 || !card[`SkillId${slot}`]) continue;
      card[`SkillLevel${slot}`] = level;
      card[`BaseSkillLevel${slot}`] = level;
    }
    if (liveAbilityLevel > 0 && card.LiveAbilityId) {
      card.LiveAbilityLevel = liveAbilityLevel;
      card.BaseLiveAbilityLevel = liveAbilityLevel;
    }
    if (activityAbilityLevel > 0 && card.ActivityAbilityId) {
      card.ActivityAbilityLevel = activityAbilityLevel;
      card.BaseActivityAbilityLevel = activityAbilityLevel;
    }

    pendingCards.push(card);
    if (existing) cardsUpdated++;
    else cardsAdded++;
  }

  if (pendingCards.length) await putElements(playerId, 'Cards', pendingCards, exec);

  // Stories: every story in the master data is seeded as read. The desired set
  // is every `master_Story` id plus every `StoryId` referenced by a main story
  // part chapter, an extra story or an event story, plus the card stories
  // unlocked at max level. Add only missing ids and upgrade unread rows so a
  // re-seed is a no-op and existing fields are preserved.
  for (const masterCard of masterCards) {
    const mc = masterCard as unknown as Decoded;
    const releaseId = String(mc.CardLevelReleaseId ?? '');
    if (!releaseId) continue;
    const releases = levelReleasesByReleaseId.get(releaseId) ?? [];
    for (const storyId of cardStoryIdsFromRelease(mc, maxLevel, releases)) {
      if (storyId) desiredStories.set(storyId, storyId);
    }
  }
  for (const row of await exec.select({ Id: master.masterStory.Id }).from(master.masterStory)) {
    const storyId = row.Id == null ? '' : String(row.Id);
    if (storyId) desiredStories.set(storyId, storyId);
  }
  for (const part of await exec
    .select({ Chapters: master.masterStoryPart.Chapters })
    .from(master.masterStoryPart)) {
    for (const chapter of Array.isArray(part.Chapters) ? (part.Chapters as Decoded[]) : []) {
      for (const storyId of storyIdsFromEpisodes(chapter.Episodes)) {
        desiredStories.set(storyId, storyId);
      }
    }
  }
  for (const story of await exec
    .select({ Episodes: master.masterExtraStory.Episodes })
    .from(master.masterExtraStory)) {
    for (const storyId of storyIdsFromEpisodes(story.Episodes)) {
      desiredStories.set(storyId, storyId);
    }
  }
  for (const event of await exec
    .select({ Episodes: master.masterEventStory.Episodes })
    .from(master.masterEventStory)) {
    for (const storyId of storyIdsFromEpisodes(event.Episodes)) {
      desiredStories.set(storyId, storyId);
    }
  }
  const existingStories = await listElements(playerId, 'Stories', exec);
  const existingStoryById = new Map(
    existingStories.map((story) => [String(story.StoryId ?? ''), story]),
  );
  const storyMsg = collectionElementMsg('Stories') ?? undefined;
  const storyWrites: Decoded[] = [];
  for (const storyId of desiredStories.keys()) {
    const existing = existingStoryById.get(storyId);
    if (!existing) {
      storyWrites.push({
        __msg: storyMsg,
        StoryId: storyId,
        StatusType: STORY_STATUS_READ,
      } as Decoded);
    } else if (Number(existing.StatusType ?? 0) < STORY_STATUS_READ) {
      storyWrites.push({ ...existing, StatusType: STORY_STATUS_READ } as Decoded);
    }
  }
  let storiesRead = 0;
  if (storyWrites.length) {
    await putElements(playerId, 'Stories', storyWrites, exec);
    storiesRead = storyWrites.length;
  }

  // ---------------------------------------------------------------------
  // Cosmetics. Reward definitions are scanned so categories without their own
  // master table (decorations) still get every referenced id.
  // ---------------------------------------------------------------------
  const rewardRows = await exec
    .select({ Resources: master.masterReward.Resources })
    .from(master.masterReward);
  const rewarded = collectRewardIds(rewardRows);
  const rewardIds = (type: number) => rewarded.get(type) ?? [];

  const costumeRows = await exec
    .select({ Id: master.masterCostume.Id, DefaultHairId: master.masterCostume.DefaultHairId })
    .from(master.masterCostume);
  const hairRows = await exec.select({ Id: master.masterHair.Id }).from(master.masterHair);
  const emblemRows = await exec.select({ Id: master.masterEmblem.Id }).from(master.masterEmblem);
  const characterRows = await exec
    .select({
      Id: master.masterCharacter.Id,
      DefaultCostumeId: master.masterCharacter.DefaultCostumeId,
      Type: master.masterCharacter.Type,
    })
    .from(master.masterCharacter)
    .then((rows) => rows.filter(isSandboxCharacter));
  const recipeRows = await exec
    .select({ Id: master.masterPhotoRecipe.Id })
    .from(master.masterPhotoRecipe);
  const poseRows = await exec
    .select({ Id: master.masterPhotoPose.Id })
    .from(master.masterPhotoPose);
  const toyRows = await exec
    .select({ Id: master.masterShowcaseToy.Id })
    .from(master.masterShowcaseToy);
  const musicRows = await exec
    .select({ MusicId: master.masterShowcaseMusic.MusicId })
    .from(master.masterShowcaseMusic);

  // Heal accounts seeded by an older build: drop rows the client would choke on
  // before topping the collections up again (`./clientDenylist.ts`).
  const unresolvableRemoved =
    (await pruneUnresolvable(exec, playerId, 'Costumes', 'CostumeId')) +
    (await pruneUnresolvable(exec, playerId, 'Hairs', 'HairId'));

  const defaultHairByCostume = new Map(
    costumeRows.map((row) => [String(row.Id ?? ''), String(row.DefaultHairId ?? '')]),
  );

  const costumes = await ensureCollection(
    exec,
    playerId,
    'Costumes',
    'CostumeId',
    union(rewardIds(COLLECTION_RESOURCE_TYPES.costume), idsOf(costumeRows, 'Id')),
  );
  const hairs = await ensureCollection(
    exec,
    playerId,
    'Hairs',
    'HairId',
    union(rewardIds(COLLECTION_RESOURCE_TYPES.hair), idsOf(hairRows, 'Id')),
  );
  const [topActivityLevel] = await exec
    .select({
      Level: master.masterCharacterActivityLevel.Level,
      RequiredExp: master.masterCharacterActivityLevel.RequiredExp,
      MaxStamina: master.masterCharacterActivityLevel.MaxStamina,
    })
    .from(master.masterCharacterActivityLevel)
    .orderBy(desc(master.masterCharacterActivityLevel.Level))
    .limit(1);
  const charactersRemoved = await pruneCharacters(
    exec,
    playerId,
    new Set(characterRows.map((row) => String(row.Id))),
  );
  const characters = await ensureCharacters(
    exec,
    playerId,
    characterRows,
    defaultHairByCostume,
    topActivityLevel
      ? {
          Level: Number(topActivityLevel.Level),
          RequiredExp: Number(topActivityLevel.RequiredExp ?? 0),
          MaxStamina: Number(topActivityLevel.MaxStamina ?? 0),
        }
      : undefined,
    await fanAmountFloors(exec),
  );
  const companyBond = await ensureCompanyBond(exec, playerId);
  const loveLevels = await ensureLoveLevels(exec, playerId);
  const emblems = await ensureCollection(
    exec,
    playerId,
    'Emblems',
    'EmblemId',
    union(rewardIds(COLLECTION_RESOURCE_TYPES.emblem), idsOf(emblemRows, 'Id')),
  );
  const decorations = await ensureCollection(
    exec,
    playerId,
    'Decorations',
    'DecorationId',
    rewardIds(COLLECTION_RESOURCE_TYPES.decoration),
  );
  const photoRecipes = await ensureCollection(
    exec,
    playerId,
    'PhotoRecipes',
    'PhotoRecipeId',
    union(rewardIds(COLLECTION_RESOURCE_TYPES.photoRecipe), idsOf(recipeRows, 'Id')),
  );
  const photoPoses = await ensureCollection(
    exec,
    playerId,
    'PhotoPoses',
    'PhotoPoseId',
    union(rewardIds(COLLECTION_RESOURCE_TYPES.photoPose), idsOf(poseRows, 'Id')),
  );
  const { added: showcaseToys, raised: showcaseToyAmounts } = await ensureShowcaseToys(
    exec,
    playerId,
    union(rewardIds(COLLECTION_RESOURCE_TYPES.showcaseToy), idsOf(toyRows, 'Id')),
    SANDBOX_SHOWCASE_TOY_AMOUNT,
  );
  const showcaseMusics = await ensureCollection(
    exec,
    playerId,
    'ShowcaseMusics',
    'ShowcaseMusicId',
    union(rewardIds(COLLECTION_RESOURCE_TYPES.showcaseMusic), idsOf(musicRows, 'MusicId')),
  );

  // Owned music: `UserGetResponse.Musics` is a first-class player collection
  // (`UserMusic{MusicId}`), so grant the whole `master_Music` catalogue.
  const allMusicRows = await exec
    .select({ Id: master.masterMusic.Id })
    .from(master.masterMusic);
  const musics = await ensureCollection(
    exec,
    playerId,
    'Musics',
    'MusicId',
    idsOf(allMusicRows as unknown as Record<string, unknown>[], 'Id'),
  );

  // Accessories are not implemented in the sandbox: the inventory keeps none
  // and deck positions must not reference one.
  const accessories = await removeSandboxAccessories(exec, playerId);

  return {
    playerId,
    managerLevel: progress.managerLevel,
    tutorials: progress.tutorials,
    areas: progress.areas,
    items: progress.items,
    messages: progress.messages,
    telephones: progress.telephones,
    homeTalks: progress.homeTalks,
    excursionGazeReactions: progress.excursionGazeReactions,
    unresolvableRemoved,
    cardsAdded,
    cardsUpdated,
    storiesRead,
    costumes,
    hairs,
    accessories,
    characters,
    charactersRemoved,
    companyBond,
    loveLevels,
    emblems,
    decorations,
    photoRecipes,
    photoPoses,
    showcaseToys,
    showcaseToyAmounts,
    showcaseMusics,
    musics,
  };
}
