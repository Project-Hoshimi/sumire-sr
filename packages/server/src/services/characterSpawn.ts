import { db } from '../db/client.ts';
import { type Executor } from '../db/tx.ts';
import { getCharacter, getCharacterActivityLevel, getCostume, getHair } from '../master/index.ts';
import { listElements, putElements } from './playerState.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Card -> idol ownership repair.
 *
 * Port of Solis `viber.ensureGachaCharacter` / `ensureGachaCostume` /
 * `ensureGachaHair` and `usercharacter.SpawnUserCharacter`. Granting a card
 * whose idol the player has no `UserCharacter` for (e.g. a story/quest card
 * outside the gacha pools) used to leave the account without the idol, which
 * later failed `Quest:ListAsset` with "not enough owned idols for the live
 * appearance". Obtaining the card now also spawns the idol plus the outfits and
 * hairstyles its master row defaults to.
 */

const CHARACTERS = 'Characters';
const COSTUMES = 'Costumes';
const HAIRS = 'Hairs';

const USER_CHARACTER_MSG = 'Solis.Common.Proto.Transaction.UserCharacter';
const USER_COSTUME_MSG = 'Solis.Common.Proto.Transaction.UserCostume';
const USER_HAIR_MSG = 'Solis.Common.Proto.Transaction.UserHair';
const COMPANY_BONUS_MSG = 'Solis.Common.Proto.Transaction.CompanyBonusParameterInfo';
const REWARD_RESULT_MSG = 'Solis.Common.Proto.Transaction.RewardResult';

/** `Solis.Common.Proto.ResourceType` values this module can grant. */
const RES_CHARACTER = 4;
const RES_COSTUME = 5;
const RES_HAIR = 28;

/**
 * `Solis.Common.Proto.ParameterType` Dance/Vocal/Visual/Stamina/Mental/Technique.
 * A spawned idol starts with the same zeroed company bonus table as Solis.
 */
const BONUS_PARAMETER_TYPES = [1, 2, 3, 4, 5, 6];

/** Collections spawned alongside a card, plus their `RewardResult` rows. */
export type SpawnedCharacterGrant = {
  characters: Decoded[];
  costumes: Decoded[];
  hairs: Decoded[];
  results: Decoded[];
};

function emptyGrant(): SpawnedCharacterGrant {
  return { characters: [], costumes: [], hairs: [], results: [] };
}

/** Mirrors Solis `gachaRewardResult`: a freshly unlocked resource is `IsNew`. */
function rewardResult(resourceType: number, resourceId: string, before: number, after: number): Decoded {
  return {
    __msg: REWARD_RESULT_MSG,
    ResourceType: resourceType,
    ...(resourceId ? { ResourceId: resourceId } : {}),
    BeforeAmount: before,
    AfterAmount: after,
    AmountI64: 1,
    IsNew: before === 0 && after > 0,
  } as Decoded;
}

/**
 * Port of Solis `usercharacter.SpawnUserCharacter`: build a level-1
 * `UserCharacter` from the master `Character` row. Returns null when the master
 * row is missing. Zero/false/empty fields are omitted (protobuf defaults).
 */
export async function spawnUserCharacter(characterId: string): Promise<Decoded | null> {
  const master = await getCharacter(characterId);
  if (!master) return null;
  const activityLevel = await getCharacterActivityLevel(1);
  return {
    __msg: USER_CHARACTER_MSG,
    CharacterId: characterId,
    ActivityStamina: Number(activityLevel?.MaxStamina ?? 0),
    FavoriteCostumeId: master.DefaultCostumeId == null ? '' : String(master.DefaultCostumeId),
    LiveCostumeId: master.DefaultLiveCostumeId == null ? '' : String(master.DefaultLiveCostumeId),
    StaminaUpdatedTime: Date.now(),
    ActivityLevel: 1,
    AudienceCandidateAmount: 10,
    CompanyBonusParameterInfos: BONUS_PARAMETER_TYPES.map((type) => ({
      __msg: COMPANY_BONUS_MSG,
      BonusParameterType: type,
      BonusParameterUpPermil: 0,
    })),
  } as Decoded;
}

function ownsElement(elements: Decoded[], key: string, id: string): boolean {
  return elements.some((el) => String(el[key] ?? '') === id);
}

/**
 * Port of Solis `ensureGachaCharacter`: make sure the player owns the idol tied
 * to a card, plus that idol's default costumes and their default hairstyles.
 * No-op (empty arrays) when the character is already owned.
 */
export async function ensureCardCharacter(
  playerId: string,
  characterId: string,
  exec: Executor = db,
): Promise<SpawnedCharacterGrant> {
  if (!characterId) return emptyGrant();

  const ownedCharacters = await listElements(playerId, CHARACTERS, exec);
  if (ownsElement(ownedCharacters, 'CharacterId', characterId)) return emptyGrant();

  const character = await spawnUserCharacter(characterId);
  if (!character) return emptyGrant();
  await putElements(playerId, CHARACTERS, [character], exec);

  const granted = emptyGrant();
  granted.characters.push(character);
  granted.results.push(rewardResult(RES_CHARACTER, characterId, 0, 1));

  const master = await getCharacter(characterId);
  const seenCostumes = new Set<string>();
  for (const rawCostumeId of [master?.DefaultCostumeId, master?.DefaultLiveCostumeId]) {
    const costumeId = rawCostumeId == null ? '' : String(rawCostumeId);
    if (!costumeId || seenCostumes.has(costumeId)) continue;
    seenCostumes.add(costumeId);

    const ownedCostumes = await listElements(playerId, COSTUMES, exec);
    if (ownsElement(ownedCostumes, 'CostumeId', costumeId)) continue;
    const costume = {
      __msg: USER_COSTUME_MSG,
      CostumeId: costumeId,
      Checked: true,
      ObtainedTime: Date.now(),
    } as Decoded;
    await putElements(playerId, COSTUMES, [costume], exec);
    granted.costumes.push(costume);
    granted.results.push(rewardResult(RES_COSTUME, costumeId, 0, 1));

    const masterCostume = await getCostume(costumeId);
    const hairId = masterCostume?.DefaultHairId == null ? '' : String(masterCostume.DefaultHairId);
    if (!hairId) continue;
    const ownedHairs = await listElements(playerId, HAIRS, exec);
    if (ownsElement(ownedHairs, 'HairId', hairId)) continue;
    // A successful master lookup protects player data from catalog typos.
    if (!(await getHair(hairId))) continue;
    const hair = { __msg: USER_HAIR_MSG, HairId: hairId, Checked: true } as Decoded;
    await putElements(playerId, HAIRS, [hair], exec);
    granted.hairs.push(hair);
    granted.results.push(rewardResult(RES_HAIR, hairId, 0, 1));
  }

  return granted;
}
