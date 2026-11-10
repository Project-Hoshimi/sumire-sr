// Port of the DB-facing live input preparation from Solis
// `internal/server/rpc/servers/internal/viber/live.go` (+ `live_music.go`).
//
// Solis reads player state from MongoDB (`opuser.*`); here the same state comes
// from the generic player-state store (`playerState.ts`) inside the caller's
// transaction. Master rows come from `master/index.ts`. The result is the pure
// simulator `Input` consumed by `src/live`.
//
// Deviations from Solis are documented at the call sites: sumire-sr has no
// staff / company-enjoy master or player collections, and no
// `UserPublic` collection (the public id lives on the player row's captured
// auth data).

import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { type Executor } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import {
  findLiveStatusEfficacy,
  getAccessory,
  getCard,
  getCardParameter,
  getCardRarity,
  getCharacter,
  getCostume,
  getHair,
  getLiveBonusGroup,
  getMusic,
  getQuestCharacterAdvantage,
  getQuestPressure,
  getSetting,
  listCardEvolutionLevelReleases,
  listCardsByIds,
  listCharacters,
  listComboAdvantages,
  listLiveAbilities,
  listLiveBonuses,
  listMusicChartPatterns,
  listMusicMasteryLevels,
  listMusicMasteryRewardLevels,
  listMusicMasteryRewards,
  listPhotoAbilities,
  listPhotoAbilityTargets,
  listQuestAudienceAdvantages,
  listQuestStaminaConsumptions,
  listSkillEfficacies,
  listSkillTargets,
  listSkillTriggers,
  listSkills,
} from '../master/index.ts';
import { MoodType, PhotoAbilityType, StatusEffectType } from '../live/enums.ts';
import { conversionStatusEfficacyType } from '../live/compile.ts';
import {
  applyGrants,
  addManagerExp,
  resolveRewardRefs,
} from '../master/reward.ts';
import { cardReleaseForCard } from './cardRelease.ts';
import { getSingleton, listElements, putElements, findPlayerByAccountId } from './playerState.ts';
import {
  AllocateAudience,
  ExtraCharacterIDs,
  NPCBalance,
  NPCRoster,
  PhotoTargetIndexes,
  ResolveCharacterAdvantage,
  beatScoreCoefficientPermil,
  simulate,
} from '../live/index.ts';
import type {
  CardData,
  Input,
  LiveDeckCard,
  LiveDeckCardSkill,
  LiveResult,
  LiveUserInfo,
  MusicChartPattern,
  Quest,
  QuestOpponentInfo,
  Setting,
  Skill,
  SkillEfficacy,
  SkillTarget,
  SkillTrigger,
  StrengthModifier,
} from '../live/index.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import type * as masterSchema from '../db/masterSchema.ts';

type CardRow = typeof masterSchema.masterCard.$inferSelect;
type CharacterRow = typeof masterSchema.masterCharacter.$inferSelect;
type CostumeRow = typeof masterSchema.masterCostume.$inferSelect;
type HairRow = typeof masterSchema.masterHair.$inferSelect;
type AccessoryRow = typeof masterSchema.masterAccessory.$inferSelect;
type MusicRow = typeof masterSchema.masterMusic.$inferSelect;
type PhotoAbilityRow = typeof masterSchema.masterPhotoAbility.$inferSelect;
type PhotoAbilityTargetRow = typeof masterSchema.masterPhotoAbilityTarget.$inferSelect;
type LiveAbilityRow = typeof masterSchema.masterLiveAbility.$inferSelect;

const MSG = {
  LIVE_CHARACTER_ASSET: 'Solis.Common.Proto.Api.LiveCharacterAssetInfo',
  EXTRA_CHARACTER: 'Solis.Common.Proto.Api.ExtraCharacterInfo',
  RANK_PATTERN: 'Solis.Common.Proto.Api.QuestRankPattern',
  CHARACTER_MUSIC: 'Solis.Common.Proto.Transaction.UserCharacterMusic',
  REWARD: 'Solis.Common.Proto.Transaction.Reward',
} as const;

/** `Solis.Common.Proto.ParameterType` / `AccessoryParameterType` wire values. */
const PARAMETER = {
  Unknown: 0,
  Dance: 1,
  Vocal: 2,
  Visual: 3,
  Stamina: 4,
  Mental: 5,
  Technique: 6,
} as const;
const ACCESSORY_PARAMETER = PARAMETER;
const ACCESSORY_CATEGORY = { Unknown: 0, Part1: 1, Part2: 2 } as const;
const LIVE_ABILITY = {
  Unknown: 0,
  DanceAdd: 1,
  DanceMultiply: 2,
  VocalAdd: 3,
  VocalMultiply: 4,
  VisualAdd: 5,
  VisualMultiply: 6,
  StaminaAdd: 7,
  StaminaMultiply: 8,
  MentalAdd: 9,
  MentalMultiply: 10,
  TechniqueAdd: 11,
  TechniqueMultiply: 12,
  PassiveSkill: 13,
  ManagerExp: 14,
  Gold: 15,
  CardExp: 16,
  BeatScoreAdd: 17,
  BeatScoreMultiply: 18,
  ActiveSkillScoreAdd: 19,
  ActiveSkillScoreMultiply: 20,
  SpecialSkillScoreAdd: 21,
  SpecialSkillScoreMultiply: 22,
  CriticalScoreMultiply: 23,
  AudienceAmountUp: 24,
  AccessoryParameterUp: 25,
  PhotoLevelUp: 26,
} as const;
const POSSESSION = { Unknown: 0, Card: 1, Photo: 2, Ability: 3, Quest: 4 } as const;
const LIVE_TYPE = { Unknown: 0, Score: 1, Battle: 2 } as const;
const RANK_TYPE = { Unknown: 0, D: 1, C: 2, B: 3, A: 4, S: 5, Splus: 6 } as const;
const MAX_INT32 = 2_147_483_647;

function n(value: unknown): number {
  return Number(value ?? 0) || 0;
}

function s(value: unknown): string {
  return value == null ? '' : String(value);
}

/** Port of Solis `liveStringKeys`: non-empty ids in stable order. */
function liveStringKeys(values: Iterable<string>): string[] {
  return [...values].filter((value) => value !== '').sort();
}

function asMap<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) out.set(key(row), row);
  return out;
}

/** Solis `FailedPreconditionf`. */
class LivePreconditionError extends Error {}

function failed(message: string): never {
  throw new LivePreconditionError(message);
}

export type LiveFormation = {
  Name: string;
  Positions: Decoded[];
};

export type LiveEquipmentBoost = {
  accessoryPermil: number;
  photoLevel: number;
};

export type PreparedPhotoBonus = {
  Source: number;
  Definition: PhotoAbilityRow;
  Amount: number;
};

/**
 * Port of Solis `LiveDeckCharacterAssets`: choose one owned replacement idol per
 * deck position, deterministically, never re-using an idol or stealing a later
 * position's original display identity.
 */
export async function liveDeckCharacterAssets(
  positions: Decoded[],
  originalIDs: string[],
  characters: Decoded[],
  masters: Map<string, CharacterRow>,
  exec: Executor = db,
): Promise<Decoded[]> {
  if (positions.length !== originalIDs.length) failed('live appearance inputs differ in size');
  const owned = new Map<string, Decoded>();
  const ordered: string[] = [];
  for (const character of characters) {
    const id = s(character.CharacterId);
    owned.set(id, character);
    ordered.push(id);
  }
  ordered.sort();
  const reserved = new Set<string>();
  const used = new Set<string>();
  for (const id of originalIDs) reserved.add(id);
  const assets: Decoded[] = [];
  for (let index = 0; index < positions.length; index++) {
    const position = positions[index];
    let id = originalIDs[index];
    let costumeID = s(position.CostumeId);
    let hairID = s(position.HairId);
    if (used.has(id)) {
      // Replacement selection is an authored deterministic rule. Never pick an
      // unowned idol or steal a later original idol's display identity.
      id = '';
      costumeID = '';
      hairID = '';
      for (const candidate of ordered) {
        if (!reserved.has(candidate) && !used.has(candidate)) {
          id = candidate;
          break;
        }
      }
    }
    const character = owned.get(id);
    if (character === undefined) failed('not enough owned idols for the live appearance');
    const asset = await questCharacterAsset(character, masters.get(id), costumeID, hairID, exec);
    used.add(id);
    assets.push(asset);
  }
  return assets;
}

/**
 * Port of Solis `PrepareExtraLiveAppearances`: extra performers have no cards
 * and never participate in audience or score calculations.
 */
export async function prepareExtraLiveAppearances(
  playerId: string,
  music: MusicRow | null,
  characters: Decoded[],
  masters: Map<string, CharacterRow>,
  displayed: Decoded[],
  exec: Executor = db,
): Promise<Decoded[]> {
  const owned = new Map<string, Decoded>();
  const ids: string[] = [];
  for (const character of characters) {
    const id = s(character.CharacterId);
    owned.set(id, character);
    ids.push(id);
  }
  const used = displayed.map((asset) => s(asset.CharacterId));
  const chosen = ExtraCharacterIDs(n(music?.DisplayCharacterAmount), ids, used);
  const ownedCostumes = new Set((await listElements(playerId, 'Costumes', exec)).map((row) => s(row.CostumeId)));
  const ownedHairs = new Set((await listElements(playerId, 'Hairs', exec)).map((row) => s(row.HairId)));
  const result: Decoded[] = [];
  for (let i = 0; i < chosen.length; i++) {
    const asset = await questCharacterAsset(owned.get(chosen[i]), masters.get(chosen[i]), '', '', exec);
    if (!ownedCostumes.has(s(asset.CostumeId))) failed('extra live costume is not owned');
    if (!ownedHairs.has(s(asset.HairId))) failed('extra live hair is not owned');
    result.push({
      __msg: MSG.EXTRA_CHARACTER,
      Position: displayed.length + i + 1,
      CharacterId: asset.CharacterId,
      CostumeId: asset.CostumeId,
      HairId: asset.HairId,
    } as Decoded);
  }
  return result;
}

/** Port of Solis `questCharacterAsset`. */
export async function questCharacterAsset(
  character: Decoded | undefined,
  master: CharacterRow | undefined,
  costumeID: string,
  hairID: string,
  exec: Executor = db,
): Promise<Decoded> {
  if (character === undefined) failed('live appearance requires an owned idol');
  const characterId = s(character.CharacterId);
  const resolvedMaster = master ?? (await getCharacter(characterId));
  if (resolvedMaster === null || s(resolvedMaster.Id) !== characterId) {
    failed('live appearance character does not match master');
  }
  if (costumeID === '') costumeID = s(character.LiveCostumeId);
  if (costumeID === '') costumeID = s(resolvedMaster.DefaultLiveCostumeId);
  if (costumeID === '') costumeID = s(resolvedMaster.DefaultCostumeId);
  const costume = await getCostume(costumeID);
  if (costume === null) failed('live costume is missing from master');
  if (s(costume.CharacterId) !== characterId || s(costume.CostumeTypeId).startsWith('sd-')) {
    failed('deck costume has no usable live model for this idol');
  }
  if (hairID === '') hairID = s(character.LiveHairId);
  if (hairID === '') hairID = s(costume.DefaultHairId);
  let hair = await getHair(hairID);
  const fits = (candidate: HairRow | null): boolean =>
    candidate !== null &&
    s(candidate.CharacterId) === characterId &&
    !toArray(candidate.NotWearableCostumeIds).includes(costumeID) &&
    (toArray(candidate.WearableCostumeIds).length === 0 ||
      toArray(candidate.WearableCostumeIds).includes(costumeID));
  if (!fits(hair)) {
    // Global live hair can become incompatible with a deck-specific outfit.
    // Prefetch and Start must both use the costume's compatible default.
    hairID = s(costume.DefaultHairId);
    hair = await getHair(hairID);
    if (!fits(hair)) failed('costume default hair has no compatible live model');
  }
  return {
    __msg: MSG.LIVE_CHARACTER_ASSET,
    CharacterId: characterId,
    CostumeId: costumeID,
    HairId: hairID,
  } as Decoded;
}

function toArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => s(v)) : [];
}

/**
 * Port of Solis `LoadLiveFormation`: the saved deck number, not a frozen stat
 * snapshot. Bulk plays revalidate these ids against current possessions.
 */
export async function loadLiveFormation(
  playerId: string,
  number: number,
  exec: Executor = db,
): Promise<LiveFormation> {
  const decks = await listElements(playerId, 'Decks', exec);
  const deck = decks.find((row) => n(row.Number) === number);
  if (deck === undefined) throw new Error(`live formation deck ${number} not found`);
  const positions = (await listElements(playerId, 'DeckPositions', exec))
    .filter((row) => n(row.Number) === number)
    .sort((a, b) => n(a.Position) - n(b.Position));
  return { Name: s(deck.Name), Positions: positions };
}

/**
 * Port of Solis `GrantLiveResource`. Sumire's `applyGrants` is the equivalent of
 * Solis `GrantGachaReward`; card resources are still granted one at a time.
 * Mission de-duplication is unnecessary here because `applyGrants` never emits
 * mission rows.
 */
export async function grantLiveResource(
  playerId: string,
  resourceType: number,
  id: string,
  amount: number,
  updated: Decoded,
  exec: Executor = db,
): Promise<Decoded[]> {
  const results: Decoded[] = [];
  let remaining = amount;
  while (remaining > 0) {
    const chunk = resourceType === 2 ? 1 : Math.min(remaining, MAX_INT32);
    const applied = await applyGrants(
      playerId,
      [{ resourceType, resourceId: id, amount: chunk }],
      exec,
    );
    results.push(...applied.results);
    if (applied.updated) mergeInto(updated, applied.updated);
    remaining -= chunk;
  }
  return results;
}

function mergeInto(target: Decoded, source: Decoded): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === '__msg' || key === '__unknown') continue;
    if (!Array.isArray(value)) {
      target[key] = value as Decoded; // singletons (User, Balance) replace
      continue;
    }
    const existing = Array.isArray(target[key]) ? (target[key] as unknown[]) : [];
    target[key] = [...existing, ...value] as Decoded;
  }
}

/** Port of Solis `LiveResultCharacterIDs`. */
export function liveResultCharacterIds(input: Input, result: LiveResult): string[] {
  const ids: string[] = [];
  const cards = result.UserInfos?.[0]?.UserDeck?.Cards ?? [];
  for (const card of cards) {
    const id = input.Cards.get(n(card.Index))?.CharacterID ?? '';
    if (id !== '' && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Port of Solis `LiveClearRankPatterns`: display grades only, not additional
 * reward thresholds.
 */
export function liveClearRankPatterns(clearScore: number): Decoded[] {
  const clear = Math.max(0, Math.trunc(clearScore));
  return [
    {
      __msg: MSG.RANK_PATTERN,
      RankType: RANK_TYPE.B,
      ThresholdScore: Math.min(Number.MAX_SAFE_INTEGER - 1024, Math.floor(clear * 1.2)),
    },
    { __msg: MSG.RANK_PATTERN, RankType: RANK_TYPE.C, ThresholdScore: clear },
    { __msg: MSG.RANK_PATTERN, RankType: RANK_TYPE.D },
  ] as Decoded[];
}

/**
 * Port of Solis `GrantLiveMastery`: per-character music mastery, level-up
 * threshold rewards, and the optional per-character stone accumulator used by
 * bulk-skip summaries.
 */
export async function grantLiveMastery(
  playerId: string,
  musicId: string,
  characters: string[],
  count: number,
  reward: Decoded,
  updated: Decoded,
  exec: Executor = db,
  stoneByCharacter?: Map<string, number>,
): Promise<void> {
  if (musicId === '') return;
  const levels = await listMusicMasteryLevels();
  const rows = (await listElements(playerId, 'CharacterMusics', exec)).filter(
    (row) => s(row.MusicId) === musicId,
  );
  const byId = new Map<string, Decoded>();
  for (const row of rows) byId.set(s(row.CharacterId), row);
  const rules = await listMusicMasteryRewards(musicId);
  const sets = new Map<string, string>();
  for (const rule of rules) sets.set(s(rule.CharacterId), s(rule.MusicMasteryRewardSetId));
  const loaded = new Map<string, Awaited<ReturnType<typeof listMusicMasteryRewardLevels>>>();
  for (const id of characters) {
    let row = byId.get(id);
    if (row === undefined) row = { __msg: MSG.CHARACTER_MUSIC, MusicId: musicId, CharacterId: id } as Decoded;
    const before = n(row.MasteryLevel);
    if (n(row.MasteryPoint) > MAX_INT32 - count) failed('music mastery overflows');
    row.MasteryPoint = n(row.MasteryPoint) + count;
    for (const level of levels) {
      if (n(row.MasteryPoint) >= n(level.RequiredMasteryPoint)) {
        row.MasteryLevel = Math.max(n(row.MasteryLevel), n(level.Level));
      }
    }
    if (s(row.__msg) === '') row.__msg = MSG.CHARACTER_MUSIC;
    await putElements(playerId, 'CharacterMusics', [row], exec);
    const updatedRows = Array.isArray(updated.CharacterMusics)
      ? (updated.CharacterMusics as Decoded[])
      : [];
    updated.CharacterMusics = [...updatedRows, row];
    if (n(row.MasteryLevel) <= before || s(sets.get(id)) === '') continue;
    const setId = s(sets.get(id));
    let rewards = loaded.get(setId);
    if (rewards === undefined) {
      rewards = await listMusicMasteryRewardLevels(setId);
      loaded.set(setId, rewards);
    }
    for (const r of rewards) {
      if (n(r.Level) <= before || n(r.Level) > n(row.MasteryLevel)) continue;
      const grants = await resolveRewardRefs([s(r.RewardId)]);
      for (const grant of grants) {
        const results = await grantLiveResource(
          playerId,
          grant.resourceType,
          grant.resourceId,
          grant.amount,
          updated,
          exec,
        );
        if (stoneByCharacter && (grant.resourceType === 15 || grant.resourceType === 16)) {
          stoneByCharacter.set(id, (stoneByCharacter.get(id) ?? 0) + grant.amount);
        }
        for (const result of results) {
          const rewardRows = Array.isArray(reward.MusicMasteryRewards)
            ? (reward.MusicMasteryRewards as Decoded[])
            : [];
          reward.MusicMasteryRewards = [
            ...rewardRows,
            {
              __msg: MSG.REWARD,
              ResourceType: n(result.ResourceType),
              ResourceId: s(result.ResourceId),
              Amount: n(result.AmountI64),
            } as Decoded,
          ];
        }
      }
    }
  }
}

/** Attribute is stable card metadata, taken from the largest master ratio. */
export function liveCardAttribute(m: CardRow): number {
  let attribute: number = PARAMETER.Vocal;
  let highest = n(m.VocalRatioPermil);
  if (n(m.DanceRatioPermil) > highest) {
    attribute = PARAMETER.Dance;
    highest = n(m.DanceRatioPermil);
  }
  if (n(m.VisualRatioPermil) > highest) attribute = PARAMETER.Visual;
  return attribute;
}

/**
 * Port of Solis `NewLiveInput`: shared master rules only (no user state).
 */
export async function newLiveInput(
  q: Quest,
  seed: bigint,
  exec: Executor = db,
): Promise<{ input: Input; music: MusicRow | null }> {
  const setting = await getSetting();
  if (setting === null) throw new Error('master Setting is missing');
  const chart = (await listMusicChartPatterns(s(q.MusicChartPatternId))).sort(
    (a, b) => n(a.Number) - n(b.Number),
  );
  if (chart.length === 0) failed('quest has no chart');
  const pressure = await getQuestPressure(s(q.QuestPressureId));
  const audienceAdvantages = await listQuestAudienceAdvantages(s(q.QuestAudienceAdvantageId));
  const music = await getMusic(s(q.MusicId));
  if (music === null) throw new Error(`master Music ${s(q.MusicId)} is missing`);
  // Use the song's reference chart, not the current quest's easier/harder
  // variant. Some event/360 songs have no canonical -001 chart; in that case the
  // resolver uses this quest's explicit chart with the same approximation.
  let reference = chart;
  const referenceID = `chart-${s(music.Id).replace(/^music-/, '')}-001`;
  if (referenceID !== s(q.MusicChartPatternId)) {
    reference = await listMusicChartPatterns(referenceID);
  }
  const coefficient = beatScoreCoefficientPermil(
    s(music.Id),
    reference as unknown as MusicChartPattern[],
    chart as unknown as MusicChartPattern[],
  );
  const comboAdvantages = await listComboAdvantages(s(music.ComboAdvantageId));
  const staminaConsumption = await listQuestStaminaConsumptions();
  const input: Input = {
    Quest: q,
    Setting: setting as unknown as Setting,
    Chart: chart as unknown as MusicChartPattern[],
    Pressure: (pressure ?? {}) as unknown as Input['Pressure'],
    AudienceAdvantages: audienceAdvantages as unknown as Input['AudienceAdvantages'],
    ComboAdvantages: comboAdvantages as unknown as Input['ComboAdvantages'],
    StaminaConsumption: staminaConsumption as unknown as Input['StaminaConsumption'],
    Users: [],
    Cards: new Map<number, CardData>(),
    Skills: new Map<string, Skill>(),
    Efficacies: new Map<string, SkillEfficacy>(),
    Triggers: new Map<string, SkillTrigger>(),
    Targets: new Map<string, SkillTarget>(),
    Seed: seed,
    BeatScoreCoefficientPermil: coefficient,
  };
  return { input, music };
}

// ---------------------------------------------------------------------------
// Solis `live.go:374-1362`: PrepareLiveInput and its preparation helpers.
// ---------------------------------------------------------------------------

/** Port of Solis `parameterPhotoTypes`. */
export function parameterPhotoTypes(typ: number): [number, number, boolean] {
  switch (typ) {
    case PARAMETER.Dance:
      return [PhotoAbilityType.DanceAdd, PhotoAbilityType.DanceMultiply, true];
    case PARAMETER.Vocal:
      return [PhotoAbilityType.VocalAdd, PhotoAbilityType.VocalMultiply, true];
    case PARAMETER.Visual:
      return [PhotoAbilityType.VisualAdd, PhotoAbilityType.VisualMultiply, true];
    case PARAMETER.Stamina:
      return [PhotoAbilityType.StaminaAdd, PhotoAbilityType.StaminaMultiply, true];
    case PARAMETER.Mental:
      return [PhotoAbilityType.MentalAdd, PhotoAbilityType.MentalMultiply, true];
    case PARAMETER.Technique:
      return [PhotoAbilityType.TechniqueAdd, PhotoAbilityType.TechniqueMultiply, true];
    default:
      return [PhotoAbilityType.Unknown, PhotoAbilityType.Unknown, false];
  }
}

/** Port of Solis `AccessoryPhotoTypes`. */
export function accessoryPhotoTypes(typ: number): [number, number, boolean] {
  switch (typ) {
    case ACCESSORY_PARAMETER.Dance:
      return parameterPhotoTypes(PARAMETER.Dance);
    case ACCESSORY_PARAMETER.Vocal:
      return parameterPhotoTypes(PARAMETER.Vocal);
    case ACCESSORY_PARAMETER.Visual:
      return parameterPhotoTypes(PARAMETER.Visual);
    case ACCESSORY_PARAMETER.Stamina:
      return parameterPhotoTypes(PARAMETER.Stamina);
    case ACCESSORY_PARAMETER.Mental:
      return parameterPhotoTypes(PARAMETER.Mental);
    case ACCESSORY_PARAMETER.Technique:
      return parameterPhotoTypes(PARAMETER.Technique);
    default:
      return [PhotoAbilityType.Unknown, PhotoAbilityType.Unknown, false];
  }
}

// The two enums are independent wire contracts; do not convert their numbers.
const LIVE_ABILITY_PHOTO: Record<number, number> = {
  [LIVE_ABILITY.DanceAdd]: PhotoAbilityType.DanceAdd,
  [LIVE_ABILITY.DanceMultiply]: PhotoAbilityType.DanceMultiply,
  [LIVE_ABILITY.VocalAdd]: PhotoAbilityType.VocalAdd,
  [LIVE_ABILITY.VocalMultiply]: PhotoAbilityType.VocalMultiply,
  [LIVE_ABILITY.VisualAdd]: PhotoAbilityType.VisualAdd,
  [LIVE_ABILITY.VisualMultiply]: PhotoAbilityType.VisualMultiply,
  [LIVE_ABILITY.StaminaAdd]: PhotoAbilityType.StaminaAdd,
  [LIVE_ABILITY.StaminaMultiply]: PhotoAbilityType.StaminaMultiply,
  [LIVE_ABILITY.MentalAdd]: PhotoAbilityType.MentalAdd,
  [LIVE_ABILITY.MentalMultiply]: PhotoAbilityType.MentalMultiply,
  [LIVE_ABILITY.TechniqueAdd]: PhotoAbilityType.TechniqueAdd,
  [LIVE_ABILITY.TechniqueMultiply]: PhotoAbilityType.TechniqueMultiply,
  [LIVE_ABILITY.ManagerExp]: PhotoAbilityType.ManagerExp,
  [LIVE_ABILITY.Gold]: PhotoAbilityType.Gold,
  [LIVE_ABILITY.CardExp]: PhotoAbilityType.CardExp,
  [LIVE_ABILITY.BeatScoreAdd]: PhotoAbilityType.BeatScoreAdd,
  [LIVE_ABILITY.BeatScoreMultiply]: PhotoAbilityType.BeatScoreMultiply,
  [LIVE_ABILITY.ActiveSkillScoreAdd]: PhotoAbilityType.ActiveSkillScoreAdd,
  [LIVE_ABILITY.ActiveSkillScoreMultiply]: PhotoAbilityType.ActiveSkillScoreMultiply,
  [LIVE_ABILITY.SpecialSkillScoreAdd]: PhotoAbilityType.SpecialSkillScoreAdd,
  [LIVE_ABILITY.SpecialSkillScoreMultiply]: PhotoAbilityType.SpecialSkillScoreMultiply,
  [LIVE_ABILITY.CriticalScoreMultiply]: PhotoAbilityType.CriticalScoreMultiply,
  [LIVE_ABILITY.AudienceAmountUp]: PhotoAbilityType.AudienceAmountUp,
};

/** Port of Solis `liveAbilityPhotoType`. */
export function liveAbilityPhotoType(typ: number): [number, boolean] {
  const photo = LIVE_ABILITY_PHOTO[typ];
  return photo === undefined ? [PhotoAbilityType.Unknown, false] : [photo, true];
}

/** Port of Solis `addLiveBonus`. int64 overflow is unreachable below 2^53-1. */
export function addLiveBonus(bonus: Map<number, number>, key: number, value: number): void {
  const current = bonus.get(key) ?? 0;
  if (value < 0 || current > Number.MAX_SAFE_INTEGER - value) {
    failed('negative or overflowing live bonus');
  }
  bonus.set(key, current + value);
}

/** Port of Solis `ApplyLiveCardStats`. */
export function applyLiveCardStats(card: LiveDeckCard, bonus: Map<number, number>): void {
  const row = card as Record<string, unknown>;
  const values: Array<[string, number]> = [
    ['Dance', PARAMETER.Dance],
    ['Vocal', PARAMETER.Vocal],
    ['Visual', PARAMETER.Visual],
    ['Stamina', PARAMETER.Stamina],
    ['Mental', PARAMETER.Mental],
    ['Technique', PARAMETER.Technique],
  ];
  for (const [field, parameter] of values) {
    const value = n(row[field]);
    if (value < 0) failed('negative card base parameter');
    const [flatType, ratioType] = parameterPhotoTypes(parameter);
    const flat = bonus.get(flatType) ?? 0;
    const ratio = bonus.get(ratioType) ?? 0;
    const scaled = (1000n + BigInt(ratio)) * BigInt(value);
    const result = scaled / 1000n + BigInt(flat);
    if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < 0n) failed('live parameter overflows');
    row[field] = Number(result);
  }
}

/** Port of Solis `prepareOwnedLiveAbilities`. */
export async function prepareOwnedLiveAbilities(
  owned: readonly Decoded[],
  q: Quest,
  exec: Executor = db,
): Promise<{ bonuses: Map<number, number>; passives: LiveDeckCardSkill[]; equipment: LiveEquipmentBoost }> {
  const equipment: LiveEquipmentBoost = { accessoryPermil: 0, photoLevel: 0 };
  const ids = new Set<string>();
  for (const card of owned) {
    if (s(card.LiveAbilityId) !== '' && n(card.LiveAbilityLevel) > 0) ids.add(s(card.LiveAbilityId));
  }
  const masters = await listLiveAbilities(liveStringKeys(ids));
  const byID = asMap(masters, (row) => s(row.Id));
  const bonuses = new Map<number, number>();
  const passives: LiveDeckCardSkill[] = [];
  for (const card of owned) {
    const abilityID = s(card.LiveAbilityId);
    const abilityLevel = n(card.LiveAbilityLevel);
    if (abilityID === '' || abilityLevel <= 0) continue;
    const master = byID.get(abilityID);
    if (master === undefined) failed('owned live ability is missing from master');
    let chosen: Decoded | undefined;
    for (const level of (master.Levels as Decoded[] | null) ?? []) {
      if (n(level.Level) === abilityLevel && n(level.RequiredCardLevel) <= n(card.Level)) {
        chosen = level;
        break;
      }
    }
    if (chosen === undefined) failed('owned live ability level is invalid');
    const mood = n(chosen.MoodType);
    if (mood !== MoodType.Unknown && mood !== n(q.MoodType)) continue;
    const typ = n(chosen.Type);
    if (typ === LIVE_ABILITY.PassiveSkill) {
      passives.push({
        SkillId: s(chosen.SkillId),
        SkillLevel: n(chosen.Value),
        LiveAbilityId: abilityID,
        LiveAbilityLevel: n(chosen.Level),
      });
      continue;
    }
    if (typ === LIVE_ABILITY.AccessoryParameterUp || typ === LIVE_ABILITY.PhotoLevelUp) {
      const value = n(chosen.Value);
      const field = typ === LIVE_ABILITY.AccessoryParameterUp ? 'accessoryPermil' : 'photoLevel';
      if (value < 0 || equipment[field] > Number.MAX_SAFE_INTEGER - value) {
        failed('equipment bonus overflows');
      }
      equipment[field] += value;
      continue;
    }
    const [photoType, ok] = liveAbilityPhotoType(typ);
    if (!ok) failed(`live ability ${typ} is unsupported`);
    addLiveBonus(bonuses, photoType, n(chosen.Value));
  }
  return { bonuses, passives, equipment };
}

/**
 * Port of Solis `PhotoAbilityEffectValue` (photo.go): the highest seeded level at
 * or below the effective photo level, scaled by the rolled grade.
 */
export function photoAbilityEffectValue(master: PhotoAbilityRow, level: number, grade: number): number {
  const levels = (master.PhotoAbilityLevels as Decoded[] | null) ?? [];
  let selectedLevel: Decoded | undefined;
  for (const candidate of levels) {
    if (n(candidate.Level) <= level && (selectedLevel === undefined || n(candidate.Level) > n(selectedLevel.Level))) {
      selectedLevel = candidate;
    }
  }
  if (selectedLevel === undefined) {
    for (const candidate of levels) {
      if (selectedLevel === undefined || n(candidate.Level) < n(selectedLevel.Level)) selectedLevel = candidate;
    }
  }
  const grades = (master.PhotoAbilityGrades as Decoded[] | null) ?? [];
  const selectedGrade = grades.find((candidate) => n(candidate.Grade) === grade);
  if (selectedLevel === undefined || selectedGrade === undefined) {
    failed(`photo ability ${s(master.Id)} lacks level ${level} or grade ${grade}`);
  }
  const scaled = (BigInt(n(selectedLevel.Value)) * BigInt(n(selectedGrade.BonusPermil))) / 1000n;
  const value = scaled + BigInt(n(selectedGrade.BonusValue));
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) failed('photo ability effect overflows');
  return Number(value);
}

/** Port of Solis `prepareLiveEquipment`. */
export async function prepareLiveEquipment(
  playerId: string,
  q: Quest,
  position: Decoded,
  owned: Decoded,
  character: CharacterRow,
  cardType: number,
  card: LiveDeckCard,
  bonus: Map<number, number>,
  equipment: LiveEquipmentBoost,
  photos: PreparedPhotoBonus[],
  seenPhotos: Set<string>,
  counts: Map<string, number>,
  exec: Executor = db,
): Promise<void> {
  const parts = [s(position.Part1AccessoryId), s(position.Part2AccessoryId)];
  for (let part = 0; part < parts.length; part++) {
    const id = parts[part];
    if (id === '') continue;
    const accessory = await getAccessory(id);
    if (accessory === null) failed('accessory is missing from master');
    const category = part === 0 ? ACCESSORY_CATEGORY.Part1 : ACCESSORY_CATEGORY.Part2;
    const ownerID = s(accessory.CharacterId);
    const groupID = s(accessory.CharacterGroupId);
    if (
      n(accessory.CategoryType) !== category ||
      (ownerID !== '' && ownerID !== s(character.Id)) ||
      (groupID !== '' && groupID !== s(character.CharacterGroupId))
    ) {
      failed('accessory cannot be equipped by this card');
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
    const pairs: Array<[number, number, number]> = [
      [n(accessory.Param1Type), n(accessory.Param1Value), n(accessory.Param1Permil)],
      [n(accessory.Param2Type), n(accessory.Param2Value), n(accessory.Param2Permil)],
    ];
    for (const [typ, rawFlat, rawRatio] of pairs) {
      if (typ === ACCESSORY_PARAMETER.Unknown) continue;
      let flat = rawFlat;
      let ratio = rawRatio;
      const boost = equipment.accessoryPermil;
      if (boost > 0) {
        if (boost > Number.MAX_SAFE_INTEGER - 1000) failed('accessory bonus overflows');
        const scale = BigInt(1000 + boost);
        flat = Number((BigInt(flat) * scale) / 1000n);
        ratio = Number((BigInt(ratio) * scale) / 1000n);
      }
      const [flatType, ratioType, ok] = accessoryPhotoTypes(typ);
      if (!ok) failed(`unsupported accessory parameter ${typ}`);
      addLiveBonus(bonus, flatType, flat);
      addLiveBonus(bonus, ratioType, ratio);
    }
  }
  const photoIDs = toArray(position.PhotoIds);
  if (photoIDs.length > n(owned.PhotoEquipableCount)) failed('insufficient photo slots');
  const userPhotos = asMap(await listElements(playerId, 'Photos', exec), (row) => s(row.PhotoId));
  let retouched = 0;
  for (const id of photoIDs) {
    if (id === '' || seenPhotos.has(id)) failed('photo must not be equipped twice');
    seenPhotos.add(id);
    const photo = userPhotos.get(id);
    if (photo === undefined) failed('photo is not owned');
    const photoCharacters = toArray(photo.CharacterIds);
    if (photoCharacters.length > 0 && !photoCharacters.includes(s(character.Id))) {
      failed('photo is not equipable by this idol');
    }
    if (s(photo.PhotoRecipeId) !== '') retouched += 1;
    if (retouched > 1) failed('only one retouched photo may be equipped');
    const abilities = (photo.Abilities as Decoded[] | null) ?? [];
    const abilityIDs = new Set<string>();
    for (const ability of abilities) {
      if (ability.IsAvailable === true || n(ability.IsAvailable) === 1) abilityIDs.add(s(ability.PhotoAbilityId));
    }
    const definitions = await listPhotoAbilities(liveStringKeys(abilityIDs));
    const byID = asMap(definitions, (row) => s(row.Id));
    const kind = n(q.ClearScore) === 0 ? LIVE_TYPE.Battle : LIVE_TYPE.Score;
    for (const ability of abilities) {
      if (!(ability.IsAvailable === true || n(ability.IsAvailable) === 1)) continue;
      const definition = byID.get(s(ability.PhotoAbilityId));
      if (definition === undefined) failed('photo ability master is missing');
      const mood = n(definition.MoodType);
      if (mood !== MoodType.Unknown && mood !== n(q.MoodType)) continue;
      if (n(definition.ConditionCardType) !== 0 && n(definition.ConditionCardType) !== cardType) continue;
      if (n(definition.ConditionLiveType) !== 0 && n(definition.ConditionLiveType) !== kind) continue;
      const level = n(photo.Level) + equipment.photoLevel;
      if (level <= 0 || level > MAX_INT32) failed('invalid effective photo level');
      const effect = photoAbilityEffectValue(definition, level, n(ability.Grade));
      photos.push({ Source: n(card.Index), Definition: definition, Amount: effect });
    }
  }
}

/** Port of Solis `preparedPhotoBonusType`. */
export function preparedPhotoBonusType(typ: number): boolean {
  switch (typ) {
    case PhotoAbilityType.DanceAdd:
    case PhotoAbilityType.DanceMultiply:
    case PhotoAbilityType.VocalAdd:
    case PhotoAbilityType.VocalMultiply:
    case PhotoAbilityType.VisualAdd:
    case PhotoAbilityType.VisualMultiply:
    case PhotoAbilityType.StaminaAdd:
    case PhotoAbilityType.StaminaMultiply:
    case PhotoAbilityType.MentalAdd:
    case PhotoAbilityType.MentalMultiply:
    case PhotoAbilityType.TechniqueAdd:
    case PhotoAbilityType.TechniqueMultiply:
    case PhotoAbilityType.ManagerExp:
    case PhotoAbilityType.Gold:
    case PhotoAbilityType.CardExp:
    case PhotoAbilityType.BeatScoreAdd:
    case PhotoAbilityType.BeatScoreMultiply:
    case PhotoAbilityType.ActiveSkillScoreAdd:
    case PhotoAbilityType.ActiveSkillScoreMultiply:
    case PhotoAbilityType.SpecialSkillScoreAdd:
    case PhotoAbilityType.SpecialSkillScoreMultiply:
    case PhotoAbilityType.CriticalScoreMultiply:
    case PhotoAbilityType.AudienceAmountUp:
    case PhotoAbilityType.CoolTimeReductionSkill1:
    case PhotoAbilityType.CoolTimeReductionSkill2:
    case PhotoAbilityType.CoolTimeReductionSkill3:
      return true;
    default:
      return false;
  }
}

/**
 * Port of Solis `ApplyPreparedPhotoBonuses`: resolve every recipient before
 * finalizing any card's stats, so neighbor photos apply symmetrically.
 */
export async function applyPreparedPhotoBonuses(
  input: Input,
  user: LiveUserInfo,
  bonuses: readonly PreparedPhotoBonus[],
  exec: Executor = db,
): Promise<void> {
  const ids = new Set<string>();
  for (const bonus of bonuses) {
    if (s(bonus.Definition.AbilityTargetId) !== '') ids.add(s(bonus.Definition.AbilityTargetId));
  }
  const targets = new Map<string, PhotoAbilityTargetRow>();
  if (ids.size > 0) {
    for (const row of await listPhotoAbilityTargets(liveStringKeys(ids))) targets.set(s(row.Id), row);
    if (targets.size !== ids.size) failed('photo target master is missing');
  }
  const cards = user.UserDeck?.Cards ?? [];
  const byIndex = new Map<number, LiveDeckCard>();
  for (const card of cards) byIndex.set(n(card.Index), card);
  for (const bonus of bonuses) {
    const definition = bonus.Definition;
    if (bonus.Amount < 0) failed('negative photo effect');
    const recipients = PhotoTargetIndexes(
      cards,
      input.Cards,
      bonus.Source,
      targets.get(s(definition.AbilityTargetId)) as unknown as Parameters<typeof PhotoTargetIndexes>[3],
    );
    for (const index of recipients) {
      const data = input.Cards.get(index);
      if (data === undefined) failed('photo recipient is not in the live unit');
      const typ = n(definition.AbilityType);
      if (typ === PhotoAbilityType.PassiveSkill) {
        if (bonus.Amount <= 0 || bonus.Amount > MAX_INT32) failed('invalid photo passive level');
        const card = byIndex.get(index);
        if (card === undefined) failed('photo recipient is not in this unit');
        let photoIndex = 1001;
        for (const skill of card.Skills ?? []) {
          if (n(skill.PossessionType) === POSSESSION.Photo) photoIndex += 1;
        }
        card.Skills = [
          ...(card.Skills ?? []),
          {
            Index: photoIndex,
            SkillId: s(definition.SkillId),
            SkillLevel: bonus.Amount,
            PossessionType: POSSESSION.Photo,
          },
        ];
      } else if (
        typ === PhotoAbilityType.ReceivedStrengthEffectValueIncrease ||
        typ === PhotoAbilityType.ReceivedStrengthEffectCountIncrease ||
        typ === PhotoAbilityType.AffectStrengthEffectValueIncrease ||
        typ === PhotoAbilityType.AffectStrengthEffectCountIncrease
      ) {
        if (bonus.Amount > MAX_INT32 || n(definition.StatusEffectType) === StatusEffectType.Unknown) {
          failed('invalid status-restricted photo modifier');
        }
        data.StrengthModifiers.push({
          Type: typ,
          StatusTypes: [n(definition.StatusEffectType)],
          Amount: bonus.Amount,
        });
      } else {
        if (!preparedPhotoBonusType(typ)) failed(`photo ability ${typ} is unsupported`);
        addLiveBonus(data.Bonuses, typ, bonus.Amount);
      }
    }
  }
}

/** Port of Solis `prepareNativeSkills`. */
export async function prepareNativeSkills(
  card: LiveDeckCard,
  master: CardRow,
  ids: readonly string[],
  levels: readonly number[],
): Promise<void> {
  const release = await cardReleaseForCard(
    master as unknown as Decoded,
    n(card.Level),
    n(card.EvolutionLevel),
  );
  const unlocked = new Set(release.skillSlots);
  const masterIDs = [s(master.SkillId1), s(master.SkillId2), s(master.SkillId3), s(master.SkillId4)];
  const native: LiveDeckCardSkill[] = [];
  for (let i = 0; i < ids.length; i++) {
    let id = ids[i];
    if (id === '') id = masterIDs[i];
    if (!unlocked.has(i + 1) || id === '') continue;
    const level = levels[i];
    if (level === 0) failed('learned native skill has an invalid level');
    native.push({ Index: i + 1, SkillId: id, SkillLevel: level, PossessionType: POSSESSION.Card });
  }
  card.Skills = [...native, ...(card.Skills ?? [])];
}

/** Port of Solis `prepareNPCAppearance`: NPC defaults ignore user preference. */
export async function prepareNPCAppearance(card: LiveDeckCard, master: CharacterRow): Promise<void> {
  const costumeID = s(master.DefaultCostumeId);
  const costume = await getCostume(costumeID);
  if (costume === null) failed('NPC live costume is missing from master');
  if (s(costume.CharacterId) !== s(master.Id) || s(costume.CostumeTypeId).startsWith('sd-')) {
    failed('invalid live costume');
  }
  const hairID = s(costume.DefaultHairId);
  const hair = await getHair(hairID);
  if (hair === null) failed('NPC live hair is missing from master');
  const notWearable = toArray(hair.NotWearableCostumeIds);
  const wearable = toArray(hair.WearableCostumeIds);
  if (
    s(hair.CharacterId) !== s(master.Id) ||
    notWearable.includes(costumeID) ||
    (wearable.length > 0 && !wearable.includes(costumeID))
  ) {
    failed('invalid live hair');
  }
  card.DisplayCharacterId = s(master.Id);
  card.DisplayCostumeId = costumeID;
  card.DisplayHairId = hairID;
}

/** Port of Solis `prepareNPC`. */
export async function prepareNPC(
  input: Input,
  roster: QuestOpponentInfo,
  masters: Map<string, CardRow>,
  characters: Map<string, CharacterRow>,
): Promise<void> {
  let bonus: ReturnType<typeof NPCBalance>;
  try {
    bonus = NPCBalance(input.Quest, input.Setting);
  } catch (error) {
    failed((error as Error).message);
  }
  const side: LiveUserInfo = {
    Index: 2,
    IsNpc: true,
    Name: s(roster.Name),
    UserDeck: { DeckName: '', Cards: [], BonusSkills: [] },
  };
  const infos = [...(roster.CardInfos ?? [])].sort((a, b) => n(a.Position) - n(b.Position));
  for (const info of infos) {
    const master = masters.get(s(info.CardId));
    if (master === undefined) failed('NPC card master missing');
    if (n(info.EvolutionLevel) !== 0) failed('NPC evolution preparation is not supported');
    const parameter = await getCardParameter(s(master.CardParameterId), n(info.Level));
    if (parameter === null) failed('NPC card parameter is missing from master');
    const rarity = await getCardRarity(n(info.Rarity));
    if (rarity === null) failed('NPC card rarity is missing from master');
    const ratioBonus = n(rarity.ParameterBonusPermil);
    const base = {
      Vocal: calcAttr(n(parameter.Value), n(master.VocalRatioPermil), ratioBonus),
      Dance: calcAttr(n(parameter.Value), n(master.DanceRatioPermil), ratioBonus),
      Visual: calcAttr(n(parameter.Value), n(master.VisualRatioPermil), ratioBonus),
      Stamina: calcAttr(n(parameter.StaminaValue), n(master.StaminaRatioPermil), ratioBonus),
    };
    for (const value of [base.Vocal, base.Dance, base.Visual]) {
      if (value > Number.MAX_SAFE_INTEGER - bonus.Primary) failed('NPC stat overflows');
    }
    if (base.Stamina > Number.MAX_SAFE_INTEGER - bonus.Stamina) failed('NPC stamina overflows');
    const card: LiveDeckCard = {
      Index: 5 + n(info.Position),
      CardId: s(info.CardId),
      Level: n(info.Level),
      Rarity: n(info.Rarity),
      Vocal: base.Vocal + bonus.Primary,
      Dance: base.Dance + bonus.Primary,
      Visual: base.Visual + bonus.Primary,
      Stamina: base.Stamina + bonus.Stamina,
      Mental: bonus.Mental,
      Technique: bonus.Technique,
      Skills: [],
    };
    card.StartStamina = card.Stamina;
    await prepareNativeSkills(
      card,
      master,
      [s(master.SkillId1), s(master.SkillId2), s(master.SkillId3), s(master.SkillId4)],
      [-1, -1, -1, -1],
    );
    const character = characters.get(s(master.CharacterId));
    if (character === undefined) failed('NPC character missing');
    await prepareNPCAppearance(card, character);
    input.Cards.set(n(card.Index), {
      CharacterID: s(master.CharacterId),
      GroupID: s(character.CharacterGroupId),
      Type: n(master.Type),
      Attribute: liveCardAttribute(master),
      LightFans: n(info.LightFanAmount),
      MiddleFans: n(info.MiddleFanAmount),
      HeavyFans: n(info.HeavyFanAmount),
      Bonuses: new Map(),
      StrengthModifiers: [],
      CharacterAdvantagePermil: 0,
    });
    side.UserDeck?.Cards?.push(card);
  }
  input.Users.push(side);
}

/** Port of Solis `prepareNPC`'s primary stat helper (`calcAttr`, card/calc.go). */
function calcAttr(param: number, ratio: number, bonus: number): number {
  return Math.trunc(Math.trunc((param * ratio) / 1000) * bonus / 1000);
}

/** Port of Solis `PrepareLiveQuestBonus`. */
export async function prepareLiveQuestBonus(input: Input, exec: Executor = db): Promise<void> {
  const groupID = s(input.Quest.LiveBonusGroupId);
  if (groupID === '') return;
  const group = await getLiveBonusGroup(groupID);
  if (group === null) failed('live bonus group is missing from master');
  const groupIDs = toArray(group.LiveBonusIds);
  const bonuses = await listLiveBonuses(groupIDs);
  if (bonuses.length !== groupIDs.length) failed('live bonus group is incomplete');
  const byID = asMap(bonuses, (row) => s(row.Id));
  const abilityIDs = new Set<string>();
  for (const bonus of bonuses) abilityIDs.add(s(bonus.LiveAbilityId));
  const byAbility = asMap(await listLiveAbilities(liveStringKeys(abilityIDs)), (row) => s(row.Id));
  for (let i = 0; i < groupIDs.length; i++) {
    const bonus = byID.get(groupIDs[i]);
    if (bonus === undefined) failed('live bonus group is incomplete');
    const master = byAbility.get(s(bonus.LiveAbilityId));
    if (master === undefined) failed('quest live bonus ability is missing from master');
    const level = ((master.Levels as Decoded[] | null) ?? []).find(
      (candidate) => n(candidate.Level) === n(bonus.LiveAbilityLevel),
    );
    if (level === undefined) failed('quest live bonus level missing');
    if (n(level.Type) !== LIVE_ABILITY.PassiveSkill) failed('non-passive quest bonus is not yet supported');
    for (const user of input.Users) {
      const skills = user.UserDeck?.BonusSkills ?? [];
      user.UserDeck!.BonusSkills = [
        ...skills,
        {
          Index: 3001 + i,
          SkillId: s(level.SkillId),
          SkillLevel: n(level.Value),
          PossessionType: POSSESSION.Quest,
          LiveAbilityId: s(bonus.LiveAbilityId),
          LiveAbilityLevel: n(bonus.LiveAbilityLevel),
        },
      ];
    }
  }
}

/** Port of Solis `ResolveLiveSkills`. */
export async function resolveLiveSkills(input: Input, exec: Executor = db): Promise<void> {
  const ids = new Set<string>();
  for (const user of input.Users) {
    for (const card of user.UserDeck?.Cards ?? []) {
      for (const skill of card.Skills ?? []) ids.add(s(skill.SkillId));
    }
    for (const skill of user.UserDeck?.BonusSkills ?? []) ids.add(s(skill.SkillId));
  }
  const skills = await listSkills(liveStringKeys(ids));
  for (const skill of skills) input.Skills.set(s(skill.Id), skill as unknown as Skill);
  if (skills.length !== ids.size) failed('live references missing skill definitions');

  const efficacyIDs = new Set<string>();
  const triggerIDs = new Set<string>();
  const targetIDs = new Set<string>();
  const collect = (ref: LiveDeckCardSkill, cardLevel: number): void => {
    const definition = input.Skills.get(s(ref.SkillId));
    if (definition === undefined) failed('live references missing skill definitions');
    const levels = definition.Levels ?? [];
    if (n(ref.SkillLevel) < 0) {
      ref.SkillLevel = 0;
      for (const level of levels) {
        if (n(level.RequiredCardLevel) <= cardLevel) {
          ref.SkillLevel = Math.max(n(ref.SkillLevel), n(level.Level));
        }
      }
    }
    const level = levels.find((candidate) => n(candidate.Level) === n(ref.SkillLevel));
    if (level === undefined) failed(`invalid skill level for "${s(ref.SkillId)}"`);
    if (n(ref.PossessionType) === POSSESSION.Card && n(level.RequiredCardLevel) > cardLevel) {
      failed("native skill level exceeds the card's effective level");
    }
    triggerIDs.add(s(level.TriggerId));
    for (const detail of level.SkillDetails ?? []) {
      efficacyIDs.add(s(detail.EfficacyId));
      triggerIDs.add(s(detail.TriggerId));
    }
    for (const id of ref.RewrittenEfficacyIds ?? []) efficacyIDs.add(s(id));
  };
  for (const user of input.Users) {
    for (const card of user.UserDeck?.Cards ?? []) {
      for (const skill of card.Skills ?? []) {
        collect(skill, n(card.Level));
        const row = card as Record<string, unknown>;
        switch (n(skill.Index)) {
          case 1:
            row.SkillLevel1 = n(skill.SkillLevel);
            break;
          case 2:
            row.SkillLevel2 = n(skill.SkillLevel);
            break;
          case 3:
            row.SkillLevel3 = n(skill.SkillLevel);
            break;
          case 4:
            row.SkillLevel4 = n(skill.SkillLevel);
            break;
        }
      }
    }
    for (const skill of user.UserDeck?.BonusSkills ?? []) collect(skill, MAX_INT32);
  }

  const efficacies = await listSkillEfficacies(liveStringKeys(efficacyIDs));
  for (const efficacy of efficacies) {
    input.Efficacies.set(s(efficacy.Id), efficacy as unknown as SkillEfficacy);
    targetIDs.add(s(efficacy.SkillTargetId));
    // Conditional score encodes an additional trigger inside the efficacy ID
    // rather than SkillLevel/SkillDetail. Resolve it before entering the engine.
    const id = s(efficacy.Id);
    if (id.startsWith('ef-score_get_by_trigger-')) {
      const parts = id.replace(/^ef-/, '').split('-');
      if (parts.length >= 6) triggerIDs.add(parts.slice(2, parts.length - 2).join('-'));
    }
  }
  if (efficacies.length !== liveStringKeys(efficacyIDs).length) {
    failed('live efficacy definition is missing');
  }
  for (const efficacy of efficacies) {
    const conversion = conversionStatusEfficacyType(efficacy as unknown as SkillEfficacy);
    if (conversion.error !== undefined) failed(conversion.error.message);
    if (!conversion.matched) continue;
    const found = [...input.Efficacies.values()].some((candidate) => n(candidate.Type) === conversion.typ);
    if (found) continue;
    const id = s(efficacy.Id);
    const name = id.slice(id.lastIndexOf('-') + 1);
    const definition = await findLiveStatusEfficacy(name);
    if (definition === null) failed('conversion destination master is missing');
    if (n(definition.Type) !== conversion.typ) failed('conversion destination master mismatch');
    input.Efficacies.set(s(definition.Id), definition as unknown as SkillEfficacy);
  }
  const triggers = await listSkillTriggers(liveStringKeys(triggerIDs));
  for (const trigger of triggers) input.Triggers.set(s(trigger.Id), trigger as unknown as SkillTrigger);
  if (triggers.length !== liveStringKeys(triggerIDs).length) failed('live trigger definition is missing');
  const targets = await listSkillTargets(liveStringKeys(targetIDs));
  for (const target of targets) input.Targets.set(s(target.Id), target as unknown as SkillTarget);
  if (targets.length !== liveStringKeys(targetIDs).length) failed('live target definition is missing');
}

/** The public id Solis reads from `UserPublic`; sumire keeps it on the player row. */
async function playerPublicUserId(playerId: string, exec: Executor): Promise<string> {
  const [row] = await exec
    .select({ data: players.data })
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1);
  const data = row?.data as { publicUserId?: string } | null | undefined;
  return data?.publicUserId ?? playerId;
}

/**
 * Port of Solis `PrepareLiveInput`: resolve every user/master reference for one
 * live inside the caller's snapshot transaction. Performs no writes.
 */
export async function prepareLiveInput(
  playerId: string,
  req: Decoded,
  q: Quest,
  seed: bigint,
  formation: LiveFormation | null,
  exec: Executor = db,
): Promise<Input> {
  if (q === null || req === null || n(req.DeckNumber) <= 0) {
    throw new LivePreconditionError('a quest and saved deck are required');
  }
  if (toArray(req.UserBuddyDeckPositions).length > 0) {
    failed('friend buddy live units are not supported');
  }
  const { input, music } = await newLiveInput(q, seed, exec);
  const setting = input.Setting;
  if (formation === null) throw new LivePreconditionError('live formation is required');
  const deck = { Number: n(req.DeckNumber), Name: formation.Name };
  const positions = [...formation.Positions];
  if (positions.length !== 5) failed('a live unit requires five occupied positions');
  positions.sort((a, b) => n(a.Position) - n(b.Position));
  const owned = await listElements(playerId, 'Cards', exec);
  const ownedByID = asMap(owned, (row) => s(row.CardId));
  const cardIDs = new Set<string>();
  for (const position of positions) cardIDs.add(s(position.CardId));
  let npc: QuestOpponentInfo | null = null;
  if (n(q.ClearScore) === 0) {
    try {
      npc = NPCRoster(s(q.Id)) as unknown as QuestOpponentInfo;
    } catch (error) {
      failed((error as Error).message);
    }
    for (const info of npc!.CardInfos ?? []) cardIDs.add(s(info.CardId));
  }
  const masters = await listCardsByIds(liveStringKeys(cardIDs));
  const byCard = asMap(masters, (row) => s(row.Id));
  const characters = await listElements(playerId, 'Characters', exec);
  const byCharacter = asMap(characters, (row) => s(row.CharacterId));
  const byMasterCharacter = asMap((await listCharacters()) as CharacterRow[], (row) => s(row.Id));
  // not ported: sumire-sr has no UserStaff collection or StaffLevel master, so
  // Solis' staff parameter bonus contributes nothing.
  // not ported: sumire-sr has no CompanyEnjoyCharacterLevel master table (bond
  // levels are derived in services/company.ts), so no company ratio bonus.
  const { bonuses: global, passives: globalPassives, equipment: equipmentBoost } =
    await prepareOwnedLiveAbilities(owned, q, exec);
  const userRow = (await getSingleton(playerId, 'User', exec)) ?? ({} as Decoded);
  const self: LiveUserInfo = {
    Index: 1,
    UserId: await playerPublicUserId(playerId, exec),
    Name: s(userRow.Name),
    EmblemId: s(userRow.EmblemId),
    UserDeck: { DeckName: deck.Name, Cards: [], BonusSkills: [] },
  };
  input.Users.push(self);
  const seenCards = new Set<string>();
  const seenPhotos = new Set<string>();
  const photoBonuses: PreparedPhotoBonus[] = [];
  const accessoryCounts = new Map<string, number>();
  const originalIDs = positions.map((position) => s(byCard.get(s(position.CardId))?.CharacterId));
  const appearances = await liveDeckCharacterAssets(positions, originalIDs, characters, byMasterCharacter, exec);
  const extra = await prepareExtraLiveAppearances(playerId, music, characters, byMasterCharacter, appearances, exec);
  self.UserDeck!.ExtraCharacterInfos = extra as Array<Record<string, unknown>>;
  const ownedCostumes = new Set((await listElements(playerId, 'Costumes', exec)).map((row) => s(row.CostumeId)));
  const ownedHairs = new Set((await listElements(playerId, 'Hairs', exec)).map((row) => s(row.HairId)));
  const ownedAccessories = asMap(await listElements(playerId, 'Accessories', exec), (row) => s(row.AccessoryId));
  for (let i = 0; i < positions.length; i++) {
    const position = positions[i];
    if (n(position.Position) !== i + 1 || seenCards.has(s(position.CardId))) {
      throw new LivePreconditionError('live positions 1..5 and cards must be unique');
    }
    seenCards.add(s(position.CardId));
    const ownedCard = ownedByID.get(s(position.CardId));
    const master = byCard.get(s(position.CardId));
    if (ownedCard === undefined || master === undefined) {
      failed(`live card "${s(position.CardId)}" is not owned or not in master`);
    }
    const userCharacter = byCharacter.get(s(master.CharacterId));
    const masterCharacter = byMasterCharacter.get(s(master.CharacterId));
    if (userCharacter === undefined || masterCharacter === undefined) failed('live character is missing');
    const card: LiveDeckCard = {
      Index: i + 1,
      CardId: s(ownedCard.CardId),
      Level: n(ownedCard.Level),
      Rarity: n(ownedCard.Rarity),
      EvolutionLevel: n(ownedCard.EvolutionLevel),
      Vocal: n(ownedCard.Vocal),
      Dance: n(ownedCard.Dance),
      Visual: n(ownedCard.Visual),
      Stamina: n(ownedCard.Stamina),
      Mental: n(setting.CardDefaultMental),
      Technique: n(setting.CardDefaultTechnique),
      Skills: [],
    };
    if (n(card.Level) <= 0) failed('live card has no effective level');
    const bonuses = new Map<number, number>(global);
    await prepareLiveEquipment(
      playerId,
      q,
      position,
      ownedCard,
      masterCharacter,
      n(master.Type),
      card,
      bonuses,
      equipmentBoost,
      photoBonuses,
      seenPhotos,
      accessoryCounts,
      exec,
    );
    await prepareNativeSkills(
      card,
      master,
      [s(ownedCard.SkillId1), s(ownedCard.SkillId2), s(ownedCard.SkillId3), s(ownedCard.SkillId4)],
      [n(ownedCard.SkillLevel1), n(ownedCard.SkillLevel2), n(ownedCard.SkillLevel3), n(ownedCard.SkillLevel4)],
    );
    globalPassives.forEach((ref, j) => {
      card.Skills!.push({
        Index: 2001 + j,
        SkillId: s(ref.SkillId),
        SkillLevel: n(ref.SkillLevel),
        PossessionType: POSSESSION.Ability,
        LiveAbilityId: s(ref.LiveAbilityId),
        LiveAbilityLevel: n(ref.LiveAbilityLevel),
      });
    });
    const appearance = appearances[i];
    if (appearance === undefined) failed('live appearance is missing');
    // Prefetch is a projection; Start additionally validates ownership of the
    // exact chosen outfit/hair, including a substituted idol's live settings.
    if (!ownedCostumes.has(s(appearance.CostumeId))) failed('live costume is not owned');
    if (!ownedHairs.has(s(appearance.HairId))) failed('live hair is not owned');
    card.DisplayCharacterId = s(appearance.CharacterId);
    card.DisplayCostumeId = s(appearance.CostumeId);
    card.DisplayHairId = s(appearance.HairId);
    input.Cards.set(i + 1, {
      CharacterID: s(masterCharacter.Id),
      GroupID: s(masterCharacter.CharacterGroupId),
      Type: n(master.Type),
      Attribute: liveCardAttribute(master),
      LightFans: n(userCharacter.LightFanAmount),
      MiddleFans: n(userCharacter.MiddleFanAmount),
      HeavyFans: n(userCharacter.HeavyFanAmount),
      Bonuses: bonuses,
      StrengthModifiers: [],
      CharacterAdvantagePermil: 0,
    });
    self.UserDeck!.Cards!.push(card);
  }
  await applyPreparedPhotoBonuses(input, self, photoBonuses, exec);
  let characterAdvantage: Parameters<typeof ResolveCharacterAdvantage>[1] = null;
  const advantageID = s(q.QuestCharacterAdvantageId);
  if (advantageID !== '') {
    characterAdvantage = (await getQuestCharacterAdvantage(
      advantageID,
    )) as unknown as Parameters<typeof ResolveCharacterAdvantage>[1];
  }
  for (const card of self.UserDeck!.Cards ?? []) {
    const data = input.Cards.get(n(card.Index));
    if (data === undefined) failed('live card is missing from the unit');
    applyLiveCardStats(card, data.Bonuses);
    card.StartStamina = card.Stamina;
  }
  for (const [id, count] of accessoryCounts) {
    const ownedAccessory = ownedAccessories.get(id);
    if (ownedAccessory === undefined) failed('accessory is not owned');
    if (n(ownedAccessory.Amount) < count) failed('insufficient accessory copies');
  }
  if (npc !== null) await prepareNPC(input, npc, byCard, byMasterCharacter);
  for (const [index, data] of input.Cards) {
    data.CharacterAdvantagePermil = ResolveCharacterAdvantage(data, characterAdvantage);
    input.Cards.set(index, data);
  }
  await prepareLiveQuestBonus(input, exec);
  await resolveLiveSkills(input, exec);
  const actors: CardData[] = [];
  const deckCards: LiveDeckCard[] = [];
  for (const side of input.Users) {
    for (const card of side.UserDeck?.Cards ?? []) {
      const data = input.Cards.get(n(card.Index));
      if (data === undefined) failed('live card is missing from the unit');
      actors.push(data);
      deckCards.push(card);
    }
  }
  const audiences = AllocateAudience(actors, n(q.MaxCapacity), setting);
  for (let i = 0; i < deckCards.length; i++) deckCards[i].AudienceAmount = audiences[i];
  return input;
}
