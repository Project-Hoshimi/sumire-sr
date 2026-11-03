import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { players, playerEntities } from '../db/schema.ts';
import {
  getPhotoRarityLevel,
  getPhotoRecipe,
  getPhotoRetouchEnhance,
  getSetting,
  getItem,
  getCard,
  getCharacter,
  getPhotoAbility,
  getPhotoActivity,
  getPhotoExpression,
  getPhotoExpressionStagePosition,
  getPhotoPose,
  getPhotoFacial,
  getPhotoQuestMusic,
  getPhotoQuestStage, getPhotoStage,
  listMusics,
  listStories,
  getStory,
  getStoryPart,
  getCostume,
  getHair,
  listCharacters,
  listItems,
  listPhotoAbilitySets,
  listPhotoRarityLevels,
  listPhotoActivities,
  listPhotoQuestMusics,
  listPhotoQuestStages,
  listPhotoExpressions,
  listPhotoContestActivities,
  listPhotoContestQuestMusics,
  listPhotoContestQuestStages,
  listPhotoContestSections,
  listPhotoContestSectionRewards,
  getPhotoContestSectionReward,
  getShowcaseFrame,
  listShowcaseFrames,
  listShowcaseHashtags,
  listShowcaseMusics,
  listShowcaseMusicFilters,
  getShowcaseSetting,
  listShowcaseToys,
  listShowcaseToyCategories,
  listShowcaseToyShopFilters,
  getExcursionPlace,
} from '../master/index.ts';
import { applyGrants, applyRewardRefs, type Grant } from '../master/reward.ts';
import { getCurrency, spendCurrency } from './currency.ts';
import { getItemAmount, spendItem } from './inventory.ts';
import { consume, consumptionUpdatedData } from './consumption.ts';
import { getSingleton, listElements, putElements, putSingleton, removeElements } from './playerState.ts';
import { isSandbox } from '../profile.ts';
import { SANDBOX_SPECIAL_PHOTO_SHOOTING_ID } from '../profiles/sandbox/specialPhoto.ts';
import {
  SANDBOX_SHELF_DEFAULT_TEMPLATE_ID,
  SANDBOX_SHELF_PHOTO_LIMIT,
  sandboxShelfAlbum,
  sandboxShelfAlbumTemplateId,
  sandboxShelfEpisodeInfos,
  sandboxShelfInfo,
  sandboxShelfTemplateInfos,
  shelfPageSubject,
} from '../profiles/sandbox/shelf.ts';
import {
  SANDBOX_SHOWCASE_CASE_COUNT,
  sandboxShowcaseShops,
  withSandboxShowcaseSlots,
} from '../profiles/sandbox/showcase.ts';
import { encodeMessage, msgRegistry, Writer, type Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import {
  PHOTO_OBJECT_PREFIX,
  clonePhotoImage,
  findFinalizedPhotoImageMetadataByNames,
  isPhotoAssetId,
  photoFirebaseDownloadUrl,
  publicUserIdForPlayer,
  removeUserPhotoImageObjects,
  type PhotoImageMetadata,
} from '../firebaseStorage.ts';

/**
 * Server-authoritative photo management.
 *
 * Scope is management only (enhance / limit extend / retouch / reroll / update
 * / lock / delete / recipe sale / report); the photo *shooting* pipeline is out
 * of scope for this slice. None of these endpoints were captured, so they are
 * built from the generated schema and validated with `dbtest.ts` only (no
 * byte-exact verification).
 */

const PHOTO_MSG = 'Solis.Common.Proto.Transaction.UserPhoto';
const PHOTO_ABILITY_MSG = 'Solis.Common.Proto.Transaction.UserPhotoAbility';
const PHOTO_RECIPE_MSG = 'Solis.Common.Proto.Transaction.UserPhotoRecipe';
const USER_MSG = 'Solis.Common.Proto.Transaction.User';
const USER_ITEM_MSG = 'Solis.Common.Proto.Transaction.UserItem';
const USER_BALANCE_MSG = 'Solis.Common.Proto.Transaction.UserBalance';
const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';

const PHOTO_ENHANCE_ITEM = 'item-photo_enhance';
const PHOTO_REROLL_ITEM = 'item-photo_reroll';

const SPECIAL_ACTIVITY_INFO_MSG = 'Solis.Common.Proto.Api.SpecialPhotoActivityInfo';
const SPECIAL_MUSIC_INFO_MSG = 'Solis.Common.Proto.Api.SpecialPhotoQuestMusicInfo';
const SPECIAL_STAGE_MSG = 'Solis.Common.Proto.Api.SpecialPhotoQuestStage';
const PHOTO_SHOOTING_PARAM_MSG = 'Solis.Common.Proto.Api.PhotoCreateShootingParam';
const EXCURSION_SHOOTING_PARAM_MSG = 'Solis.Common.Proto.Api.PhotoCreateExcursionShootingParam';

const USER_GIFT_MSG = 'Solis.Common.Proto.Transaction.UserGift';
const PHOTO_GIFT_MSG = 'Solis.Common.Proto.Transaction.PhotoGift';
const GIFT_KIND = 'Gifts';

// Solis internal/viber/photo_shooting.go + photo.go constants.
const RESERVED_PHOTO_IMAGE_ID_COUNT = 20;
const PHOTO_GIFT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const PHOTO_CAPACITY_GIFT_MESSAGE = '所持上限を超えたためギフトに送られました';
const PHOTO_DEDICATED_ABILITY_MISSION_ID = 'ms-photo-manager_level_achievement-80';
const PHOTO_DEDICATED_ABILITY_MIN_LEVEL = 80;
const PHOTO_ITEM_TYPE_SHOOTING = 11;
const PHOTO_ITEM_TYPE_SHOOTING_LEVEL_CHANGE = 13;
const CHARACTER_TYPE_NPC = 2;

// Rarity weights, indexed by the minimum rarity; per hundred.
const PHOTO_RARITY_WEIGHTS: Record<number, number[]> = {
  1: [55, 25, 12, 6, 2],
  2: [60, 25, 10, 5],
  3: [70, 25, 5],
  4: [90, 10],
  5: [100],
};
const PHOTO_LEVEL_JITTER = [-10, -5, 0, 5, 10, 15];

// PhotoImageType_User: photos whose bytes live in (emulated) Firebase Storage.
const PHOTO_IMAGE_TYPE_USER = 2;

type PhotoAbilityLevel = { Level?: number; Value?: number };
type PhotoAbilityGrade = { Grade?: number; BonusPermil?: number; BonusValue?: number };
type PhotoGenerator = {
  minLevel: number;
  maxLevel: number;
  thresholds: number[];
  qualityAnchors: Map<number, number>;
  abilitySets: Awaited<ReturnType<typeof listPhotoAbilitySets>>;
  dedicatedCharacterIds: Set<string>;
};

type PhotoShootingScene = {
  placeName: string;
  eventName: string;
  photoNamePrefix?: string;
  candidateCharacterIds?: string[];
  storyId?: string;
  storyShooting?: boolean;
  expressionShooting?: boolean;
  panoramaShooting?: boolean;
  showcaseShooting?: boolean;
  reliabilityOncePerCharacter?: boolean;
  musicId?: string;
  forcedRarity?: number;
  allowNonFilmItem?: boolean;
  /** The film only drives generation and is not spent (album photos). */
  noFilmCost?: boolean;
  specifiedPoseCounts?: Record<string, number>;
  specifiedCharacterCounts?: Record<string, number>;
};

type PhotoCreateParam = { imageId: string; itemId: string; focusCharacterId?: string };

type PhotoCreationResult = {
  photos: Decoded[];
  isGift: boolean;
  updated: Decoded;
  deleted: Decoded | null;
  highestPhotoLevel: number;
};

const PHOTO_POOL_ACTIVITY_ID = 'photo_activity-pool';
const PHOTO_POOL_MIKU_ACTIVITY_ID = 'photo_activity-pool-miku';
const PHOTO_POOL_MIKU_COSTUME_ID = 'cos-mku-miku-05';

/**
 * The swimsuit gravure venue is split into two master rows by whether Miku's
 * swimsuit costume (`cos-mku-miku-05`) is owned
 * (`cd-activity-mizg-possetion` / `cd-activity-mizg-notpossetion`). Every
 * outfit is usable there, so the player gets exactly one.
 */
export function dedupePoolPhotoActivities<T extends { Id: string }>(
  activities: T[],
  ownedCostumeIds: Set<string>,
): T[] {
  const hiddenId = ownedCostumeIds.has(PHOTO_POOL_MIKU_COSTUME_ID)
    ? PHOTO_POOL_ACTIVITY_ID
    : PHOTO_POOL_MIKU_ACTIVITY_ID;
  return activities.filter((activity) => activity.Id !== hiddenId);
}

function photoNumberAfter(value: string, marker: string): number | undefined {
  const index = value.indexOf(marker);
  if (index < 0) return undefined;
  const match = /^\d+/.exec(value.slice(index + marker.length));
  return match ? Number(match[0]) : undefined;
}

function photoQualityFromDescription(description: string): number | undefined {
  return photoNumberAfter(description, '品質');
}

function photoMaximumQualityFromDescription(description: string): number | undefined {
  return photoNumberAfter(description, '最大品質:');
}

function dedicatedSets(generator: PhotoGenerator, characterId: string): PhotoGenerator['abilitySets'] {
  const suffix = `-${characterId.replace(/^char-/, '')}-idol-`;
  return generator.abilitySets.filter(
    (set) => Number(set.PhotoRarity ?? 0) === 5 && Number(set.Limited ?? 0) !== 0 && String(set.Id).includes(suffix),
  );
}

function genericSets(generator: PhotoGenerator, rarity: number): PhotoGenerator['abilitySets'] {
  return generator.abilitySets.filter(
    (set) =>
      Number(set.Limited ?? 0) === 0 &&
      String(set.Id).startsWith(`pab-set-${rarity}-`) &&
      !String(set.Id).includes('recipe'),
  );
}

async function newPhotoGenerator(): Promise<PhotoGenerator> {
  const [abilitySets, characters, items, levels, setting] = await Promise.all([
    listPhotoAbilitySets(),
    listCharacters(),
    listItems(),
    listPhotoRarityLevels(),
    getSetting(),
  ]);
  if (!levels.length) throw new Error('photo generator: no photo rarity levels');

  const qualityAnchors = new Map<number, number>();
  for (const item of items) {
    if (Number(item.Type ?? 0) !== PHOTO_ITEM_TYPE_SHOOTING) continue;
    const value = Number(item.Value ?? 0);
    const quality = photoQualityFromDescription(String(item.Description ?? ''));
    if (quality === undefined) continue;
    qualityAnchors.set(value, Math.max(qualityAnchors.get(value) ?? 0, quality));
  }
  const generator: PhotoGenerator = {
    minLevel: Math.min(...levels.map((l) => Number(l.Level ?? 0))),
    maxLevel: Math.max(...levels.map((l) => Number(l.Level ?? 0))),
    thresholds: ((setting?.PhotoShootingItemThresholds as number[] | null | undefined) ?? [])
      .map(Number)
      .sort((a, b) => a - b),
    qualityAnchors,
    abilitySets,
    dedicatedCharacterIds: new Set(),
  };
  generator.dedicatedCharacterIds = new Set(
    characters.filter((c) => dedicatedSets(generator, String(c.Id)).length > 0).map((c) => String(c.Id)),
  );
  return generator;
}

function randomRarity(filmLevel: number, thresholds: number[]): number {
  let minimum = 1;
  thresholds.forEach((threshold, index) => {
    if (filmLevel >= threshold) minimum = index + 1;
  });
  minimum = Math.min(5, Math.max(1, minimum));
  const weights = PHOTO_RARITY_WEIGHTS[minimum] ?? PHOTO_RARITY_WEIGHTS[5];
  let draw = Math.floor(Math.random() * 100);
  for (let index = 0; index < weights.length; index++) {
    if (draw < weights[index]) return minimum + index;
    draw -= weights[index];
  }
  return 5;
}

function qualityForFilmLevel(generator: PhotoGenerator, filmLevel: number): number {
  const exact = generator.qualityAnchors.get(filmLevel);
  if (exact !== undefined) return exact;
  const lowerEntries = [...generator.qualityAnchors.entries()].filter(([level]) => level < filmLevel);
  const upperEntries = [...generator.qualityAnchors.entries()].filter(([level]) => level > filmLevel);
  const lower = lowerEntries.length ? lowerEntries.reduce((a, b) => (a[0] > b[0] ? a : b)) : undefined;
  const upper = upperEntries.length ? upperEntries.reduce((a, b) => (a[0] < b[0] ? a : b)) : undefined;
  if (lower && upper) {
    return lower[1] + Math.trunc(((upper[1] - lower[1]) * (filmLevel - lower[0])) / (upper[0] - lower[0]));
  }
  if (lower) return lower[1] + 10 * (filmLevel - lower[0]);
  if (upper) return Math.max(generator.minLevel, upper[1] - 20 * (upper[0] - filmLevel));
  return Math.max(generator.minLevel, filmLevel * 20);
}

function randomLevel(
  generator: PhotoGenerator,
  item: Awaited<ReturnType<typeof getItem>>,
  managerLevel: number,
  fixed: boolean,
): number {
  const description = String(item?.Description ?? '');
  let base = qualityForFilmLevel(generator, Number(item?.Value ?? 0));
  const quality = photoQualityFromDescription(description);
  if (quality !== undefined) base = quality;
  if (Number(item?.Type ?? 0) === PHOTO_ITEM_TYPE_SHOOTING_LEVEL_CHANGE) {
    const maximumQuality = photoMaximumQualityFromDescription(description);
    if (maximumQuality !== undefined) base = Math.min(managerLevel, maximumQuality);
    else base = managerLevel;
  }
  if (!fixed) base += PHOTO_LEVEL_JITTER[Math.floor(Math.random() * PHOTO_LEVEL_JITTER.length)];
  base = Math.trunc((base + 2) / 5) * 5;
  return Math.min(generator.maxLevel, Math.max(generator.minLevel, base));
}

function photoAbilityEffectValue(
  ability: { PhotoAbilityLevels?: unknown; PhotoAbilityGrades?: unknown },
  level: number,
  grade: number,
): number {
  const levels = [...((ability.PhotoAbilityLevels as PhotoAbilityLevel[] | null | undefined) ?? [])].sort(
    (a, b) => Number(a.Level ?? 0) - Number(b.Level ?? 0),
  );
  if (!levels.length) throw new Error('photo ability has no levels');
  let selected = levels[0];
  for (const entry of levels) {
    if (Number(entry.Level ?? 0) <= level) selected = entry;
    else break;
  }
  const grades = (ability.PhotoAbilityGrades as PhotoAbilityGrade[] | null | undefined) ?? [];
  const selectedGrade = grades.find((g) => Number(g.Grade ?? 0) === grade);
  if (!selectedGrade) throw new Error(`photo ability grade ${grade} not found`);
  return (
    Math.trunc((Number(selected.Value ?? 0) * Number(selectedGrade.BonusPermil ?? 0)) / 1000) +
    Number(selectedGrade.BonusValue ?? 0)
  );
}

async function buildPhotoAbilitiesFromSet(
  set: PhotoGenerator['abilitySets'][number],
  level: number,
): Promise<Decoded[]> {
  const ids = (set.PhotoAbilityIds as string[] | null | undefined) ?? [];
  if (!ids.length) throw new Error(`photo ability set ${set.Id} is empty`);
  const out: Decoded[] = [];
  for (const abilityId of ids) {
    const ability = await getPhotoAbility(abilityId);
    if (!ability) throw new Error(`photo ability not found: ${abilityId}`);
    const grades = (ability.PhotoAbilityGrades as PhotoAbilityGrade[] | null | undefined) ?? [];
    if (!grades.length) throw new Error(`photo ability has no grades: ${abilityId}`);
    const grade = Number(grades[Math.floor(Math.random() * grades.length)].Grade ?? 0);
    out.push({
      __msg: PHOTO_ABILITY_MSG,
      PhotoAbilityId: abilityId,
      EffectValue: photoAbilityEffectValue(ability, level, grade),
      Grade: grade,
      IsAvailable: true,
    } as Decoded);
  }
  return out;
}

async function randomAbilities(
  generator: PhotoGenerator,
  rarity: number,
  level: number,
  focusCharacterId: string,
  dedicated: boolean,
): Promise<Decoded[]> {
  const candidates = dedicated ? dedicatedSets(generator, focusCharacterId) : genericSets(generator, rarity);
  if (!candidates.length) {
    throw new Error(
      dedicated
        ? `no dedicated photo ability set for ${focusCharacterId}`
        : `no photo ability set for rarity ${rarity}`,
    );
  }
  return buildPhotoAbilitiesFromSet(candidates[Math.floor(Math.random() * candidates.length)], level);
}

async function generatePhoto(
  generator: PhotoGenerator,
  item: Awaited<ReturnType<typeof getItem>>,
  focusCharacterId: string,
  managerLevel: number,
): Promise<{ Rarity: number; Level: number; Abilities: Decoded[]; Dedicated: boolean; CharacterId: string }> {
  const guaranteedFive = String(item?.Name ?? '').includes('★5確定') || Boolean(item?.IsPhotoShootingCharacterOnly);
  const rarity = guaranteedFive ? 5 : randomRarity(Number(item?.Value ?? 0), generator.thresholds);
  let dedicated = Boolean(item?.IsPhotoShootingCharacterOnly);
  if (!dedicated && rarity === 5 && Math.floor(Math.random() * 100) < 1) {
    dedicated = generator.dedicatedCharacterIds.has(focusCharacterId);
  }
  const level = randomLevel(generator, item, managerLevel, guaranteedFive);
  const abilities = await randomAbilities(generator, rarity, level, focusCharacterId, dedicated);
  if (
    dedicated &&
    abilities.length > 0 &&
    String(abilities[0].PhotoAbilityId ?? '').startsWith('pab-passive-skill_')
  ) {
    abilities[0].MissionId = PHOTO_DEDICATED_ABILITY_MISSION_ID;
    abilities[0].IsAvailable = managerLevel >= PHOTO_DEDICATED_ABILITY_MIN_LEVEL;
  }
  return { Rarity: rarity, Level: level, Abilities: abilities, Dedicated: dedicated, CharacterId: focusCharacterId };
}

async function photoCapacityLimit(playerId: string, exec: Executor): Promise<number> {
  const [setting, user] = await Promise.all([getSetting(), loadUser(exec, playerId)]);
  const extended = Number(user.PhotoLimitExtendedCount ?? 0);
  const base = Number(setting?.PhotoDefaultLimit ?? 0);
  const amount = Number(setting?.PhotoLimitExtendAmount ?? 0);
  const limit = Number(setting?.PhotoLimitExtendLimit ?? 0);
  if (!setting || !user || base <= 0 || amount <= 0 || limit < 0 || extended < 0) {
    throw new Error('photo capacity setting is invalid');
  }
  return base + Math.min(extended, limit) * amount;
}

async function addPhotoGift(
  exec: Executor,
  playerId: string,
  photo: Decoded,
  shootingTime: number,
): Promise<void> {
  const gift = {
    __msg: USER_GIFT_MSG,
    GiftId: randomUUID(),
    ResourceType: 21,
    ResourceId: String(photo.PhotoId ?? ''),
    Amount: 1,
    Message: PHOTO_CAPACITY_GIFT_MESSAGE,
    PostedTime: shootingTime,
    LimitTime: shootingTime + PHOTO_GIFT_RETENTION_MS,
    PhotoGift: { __msg: PHOTO_GIFT_MSG, Name: String(photo.Name ?? '') },
  } as Decoded;
  const shape = msgRegistry.get(USER_GIFT_MSG);
  if (!shape) throw new Error('UserGift proto is not registered');
  const writer = new Writer();
  encodeMessage(shape, gift, writer);
  const [max] = await exec
    .select({ ordinal: playerEntities.ordinal })
    .from(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, GIFT_KIND)))
    .orderBy(desc(playerEntities.ordinal))
    .limit(1);
  await exec.insert(playerEntities).values({
    id: randomUUID(),
    playerId,
    kind: GIFT_KIND,
    entityKey: String(gift.GiftId),
    ordinal: Number(max?.ordinal ?? -1) + 1,
    blob: Buffer.from(writer.toBytes()).toString('base64'),
    createdAt: new Date(),
  });
}

function jstMonthDay(timestamp: number): string {
  const date = new Date(timestamp + 9 * 60 * 60 * 1000);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

async function resolvePhotoFocusCharacter(
  exec: Executor,
  playerId: string,
  requestedCharacterId: string,
  candidates: string[],
  rpc: string,
): Promise<string> {
  const ownedCharacters = await listElements(playerId, 'Characters', exec);
  const ownedIds = new Set(ownedCharacters.map((c) => String(c.CharacterId ?? '')).filter(Boolean));
  if (requestedCharacterId) {
    const master = await getCharacter(requestedCharacterId);
    if (!master) throw new Error(`${rpc}: unknown character ${requestedCharacterId}`);
    if (Number(master.Type ?? 0) !== CHARACTER_TYPE_NPC && !ownedIds.has(requestedCharacterId)) {
      throw new Error(`${rpc}: character not owned ${requestedCharacterId}`);
    }
    return requestedCharacterId;
  }
  let pool = [...new Set(candidates.map((id) => id.trim()).filter(Boolean))].filter((id) => ownedIds.has(id));
  if (!pool.length) pool = [...ownedIds];
  if (!pool.length) throw new Error(`${rpc}: no photographed character can be determined`);
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Shared Solis `CreateUserPhotoShootings` core: validate reserved image IDs and
 * film items, generate photos (rarity/level/abilities), enforce capacity (overflow
 * goes to the gift box), bump reliability, mark the story as shot and rotate the
 * reserved image IDs.
 */
async function createUserPhotoShootings(
  exec: Executor,
  playerId: string,
  scene: PhotoShootingScene,
  params: PhotoCreateParam[],
  manualCount: number,
  rpc: string,
): Promise<PhotoCreationResult> {
  if (params.length === 0 || params.length > RESERVED_PHOTO_IMAGE_ID_COUNT) {
    throw new Error(`${rpc}: shooting count must be between 1 and ${RESERVED_PHOTO_IMAGE_ID_COUNT}`);
  }
  if (manualCount < 0) throw new Error(`${rpc}: manualCount must not be negative`);

  const [user, photos] = await Promise.all([loadUser(exec, playerId), listElements(playerId, 'Photos', exec)]);
  const capacity = await photoCapacityLimit(playerId, exec);
  const available = Math.max(0, capacity - photos.length);
  const ownedPhotoCount = Math.min(params.length, available);

  const reserved = ((user.NextPhotoImageIds as string[] | null | undefined) ?? []).map(String);
  const reservedSet = new Set(reserved);
  const usedImageIds = new Set<string>();
  const filmAmounts = new Map<string, number>();
  const filmItems = new Map<string, Awaited<ReturnType<typeof getItem>>>();

  for (const param of params) {
    if (!param.imageId || !param.itemId) throw new Error(`${rpc}: photoImageId and itemId are required`);
    if (!reservedSet.has(param.imageId)) {
      throw new Error(`${rpc}: photo image ID ${JSON.stringify(param.imageId)} is not reserved for this user`);
    }
    if (usedImageIds.has(param.imageId)) throw new Error(`${rpc}: photoImageId values must be unique`);
    usedImageIds.add(param.imageId);

    let item = filmItems.get(param.itemId);
    if (item === undefined) {
      item = await getItem(param.itemId);
      // Contest entry items live outside master Item; they are spent but do not
      // shape the generated photo.
      if (!item && !scene.allowNonFilmItem) throw new Error(`${rpc}: item not found ${param.itemId}`);
      if (
        item &&
        !scene.allowNonFilmItem &&
        Number(item.Type ?? 0) !== PHOTO_ITEM_TYPE_SHOOTING &&
        Number(item.Type ?? 0) !== PHOTO_ITEM_TYPE_SHOOTING_LEVEL_CHANGE
      ) {
        throw new Error(`${rpc}: item ${JSON.stringify(param.itemId)} is not a shooting film`);
      }
      if (scene.storyShooting && item?.IsPhotoShootingCharacterOnly) {
        throw new Error(`${rpc}: character-only film cannot be used for story shooting`);
      }
      filmItems.set(param.itemId, item);
    }
    filmAmounts.set(param.itemId, (filmAmounts.get(param.itemId) ?? 0) + 1);
  }

  if (!scene.noFilmCost) {
    for (const [itemId, amount] of filmAmounts) {
      await spendItem(playerId, itemId, amount, exec);
    }
  }

  const generator = await newPhotoGenerator();
  const managerLevel = Number(user.ManagerLevel ?? 0);
  const shootingTime = Date.now();
  const date = jstMonthDay(shootingTime);
  const created: Decoded[] = [];
  const reliabilityIncreases = new Map<string, number>();
  let highestPhotoLevel = 0;

  for (const param of params) {
    const focusId = await resolvePhotoFocusCharacter(
      exec,
      playerId,
      param.focusCharacterId ?? '',
      scene.candidateCharacterIds ?? [],
      rpc,
    );
    const character = await getCharacter(focusId);
    if (!character) throw new Error(`${rpc}: character not found ${focusId}`);
    const item = filmItems.get(param.itemId)!;
    const generated = await generatePhoto(generator, item, focusId, managerLevel);
    const nameBase = scene.photoNamePrefix || String(character.Name ?? '').trim();
    const photo: Decoded = {
      __msg: PHOTO_MSG,
      PhotoId: randomUUID(),
      AssetId: param.imageId,
      ImageType: PHOTO_IMAGE_TYPE_USER,
      Name: `${nameBase.trim()} ${date}`,
      Rarity: scene.forcedRarity ?? generated.Rarity,
      PlaceName: scene.placeName,
      EventName: scene.eventName,
      Locked: false,
      Level: generated.Level,
      Rerollable: true,
      Abilities: generated.Abilities,
      ShootingTime: shootingTime,
      FocusCharacterId: focusId,
    } as Decoded;
    if (generated.Dedicated) photo.CharacterIds = [focusId];
    created.push(photo);
    highestPhotoLevel = Math.max(highestPhotoLevel, generated.Level);
    if (Number(character.Type ?? 0) !== CHARACTER_TYPE_NPC) {
      if (scene.reliabilityOncePerCharacter) reliabilityIncreases.set(focusId, 1);
      else reliabilityIncreases.set(focusId, (reliabilityIncreases.get(focusId) ?? 0) + 1);
    }
  }

  const ownedPhotos = created.slice(0, ownedPhotoCount);
  const overflowPhotos = created.slice(ownedPhotoCount);
  if (ownedPhotos.length) await putElements(playerId, 'Photos', ownedPhotos, exec);

  const responsePhotos: Decoded[] = [...ownedPhotos];
  for (const photo of overflowPhotos) {
    await addPhotoGift(exec, playerId, photo, shootingTime);
    const clone = { ...photo, Abilities: ((photo.Abilities as Decoded[] | undefined) ?? []).map((a) => ({ ...a, IsAvailable: false })) } as Decoded;
    responsePhotos.push(clone);
  }

  const updatedCharacters: Decoded[] = [];
  if (reliabilityIncreases.size) {
    const characters = await listElements(playerId, 'Characters', exec);
    const byId = new Map(characters.map((c) => [String(c.CharacterId ?? ''), c]));
    for (const [characterId, increase] of reliabilityIncreases) {
      const character = byId.get(characterId);
      if (!character) continue;
      character.Reliability = Number(character.Reliability ?? 0) + increase;
      updatedCharacters.push(character);
    }
    if (updatedCharacters.length) await putElements(playerId, 'Characters', updatedCharacters, exec);
  }

  const totalCount = (await getSingleton(playerId, 'TotalCount', exec)) ??
    ({ __msg: 'Solis.Common.Proto.Transaction.UserTotalCount' } as Decoded);
  totalCount.PhotoShootCount = Number(totalCount.PhotoShootCount ?? 0) + created.length;
  await putSingleton(playerId, 'TotalCount', totalCount, exec);

  const updatedStories: Decoded[] = [];
  if (scene.storyId) {
    const stories = await listElements(playerId, 'Stories', exec);
    const story = stories.find((s) => String(s.StoryId ?? '') === scene.storyId);
    if (!story) throw new Error(`${rpc}: story not owned ${scene.storyId}`);
    if (!story.IsPhotoShot) {
      story.IsPhotoShot = true;
      await putElements(playerId, 'Stories', [story], exec);
      updatedStories.push(story);
    }
  }

  const unused = reserved.filter((id) => !usedImageIds.has(id));
  const nextIds = [...unused];
  while (nextIds.length < RESERVED_PHOTO_IMAGE_ID_COUNT) {
    const id = randomUUID();
    if (reservedSet.has(id) || nextIds.includes(id)) continue;
    nextIds.push(id);
  }
  user.NextPhotoImageIds = nextIds;
  await putSingleton(playerId, 'User', user, exec);

  const updatedItems: Decoded[] = [];
  for (const itemId of filmAmounts.keys()) {
    updatedItems.push(itemSlice(itemId, await getItemAmount(playerId, itemId, exec)));
  }

  const updated = updatedData(
    ['Photos', ownedPhotos.length ? ownedPhotos : undefined],
    ['Characters', updatedCharacters.length ? updatedCharacters : undefined],
    ['Stories', updatedStories.length ? updatedStories : undefined],
    ['TotalCount', totalCount],
    ['User', user],
    ['Items', updatedItems],
  );

  return {
    photos: responsePhotos,
    isGift: overflowPhotos.length > 0,
    updated,
    deleted: null,
    highestPhotoLevel,
  };
}

function accountOf(ctx: { auth: { ok: boolean; claims?: { sub?: string } } }): string {
  const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
  if (!accountId) throw new Error('unauthenticated');
  return accountId;
}

async function playerForAccount(accountId: string, rpc: string, exec: Executor = db) {
  const [pl] = await exec.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  if (!pl) throw new Error(`${rpc}: no player for account`);
  return pl;
}

const DOKAN_WATCHED_KIND = 'dokan_watched';

async function listWatchedDokanIds(playerId: string, exec: Executor = db): Promise<string[]> {
  const rows = await exec
    .select({ entityKey: playerEntities.entityKey })
    .from(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, DOKAN_WATCHED_KIND)));
  return rows.map((r) => r.entityKey);
}

async function markDokanWatched(playerId: string, dokanIds: string[], exec: Executor = db): Promise<void> {
  const now = new Date();
  const existing = new Set(await listWatchedDokanIds(playerId, exec));
  const fresh = dokanIds.filter((id) => id && !existing.has(id));
  if (!fresh.length) return;
  const [max] = await exec
    .select({ ordinal: playerEntities.ordinal })
    .from(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, DOKAN_WATCHED_KIND)))
    .orderBy(desc(playerEntities.ordinal))
    .limit(1);
  let ordinal = Number(max?.ordinal ?? -1);
  await exec
    .insert(playerEntities)
    .values(
      fresh.map((id) => ({
        id: randomUUID(),
        playerId,
        kind: DOKAN_WATCHED_KIND,
        entityKey: id,
        ordinal: ++ordinal,
        blob: JSON.stringify({ watchedAt: now.toISOString() }),
        createdAt: now,
      })),
    )
    .onConflictDoNothing();
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

type PhotoResult = { updated: Decoded; deleted: Decoded | null; rewardResults?: Decoded[]; photos?: Decoded[] };

async function runPhoto<T>(
  accountId: string,
  rpc: string,
  fn: (tx: Executor, playerId: string) => Promise<T>,
): Promise<T> {
  const pl = await playerForAccount(accountId, rpc);
  return withPlayerTx(pl.id, (tx) => fn(tx, pl.id));
}

function commonOnly(res: PhotoResult): Decoded {
  return { __msg: '', CommonResponse: commonResponse(res.updated, res.deleted) } as Decoded;
}

function withRewardResults(res: PhotoResult): Decoded {
  return {
    __msg: '',
    RewardResults: res.rewardResults ?? [],
    CommonResponse: commonResponse(res.updated, res.deleted),
  } as Decoded;
}

async function loadUser(exec: Executor, playerId: string): Promise<Decoded> {
  return (await getSingleton(playerId, 'User', exec)) ?? ({ __msg: USER_MSG } as Decoded);
}

async function requirePhoto(exec: Executor, playerId: string, photoId: string, rpc: string): Promise<Decoded> {
  const photos = await listElements(playerId, 'Photos', exec);
  const photo = photos.find((p) => String(p.PhotoId ?? '') === photoId);
  if (!photo) throw new Error(`${rpc}: photo not owned ${photoId}`);
  return photo;
}

function itemSlice(itemId: string, amount: number): Decoded {
  return { __msg: USER_ITEM_MSG, ItemId: itemId, Amount: amount } as Decoded;
}

async function spendStone(exec: Executor, playerId: string, amount: number): Promise<Decoded> {
  const free = await getCurrency(playerId, 'freeJewel', exec);
  let remaining = amount;
  if (free >= remaining) {
    await spendCurrency(playerId, 'freeJewel', remaining, exec);
  } else {
    await spendCurrency(playerId, 'freeJewel', free, exec);
    remaining -= free;
    await spendCurrency(playerId, 'paidJewel', remaining, exec);
  }
  const freeAfter = await getCurrency(playerId, 'freeJewel', exec);
  const paidAfter = await getCurrency(playerId, 'paidJewel', exec);
  return { __msg: USER_BALANCE_MSG, FreeBalance: freeAfter, PaidBalance: paidAfter } as Decoded;
}

// Solis photo_panorama/catalogdata/photo_panorama.yaml.
const PANORAMA_TUTORIAL_CONDITION = 'cd-tutorial-finish-photo-create-shooting';
// Solis catalog plus music-hsm-017 (MELODIES), matching the official
// PhotoPanorama:List capture of 2026-10-09.
const PANORAMA_CATALOG = [
  { MusicId: 'music-clb-011', StageId: 'stage-live-unique-004-00', Order: 3, ViewConditionId: 'cd-time-music-clb-011-25-0826' },
  { MusicId: 'music-hsm-003', StageId: 'stage-live-dome-01-00', Order: 1, ViewConditionId: 'cd-time-music-360live-25-0624' },
  { MusicId: 'music-hsm-015', StageId: 'stage-live-dome-03-00', Order: 2, ViewConditionId: 'cd-time-music-360live-25-0624' },
  { MusicId: 'music-hsm-016', StageId: 'stage-live-dome-04-00', Order: 12, ViewConditionId: 'cd-time-music-hsm-016-26-0624' },
  { MusicId: 'music-hsm-017', StageId: 'stage-live-dome-03-00', Order: 15, ViewConditionId: 'cd-time-music-hsm-017-26-0831' },
  { MusicId: 'music-liz-005', StageId: 'stage-live-dome-01-01', Order: 11, ViewConditionId: 'cd-time-music-liz-005-26-0527' },
  { MusicId: 'music-moon-010', StageId: 'stage-live-dome-01-01', Order: 6, ViewConditionId: 'cd-time-music-moon-010-25-1224' },
  { MusicId: 'music-moon-011', StageId: 'stage-live-dome-01-06', Order: 8, ViewConditionId: 'cd-time-music-moon-011-26-0128' },
  { MusicId: 'music-sun-004', StageId: 'stage-live-dome-00-00', Order: 14, ViewConditionId: 'cd-time-music-sun-004-26-0708' },
  { MusicId: 'music-thrx-007', StageId: 'stage-live-dome-02-01', Order: 7, ViewConditionId: 'cd-time-music-thrx-007-26-0104' },
  { MusicId: 'music-tri-010', StageId: 'stage-live-dome-00-00', Order: 13, ViewConditionId: 'cd-time-music-tri-010-26-0625' },
  { MusicId: 'music-unit-010-360', StageId: 'stage-live-dome-05-00', Order: 5, ViewConditionId: 'cd-time-music-unit-010-25-1128' },
  { MusicId: 'music-unit-012', StageId: 'stage-live-dome-04-00', Order: 4, ViewConditionId: 'cd-time-music-unit-012-25-0927' },
  { MusicId: 'music-unit-013', StageId: 'stage-live-dome-01-06', Order: 9, ViewConditionId: 'cd-time-music-unit-013-26-0226' },
  { MusicId: 'music-unit-014', StageId: 'stage-live-dome-03-00', Order: 10, ViewConditionId: 'cd-time-music-unit-014-26-0327' },
];

/** Solis `listPhotoPanoramaMusics`: catalog songs whose master Music has a 360 live
 *  and whose stage exists, with the asset id taken from the master row. */
async function listPanoramaMusics() {
  const catalog = new Map(PANORAMA_CATALOG.map((e) => [e.MusicId, e]));
  const musics = (await listMusics())
    .filter((m) => m.Is360LiveExist && catalog.has(String(m.Id)))
    .sort((a, b) => String(a.Id).localeCompare(String(b.Id)));
  const resolved = [];
  for (const music of musics) {
    const entry = catalog.get(String(music.Id))!;
    if (!(await getPhotoStage(entry.StageId))) continue;
    resolved.push({ ...entry, AssetId: String(music.AssetId ?? '') });
  }
  return resolved;
}

// Solis internal/server/rpc/servers/photo/check_*.go validation.
function stringList(value: unknown): string[] {
  return ((value as unknown[] | null | undefined) ?? []).map((v) => String(v ?? ''));
}

function uniqueRequiredStrings(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function createShootingParams(raw: unknown): PhotoCreateParam[] {
  return ((raw as unknown[] | null | undefined) ?? []).map((p) => ({
    imageId: String((p as any).PhotoImageId ?? ''),
    itemId: String((p as any).ItemId ?? ''),
    focusCharacterId: String((p as any).MainCharacterId ?? ''),
  }));
}

function validatePhotoStyleLists(characterIds: string[], costumeIds: string[], hairIds: string[]): void {
  if (!characterIds.length) throw new Error('at least one character is required');
  if (characterIds.length !== costumeIds.length || characterIds.length !== hairIds.length) {
    throw new Error('character, costume and hair lists must have the same length');
  }
}

function validateOptionalPhotoStyleLists(characterIds: string[], costumeIds: string[], hairIds: string[]): void {
  if (
    characterIds.length !== costumeIds.length ||
    characterIds.length !== hairIds.length ||
    costumeIds.length !== hairIds.length
  ) {
    throw new Error('character, costume and hair lists must have the same length');
  }
}

async function validateOwnedPhotoStyles(
  exec: Executor,
  playerId: string,
  characterIds: string[],
  costumeIds: string[],
  hairIds: string[],
): Promise<void> {
  const [characters, costumes, hairs] = await Promise.all([
    listElements(playerId, 'Characters', exec),
    listElements(playerId, 'Costumes', exec),
    listElements(playerId, 'Hairs', exec),
  ]);
  const ownedCharacters = new Set(characters.map((c) => String(c.CharacterId ?? '')));
  const ownedCostumes = new Set(costumes.map((c) => String(c.CostumeId ?? '')));
  const ownedHairs = new Set(hairs.map((h) => String(h.HairId ?? '')));

  for (let i = 0; i < characterIds.length; i++) {
    const characterId = characterIds[i];
    const costumeId = costumeIds[i];
    const hairId = hairIds[i];
    if (!characterId || !costumeId || !hairId) throw new Error('character, costume and hair are required');
    if (!ownedCharacters.has(characterId)) throw new Error(`character not owned ${characterId}`);
    if (!ownedCostumes.has(costumeId)) throw new Error(`costume not owned ${costumeId}`);
    if (!ownedHairs.has(hairId)) throw new Error(`hair not owned ${hairId}`);
    const [costume, hair] = await Promise.all([getCostume(costumeId), getHair(hairId)]);
    if (!costume) throw new Error(`costume not found ${costumeId}`);
    if (!hair) throw new Error(`hair not found ${hairId}`);
    if (String(costume.CharacterId ?? '') !== characterId || String(hair.CharacterId ?? '') !== characterId) {
      throw new Error(`costume and hair must belong to character ${characterId}`);
    }
  }
}

async function checkPhotoShooting(
  request: Decoded | null | undefined,
  exec: Executor,
  playerId: string,
): Promise<void> {
  const characterIds = stringList(request?.CharacterIds);
  const costumeIds = stringList(request?.CostumeIds);
  const hairIds = stringList(request?.HairIds);
  validatePhotoStyleLists(characterIds, costumeIds, hairIds);

  const actionType = Number(request?.ActionType ?? 0);
  if (actionType === 1 || actionType === 2) {
    const activityId = String(request?.PhotoActivityId ?? '');
    if (!activityId) throw new Error('photoActivityId is required');
    const activity = await getPhotoActivity(activityId);
    if (!activity) throw new Error(`photo activity not found ${activityId}`);
    if (Number(activity.Type ?? 0) !== actionType) throw new Error(`photo activity ${activityId} action type mismatch`);
  } else if (actionType === 3) {
    const musicId = String(request?.PhotoMusicId ?? '');
    const stageId = String(request?.PhotoStageId ?? '');
    if (!musicId) throw new Error('photoMusicId is required');
    if (!stageId) throw new Error('photoStageId is required');
    if (!(await getPhotoQuestMusic(musicId))) throw new Error(`photo music not found ${musicId}`);
    if (!(await getPhotoStage(stageId))) throw new Error(`photo stage not found ${stageId}`);
  } else {
    throw new Error(`unsupported photo shooting action type ${actionType}`);
  }
  await validateOwnedPhotoStyles(exec, playerId, characterIds, costumeIds, hairIds);
}

async function checkExpressionShooting(
  request: Decoded | null | undefined,
  exec: Executor,
  playerId: string,
): Promise<void> {
  const expressionId = String(request?.PhotoExpressionId ?? '');
  if (!expressionId) throw new Error('photoExpressionId is required');
  if (!(await getPhotoExpression(expressionId))) throw new Error(`photo expression not found ${expressionId}`);

  const characterId = String(request?.CharacterId ?? '');
  const costumeId = String(request?.CostumeId ?? '');
  const hairId = String(request?.HairId ?? '');
  const anySingular = Boolean(characterId || costumeId || hairId);
  if (anySingular && !(characterId && costumeId && hairId)) {
    throw new Error('character, costume and hair must be specified together');
  }

  const characterIds = stringList(request?.CharacterIds);
  const costumeIds = stringList(request?.CostumeIds);
  const hairIds = stringList(request?.HairIds);
  validateOptionalPhotoStyleLists(characterIds, costumeIds, hairIds);
  if (!anySingular && !characterIds.length) throw new Error('at least one character is required');

  if (anySingular) await validateOwnedPhotoStyles(exec, playerId, [characterId], [costumeId], [hairId]);
  if (characterIds.length) await validateOwnedPhotoStyles(exec, playerId, characterIds, costumeIds, hairIds);
}

async function checkCardStoryShooting(
  request: Decoded | null | undefined,
  exec: Executor,
  playerId: string,
): Promise<void> {
  const cardId = String(request?.CardId ?? '');
  const number = Number(request?.Number ?? 0);
  if (!cardId) throw new Error('cardId is required');
  if (number <= 0) throw new Error('number is required');
  const card = await getCard(cardId);
  if (!card) throw new Error(`card not found ${cardId}`);
  const stories = (card.Stories as Array<{ StoryId?: string }> | null | undefined) ?? [];
  if (number > stories.length) throw new Error(`card story ${number} not found`);
  const cards = await listElements(playerId, 'Cards', exec);
  if (!cards.some((c) => String(c.CardId ?? '') === cardId)) throw new Error(`card not owned ${cardId}`);
  const storyId = String(stories[number - 1]?.StoryId ?? '');
  const story = (await listElements(playerId, 'Stories', exec)).find(
    (s) => String(s.StoryId ?? '') === storyId,
  );
  if (!story) throw new Error(`story not owned ${storyId}`);
  if (story.IsInvalid || Number(story.StatusType ?? 0) === 0) {
    throw new Error(`story ${storyId} is not available for shooting`);
  }
}

async function resolvePhotoStoryEpisode(
  partId: string,
  chapter: number,
  route: number,
  episode: number,
): Promise<string> {
  if (!partId || chapter <= 0 || route <= 0 || episode <= 0) {
    throw new Error('story part, chapter, route and episode are required');
  }
  const part = await getStoryPart(partId);
  if (!part) throw new Error(`story part not found ${partId}`);
  const chapters = (part.Chapters as Array<{
    Chapter?: number;
    Route?: number;
    Episodes?: Array<{ Episode?: number; StoryId?: string }>;
  }> | null | undefined) ?? [];
  const selectedChapter = chapters.find(
    (c) => Number(c.Chapter ?? 0) === chapter && Number(c.Route ?? 0) === route,
  );
  const selectedEpisode = (selectedChapter?.Episodes ?? []).find(
    (e) => Number(e.Episode ?? 0) === episode,
  );
  const storyId = String(selectedEpisode?.StoryId ?? '');
  if (!storyId) throw new Error('unknown story episode');
  return storyId;
}

async function photoStoryCharacters(storyId: string): Promise<string[]> {
  const [story, setting] = await Promise.all([getStory(storyId), getSetting()]);
  const ids = ((story?.AdditionalDisplayCharacterIds as string[] | null | undefined) ?? []).map(String);
  ids.push(String(setting?.StoryPhotoShootingDefaultCharacterId ?? ''));
  return uniqueRequiredStrings(ids);
}

function storyPartEventName(name: string): string {
  const trimmed = name.trim();
  return trimmed.endsWith('編') ? trimmed : `${trimmed}編`;
}

async function checkStoryEpisodeShooting(
  request: Decoded | null | undefined,
  exec: Executor,
  playerId: string,
): Promise<string> {
  const storyId = await resolvePhotoStoryEpisode(
    String(request?.StoryPartId ?? ''),
    Number(request?.Chapter ?? 0),
    Number(request?.Route ?? 0),
    Number(request?.Episode ?? 0),
  );
  const story = (await listElements(playerId, 'Stories', exec)).find(
    (s) => String(s.StoryId ?? '') === storyId,
  );
  if (!story) throw new Error(`story not owned ${storyId}`);
  if (story.IsInvalid || (Number(story.StatusType ?? 0) !== 2 && !story.IsUseActivatePhotoShootingStoryTicket)) {
    throw new Error(`story ${storyId} is not available for shooting`);
  }
  return storyId;
}

async function checkExcursionShooting(
  request: Decoded | null | undefined,
  exec: Executor,
  playerId: string,
): Promise<void> {
  const placeId = String(request?.ExcursionPlaceId ?? '');
  const characterId = String(request?.CharacterId ?? '');
  const costumeId = String(request?.CostumeId ?? '');
  const hairId = String(request?.HairId ?? '');
  if (!placeId || !characterId || !costumeId || !hairId) {
    throw new Error('excursion place, character, costume and hair are required');
  }
  if (!(await getExcursionPlace(placeId))) throw new Error(`excursion place not found ${placeId}`);
  await validateOwnedPhotoStyles(exec, playerId, [characterId], [costumeId], [hairId]);
}

async function checkSpecialShooting(
  request: Decoded | null | undefined,
  exec: Executor,
  playerId: string,
): Promise<void> {
  // The request's SpecialPhotoShootingId is the campaign id, not a photo
  // activity id: a matching activity row still drives the action-type check,
  // while the sandbox campaign has no master row and is accepted as-is.
  const actionType = Number(request?.ActionType ?? 0);
  const specialId = String(request?.SpecialPhotoShootingId ?? '');
  if (!specialId) throw new Error('specialPhotoShootingId is required');
  const activity = await getPhotoActivity(specialId);
  if (activity) {
    if (actionType && Number(activity.Type ?? 0) !== actionType) {
      throw new Error(`photo activity ${specialId} action type mismatch`);
    }
  } else if (!(specialId === SANDBOX_SPECIAL_PHOTO_SHOOTING_ID && isSandbox())) {
    throw new Error(`special photo shooting not found ${specialId}`);
  }
  const musicId = String(request?.MusicId ?? '');
  const stageId = String(request?.StageId ?? '');
  if (musicId && !(await getPhotoQuestMusic(musicId))) throw new Error(`photo music not found ${musicId}`);
  if (stageId && !(await getPhotoStage(stageId))) throw new Error(`photo stage not found ${stageId}`);
  const characterIds = stringList(request?.CharacterIds);
  const costumeIds = stringList(request?.CostumeIds);
  const hairIds = stringList(request?.HairIds);
  validateOptionalPhotoStyleLists(characterIds, costumeIds, hairIds);
  if (characterIds.length) await validateOwnedPhotoStyles(exec, playerId, characterIds, costumeIds, hairIds);
}

async function checkPanoramaShooting(
  request: Decoded | null | undefined,
  exec: Executor,
  playerId: string,
): Promise<void> {
  const musicId = String(request?.PhotoMusicId ?? '');
  if (!musicId) throw new Error('photoMusicId is required');
  if (!(await listPanoramaMusics()).some((m) => m.MusicId === musicId)) throw new Error(`panorama music not found ${musicId}`);
  const characterIds = stringList(request?.CharacterIds);
  const costumeIds = stringList(request?.CostumeIds);
  const hairIds = stringList(request?.HairIds);
  validatePhotoStyleLists(characterIds, costumeIds, hairIds);
  if (uniqueRequiredStrings(characterIds).length !== characterIds.length) {
    throw new Error('characterIds must be unique');
  }
  await validateOwnedPhotoStyles(exec, playerId, characterIds, costumeIds, hairIds);
}

async function checkShowcaseShooting(
  request: Decoded | null | undefined,
  exec: Executor,
  playerId: string,
): Promise<void> {
  const number = Number(request?.Number ?? 0);
  if (number <= 0) throw new Error('number is required');
  const showcases = await listElements(playerId, 'Showcases', exec);
  if (!showcases.some((s) => Number(s.Number ?? 0) === number)) {
    throw new Error(`showcase not found ${number}`);
  }
}

function photoShootingResponse(res: PhotoCreationResult, extra: Record<string, unknown> = {}): Decoded {
  return {
    __msg: '',
    Photos: res.photos,
    IsGift: res.isGift,
    ...extra,
    CommonResponse: commonResponse(res.updated, res.deleted),
  } as Decoded;
}

/** `Photo:Enhance` — raise a photo's level using Advance Film. */
register(
  'Photo:Enhance',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const photoId = ctx.request?.PhotoId == null ? '' : String(ctx.request.PhotoId);
    const target = Number(ctx.request?.Level ?? 0);
    if (!photoId || target <= 0) throw new Error('Photo:Enhance: missing PhotoId/Level');

    return commonOnly(
      await runPhoto(accountId, 'Photo:Enhance', async (tx, playerId) => {
        const photo = await requirePhoto(tx, playerId, photoId, 'Photo:Enhance');
        const current = Number(photo.Level ?? 10);
        if (target <= current) throw new Error(`Photo:Enhance: target ${target} not above current ${current}`);
        const row = await getPhotoRarityLevel(Number(photo.Rarity ?? 1), target);
        if (!row) throw new Error(`Photo:Enhance: no PhotoRarityLevel ${photo.Rarity}/${target}`);
        const cost = Number(row.EnhanceRequiredItem ?? 0);
        await spendItem(playerId, PHOTO_ENHANCE_ITEM, cost, tx);
        photo.Level = target;
        await putElements(playerId, 'Photos', [photo], tx);
        const remaining = await getItemAmount(playerId, PHOTO_ENHANCE_ITEM, tx);
        ctx.fastifyReq.log.info({ accountId, playerId, photoId, from: current, to: target, cost }, 'photo enhance');
        return {
          updated: updatedData(['Items', [itemSlice(PHOTO_ENHANCE_ITEM, remaining)]], ['Photos', [photo]]),
          deleted: null,
        };
      }),
    );
  },
  { ownsState: true },
);

/**
 * `Photo:ExtendLimit` — buy `PhotoLimitExtendAmount` more photo storage for
 * stones, up to `Setting.PhotoLimitExtendLimit` times. Request is `Empty`.
 */
register(
  'Photo:ExtendLimit',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return commonOnly(
      await runPhoto(accountId, 'Photo:ExtendLimit', async (tx, playerId) => {
        const setting = await getSetting();
        const limit = Number(setting?.PhotoLimitExtendLimit ?? 20);
        const user = await loadUser(tx, playerId);
        const count = Number(user.PhotoLimitExtendedCount ?? 0);
        if (count >= limit) throw new Error(`Photo:ExtendLimit: already at max ${limit}`);
        const balance = await spendStone(tx, playerId, Number(setting?.PhotoLimitExtendStone ?? 100));
        user.PhotoLimitExtendedCount = count + 1;
        await putSingleton(playerId, 'User', user, tx);
        ctx.fastifyReq.log.info({ accountId, playerId, count: count + 1 }, 'photo extend limit');
        return { updated: updatedData(['User', user], ['Balance', balance]), deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Photo:Retouch` — apply a photo recipe, changing the photo's abilities. */
register(
  'Photo:Retouch',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const photoId = ctx.request?.PhotoId == null ? '' : String(ctx.request.PhotoId);
    const recipeId = ctx.request?.PhotoRecipeId == null ? '' : String(ctx.request.PhotoRecipeId);
    if (!photoId || !recipeId) throw new Error('Photo:Retouch: missing PhotoId/PhotoRecipeId');

    const recipe = await getPhotoRecipe(recipeId);
    if (!recipe) throw new Error(`Photo:Retouch: unknown PhotoRecipe ${recipeId}`);

    return commonOnly(
      await runPhoto(accountId, 'Photo:Retouch', async (tx, playerId) => {
        const photo = await requirePhoto(tx, playerId, photoId, 'Photo:Retouch');
        const groupId = String(recipe.PhotoRetouchEnhanceGroupId ?? '');
        const step = groupId
          ? await getPhotoRetouchEnhance(groupId, Number(photo.Level ?? 10))
          : null;
        const consumptionId = step?.ConsumptionId ?? recipe.RetouchConsumptionId;
        const results = await consume(playerId, consumptionId, 1, tx);
        photo.PhotoRecipeId = recipeId;
        await putElements(playerId, 'Photos', [photo], tx);
        ctx.fastifyReq.log.info({ accountId, playerId, photoId, recipeId }, 'photo retouch');
        return {
          updated: updatedData(
            ['Photos', [photo]],
            ...consumptionUpdatedData(results),
          ),
          deleted: null,
        };
      }),
    );
  },
  { ownsState: true },
);

/** `Photo:Reroll` — reroll a photo's abilities for Recycle Film. */
register(
  'Photo:Reroll',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const photoId = ctx.request?.PhotoId == null ? '' : String(ctx.request.PhotoId);
    if (!photoId) throw new Error('Photo:Reroll: missing PhotoId');

    return commonOnly(
      await runPhoto(accountId, 'Photo:Reroll', async (tx, playerId) => {
        const photo = await requirePhoto(tx, playerId, photoId, 'Photo:Reroll');
        const row = await getPhotoRarityLevel(Number(photo.Rarity ?? 1), Number(photo.Level ?? 10));
        if (!row) throw new Error('Photo:Reroll: no PhotoRarityLevel row');
        const cost = Number(row.RerollRequiredItem ?? 0);
        await spendItem(playerId, PHOTO_REROLL_ITEM, cost, tx);
        photo.Abilities = [];
        photo.Rerollable = false;
        await putElements(playerId, 'Photos', [photo], tx);
        const remaining = await getItemAmount(playerId, PHOTO_REROLL_ITEM, tx);
        ctx.fastifyReq.log.info({ accountId, playerId, photoId, cost }, 'photo reroll');
        return {
          updated: updatedData(['Items', [itemSlice(PHOTO_REROLL_ITEM, remaining)]], ['Photos', [photo]]),
          deleted: null,
        };
      }),
    );
  },
  { ownsState: true },
);

/** `Photo:Update` — rename a photo. */
register(
  'Photo:Update',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const photoId = ctx.request?.PhotoId == null ? '' : String(ctx.request.PhotoId);
    const name = ctx.request?.Name == null ? '' : String(ctx.request.Name);
    if (!photoId) throw new Error('Photo:Update: missing PhotoId');

    return commonOnly(
      await runPhoto(accountId, 'Photo:Update', async (tx, playerId) => {
        const photo = await requirePhoto(tx, playerId, photoId, 'Photo:Update');
        photo.Name = name;
        await putElements(playerId, 'Photos', [photo], tx);
        return { updated: updatedData(['Photos', [photo]]), deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Photo:SwitchLock` — toggle the lock flag on each given photo. */
register(
  'Photo:SwitchLock',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const ids = ((ctx.request?.PhotoIds as unknown[] | undefined) ?? []).map((v) => String(v)).filter(Boolean);
    if (!ids.length) throw new Error('Photo:SwitchLock: missing PhotoIds');

    return commonOnly(
      await runPhoto(accountId, 'Photo:SwitchLock', async (tx, playerId) => {
        const photos = await listElements(playerId, 'Photos', tx);
        const changed: Decoded[] = [];
        for (const id of ids) {
          const photo = photos.find((p) => String(p.PhotoId ?? '') === id);
          if (!photo) throw new Error(`Photo:SwitchLock: photo not owned ${id}`);
          photo.Locked = !photo.Locked;
          changed.push(photo);
        }
        await putElements(playerId, 'Photos', changed, tx);
        return { updated: updatedData(['Photos', changed]), deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Photo:Delete` — delete photos, returning Advance Film per deleted photo. */
register(
  'Photo:Delete',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const ids = ((ctx.request?.PhotoIds as unknown[] | undefined) ?? []).map((v) => String(v)).filter(Boolean);
    if (!ids.length) throw new Error('Photo:Delete: missing PhotoIds');

    let deletedOwner = '';
    const deletedAssetIds: string[] = [];
    const result = withRewardResults(
      await runPhoto(accountId, 'Photo:Delete', async (tx, playerId) => {
        const photos = await listElements(playerId, 'Photos', tx);
        const removed: Decoded[] = [];
        const grants: Grant[] = [];
        for (const id of ids) {
          const photo = photos.find((p) => String(p.PhotoId ?? '') === id);
          if (!photo) throw new Error(`Photo:Delete: photo not owned ${id}`);
          const row = await getPhotoRarityLevel(Number(photo.Rarity ?? 1), Number(photo.Level ?? 10));
          const amount = Number(row?.DeleteRewardItem ?? 0);
          if (amount > 0) grants.push({ resourceType: 1, resourceId: PHOTO_ENHANCE_ITEM, amount });
          removed.push(photo);
        }
        await removeElements(playerId, 'Photos', removed, tx);
        const applied = grants.length ? await applyGrants(playerId, grants, tx) : null;
        const updated = applied?.updated ?? ({ __msg: UPDATED_DATA_MSG } as Decoded);
        deletedOwner = playerId;
        for (const photo of removed) {
          if (Number(photo.ImageType ?? 0) === PHOTO_IMAGE_TYPE_USER && String(photo.AssetId ?? '') !== '') {
            deletedAssetIds.push(String(photo.AssetId));
          }
        }
        ctx.fastifyReq.log.info({ accountId, playerId, count: removed.length }, 'photo delete');
        return {
          updated,
          deleted: { __msg: DELETED_DATA_MSG, Photos: removed } as Decoded,
          rewardResults: applied?.results ?? [],
        };
      }),
    );
    // After commit, drop the uploaded image objects (Solis removeUserPhotoImageObjects).
    await removeUserPhotoImageObjects(ctx.fastifyReq.log, deletedOwner, deletedAssetIds);
    return result;
  },
  { ownsState: true },
);

/** `Photo:SaleRecipe`— sell photo recipes for their master sale reward. */
register(
  'Photo:SaleRecipe',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const ids = ((ctx.request?.PhotoRecipeIds as unknown[] | undefined) ?? []).map((v) => String(v)).filter(Boolean);
    if (!ids.length) throw new Error('Photo:SaleRecipe: missing PhotoRecipeIds');

    return withRewardResults(
      await runPhoto(accountId, 'Photo:SaleRecipe', async (tx, playerId) => {
        const recipes = await listElements(playerId, 'PhotoRecipes', tx);
        const removed: Decoded[] = [];
        const refs: string[] = [];
        for (const id of ids) {
          const recipe = recipes.find((r) => String(r.PhotoRecipeId ?? '') === id);
          if (!recipe) throw new Error(`Photo:SaleRecipe: recipe not owned ${id}`);
          const master = await getPhotoRecipe(id);
          const saleRef = String(master?.SaleRewardId ?? '');
          if (saleRef) refs.push(saleRef);
          removed.push(recipe);
        }
        await removeElements(playerId, 'PhotoRecipes', removed, tx);
        const applied = refs.length ? await applyRewardRefs(playerId, refs, tx) : null;
        const updated = applied?.updated ?? ({ __msg: UPDATED_DATA_MSG } as Decoded);
        ctx.fastifyReq.log.info({ accountId, playerId, count: removed.length }, 'photo sale recipe');
        return {
          updated,
          deleted: { __msg: DELETED_DATA_MSG, PhotoRecipes: removed } as Decoded,
          rewardResults: applied?.results ?? [],
        };
      }),
    );
  },
  { ownsState: true },
);

/** `Photo:Report` — reports a photo as a gift; request is `Empty`. */
register(
  'Photo:Report',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const res = await runPhoto(accountId, 'Photo:Report', async (_tx, playerId) => {
      ctx.fastifyReq.log.info({ accountId, playerId }, 'photo report');
      return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
    });
    return {
      __msg: '',
      IsGift: false,
      CommonResponse: commonResponse(res.updated, res.deleted),
    } as Decoded;
  },
  { ownsState: true },
);

/**
 * `Photo:ListShooting` — the shooting top page. Request is `Empty`.
 * Returns every selectable activity / quest music / quest stage / expression,
 * with unlock flags set to true (no condition engine exists yet).
 */
register(
  'Photo:ListShooting',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return runPhoto(accountId, 'Photo:ListShooting', async (tx, playerId) => {
      const activities = await listPhotoActivities();
      const costumes = await listElements(playerId, 'Costumes', tx);
      const ownedCostumes = new Set(costumes.map((c) => String(c.CostumeId ?? '')));
      const musics = await listPhotoQuestMusics();
      const stages = await listPhotoQuestStages();
      const expressions = await listPhotoExpressions();
      ctx.fastifyReq.log.info({ accountId, playerId }, 'photo list shooting');
      return {
        __msg: '',
        Activities: dedupePoolPhotoActivities(activities, ownedCostumes).map((a) => ({
          __msg: 'Solis.Common.Proto.Api.PhotoActivity',
          PhotoActivityId: a.Id,
          IsUnlocked: true,
        } as Decoded)),
        Musics: musics.map((m) => ({
          __msg: 'Solis.Common.Proto.Api.PhotoMusic',
          MusicId: m.Id,
          IsUnlocked: true,
        } as Decoded)),
        Stages: stages.map((s) => ({
          __msg: 'Solis.Common.Proto.Api.PhotoStage',
          StageId: s.Id,
          IsUnlocked: true,
        } as Decoded)),
        Expressions: expressions.map((e) => ({
          __msg: 'Solis.Common.Proto.Api.PhotoExpression',
          PhotoExpressionId: e.Id,
          IsUnlocked: true,
        } as Decoded)),
        DokanInfo: {
          __msg: 'Solis.Common.Proto.Api.PhotoDokanInfo',
          Expressions: (await listWatchedDokanIds(playerId, tx)).includes('dokan_photo-expression-tutorial')
            ? ([] as Decoded[])
            : [
                {
                  __msg: 'Solis.Common.Proto.Api.DokanInfo',
                  Id: 'dokan_photo-expression-tutorial',
                  Type: 2,
                  NoticeInfo: {
                    __msg: 'Solis.Common.Proto.Api.NoticeInfo',
                    Id: 'info-news-pose-howto-24-1224',
                    Title: '新機能「ポーズ撮影」登場！',
                    BannerAssetId: 'img_banner_l_photo-expression',
                  } as Decoded,
                } as Decoded,
              ],
        } as Decoded,
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Dokan:SetWatched` — acknowledge (mark watched) the given dokan ids. */
register(
  'Dokan:SetWatched',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const ids = ((ctx.request?.DokanIds as unknown[] | undefined) ?? []).map((id) => String(id));
    return commonOnly(
      await runPhoto(accountId, 'Dokan:SetWatched', async (tx, playerId) => {
        await markDokanWatched(playerId, ids, tx);
        ctx.fastifyReq.log.info({ accountId, playerId, count: ids.length, ids }, 'dokan set watched');
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Dokan:OutputWatchedLog` — server-side log of already-watched dokans. */
register(
  'Dokan:OutputWatchedLog',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const ids = ((ctx.request?.DokanIds as unknown[] | undefined) ?? []).map((id) => String(id));
    return commonOnly(
      await runPhoto(accountId, 'Dokan:OutputWatchedLog', async (tx, playerId) => {
        ctx.fastifyReq.log.info({ accountId, playerId, count: ids.length, ids }, 'dokan output watched log');
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Photo:CheckShooting` — validate a shooting scene before consumption. */
register(
  'Photo:CheckShooting',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return commonOnly(
      await runPhoto(accountId, 'Photo:CheckShooting', async (tx, playerId) => {
        await checkPhotoShooting(ctx.request, tx, playerId);
        ctx.fastifyReq.log.info({ accountId, playerId }, 'photo check shooting');
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Photo:CreateShootings` — consume film and generate photos. */
register(
  'Photo:CreateShootings',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const params = createShootingParams(ctx.request?.CreateShootingParams);
    const manualCount = Number(ctx.request?.ManualCount ?? 0);
    const actionType = Number(ctx.request?.ActionType ?? 0);

    const res = await runPhoto(accountId, 'Photo:CreateShootings', async (tx, playerId) => {
      await checkPhotoShooting(ctx.request, tx, playerId);

      let placeName = '';
      let eventName = '';
      let musicId: string | undefined;
      if (actionType === 3) {
        const stage = await getPhotoStage(String(ctx.request?.PhotoStageId ?? ''));
        placeName = String(stage?.Name ?? '');
        eventName = 'ライブ';
        musicId = String(ctx.request?.PhotoMusicId ?? '');
      } else {
        const activity = await getPhotoActivity(String(ctx.request?.PhotoActivityId ?? ''));
        placeName = String(activity?.Name ?? '');
        eventName = placeName;
      }

      const result = await createUserPhotoShootings(
        tx,
        playerId,
        {
          placeName,
          eventName,
          candidateCharacterIds: stringList(ctx.request?.CharacterIds),
          musicId,
        },
        params,
        manualCount,
        'Photo:CreateShootings',
      );
      ctx.fastifyReq.log.info({ accountId, playerId, count: result.photos.length }, 'photo create shootings');
      return result;
    });
    return photoShootingResponse(res);
  },
  { ownsState: true },
);

/**
 * `Photo:GetImageURL` — Firebase Storage download URLs for the caller's photo
 * images (Solis photo/get_image_url.go). Type 1 = original, 2 = thumbnail,
 * 3 = both. URLs carry the published download token; an image that was never
 * uploaded still gets a token-less URL, and a missing `_t` thumbnail falls back
 * to the original image.
 */
register(
  'Photo:GetImageURL',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const type = Number(ctx.request?.Type ?? 0);
    if (type !== 1 && type !== 2 && type !== 3) throw new Error('Photo:GetImageURL: unsupported photo image request type');
    const assetIds = ((ctx.request?.AssetIds as unknown[] | undefined) ?? []).map((v) => String(v));
    const pl = await playerForAccount(accountId, 'Photo:GetImageURL');
    const publicUserId = await publicUserIdForPlayer(pl.id);

    const names: string[] = [];
    const lookupNames: string[] = [];
    for (const assetId of assetIds) {
      if (!isPhotoAssetId(assetId)) throw new Error(`Photo:GetImageURL: invalid photo assetId ${JSON.stringify(assetId)}`);
      const name = `${PHOTO_OBJECT_PREFIX}/${publicUserId}/${assetId}`;
      names.push(name);
      lookupNames.push(name);
      if (type !== 1) lookupNames.push(`${name}_t`);
    }
    const metadataByName = new Map<string, PhotoImageMetadata>();
    for (const entry of await findFinalizedPhotoImageMetadataByNames(pl.id, lookupNames)) {
      if (entry.generation !== '' && entry.publicUserId === publicUserId) metadataByName.set(entry.name, entry);
    }

    const list = names.map((name, index) => {
      const downloadUrl = photoFirebaseDownloadUrl(name, metadataByName.get(name));
      const thumbnail = metadataByName.get(`${name}_t`);
      const thumbnailUrl = thumbnail ? photoFirebaseDownloadUrl(thumbnail.name, thumbnail) : downloadUrl;
      const out: Decoded = { __msg: 'Solis.Common.Proto.Api.PhotoImageUrl', AssetId: assetIds[index] } as Decoded;
      if (type === 1 || type === 3) out.OrigUrl = downloadUrl;
      if (type === 2 || type === 3) out.TmbUrl = thumbnailUrl;
      return out;
    });
    ctx.fastifyReq.log.info(
      { accountId, type, count: assetIds.length, published: metadataByName.size },
      'photo get image url',
    );
    return { __msg: '', UrlList: list } as Decoded;
  },
  { ownsState: true },
);

/** `Photo:CheckExpressionShooting` — validate an expression shooting scene. */
register(
  'Photo:CheckExpressionShooting',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return commonOnly(
      await runPhoto(accountId, 'Photo:CheckExpressionShooting', async (tx, playerId) => {
        await checkExpressionShooting(ctx.request, tx, playerId);
        ctx.fastifyReq.log.info({ accountId, playerId }, 'photo check expression shooting');
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Photo:CreateExpressionShootings` — consume film and generate expression photos. */
register(
  'Photo:CreateExpressionShootings',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const expressionId = ctx.request?.PhotoExpressionId == null ? '' : String(ctx.request.PhotoExpressionId);
    const rawParams = ((ctx.request?.CreateExpressionShootingParams as unknown[] | undefined) ?? []).map((p) => ({
      photoImageId: String((p as any).PhotoImageId ?? ''),
      itemId: String((p as any).ItemId ?? ''),
      mainCharacterId: String((p as any).MainCharacterId ?? ''),
      stagePositionNumber: Number((p as any).StagePositionNumber ?? 0),
      photoPoseId: String((p as any).PhotoPoseId ?? ''),
      photoFacialId: String((p as any).PhotoFacialId ?? ''),
      characterIds: stringList((p as any).CharacterIds),
      photoPoseIds: stringList((p as any).PhotoPoseIds),
      photoFacialIds: stringList((p as any).PhotoFacialIds),
      photoLookingTypes: ((p as any).PhotoLookingTypes as unknown[] | undefined) ?? [],
    }));
    if (!rawParams.length) throw new Error('Photo:CreateExpressionShootings: missing CreateExpressionShootingParams');
    const manualCount = Number(ctx.request?.ManualCount ?? 0);

    const res = await runPhoto(accountId, 'Photo:CreateExpressionShootings', async (tx, playerId) => {
      await checkExpressionShooting(ctx.request, tx, playerId);
      const expression = await getPhotoExpression(expressionId);
      if (!expression) throw new Error(`photo expression not found ${expressionId}`);
      const stage = await getPhotoStage(String(expression.StageId ?? ''));
      if (!stage) throw new Error(`photo expression stage not found ${expression.StageId}`);

      const ownedPoses = new Set(
        (await listElements(playerId, 'PhotoPoses', tx)).map((p) => String(p.PhotoPoseId ?? '')),
      );
      const candidateIds = stringList(ctx.request?.CharacterIds);
      const effectiveCandidates = candidateIds.length
        ? candidateIds
        : [String(ctx.request?.CharacterId ?? '')].filter(Boolean);
      const specifiedPoseCounts: Record<string, number> = {};
      const specifiedCharacterCounts: Record<string, number> = {};
      const params: PhotoCreateParam[] = [];

      for (const param of rawParams) {
        if (!(await getPhotoExpressionStagePosition(String(expression.StageId ?? ''), param.stagePositionNumber))) {
          throw new Error('unknown expression stage position');
        }
        if (!param.photoImageId || !param.itemId || !param.mainCharacterId) {
          throw new Error('photoImageId, itemId and mainCharacterId are required');
        }
        if (param.characterIds.length) {
          if (
            param.photoPoseIds.length !== param.characterIds.length ||
            param.photoFacialIds.length !== param.characterIds.length ||
            param.photoLookingTypes.length !== param.characterIds.length
          ) {
            throw new Error('expression character option lists must have equal lengths');
          }
          if (!param.characterIds.includes(param.mainCharacterId)) {
            throw new Error('main character is absent from expression characters');
          }
        }
        for (const poseId of [...param.photoPoseIds, param.photoPoseId]) {
          if (!poseId) continue;
          if (!(await getPhotoPose(poseId))) throw new Error(`photo pose not found ${poseId}`);
          if (!ownedPoses.has(poseId)) throw new Error(`photo pose not owned ${poseId}`);
        }
        for (const facialId of [...param.photoFacialIds, param.photoFacialId]) {
          if (!facialId) continue;
          if (!(await getPhotoFacial(facialId))) throw new Error(`photo facial not found ${facialId}`);
        }
        if (param.photoPoseId) specifiedPoseCounts[param.photoPoseId] = (specifiedPoseCounts[param.photoPoseId] ?? 0) + 1;
        if (param.mainCharacterId) {
          specifiedCharacterCounts[param.mainCharacterId] =
            (specifiedCharacterCounts[param.mainCharacterId] ?? 0) + 1;
        }
        params.push({
          imageId: param.photoImageId,
          itemId: param.itemId,
          focusCharacterId: param.mainCharacterId,
        });
      }

      const result = await createUserPhotoShootings(
        tx,
        playerId,
        {
          placeName: String(stage.Name ?? ''),
          eventName: String(expression.Name ?? ''),
          candidateCharacterIds: effectiveCandidates,
          expressionShooting: true,
          specifiedPoseCounts,
          specifiedCharacterCounts,
        },
        params,
        manualCount,
        'Photo:CreateExpressionShootings',
      );
      ctx.fastifyReq.log.info({ accountId, playerId, expressionId, count: result.photos.length }, 'photo create expression shootings');
      return result;
    });
    return photoShootingResponse(res);
  },
  { ownsState: true },
);

/** `Photo:CheckCardStoryShooting` — validate a card-story shooting scene. */
register(
  'Photo:CheckCardStoryShooting',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return commonOnly(
      await runPhoto(accountId, 'Photo:CheckCardStoryShooting', async (tx, playerId) => {
        await checkCardStoryShooting(ctx.request, tx, playerId);
        ctx.fastifyReq.log.info({ accountId, playerId }, 'photo check card story shooting');
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Photo:CreateCardStoryShootings` — consume film and generate card-story photos. */
register(
  'Photo:CreateCardStoryShootings',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const cardId = ctx.request?.CardId == null ? '' : String(ctx.request.CardId);
    const number = Number(ctx.request?.Number ?? 0);
    const params = createShootingParams(ctx.request?.CreateShootingParams);
    const manualCount = Number(ctx.request?.ManualCount ?? 0);

    const res = await runPhoto(accountId, 'Photo:CreateCardStoryShootings', async (tx, playerId) => {
      await checkCardStoryShooting(ctx.request, tx, playerId);
      const card = await getCard(cardId);
      if (!card) throw new Error(`card not found ${cardId}`);
      const stories = (card.Stories as Array<{ StoryId?: string }> | null | undefined) ?? [];
      const storyId = String(stories[number - 1]?.StoryId ?? '');
      const candidates = uniqueRequiredStrings([
        ...(await photoStoryCharacters(storyId)),
        String(card.CharacterId ?? ''),
      ]);

      const result = await createUserPhotoShootings(
        tx,
        playerId,
        {
          placeName: `${card.Name ?? ''} ${number}話`,
          eventName: 'アイドル編',
          candidateCharacterIds: candidates,
          storyId,
          storyShooting: true,
        },
        params,
        manualCount,
        'Photo:CreateCardStoryShootings',
      );
      ctx.fastifyReq.log.info({ accountId, playerId, cardId, number, count: result.photos.length }, 'photo create card story shootings');
      return result;
    });
    return photoShootingResponse(res);
  },
  { ownsState: true },
);

/** `PhotoPanorama:List` — 360° live shooting list (Solis catalog). */
register(
  'PhotoPanorama:List',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return runPhoto(accountId, 'PhotoPanorama:List', async (tx, playerId) => {
      const musics = await listPanoramaMusics();
      ctx.fastifyReq.log.info({ accountId, playerId }, 'photo panorama list');
      return {
        __msg: '',
        Musics: musics.map((m) => ({
          __msg: 'Solis.Common.Proto.Api.PhotoPanoramaMusic',
          MusicId: m.MusicId,
          StageId: m.StageId,
          IsUnlocked: true,
          UnlockConditionId: PANORAMA_TUTORIAL_CONDITION,
          AssetId: m.AssetId,
          Order: m.Order,
          ViewConditionId: m.ViewConditionId,
        } as Decoded)),
        DokanInfos: [] as Decoded[],
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `PhotoPanorama:CheckShooting` — validate a 360° scene. */
register(
  'PhotoPanorama:CheckShooting',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return commonOnly(
      await runPhoto(accountId, 'PhotoPanorama:CheckShooting', async (tx, playerId) => {
        await checkPanoramaShooting(ctx.request, tx, playerId);
        ctx.fastifyReq.log.info(
          {
            accountId,
            playerId,
            musicId: ctx.request?.PhotoMusicId,
            characterIds: ctx.request?.CharacterIds,
            costumeIds: ctx.request?.CostumeIds,
            hairIds: ctx.request?.HairIds,
          },
          'photo panorama check shooting',
        );
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `PhotoPanorama:CreateShootings` — consume film and generate 360° photos. */
register(
  'PhotoPanorama:CreateShootings',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const params = createShootingParams(ctx.request?.CreateShootingParams);
    const manualCount = Number(ctx.request?.ManualCount ?? 0);
    const cameraTypes = ((ctx.request?.CameraTypes as unknown[] | undefined) ?? []).map(Number);

    const res = await runPhoto(accountId, 'PhotoPanorama:CreateShootings', async (tx, playerId) => {
      await checkPanoramaShooting(ctx.request, tx, playerId);
      if (cameraTypes.length !== params.length) throw new Error('cameraTypes and createShootingParams must have the same length');
      if (cameraTypes.some((t) => t < 1 || t > 5)) throw new Error('unsupported panorama camera type');
      const characterIds = stringList(ctx.request?.CharacterIds);
      const startCharacterId = String(ctx.request?.StartCharacterId ?? '');
      if (startCharacterId && !characterIds.includes(startCharacterId)) {
        throw new Error('start character is absent from panorama characters');
      }
      for (const param of params) {
        if (param.focusCharacterId && !characterIds.includes(param.focusCharacterId)) {
          throw new Error('main character is absent from panorama characters');
        }
      }
      const music = (await listPanoramaMusics()).find((m) => m.MusicId === String(ctx.request?.PhotoMusicId ?? ''));
      if (!music) throw new Error('panorama music not found');
      const stage = await getPhotoStage(music.StageId);

      const result = await createUserPhotoShootings(
        tx,
        playerId,
        {
          placeName: String(stage?.Name ?? ''),
          eventName: '360°LIVE ',
          candidateCharacterIds: characterIds,
          panoramaShooting: true,
          musicId: music.MusicId,
        },
        params,
        manualCount,
        'PhotoPanorama:CreateShootings',
      );
      ctx.fastifyReq.log.info({ accountId, playerId, count: result.photos.length }, 'photo panorama create shootings');
      return result;
    });
    return photoShootingResponse(res);
  },
  { ownsState: true },
);

type ShelfSavedPhoto = {
  AssetId: string;
  MainCharacterId: string;
  Episode: number;
  CreatedTime: number;
};

type ShelfAlbumState = {
  photos: ShelfSavedPhoto[];
  templateId: string;
  slots: Record<string, Record<string, string>>;
  /** Per-template `{ [slotNumber]: PositionX }` crop offsets from `Shelf:SetPhoto`. */
  positions: Record<string, Record<string, number>>;
};

type ShelfState = Record<string, ShelfAlbumState>;

/** Per-album state from the player's persisted `players.data.shelf` blob. */
function shelfAlbumState(shelf: ShelfState, albumId: string): ShelfAlbumState {
  const stored = shelf[albumId];
  const slots: ShelfAlbumState['slots'] =
    stored?.slots && typeof stored.slots === 'object' ? stored.slots : {};
  const positions: ShelfAlbumState['positions'] =
    stored?.positions && typeof stored.positions === 'object' ? stored.positions : {};
  const storedTemplateId =
    typeof stored?.templateId === 'string' && stored.templateId ? stored.templateId : '';
  // Pages saved before albums had their own frame hold the generic default; move
  // them to the album's frame unless photos were already placed in that default.
  const keepStored =
    storedTemplateId &&
    (storedTemplateId !== SANDBOX_SHELF_DEFAULT_TEMPLATE_ID ||
      Object.values(slots[storedTemplateId] ?? {}).some(Boolean));
  const state: ShelfAlbumState = {
    photos: Array.isArray(stored?.photos) ? stored.photos : [],
    templateId: keepStored ? storedTemplateId : sandboxShelfAlbumTemplateId(albumId),
    slots,
    positions,
  };
  shelf[albumId] = state;
  return state;
}

function requireShelfAlbum(albumId: string, rpc: string) {
  const album = sandboxShelfAlbum(albumId);
  if (!album) throw new Error(`${rpc}: unknown shelf album ${albumId}`);
  return album;
}

async function loadShelfState(exec: Executor, playerId: string): Promise<ShelfState> {
  const [row] = await exec
    .select({ data: players.data })
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1);
  const shelf = (row?.data as { shelf?: unknown } | null)?.shelf;
  return shelf && typeof shelf === 'object' && !Array.isArray(shelf) ? (shelf as ShelfState) : {};
}

/** Merge the shelf blob into `players.data` without touching its other keys. */
async function saveShelfState(exec: Executor, playerId: string, shelf: ShelfState): Promise<void> {
  const [row] = await exec
    .select({ data: players.data })
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1);
  const data = { ...((row?.data as Record<string, unknown> | null) ?? {}), shelf };
  await exec.update(players).set({ data }).where(eq(players.id, playerId));
}

/**
 * `Shelf:Top` — the photo-album event top page. No Shelf master tables exist;
 * serves the captured event-shelf-26-1002 sample (see profiles/sandbox/shelf.ts).
 */
register(
  'Shelf:Top',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return runPhoto(accountId, 'Shelf:Top', async (tx, playerId) => {
      ctx.fastifyReq.log.info({ accountId, playerId }, 'shelf top');
      return {
        __msg: '',
        ShelfInfo: sandboxShelfInfo(),
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Shelf:AlbumTop` — an album's template + episode listing. */
register(
  'Shelf:AlbumTop',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const albumId = ctx.request?.ShelfAlbumId == null ? '' : String(ctx.request.ShelfAlbumId);
    requireShelfAlbum(albumId, 'Shelf:AlbumTop');
    return runPhoto(accountId, 'Shelf:AlbumTop', async (tx, playerId) => {
      ctx.fastifyReq.log.info({ accountId, playerId, albumId }, 'shelf album top');
      const shelf = await loadShelfState(tx, playerId);
      const albumState = shelfAlbumState(shelf, albumId);
      return {
        __msg: '',
        TemplateInfos: sandboxShelfTemplateInfos(albumState.slots, albumState.positions),
        PhotoInfos: albumState.photos.map(
          (photo) =>
            ({
              __msg: 'Solis.Common.Proto.Api.ShelfPhotoInfo',
              AssetId: photo.AssetId,
              ShootingTime: photo.CreatedTime,
              Episode: photo.Episode,
              MainCharacterId: photo.MainCharacterId,
            }) as Decoded,
        ),
        EpisodeInfos: sandboxShelfEpisodeInfos(albumId, await listStories()),
        SelectedTemplateId: albumState.templateId,
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Shelf:CheckShooting` — validate an album shooting scene (no consumption). */
register(
  'Shelf:CheckShooting',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const albumId = ctx.request?.ShelfAlbumId == null ? '' : String(ctx.request.ShelfAlbumId);
    return commonOnly(
      await runPhoto(accountId, 'Shelf:CheckShooting', async (tx, playerId) => {
        ctx.fastifyReq.log.info({ accountId, playerId, albumId }, 'shelf check shooting');
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Shelf:SavePhoto` — register an existing photo into an album episode. */
register(
  'Shelf:SavePhoto',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const albumId = ctx.request?.ShelfAlbumId == null ? '' : String(ctx.request.ShelfAlbumId);
    const episode = Number(ctx.request?.Episode ?? 0);
    const params = ((ctx.request?.SavePhotoParams as unknown[] | undefined) ?? []).map((p) => ({
      assetId: String((p as any).AssetId ?? ''),
      mainCharacterId: String((p as any).MainCharacterId ?? ''),
    }));
    requireShelfAlbum(albumId, 'Shelf:SavePhoto');
    const res = await runPhoto(accountId, 'Shelf:SavePhoto', async (tx, playerId) => {
      const shelf = await loadShelfState(tx, playerId);
      const totalPhotos = Object.values(shelf).reduce(
        (total, state) => total + (Array.isArray(state.photos) ? state.photos.length : 0),
        0,
      );
      if (totalPhotos + params.length > SANDBOX_SHELF_PHOTO_LIMIT) {
        throw new Error(`Shelf:SavePhoto: photo limit ${SANDBOX_SHELF_PHOTO_LIMIT} exceeded`);
      }
      const albumState = shelfAlbumState(shelf, albumId);
      const createdTime = Date.now();
      for (const param of params) {
        albumState.photos.push({
          AssetId: param.assetId,
          MainCharacterId: param.mainCharacterId,
          Episode: episode,
          CreatedTime: createdTime,
        });
      }
      await saveShelfState(tx, playerId, shelf);
      ctx.fastifyReq.log.info(
        { accountId, playerId, albumId, episode, count: params.length },
        'shelf save photo',
      );
      return {
        updated: updatedData(['User', await loadUser(tx, playerId)]),
        deleted: null,
      };
    });
    return {
      __msg: '',
      CommonResponse: commonResponse(res.updated, res.deleted),
    } as Decoded;
  },
  { ownsState: true },
);

/** `Shelf:SetPhoto` — place a saved photo into a template slot. */
register(
  'Shelf:SetPhoto',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const albumId = ctx.request?.ShelfAlbumId == null ? '' : String(ctx.request.ShelfAlbumId);
    const slot = Number(ctx.request?.SlotNumber ?? 0);
    const assetId = ctx.request?.AssetId == null ? '' : String(ctx.request.AssetId);
    const positionX = Number(ctx.request?.PositionX ?? 0) || 0;
    requireShelfAlbum(albumId, 'Shelf:SetPhoto');
    return commonOnly(
      await runPhoto(accountId, 'Shelf:SetPhoto', async (tx, playerId) => {
        const shelf = await loadShelfState(tx, playerId);
        const albumState = shelfAlbumState(shelf, albumId);
        const templateSlots =
          albumState.slots[albumState.templateId] ?? (albumState.slots[albumState.templateId] = {});
        templateSlots[String(slot)] = assetId;
        const templatePositions =
          albumState.positions[albumState.templateId] ??
          (albumState.positions[albumState.templateId] = {});
        if (positionX) templatePositions[String(slot)] = positionX;
        else delete templatePositions[String(slot)];
        await saveShelfState(tx, playerId, shelf);
        ctx.fastifyReq.log.info(
          { accountId, playerId, albumId, slot, assetId, positionX },
          'shelf set photo',
        );
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Shelf:UnsetPhoto` — clear a slot in the album's current template. */
register(
  'Shelf:UnsetPhoto',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const albumId = ctx.request?.ShelfAlbumId == null ? '' : String(ctx.request.ShelfAlbumId);
    const slot = Number(ctx.request?.SlotNumber ?? 0);
    requireShelfAlbum(albumId, 'Shelf:UnsetPhoto');
    return commonOnly(
      await runPhoto(accountId, 'Shelf:UnsetPhoto', async (tx, playerId) => {
        const shelf = await loadShelfState(tx, playerId);
        const albumState = shelfAlbumState(shelf, albumId);
        const templateSlots = albumState.slots[albumState.templateId];
        if (templateSlots) delete templateSlots[String(slot)];
        delete albumState.positions[albumState.templateId]?.[String(slot)];
        await saveShelfState(tx, playerId, shelf);
        ctx.fastifyReq.log.info({ accountId, playerId, albumId, slot }, 'shelf unset photo');
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Shelf:SwitchTemplate` — select one of the album's two layouts. */
register(
  'Shelf:SwitchTemplate',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const albumId = ctx.request?.ShelfAlbumId == null ? '' : String(ctx.request.ShelfAlbumId);
    const templateId = ctx.request?.TemplateId == null ? '' : String(ctx.request.TemplateId);
    requireShelfAlbum(albumId, 'Shelf:SwitchTemplate');
    return commonOnly(
      await runPhoto(accountId, 'Shelf:SwitchTemplate', async (tx, playerId) => {
        const shelf = await loadShelfState(tx, playerId);
        const albumState = shelfAlbumState(shelf, albumId);
        albumState.templateId = templateId;
        await saveShelfState(tx, playerId, shelf);
        ctx.fastifyReq.log.info({ accountId, playerId, albumId, templateId }, 'shelf switch template');
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Shelf:DeletePhoto` — drop saved photos and any slots that showed them. */
register(
  'Shelf:DeletePhoto',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const albumId = ctx.request?.ShelfAlbumId == null ? '' : String(ctx.request.ShelfAlbumId);
    const assetIds = new Set(
      ((ctx.request?.AssetIds as unknown[] | undefined) ?? []).map((id) => String(id)),
    );
    requireShelfAlbum(albumId, 'Shelf:DeletePhoto');
    return commonOnly(
      await runPhoto(accountId, 'Shelf:DeletePhoto', async (tx, playerId) => {
        const shelf = await loadShelfState(tx, playerId);
        const albumState = shelfAlbumState(shelf, albumId);
        albumState.photos = albumState.photos.filter((photo) => !assetIds.has(photo.AssetId));
        for (const slots of Object.values(albumState.slots)) {
          for (const [slotNumber, assetId] of Object.entries(slots)) {
            if (assetIds.has(assetId)) delete slots[slotNumber];
          }
        }
        await saveShelfState(tx, playerId, shelf);
        ctx.fastifyReq.log.info(
          { accountId, playerId, albumId, count: assetIds.size },
          'shelf delete photo',
        );
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Shelf:CreatePhoto` — develop a photo saved in the album into a UserPhoto. */
register(
  'Shelf:CreatePhoto',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const albumId = ctx.request?.ShelfAlbumId == null ? '' : String(ctx.request.ShelfAlbumId);
    const assetId = ctx.request?.AssetId == null ? '' : String(ctx.request.AssetId);
    if (!albumId || !assetId) throw new Error('Shelf:CreatePhoto: missing ShelfAlbumId/AssetId');
    const album = requireShelfAlbum(albumId, 'Shelf:CreatePhoto');

    const res = await runPhoto(accountId, 'Shelf:CreatePhoto', async (tx, playerId) => {
      const shelf = await loadShelfState(tx, playerId);
      const albumState = shelfAlbumState(shelf, albumId);
      if (!albumState.photos.some((photo) => photo.AssetId === assetId)) {
        throw new Error(`Shelf:CreatePhoto: saved photo not found ${assetId}`);
      }
      const result = await createUserPhotoShootings(
        tx,
        playerId,
        {
          placeName: album.Name,
          eventName: 'フォトアルバム',
          noFilmCost: true,
        },
        [{ imageId: assetId, itemId: 'item-photo_shooting-09' }],
        0,
        'Shelf:CreatePhoto',
      );
      ctx.fastifyReq.log.info(
        { accountId, playerId, albumId, assetId, photoId: result.photos[0]?.PhotoId },
        'shelf create photo',
      );
      return result;
    });

    return {
      __msg: '',
      Photo: res.photos[0],
      IsGift: res.isGift,
      CommonResponse: commonResponse(res.updated, res.deleted),
    } as Decoded;
  },
  { ownsState: true },
);

/** `Shelf:CreateAlbumPhoto` — mint an album-special photo (rarity 3). */
register(
  'Shelf:CreateAlbumPhoto',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const albumId = ctx.request?.ShelfAlbumId == null ? '' : String(ctx.request.ShelfAlbumId);
    const assetId = ctx.request?.AssetId == null ? '' : String(ctx.request.AssetId);
    if (!albumId || !assetId) throw new Error('Shelf:CreateAlbumPhoto: missing ShelfAlbumId/AssetId');
    const album = requireShelfAlbum(albumId, 'Shelf:CreateAlbumPhoto');

    const res = await runPhoto(accountId, 'Shelf:CreateAlbumPhoto', async (tx, playerId) => {
      const publicUserId = await publicUserIdForPlayer(playerId);
      // The client reuses the asset id of an earlier shot for the composed album
      // page and caches images by id, so develop into a fresh id to miss its cache.
      const imageId = randomUUID();
      await clonePhotoImage(playerId, publicUserId, assetId, imageId, tx);
      // createUserPhotoShootings only mints photos for ids reserved in
      // NextPhotoImageIds, so swap the uploaded id for the fresh clone target.
      const user = await loadUser(tx, playerId);
      const reservedIds = ((user.NextPhotoImageIds as string[] | null | undefined) ?? []).map(String);
      user.NextPhotoImageIds = [imageId, ...reservedIds.filter((id) => id !== assetId)];
      await putSingleton(playerId, 'User', user, tx);
      const shelf = await loadShelfState(tx, playerId);
      const subject = shelfPageSubject(shelfAlbumState(shelf, albumId));
      const result = await createUserPhotoShootings(
        tx,
        playerId,
        {
          placeName: album.Name,
          eventName: 'フォトアルバム',
          forcedRarity: 3,
          noFilmCost: true,
        },
        // The develop request carries no subject, so use the idol most present in the page's slots.
        [{ imageId, itemId: 'item-photo_shooting-09', ...(subject ? { focusCharacterId: subject } : {}) }],
        0,
        'Shelf:CreateAlbumPhoto',
      );
      ctx.fastifyReq.log.info(
        { accountId, playerId, albumId, assetId, imageId, subject, photoId: result.photos[0]?.PhotoId },
        'shelf create album photo',
      );
      return result;
    });

    return {
      __msg: '',
      Photo: res.photos[0],
      IsGift: res.isGift,
      CommonResponse: commonResponse(res.updated, res.deleted),
    } as Decoded;
  },
  { ownsState: true },
);

/** Contest date-code helpers: the fixed contest id is contest-25-0826 (latest
 *  seeded master). All contest master rows carry a '<contest>-25-0826' prefix. */
const PHOTO_CONTEST_ID = 'contest-25-0826';
const CONTEST_DATE_CODE = '25-0826';
const CONTEST_NAME = 'フォトオーディション';
const CONTEST_EVENT_NAME = 'フォトコンテスト';

function contestSectionFor(rewardId: string): string | null {
  // section_reward-<letter>-25-0826-<n> -> contest_section_<letter>-25-0826
  const m = /^section_reward-([a-z])-25-0826-/.exec(rewardId);
  return m ? `contest_section_${m[1]}-25-0826` : null;
}

/** Evaluation point for a submitted shot: base + size/direction/position permil
 *  contributions + elapsed seconds. Deterministic and monotonic in the params. */
function contestEvaluationPoint(req: Decoded): number {
  const el = Number(req.ElapsedMilliSeconds ?? 0) / 1000;
  const sizeFull = Number(req.SizeFullPermil ?? 0);
  const sizeUpper = Number(req.SizeUpperPermil ?? 0);
  const dirFront = Number(req.DirectionFrontPermil ?? 0);
  const dirSide = Number(req.DirectionSidePermil ?? 0);
  const pos = Number(req.PositionPermil ?? 0);
  return 100000 + sizeFull + sizeUpper + dirFront + dirSide + pos + Math.round(el);
}

function contestRankForPoint(point: number): number {
  if (point >= 120000) return 5; // S
  if (point >= 115000) return 4; // A
  if (point >= 110000) return 3; // B
  if (point >= 105000) return 2; // C
  return 1; // D
}

/** `PhotoContest:Top` — the contest top page, assembled from the contest master. */
register(
  'PhotoContest:Top',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const contestId = ctx.request?.PhotoContestId == null ? '' : String(ctx.request.PhotoContestId);
    if (!contestId) throw new Error('PhotoContest:Top: missing PhotoContestId');
    return runPhoto(accountId, 'PhotoContest:Top', async (tx, playerId) => {
      const activities = await listPhotoContestActivities();
      const musics = await listPhotoContestQuestMusics();
      const stages = await listPhotoContestQuestStages();
      const sections = await listPhotoContestSections();
      const rewards = await listPhotoContestSectionRewards();
      const info: Decoded = {
        __msg: 'Solis.Common.Proto.Api.PhotoContestInfo',
        Id: contestId,
        Name: CONTEST_NAME,
        StartTime: 1792000000000,
        EndTime: 1793555999000,
        AggregateEndTime: 1793555999000,
        ExchangeEndTime: 1794150799000,
        AssetId: 'event-contest-25-0826',
        TotalBestShootEvaluationPoint: 0,
        TotalBestShootEvaluationPointTime: 0,
        Rank: 0,
        RankingRewardInfos: [] as Decoded[],
        SectionInfos: sections
          .filter((s) => String(s.Id).includes(CONTEST_DATE_CODE))
          .map((s) => ({
            __msg: 'Solis.Common.Proto.Api.PhotoContestSectionInfo',
            Id: s.Id,
            SectionRewardInfos: rewards
              .filter((r) => String(r.Id).startsWith(`section_reward-${s.Id.split('_')[2]}-${CONTEST_DATE_CODE}-`))
              .map((r) => ({
                __msg: 'Solis.Common.Proto.Api.PhotoContestSectionRewardInfo',
                SectionRewardId: r.Id,
                CanReceive: false,
                HaveReceived: false,
              } as Decoded)),
            BestShootAssetId: '',
            BestShootEvaluationPoint: 0,
            TotalSectionEvaluationPoint: 0,
            IsUnlocked: true,
            AdvanceGuideInfos: [] as Decoded[],
          } as Decoded)),
        Activities: activities
          .filter((a) => String(a.Id).includes(CONTEST_DATE_CODE))
          .map((a) => ({ __msg: 'Solis.Common.Proto.Api.PhotoContestActivity', Id: a.Id, IsUnlocked: true } as Decoded)),
        Musics: musics
          .filter((m) => String(m.Id).includes(CONTEST_DATE_CODE))
          .map((m) => ({ __msg: 'Solis.Common.Proto.Api.PhotoContestQuestMusic', Id: m.Id, IsUnlocked: true } as Decoded)),
        Stages: stages
          .filter((s) => String(s.Id).includes(CONTEST_DATE_CODE))
          .map((s) => ({ __msg: 'Solis.Common.Proto.Api.PhotoContestQuestStage', Id: s.Id, IsUnlocked: true } as Decoded)),
        DailyRewardResults: [] as Decoded[],
        OnceShootingSubmitLimitCount: 0,
        CurrentPhotoAmount: 0,
        SubmittingItemId: 'item-contest_submitting-25-0826',
        CreatingItemId: 'item-photo_contest_create-25-0826',
      } as Decoded;
      ctx.fastifyReq.log.info({ accountId, playerId, contestId }, 'photo contest top');
      return {
        __msg: '',
        PhotoContestInfo: info,
        DokanInfos: [] as Decoded[],
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `PhotoContest:CheckShooting` — validate a contest shooting scene. */
register(
  'PhotoContest:CheckShooting',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const contestId = ctx.request?.PhotoContestId == null ? '' : String(ctx.request.PhotoContestId);
    return runPhoto(accountId, 'PhotoContest:CheckShooting', async (tx, playerId) => {
      const user = await loadUser(tx, playerId);
      ctx.fastifyReq.log.info({ accountId, playerId, contestId }, 'photo contest check shooting');
      return {
        __msg: '',
        NextPhotoImageId: String(user.NextPhotoImageIds?.[0] ?? ''),
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `PhotoContest:CreateShooting` — consume film and generate a contest photo. */
register(
  'PhotoContest:CreateShooting',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const contestId = ctx.request?.PhotoContestId == null ? '' : String(ctx.request.PhotoContestId);
    const assetId = ctx.request?.AssetId == null ? '' : String(ctx.request.AssetId);
    const itemId = ctx.request?.ItemId == null ? '' : String(ctx.request.ItemId);
    if (!contestId || !assetId || !itemId) {
      throw new Error('PhotoContest:CreateShooting: missing PhotoContestId/AssetId/ItemId');
    }
    const res = await runPhoto(accountId, 'PhotoContest:CreateShooting', async (tx, playerId) => {
      const characters = await listElements(playerId, 'Characters', tx);
      const mainCharacterId = String(characters[0]?.CharacterId ?? '');
      const result = await createUserPhotoShootings(
        tx,
        playerId,
        {
          placeName: CONTEST_NAME,
          eventName: CONTEST_EVENT_NAME,
          candidateCharacterIds: characters.map((c) => String(c.CharacterId ?? '')),
          allowNonFilmItem: true,
        },
        [{ imageId: assetId, itemId, focusCharacterId: mainCharacterId }],
        0,
        'PhotoContest:CreateShooting',
      );
      ctx.fastifyReq.log.info(
        { accountId, playerId, contestId, assetId, itemId, photoId: result.photos[0]?.PhotoId },
        'photo contest create shooting',
      );
      return result;
    });
    return {
      __msg: '',
      Photo: res.photos[0],
      IsGift: res.isGift,
      CommonResponse: commonResponse(res.updated, res.deleted),
    } as Decoded;
  },
  { ownsState: true },
);

/** `PhotoContest:SubmitShooting` — submit a shot, compute evaluation + section rewards. */
register(
  'PhotoContest:SubmitShooting',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const contestId = ctx.request?.PhotoContestId == null ? '' : String(ctx.request.PhotoContestId);
    const sectionId = ctx.request?.SectionId == null ? '' : String(ctx.request.SectionId);
    const itemId = ctx.request?.ItemId == null ? '' : String(ctx.request.ItemId);
    if (!contestId || !sectionId || !itemId) {
      throw new Error('PhotoContest:SubmitShooting: missing PhotoContestId/SectionId/ItemId');
    }
    const res = await runPhoto(accountId, 'PhotoContest:SubmitShooting', async (tx, playerId) => {
      const point = contestEvaluationPoint(ctx.request as Decoded);
      const section = (await listPhotoContestSections()).find((s) => s.Id === sectionId);
      const rewards = await listPhotoContestSectionRewards();
      const newIds = rewards
        .filter((r) => contestSectionFor(String(r.Id)) === sectionId && Number(r.RequiredEvaluationPoint) <= point)
        .map((r) => String(r.Id));
      // persist the submitted shot as a contest photo so ListPhoto/Ranking can serve it
      const userBefore = await loadUser(tx, playerId);
      const characters = await listElements(playerId, 'Characters', tx);
      const mainCharacterId = String(ctx.request?.MainCharacterId ?? characters[0]?.CharacterId ?? '');
      const imageId = String((userBefore.NextPhotoImageIds as string[] | undefined)?.[0] ?? '');
      const result = await createUserPhotoShootings(
        tx,
        playerId,
        {
          placeName: section?.Name ?? CONTEST_NAME,
          eventName: CONTEST_EVENT_NAME,
          candidateCharacterIds: (ctx.request?.CharacterIds as string[] | undefined) ?? characters.map((c) => String(c.CharacterId ?? '')),
          allowNonFilmItem: true,
        },
        [{ imageId, itemId, focusCharacterId: mainCharacterId }],
        0,
        'PhotoContest:SubmitShooting',
      );
      const user = (result.updated.User as Decoded | undefined) ?? userBefore;
      ctx.fastifyReq.log.info(
        { accountId, playerId, contestId, sectionId, point, newRewards: newIds.length },
        'photo contest submit shooting',
      );
      return {
        updated: result.updated,
        deleted: null,
        photos: result.photos,
        point,
        newIds,
        nextPhotoImageId: String((user.NextPhotoImageIds as string[] | undefined)?.[0] ?? ''),
      };
    });
    return {
      __msg: '',
      EvaluationPoint: res.point,
      IsBest: true,
      TotalSectionEvaluationPoint: res.point,
      TotalBestShotEvaluationPoint: res.point,
      NextPhotoImageId: res.nextPhotoImageId,
      NewCanReceiveSectionRewardIds: res.newIds,
      Rank: 1,
      EvaluationRankType: contestRankForPoint(res.point),
      BaseGuideInfos: [] as Decoded[],
      AdvanceGuideInfos: [] as Decoded[],
      FixedCreatePhotoRarity: 3,
      CommonResponse: commonResponse(res.updated, res.deleted),
    } as Decoded;
  },
  { ownsState: true },
);

/** `PhotoContest:ListPhoto` — the player's submitted contest photos. */
register(
  'PhotoContest:ListPhoto',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const contestId = ctx.request?.PhotoContestId == null ? '' : String(ctx.request.PhotoContestId);
    return runPhoto(accountId, 'PhotoContest:ListPhoto', async (tx, playerId) => {
      const photos = await listElements(playerId, 'Photos', tx);
      const contestPhotos = photos.filter((p) => String(p.EventName ?? '') === CONTEST_EVENT_NAME);
      ctx.fastifyReq.log.info({ accountId, playerId, contestId }, 'photo contest list photo');
      return {
        __msg: '',
        PhotoInfos: contestPhotos.map((p) => ({
          __msg: 'Solis.Common.Proto.Api.PhotoContestPhotoInfo',
          AssetId: String(p.AssetId ?? ''),
          SectionId: '',
          EvaluationPoint: 0,
          IsBest: false,
          ShootingTime: Number(p.ShootingTime ?? 0),
          FixedCreatePhotoRarity: Number(p.Rarity ?? 0),
          EvaluationRankType: 0,
        } as Decoded)),
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `PhotoContest:Ranking` — the player's own ranking (self-only). */
register(
  'PhotoContest:Ranking',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const contestId = ctx.request?.PhotoContestId == null ? '' : String(ctx.request.PhotoContestId);
    return runPhoto(accountId, 'PhotoContest:Ranking', async (tx, playerId) => {
      const user = await loadUser(tx, playerId);
      const photos = await listElements(playerId, 'Photos', tx);
      const bestPhotos = photos
        .filter((p) => String(p.EventName ?? '') === CONTEST_EVENT_NAME)
        .slice(0, 3)
        .map((p) => ({
          __msg: 'Solis.Common.Proto.Api.PhotoContestPhotoInfo',
          AssetId: String(p.AssetId ?? ''),
          SectionId: '',
          EvaluationPoint: 0,
          IsBest: false,
          ShootingTime: Number(p.ShootingTime ?? 0),
          FixedCreatePhotoRarity: Number(p.Rarity ?? 0),
          EvaluationRankType: 0,
        } as Decoded));
      ctx.fastifyReq.log.info({ accountId, playerId, contestId }, 'photo contest ranking');
      return {
        __msg: '',
        RankingInfos: [
          {
            __msg: 'Solis.Common.Proto.Api.PhotoContestRankingInfo',
            UserId: playerId,
            Name: String(user.Name ?? ''),
            ManagerLevel: Number(user.ManagerLevel ?? 1),
            TotalBestShootEvaluationPoint: 100000,
            Rank: 1,
            EmblemId: String(user.EmblemId ?? ''),
            BestPhotoInfos: bestPhotos,
          } as Decoded,
        ],
        SelfPoint: 100000,
        SelfRank: 1,
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `PhotoContest:ReceiveSectionRewards` — claim section rewards by reward id. */
register(
  'PhotoContest:ReceiveSectionRewards',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const contestId = ctx.request?.PhotoContestId == null ? '' : String(ctx.request.PhotoContestId);
    const rewardIds = ((ctx.request?.SectionRewardIds as unknown[] | undefined) ?? []).map((v) => String(v));
    const sectionId = ctx.request?.SectionId == null ? '' : String(ctx.request.SectionId);
    if (!contestId || !rewardIds.length) {
      throw new Error('PhotoContest:ReceiveSectionRewards: missing PhotoContestId/SectionRewardIds');
    }
    const res = await runPhoto(accountId, 'PhotoContest:ReceiveSectionRewards', async (tx, playerId) => {
      const refs: string[] = [];
      for (const rid of rewardIds) {
        const reward = await getPhotoContestSectionReward(rid);
        if (!reward) throw new Error(`PhotoContest:ReceiveSectionRewards: unknown reward ${rid}`);
        const ref = String(reward.RewardId ?? '');
        if (ref) refs.push(ref);
      }
      const applied = refs.length ? await applyRewardRefs(playerId, refs, tx) : null;
      ctx.fastifyReq.log.info(
        { accountId, playerId, contestId, sectionId, count: rewardIds.length },
        'photo contest receive section rewards',
      );
      return {
        updated: applied?.updated ?? ({ __msg: UPDATED_DATA_MSG } as Decoded),
        deleted: null,
        rewardResults: applied?.results ?? [],
      };
    });
    return {
      __msg: '',
      Results: res.rewardResults,
      CommonResponse: commonResponse(res.updated, res.deleted),
    } as Decoded;
  },
  { ownsState: true },
);

/** Showcase message type names (schema-built; not captured on-device). */
const SHOWCASE_MSG = 'Solis.Common.Proto.Transaction.UserShowcase';
const SHOWCASE_MYSET_MSG = 'Solis.Common.Proto.Transaction.UserShowcaseMyset';
const SHOWCASE_LIKE_MSG = 'Solis.Common.Proto.Transaction.UserShowcaseLike';
const SHOWCASE_SELF_INFO_MSG = 'Solis.Common.Proto.Api.ShowcaseSelfInfo';
const SHOWCASE_FRAME_INFO_MSG = 'Solis.Common.Proto.Api.ShowcaseFrameInfo';
const SHOWCASE_MYSET_INFO_MSG = 'Solis.Common.Proto.Api.ShowcaseMysetInfo';
const SHOWCASE_INFO_MSG = 'Solis.Common.Proto.Api.ShowcaseInfo';
const SHOWCASE_LAYOUT_INFO_MSG = 'Solis.Common.Proto.Api.ShowcaseLayoutInfo';
const SHOWCASE_TERM_INFO_MSG = 'Solis.Common.Proto.Api.ShowcaseTermInfo';
const PROFILE_INFO_MSG = 'Solis.Common.Proto.Api.ProfileInfo';

/** Build the ProfileInfo embedded in ShowcaseInfo from the owner's User row. */
function showcaseProfileInfo(userId: string, user: Decoded): Decoded {
  return {
    __msg: PROFILE_INFO_MSG,
    UserId: userId,
    Name: String(user.Name ?? ''),
    ManagerExp: Number(user.ManagerExp ?? 0),
    ManagerLevel: Number(user.ManagerLevel ?? 1),
    EmblemId: String(user.EmblemId ?? ''),
    LastLoginTime: Number(user.LastLoginTime ?? 0),
    FavoriteCharacterIds: (user.FavoriteCharacterIds as string[] | undefined) ?? [],
    BackgroundType: Number(user.BackgroundType ?? 0),
    LayoutType: Number(user.LayoutType ?? 0),
    InformationType: Number(user.InformationType ?? 0),
    ColorType: Number(user.ColorType ?? 0),
    FavoriteCard: {
      __msg: 'Solis.Common.Proto.Api.FavoriteCardInfo',
      CardId: '',
      Rarity: 0,
      DisplayType: 0,
      EvolutionLevel: 0,
    } as Decoded,
    FavoritePhoto: {
      __msg: 'Solis.Common.Proto.Api.FavoritePhotoInfo',
      PhotoId: '',
      AssetId: '',
      ImageType: 0,
    } as Decoded,
    BuddyCardInfo: {
      __msg: 'Solis.Common.Proto.Api.BuddyCardInfo',
      CardId: '',
      Rarity: 0,
      Level: 0,
      EvolutionLevel: 0,
    } as Decoded,
  } as Decoded;
}

/** Build an unsaved showcase row for a slot number. */
function defaultShowcase(number: number, setting: Decoded | null | undefined): Decoded {
  return {
    __msg: SHOWCASE_MSG,
    Number: number,
    Name: String(setting?.Id ?? 'showcase-default'),
    Comment: '',
    MusicId: '',
    HashTagIds: [],
    IsOpen: false,
    ThumbnailAssetId: String(
      setting?.ShowcaseThumbnailDefaultAssetId ?? 'img_ui_showcase_case_thumb_default',
    ),
    ShowcaseFrameId: String(setting?.ShowcaseFrameDefaultId ?? 'frame-001'),
  } as Decoded;
}

/** `Showcase:Top` — the showcase home page. Request is `Empty`. */
register(
  'Showcase:Top',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return runPhoto(accountId, 'Showcase:Top', async (tx, playerId) => {
      const showcases = await listElements(playerId, 'Showcases', tx);
      let showcaseInfos = showcases;
      if (isSandbox()) {
        const setting = await getShowcaseSetting();
        showcaseInfos = withSandboxShowcaseSlots(
          showcases,
          SANDBOX_SHOWCASE_CASE_COUNT,
          (n) => defaultShowcase(n, setting),
        );
      }
      const mysets = await listElements(playerId, 'ShowcaseMysets', tx);
      const frames = await listShowcaseFrames();
      const musics = await listShowcaseMusics();
      const like = await getSingleton(playerId, 'ShowcaseLike', tx);
      ctx.fastifyReq.log.info({ accountId, playerId }, 'showcase top');
      return {
        __msg: '',
        Shops: isSandbox() ? sandboxShowcaseShops() : [] as Decoded[],
        DokanInfos: [] as Decoded[],
        ShowcaseInfos: showcaseInfos.map((s) => ({
          __msg: SHOWCASE_SELF_INFO_MSG,
          Number: Number(s.Number ?? 0),
          DefaultName: String(s.Name ?? ''),
          UnlockConditionId: String(s.UnlockConditionId ?? ''),
          IsUnlocked: true,
          LayoutInfo: s.LayoutInfo ?? { __msg: SHOWCASE_LAYOUT_INFO_MSG } as Decoded,
        } as Decoded)),
        TotalLikedCount: Number(like?.DailyLikeCount ?? 0),
        MysetInfos: mysets.map((m) => ({
          __msg: SHOWCASE_MYSET_INFO_MSG,
          Number: Number(m.Number ?? 0),
          DefaultName: String(m.Name ?? ''),
        } as Decoded)),
        FrameInfos: frames.map((f) => ({
          __msg: SHOWCASE_FRAME_INFO_MSG,
          Id: String(f.Id ?? ''),
          IsUnlocked: true,
        } as Decoded)),
        TopDokanInfos: [] as Decoded[],
        ShowcaseMusicIds: musics.map((m) => String(m.MusicId ?? '')),
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Showcase:Save` — upsert a showcase's frame/thumbnail/layout by Number. */
register(
  'Showcase:Save',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const number = Number(ctx.request?.Number ?? 0);
    const frameId = ctx.request?.FrameId == null ? '' : String(ctx.request.FrameId);
    const assetId = ctx.request?.AssetId == null ? '' : String(ctx.request.AssetId);
    const layout = ctx.request?.LayoutInfo;
    return commonOnly(
      await runPhoto(accountId, 'Showcase:Save', async (tx, playerId) => {
        const showcases = await listElements(playerId, 'Showcases', tx);
        let showcase = showcases.find((s) => Number(s.Number ?? 0) === number);
        const setting = await getShowcaseSetting();
        if (!showcase) {
          const nextNumber = showcases.reduce((m, s) => Math.max(m, Number(s.Number ?? 0)), 0) + 1;
          showcase = defaultShowcase(number > 0 ? number : nextNumber, setting);
          showcases.push(showcase);
        }
        if (frameId) showcase.ShowcaseFrameId = frameId;
        if (assetId) showcase.ThumbnailAssetId = assetId;
        if (layout) showcase.LayoutInfo = layout;
        await putElements(playerId, 'Showcases', [showcase], tx);
        ctx.fastifyReq.log.info({ accountId, playerId, number, frameId, assetId }, 'showcase save');
        return { updated: updatedData(['Showcases', [showcase]]), deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Showcase:SaveDetail` — update a showcase's name/comment/music/visibility. */
register(
  'Showcase:SaveDetail',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const number = Number(ctx.request?.Number ?? 0);
    return commonOnly(
      await runPhoto(accountId, 'Showcase:SaveDetail', async (tx, playerId) => {
        const showcases = await listElements(playerId, 'Showcases', tx);
        const showcase = showcases.find((s) => Number(s.Number ?? 0) === number);
        if (!showcase) throw new Error(`Showcase:SaveDetail: showcase not found ${number}`);
        if (ctx.request?.Name != null) showcase.Name = String(ctx.request.Name);
        if (ctx.request?.Comment != null) showcase.Comment = String(ctx.request.Comment);
        if (ctx.request?.MusicId != null) showcase.MusicId = String(ctx.request.MusicId);
        if (ctx.request?.IsOpen != null) showcase.IsOpen = Boolean(ctx.request.IsOpen);
        await putElements(playerId, 'Showcases', [showcase], tx);
        ctx.fastifyReq.log.info({ accountId, playerId, number }, 'showcase save detail');
        return { updated: updatedData(['Showcases', [showcase]]), deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Showcase:SaveMyset` — upsert a myset (saved layout) by Number. */
register(
  'Showcase:SaveMyset',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const number = Number(ctx.request?.Number ?? 0);
    const frameId = ctx.request?.FrameId == null ? '' : String(ctx.request.FrameId);
    const layout = ctx.request?.LayoutInfo;
    return commonOnly(
      await runPhoto(accountId, 'Showcase:SaveMyset', async (tx, playerId) => {
        const mysets = await listElements(playerId, 'ShowcaseMysets', tx);
        let myset = mysets.find((m) => Number(m.Number ?? 0) === number);
        if (!myset) {
          const nextNumber = mysets.reduce((m, x) => Math.max(m, Number(x.Number ?? 0)), 0) + 1;
          myset = {
            __msg: SHOWCASE_MYSET_MSG,
            Number: number > 0 ? number : nextNumber,
            Name: '',
            ShowcaseFrameId: String(frameId || 'frame-001'),
            IsSave: false,
          } as Decoded;
          mysets.push(myset);
        }
        if (frameId) myset.ShowcaseFrameId = frameId;
        if (layout) myset.LayoutInfo = layout;
        myset.IsSave = true;
        await putElements(playerId, 'ShowcaseMysets', [myset], tx);
        ctx.fastifyReq.log.info({ accountId, playerId, number }, 'showcase save myset');
        return { updated: updatedData(['ShowcaseMysets', [myset]]), deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Showcase:DeleteMyset` — remove a myset by Number. */
register(
  'Showcase:DeleteMyset',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const number = Number(ctx.request?.Number ?? 0);
    return commonOnly(
      await runPhoto(accountId, 'Showcase:DeleteMyset', async (tx, playerId) => {
        const mysets = await listElements(playerId, 'ShowcaseMysets', tx);
        const myset = mysets.find((m) => Number(m.Number ?? 0) === number);
        if (!myset) throw new Error(`Showcase:DeleteMyset: myset not found ${number}`);
        await removeElements(playerId, 'ShowcaseMysets', [myset], tx);
        ctx.fastifyReq.log.info({ accountId, playerId, number }, 'showcase delete myset');
        return {
          updated: { __msg: UPDATED_DATA_MSG } as Decoded,
          deleted: { __msg: DELETED_DATA_MSG, ShowcaseMysets: [myset] } as Decoded,
        };
      }),
    );
  },
  { ownsState: true },
);

/** `Showcase:ApplyMyset` — apply a saved myset to the showcase. */
register(
  'Showcase:ApplyMyset',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const number = Number(ctx.request?.Number ?? 0);
    return runPhoto(accountId, 'Showcase:ApplyMyset', async (tx, playerId) => {
      const mysets = await listElements(playerId, 'ShowcaseMysets', tx);
      const myset = mysets.find((m) => Number(m.Number ?? 0) === number);
      if (!myset) throw new Error(`Showcase:ApplyMyset: myset not found ${number}`);
      ctx.fastifyReq.log.info({ accountId, playerId, number }, 'showcase apply myset');
      return {
        __msg: '',
        FrameId: String(myset.ShowcaseFrameId ?? ''),
        LayoutInfo: myset.LayoutInfo ?? { __msg: SHOWCASE_LAYOUT_INFO_MSG } as Decoded,
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Showcase:RenameMyset` — rename a myset. */
register(
  'Showcase:RenameMyset',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const number = Number(ctx.request?.Number ?? 0);
    const name = ctx.request?.Name == null ? '' : String(ctx.request.Name);
    return commonOnly(
      await runPhoto(accountId, 'Showcase:RenameMyset', async (tx, playerId) => {
        const mysets = await listElements(playerId, 'ShowcaseMysets', tx);
        const myset = mysets.find((m) => Number(m.Number ?? 0) === number);
        if (!myset) throw new Error(`Showcase:RenameMyset: myset not found ${number}`);
        myset.Name = name;
        await putElements(playerId, 'ShowcaseMysets', [myset], tx);
        ctx.fastifyReq.log.info({ accountId, playerId, number, name }, 'showcase rename myset');
        return { updated: updatedData(['ShowcaseMysets', [myset]]), deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Showcase:CheckThumbnailShooting` — validate a thumbnail shooting scene. */
register(
  'Showcase:CheckThumbnailShooting',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const number = Number(ctx.request?.Number ?? 0);
    return commonOnly(
      await runPhoto(accountId, 'Showcase:CheckThumbnailShooting', async (tx, playerId) => {
        ctx.fastifyReq.log.info({ accountId, playerId, number }, 'showcase check thumbnail shooting');
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Showcase:Like` — like another player's showcase (self-likes no-op). */
register(
  'Showcase:Like',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const userId = ctx.request?.UserId == null ? '' : String(ctx.request.UserId);
    const number = Number(ctx.request?.Number ?? 0);
    const res = await runPhoto(accountId, 'Showcase:Like', async (tx, playerId) => {
      const user = await loadUser(tx, playerId);
      let like = await getSingleton(playerId, 'ShowcaseLike', tx);
      if (!like) like = { __msg: SHOWCASE_LIKE_MSG, DailyLikeCount: 0, RewardLikeCount: 0 } as Decoded;
      like.DailyLikeCount = Number(like.DailyLikeCount ?? 0) + 1;
      await putSingleton(playerId, 'ShowcaseLike', like, tx);
      ctx.fastifyReq.log.info({ accountId, playerId, targetUserId: userId, number }, 'showcase like');
      return {
        updated: updatedData(['ShowcaseLike', like], ['User', user]),
        deleted: null,
        isAlreadyLike: false,
      };
    });
    return {
      __msg: '',
      Rewards: [],
      IsAlreadyLike: res.isAlreadyLike,
      CommonResponse: commonResponse(res.updated, res.deleted),
    } as Decoded;
  },
  { ownsState: true },
);

/** `Photo:ListSpecialShooting` — special/promotion shooting activities + musics. */
register(
  'Photo:ListSpecialShooting',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const specialId = ctx.request?.SpecialPhotoShootingId == null ? '' : String(ctx.request.SpecialPhotoShootingId);
    const activities = (await listPhotoActivities())
      .filter((a) => a.Type === 2)
      .map((a) => ({
        __msg: SPECIAL_ACTIVITY_INFO_MSG as string,
        IsUnlocked: true,
        Order: Number(a.Order ?? 0),
        Name: a.Name ?? '',
        ThumbAssetId: a.ThumbAssetId ?? '',
        PhotoStageId: a.StageId ?? '',
        PhotoShootingMotionSetId: a.PhotoShootingMotionSetId ?? '',
        IsDeleteCharacter: Boolean(Number(a.IsDeleteCharacter ?? 0)),
        CostumeTypeIds: Array.isArray(a.CostumeTypeIds) ? a.CostumeTypeIds : [],
        ForceCostumeTypeId: a.ForceCostumeTypeId ?? '',
        CharacterIds: [],
        UnlockConditionId: '',
        ActionType: Number(a.Type ?? 2),
        ViewConditionId: '',
      }));
    const stages: Decoded[] = (await listPhotoQuestStages()).map((s) => ({
      __msg: SPECIAL_STAGE_MSG as string,
      StageId: s.Id,
      IsUnlocked: true,
      MaxCapacity: Number(s.MaxCapacity ?? 0),
      UnlockConditionId: '',
      Order: Number(s.Order ?? 0),
      ViewConditionId: '',
    }));
    const musics: Decoded[] = (await listPhotoQuestMusics()).map((m) => ({
      __msg: SPECIAL_MUSIC_INFO_MSG as string,
      MusicId: m.Id,
      IsUnlocked: true,
      Order: Number(m.Order ?? 0),
      CostumeTypeIds: [],
      CharacterIds: [],
      PhotoStages: stages,
      UnlockConditionId: '',
      ViewConditionId: '',
    }));
    ctx.fastifyReq.log.info({ accountId, specialId, activities: activities.length }, 'photo list special shooting');
    return {
      __msg: '',
      Activities: activities,
      Musics: musics,
      Name: 'スペシャル撮影',
      ItemIds: ['item-photo_shooting-02'],
      CommonResponse: commonResponse({ __msg: UPDATED_DATA_MSG } as Decoded, null),
    } as Decoded;
  },
  { ownsState: true },
);

/** `Photo:CheckSpecialShooting` — validate a special shooting scene. */
register(
  'Photo:CheckSpecialShooting',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return commonOnly(
      await runPhoto(accountId, 'Photo:CheckSpecialShooting', async (tx, playerId) => {
        await checkSpecialShooting(ctx.request, tx, playerId);
        ctx.fastifyReq.log.info({ accountId, playerId }, 'photo check special shooting');
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Photo:CreateSpecialShootings` — spend film and take special/promotion shots. */
register(
  'Photo:CreateSpecialShootings',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const params = createShootingParams(ctx.request?.CreateShootingParams);
    const manualCount = Number(ctx.request?.ManualCount ?? 0);
    const specialId = String(ctx.request?.SpecialPhotoShootingId ?? '');

    const res = await runPhoto(accountId, 'Photo:CreateSpecialShootings', async (tx, playerId) => {
      await checkSpecialShooting(ctx.request, tx, playerId);
      const activity = await getPhotoActivity(specialId);
      const musicId = String(ctx.request?.MusicId ?? '');
      const music = !activity && musicId ? await getPhotoQuestMusic(musicId) : null;
      const placeName = String(activity?.Name ?? music?.Name ?? 'スペシャル撮影');
      const result = await createUserPhotoShootings(
        tx,
        playerId,
        {
          placeName,
          eventName: 'スペシャル撮影',
          candidateCharacterIds: stringList(ctx.request?.CharacterIds),
        },
        params,
        manualCount,
        'Photo:CreateSpecialShootings',
      );
      ctx.fastifyReq.log.info({ accountId, playerId, specialId, count: result.photos.length }, 'photo create special shootings');
      return result;
    });
    return photoShootingResponse(res, { SnsText: '' });
  },
  { ownsState: true },
);

/** `Photo:CheckStoryEpisodeShooting` — validate a story-episode shooting scene. */
register(
  'Photo:CheckStoryEpisodeShooting',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return commonOnly(
      await runPhoto(accountId, 'Photo:CheckStoryEpisodeShooting', async (tx, playerId) => {
        await checkStoryEpisodeShooting(ctx.request, tx, playerId);
        ctx.fastifyReq.log.info({ accountId, playerId }, 'photo check story episode shooting');
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Photo:CreateStoryEpisodeShootings` — spend film and take story-episode shots. */
register(
  'Photo:CreateStoryEpisodeShootings',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const params = createShootingParams(ctx.request?.CreateShootingParams);
    const manualCount = Number(ctx.request?.ManualCount ?? 0);
    const chapter = Number(ctx.request?.Chapter ?? 0);
    const episode = Number(ctx.request?.Episode ?? 0);
    const partId = String(ctx.request?.StoryPartId ?? '');

    const res = await runPhoto(accountId, 'Photo:CreateStoryEpisodeShootings', async (tx, playerId) => {
      const storyId = await checkStoryEpisodeShooting(ctx.request, tx, playerId);
      const part = await getStoryPart(partId);
      const candidates = await photoStoryCharacters(storyId);
      const result = await createUserPhotoShootings(
        tx,
        playerId,
        {
          placeName: `${part?.Name ?? ''} ${chapter}章 ${episode}話`,
          eventName: storyPartEventName(String(part?.Name ?? '')),
          candidateCharacterIds: candidates,
          storyId,
          storyShooting: true,
        },
        params,
        manualCount,
        'Photo:CreateStoryEpisodeShootings',
      );
      ctx.fastifyReq.log.info({ accountId, playerId, partId, chapter, episode, count: result.photos.length }, 'photo create story episode shootings');
      return result;
    });
    return photoShootingResponse(res);
  },
  { ownsState: true },
);

/** `PointType.ActivatePhotoShootingStoryTicket`: the "Shoot Unlock Ticket". */
const POINT_PHOTO_STORY_TICKET = 7;
const USER_POINT_MSG = 'Solis.Common.Proto.Transaction.UserPoint';

/**
 * `Photo:ActivateStoryEpisodeShooting` — spend one Shoot Unlock Ticket so an
 * owned, unread story episode can be photographed. Sets the story's
 * `IsUseActivatePhotoShootingStoryTicket` and returns the story and ticket
 * count. A story that is already read or activated is left alone, unspent.
 */
register(
  'Photo:ActivateStoryEpisodeShooting',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const storyId = await resolvePhotoStoryEpisode(
      String(ctx.request?.StoryPartId ?? ''),
      Number(ctx.request?.Chapter ?? 0),
      Number(ctx.request?.Route ?? 0),
      Number(ctx.request?.Episode ?? 0),
    );
    return commonOnly(
      await runPhoto(accountId, 'Photo:ActivateStoryEpisodeShooting', async (tx, playerId) => {
        const story = (await listElements(playerId, 'Stories', tx)).find(
          (s) => String(s.StoryId ?? '') === storyId,
        );
        if (!story || story.IsInvalid) throw new Error(`story not owned ${storyId}`);
        if (story.IsUseActivatePhotoShootingStoryTicket) {
          ctx.fastifyReq.log.info({ accountId, playerId, storyId }, 'photo activate story shooting (already open)');
          return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
        }
        // The client shows an episode as locked until this flag is set, even once
        // read; read episodes may already be shot, so flag them without a ticket.
        if (Number(story.StatusType ?? 0) === 2) {
          story.IsUseActivatePhotoShootingStoryTicket = true;
          await putElements(playerId, 'Stories', [story], tx);
          return { updated: updatedData(['Stories', [story]]), deleted: null };
        }
        const ticket = (await listElements(playerId, 'Points', tx)).find(
          (p) => Number(p.PointType ?? 0) === POINT_PHOTO_STORY_TICKET,
        );
        const have = Number(ticket?.Amount ?? 0);
        if (have < 1) throw new Error('Photo:ActivateStoryEpisodeShooting: no Shoot Unlock Ticket left');
        const point = { __msg: USER_POINT_MSG, PointType: POINT_PHOTO_STORY_TICKET, Amount: have - 1 } as Decoded;
        story.IsUseActivatePhotoShootingStoryTicket = true;
        await putElements(playerId, 'Points', [point], tx);
        await putElements(playerId, 'Stories', [story], tx);
        ctx.fastifyReq.log.info({ accountId, playerId, storyId, left: have - 1 }, 'photo activate story shooting');
        return { updated: updatedData(['Stories', [story]], ['Points', [point]]), deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Photo:CheckExcursionShooting` — validate an excursion shooting scene. */
register(
  'Photo:CheckExcursionShooting',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return commonOnly(
      await runPhoto(accountId, 'Photo:CheckExcursionShooting', async (tx, playerId) => {
        await checkExcursionShooting(ctx.request, tx, playerId);
        ctx.fastifyReq.log.info({ accountId, playerId }, 'photo check excursion shooting');
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Photo:CreateExcursionShootings` — spend film and take excursion shots. */
register(
  'Photo:CreateExcursionShootings',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const params = ((ctx.request?.CreateExcursionShootingParams as unknown[] | undefined) ?? []).map((p) => ({
      imageId: String((p as any).PhotoImageId ?? ''),
      itemId: String((p as any).ItemId ?? ''),
      focusCharacterId: String(ctx.request?.CharacterId ?? ''),
    }));
    const manualCount = Number(ctx.request?.ManualCount ?? 0);
    const placeId = String(ctx.request?.ExcursionPlaceId ?? '');
    const characterId = String(ctx.request?.CharacterId ?? '');

    const res = await runPhoto(accountId, 'Photo:CreateExcursionShootings', async (tx, playerId) => {
      await checkExcursionShooting(ctx.request, tx, playerId);
      const place = await getExcursionPlace(placeId);
      if (!place) throw new Error(`excursion place not found ${placeId}`);
      const result = await createUserPhotoShootings(
        tx,
        playerId,
        {
          placeName: String(place.Name ?? ''),
          eventName: 'おでかけ撮影',
          candidateCharacterIds: [characterId],
        },
        params,
        manualCount,
        'Photo:CreateExcursionShootings',
      );
      ctx.fastifyReq.log.info({ accountId, playerId, placeId, characterId, count: result.photos.length }, 'photo create excursion shootings');
      return result;
    });
    return photoShootingResponse(res);
  },
  { ownsState: true },
);

/**
 * Photo Dream — a photo-growth quest mode. No Dream master tables exist in the
 * repo (absent from phaseA2), so all responses are served as static sample
 * data (the PhotoPanorama/Shelf approach). These endpoints were never captured
 * on-device, so the shapes come from the generated schema only.
 */
const DREAM_SEASON_ID = 'dream-season-25-1011';
const DREAM_SEASON_NAME = 'フォトドリーム';

/** Static DreamRankInfo set (DreamAreaRankType 1 D .. 6 Splus). */
function dreamRankInfos(): Decoded[] {
  const ranks: Array<[number, string, string]> = [
    [1, '5c8ab4', 'bcd6e8'],
    [2, '5c8ab4', 'bcd6e8'],
    [3, '9a7a4f', 'd9c3a1'],
    [4, 'b08a8a', 'e0c0c0'],
    [5, 'b8985a', 'e8d4a8'],
    [6, 'e86a5a', 'f8c8a0'],
  ];
  return ranks.map(([type, top, bottom]) => ({
    __msg: 'Solis.Common.Proto.Api.DreamRankInfo',
    AreaRankType: type,
    AreaRankPlus: 0,
    TopColorCode: top,
    BottomColorCode: bottom,
  } as Decoded));
}

/** Static DreamAreaAttributeInfo (all weight permil 0, AttributeType 0). */
function dreamAttributeInfo(): Decoded {
  return {
    __msg: 'Solis.Common.Proto.Api.DreamAreaAttributeInfo',
    ActiveSkillWeightPermil: 0,
    SpecialSkillWeightPermil: 0,
    SkillStaminaWeightPermil: 0,
    StaminaRecoveryWeightPermil: 0,
    BeatDanceWeightPermil: 0,
    BeatVocalWeightPermil: 0,
    BeatVisualWeightPermil: 0,
    AttributeType: 0,
    QuestPressureId: '',
  } as Decoded;
}

/** Static DreamUserPhoto for the sample dream area. */
function dreamUserPhoto(): Decoded {
  const now = Date.now();
  return {
    __msg: 'Solis.Common.Proto.Api.DreamUserPhoto',
    PhotoId: randomUUID(),
    GeneratedTime: now,
    LastChallengedTime: 0,
    AreaRankType: 1,
    AreaRankPlus: 0,
    ClearQuestNumber: 0,
    MaxQuestNumber: 1,
    Abilities: [] as Decoded[],
    AttributeInfo: dreamAttributeInfo(),
    RankPoint: 100000,
    IsDisableGenerateArea: false,
    MaxGrowthPermil: 1000,
    CurrentGrowthPermil: 0,
  } as Decoded;
}

/** `Dream:Top` — the dream top page; Empty request. */
register(
  'Dream:Top',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return runPhoto(accountId, 'Dream:Top', async (_tx, playerId) => {
      const now = Date.now();
      ctx.fastifyReq.log.info({ accountId, playerId }, 'dream top');
      return {
        __msg: '',
        SeasonInfo: {
          __msg: 'Solis.Common.Proto.Api.DreamSeasonInfo',
          Id: DREAM_SEASON_ID,
          Name: DREAM_SEASON_NAME,
          StartTime: now - 24 * 60 * 60 * 1000,
          EndTime: now + 30 * 24 * 60 * 60 * 1000,
          GenerateAreaItemId: 'item-dream_generate',
          AssetId: 'event-dream-25-1011',
          NoticeInfo: null,
          RankInfos: dreamRankInfos(),
          EventMissionInfo: null,
        } as Decoded,
        DreamUserPhotos: [] as Decoded[],
        LoginRewardResults: [] as Decoded[],
        DokanInfos: [] as Decoded[],
        GrowthPermilNoticeInfo: null,
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Dream:ListMaterialPhoto` — photos usable as material for area generation. */
register(
  'Dream:ListMaterialPhoto',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return runPhoto(accountId, 'Dream:ListMaterialPhoto', async (_tx, playerId) => {
      ctx.fastifyReq.log.info({ accountId, playerId }, 'dream list material photo');
      return {
        __msg: '',
        UserMaterialPhotos: [] as Decoded[],
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Dream:ListQuest` — quests in the generated area for BasePhotoId. */
register(
  'Dream:ListQuest',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const basePhotoId = ctx.request?.BasePhotoId == null ? '' : String(ctx.request.BasePhotoId);
    return runPhoto(accountId, 'Dream:ListQuest', async (_tx, playerId) => {
      ctx.fastifyReq.log.info({ accountId, playerId, basePhotoId }, 'dream list quest');
      return {
        __msg: '',
        QuestInfos: [] as Decoded[],
        ClearQuestNumber: 0,
        MaxQuestNumber: 1,
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Dream:GenerateArea` — generate a dream area from a base + material photo. */
register(
  'Dream:GenerateArea',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const basePhotoId = ctx.request?.BasePhotoId == null ? '' : String(ctx.request.BasePhotoId);
    const materialPhotoId = ctx.request?.MaterialPhotoId == null ? '' : String(ctx.request.MaterialPhotoId);
    return runPhoto(accountId, 'Dream:GenerateArea', async (_tx, playerId) => {
      ctx.fastifyReq.log.info({ accountId, playerId, basePhotoId, materialPhotoId }, 'dream generate area');
      return {
        __msg: '',
        DreamUserPhoto: dreamUserPhoto(),
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Dream:StartQuest` — play a dream quest; returns a cleared sample LiveResult. */
register(
  'Dream:StartQuest',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const basePhotoId = ctx.request?.BasePhotoId == null ? '' : String(ctx.request.BasePhotoId);
    const deckNumber = Number(ctx.request?.DeckNumber ?? 0);
    const isSkip = Boolean(ctx.request?.IsSkip);
    return runPhoto(accountId, 'Dream:StartQuest', async (_tx, playerId) => {
      ctx.fastifyReq.log.info({ accountId, playerId, basePhotoId, deckNumber, isSkip }, 'dream start quest');
      return {
        __msg: '',
        Result: {
          __msg: 'Solis.Common.Proto.Api.LiveResult',
          UserInfos: [] as Decoded[],
          ActivatedPassiveSkills: [] as Decoded[],
          Charts: [] as Decoded[],
          TotalAudienceAmount: 0,
          Cleared: true,
          IsDisplayDetailAvailable: false,
          PreChart: null,
          DetailLogId: 0,
        } as Decoded,
        ClearedQuestNumber: 1,
        MaxQuestNumber: 1,
        MusicMasteryRewards: [] as Decoded[],
        AbilityChangeInfos: [] as Decoded[],
        FriendApplyToBuddyInfo: null,
        RankPatterns: [] as Decoded[],
        DreamUserPhoto: dreamUserPhoto(),
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Dream:SkipQuest` — skip a cleared dream quest. */
register(
  'Dream:SkipQuest',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const basePhotoId = ctx.request?.BasePhotoId == null ? '' : String(ctx.request.BasePhotoId);
    const deckNumber = Number(ctx.request?.DeckNumber ?? 0);
    const questNumber = Number(ctx.request?.QuestNumber ?? 0);
    return runPhoto(accountId, 'Dream:SkipQuest', async (_tx, playerId) => {
      ctx.fastifyReq.log.info({ accountId, playerId, basePhotoId, deckNumber, questNumber }, 'dream skip quest');
      return {
        __msg: '',
        ClearedQuestNumber: 1,
        MaxQuestNumber: 1,
        SkipMusicMasteryRewardInfos: [] as Decoded[],
        AbilityChangeInfos: [] as Decoded[],
        DreamUserPhoto: dreamUserPhoto(),
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Dream:ResetArea` — discard the current dream area. */
register(
  'Dream:ResetArea',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const basePhotoId = ctx.request?.BasePhotoId == null ? '' : String(ctx.request.BasePhotoId);
    return commonOnly(
      await runPhoto(accountId, 'Dream:ResetArea', async (_tx, playerId) => {
        ctx.fastifyReq.log.info({ accountId, playerId, basePhotoId }, 'dream reset area');
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

/** `Photo:GetDreamBasePhotoEnhanceLevelInfos` — dream base-photo enhance levels. */
register(
  'Photo:GetDreamBasePhotoEnhanceLevelInfos',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const basePhotoId = ctx.request?.BasePhotoId == null ? '' : String(ctx.request.BasePhotoId);
    return runPhoto(accountId, 'Photo:GetDreamBasePhotoEnhanceLevelInfos', async (_tx, playerId) => {
      const abilityIds = ['pabl-10001', 'pabl-10002', 'pabl-10003', 'pabl-10004', 'pabl-10005'];
      const levelInfos = [1, 5, 10, 15, 20].map((level) => ({
        __msg: 'Solis.Common.Proto.Api.DreamBasePhotoEnhanceLevelInfo',
        Level: level,
        EffectValueInfos: abilityIds.map((id) => ({
          __msg: 'Solis.Common.Proto.Api.DreamBasePhotoEnhanceLevelEffectValueInfo',
          PhotoAbilityId: id,
          EffectValue: level * 100,
        } as Decoded)),
      } as Decoded));
      ctx.fastifyReq.log.info({ accountId, playerId, basePhotoId }, 'photo get dream base photo enhance level infos');
      return {
        __msg: '',
        LevelInfos: levelInfos,
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Showcase:Get` — a target user's showcases (self-serve; friend data empty). */
register(
  'Showcase:Get',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const userId = ctx.request?.UserId == null ? '' : String(ctx.request.UserId);
    return runPhoto(accountId, 'Showcase:Get', async (tx, playerId) => {
      const isSelf = userId === playerId;
      const user = await loadUser(tx, playerId);
      const showcases = isSelf ? await listElements(playerId, 'Showcases', tx) : [];
      ctx.fastifyReq.log.info({ accountId, playerId, targetUserId: userId }, 'showcase get');
      return {
        __msg: '',
        ShowcaseInfos: showcases.map((s) => ({
          __msg: SHOWCASE_INFO_MSG,
          Showcase: s,
          ProfileInfo: showcaseProfileInfo(userId, user),
          IsFriend: false,
          IsLiked: false,
        } as Decoded)),
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Showcase:GalleryTop` — the friend gallery top (self-only data). */
register(
  'Showcase:GalleryTop',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return runPhoto(accountId, 'Showcase:GalleryTop', async (tx, playerId) => {
      const user = await loadUser(tx, playerId);
      const showcases = await listElements(playerId, 'Showcases', tx);
      ctx.fastifyReq.log.info({ accountId, playerId }, 'showcase gallery top');
      const now = new Date();
      return {
        __msg: '',
        ShowcaseInfos: showcases.map((s) => ({
          __msg: SHOWCASE_INFO_MSG,
          Showcase: s,
          ProfileInfo: showcaseProfileInfo(playerId, user),
          IsFriend: false,
          IsLiked: false,
        } as Decoded)),
        TermInfo: {
          __msg: SHOWCASE_TERM_INFO_MSG,
          Month: now.getMonth() + 1,
          Day: now.getDate(),
          Hour: now.getHours(),
        } as Decoded,
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Showcase:SearchFriendRecommendList` — recommended showcases (self-only). */
register(
  'Showcase:SearchFriendRecommendList',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return runPhoto(accountId, 'Showcase:SearchFriendRecommendList', async (tx, playerId) => {
      const user = await loadUser(tx, playerId);
      const showcases = await listElements(playerId, 'Showcases', tx);
      ctx.fastifyReq.log.info({ accountId, playerId }, 'showcase search friend recommend list');
      const now = new Date();
      return {
        __msg: '',
        ShowcaseInfos: showcases.map((s) => ({
          __msg: SHOWCASE_INFO_MSG,
          Showcase: s,
          ProfileInfo: showcaseProfileInfo(playerId, user),
          IsFriend: false,
          IsLiked: false,
        } as Decoded)),
        TermInfo: {
          __msg: SHOWCASE_TERM_INFO_MSG,
          Month: now.getMonth() + 1,
          Day: now.getDate(),
          Hour: now.getHours(),
        } as Decoded,
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Showcase:SearchHashtagList` — search showcases by hashtag (self-only). */
register(
  'Showcase:SearchHashtagList',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const hashtagId = ctx.request?.HashtagId == null ? '' : String(ctx.request.HashtagId);
    const isHead = Boolean(ctx.request?.IsHead);
    return runPhoto(accountId, 'Showcase:SearchHashtagList', async (tx, playerId) => {
      const user = await loadUser(tx, playerId);
      const showcases = (await listElements(playerId, 'Showcases', tx)).filter((s) => {
        if (!hashtagId) return true;
        const tags = (s.HashTagIds as string[] | undefined) ?? [];
        return tags.includes(hashtagId);
      });
      ctx.fastifyReq.log.info({ accountId, playerId, hashtagId, isHead }, 'showcase search hashtag list');
      const now = new Date();
      return {
        __msg: '',
        ShowcaseInfos: showcases.map((s) => ({
          __msg: SHOWCASE_INFO_MSG,
          Showcase: s,
          ProfileInfo: showcaseProfileInfo(playerId, user),
          IsFriend: false,
          IsLiked: false,
        } as Decoded)),
        TermInfo: {
          __msg: SHOWCASE_TERM_INFO_MSG,
          Month: now.getMonth() + 1,
          Day: now.getDate(),
          Hour: now.getHours(),
        } as Decoded,
        IsEndHashtagSearchList: true,
        IsAlwaysEmpty: false,
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Showcase:Display` — view a single showcase by Number. */
register(
  'Showcase:Display',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const userId = ctx.request?.UserId == null ? '' : String(ctx.request.UserId);
    const number = Number(ctx.request?.Number ?? 0);
    return runPhoto(accountId, 'Showcase:Display', async (tx, playerId) => {
      const isSelf = userId === playerId;
      const user = await loadUser(tx, playerId);
      const showcases = isSelf ? await listElements(playerId, 'Showcases', tx) : [];
      const showcase = showcases.find((s) => Number(s.Number ?? 0) === number);
      ctx.fastifyReq.log.info({ accountId, playerId, targetUserId: userId, number }, 'showcase display');
      if (!showcase) throw new Error(`Showcase:Display: showcase not found ${number}`);
      return {
        __msg: '',
        ShowcaseInfo: {
          __msg: SHOWCASE_INFO_MSG,
          Showcase: showcase,
          ProfileInfo: showcaseProfileInfo(userId, user),
          IsFriend: false,
          IsLiked: false,
        } as Decoded,
        IsViewable: true,
        LayoutInfo: showcase.LayoutInfo ?? { __msg: SHOWCASE_LAYOUT_INFO_MSG } as Decoded,
        CommonResponse: commonResponse(null, null),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Showcase:CheckShooting` — validate a showcase photo shooting scene. */
register(
  'Showcase:CheckShooting',
  async (ctx) => {
    const accountId = accountOf(ctx);
    return commonOnly(
      await runPhoto(accountId, 'Showcase:CheckShooting', async (tx, playerId) => {
        await checkShowcaseShooting(ctx.request, tx, playerId);
        ctx.fastifyReq.log.info({ accountId, playerId }, 'showcase check shooting');
        return { updated: { __msg: UPDATED_DATA_MSG } as Decoded, deleted: null };
      }),
    );
  },
  { ownsState: true },
);

async function showcasePhotoCharacters(playerId: string, number: number, exec: Executor): Promise<string[]> {
  const showcases = await listElements(playerId, 'Showcases', exec);
  const showcase = showcases.find((s) => Number(s.Number ?? 0) === number);
  const layout = (showcase?.LayoutInfo as Decoded | undefined) ?? undefined;
  const assetInfos = (layout?.ShowcaseToyAssetInfos as Decoded[] | undefined) ?? [];
  const toys = await listShowcaseToys();
  const characters: string[] = [];
  const seenToys = new Set<string>();
  for (const asset of assetInfos) {
    const toyId = String(asset.ShowcaseToyId ?? '');
    if (!toyId || seenToys.has(toyId)) continue;
    seenToys.add(toyId);
    const toy = toys.find((t) => String(t.Id ?? '') === toyId);
    for (const characterId of ((toy?.PhotoShootingCharacterIds as string[] | null | undefined) ?? []).map(String)) {
      if (characterId && !characters.includes(characterId)) characters.push(characterId);
    }
  }
  return characters;
}

/** `Showcase:CreatePhoto` — consume film and generate showcase photos. */
register(
  'Showcase:CreatePhoto',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const number = Number(ctx.request?.Number ?? 0);
    const params = ((ctx.request?.CreatePhotoParams as unknown[] | undefined) ?? []).map((p) => ({
      imageId: String((p as any).AssetId ?? ''),
      itemId: String((p as any).ItemId ?? ''),
      focusCharacterId: String((p as any).MainCharacterId ?? ''),
    }));
    const manualCount = Number(ctx.request?.ManualCount ?? 0);

    const res = await runPhoto(accountId, 'Showcase:CreatePhoto', async (tx, playerId) => {
      await checkShowcaseShooting(ctx.request, tx, playerId);
      for (const param of params) {
        const item = await getItem(param.itemId);
        if (!item) throw new Error(`item not found ${param.itemId}`);
        if (item.IsPhotoShootingCharacterOnly) {
          throw new Error('character-only shooting film cannot be used for showcase shooting');
        }
      }
      const showcases = await listElements(playerId, 'Showcases', tx);
      const showcase = showcases.find((s) => Number(s.Number ?? 0) === number);
      const candidates = await showcasePhotoCharacters(playerId, number, tx);
      const result = await createUserPhotoShootings(
        tx,
        playerId,
        {
          placeName: String(showcase?.Name ?? '') || `ケース${number}`,
          eventName: 'グッズケース',
          photoNamePrefix: 'グッズケース',
          candidateCharacterIds: candidates,
          showcaseShooting: true,
          reliabilityOncePerCharacter: true,
        },
        params,
        manualCount,
        'Showcase:CreatePhoto',
      );
      ctx.fastifyReq.log.info({ accountId, playerId, number, count: result.photos.length }, 'showcase create photo');
      return result;
    });
    return photoShootingResponse(res);
  },
  { ownsState: true },
);
