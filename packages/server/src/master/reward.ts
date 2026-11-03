import { enumValues } from '@sumire-sr/protocol/gen/enums.ts';
import { db } from '../db/client.ts';
import { type Executor } from '../db/tx.ts';
import { getReward, getPhotoAllInOne } from '../master/index.ts';
import { getCard, getItemAmount, grantCard, grantItem } from '../services/inventory.ts';
import { applyCardBloomPt } from '../services/cardBloom.ts';
import { getCurrency, grantCurrency, type Currency } from '../services/currency.ts';
import { listElements, putElements } from '../services/playerState.ts';
import { players } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Reward resolver.
 *
 * Reward references appear in master data in two forms:
 *  - inline `rd_auto;<resourceTypeName>;<resourceId>;<amount>`
 *    e.g. `rd_auto;item;item-gacha_ticket;1`, `rd_auto;stone;;100`
 *  - a `Reward` master row id, e.g. `rd_backside-21-0831-mission-clear_count`,
 *    whose `Resources[]` list concrete grants.
 *
 * `applyRewardRefs` resolves references to concrete grants and applies them to
 * the player inside the caller's transaction, returning the `UpdatedData` slice
 * and the `RewardResult[]` the client expects.
 */

const RES_TYPE_MSG = 'Solis.Common.Proto.ResourceType';
const UPDATED_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const REWARD_RESULT_MSG = 'Solis.Common.Proto.Transaction.RewardResult';
const USER_ITEM_MSG = 'Solis.Common.Proto.Transaction.UserItem';
const USER_POINT_MSG = 'Solis.Common.Proto.Transaction.UserPoint';
const USER_BALANCE_MSG = 'Solis.Common.Proto.Transaction.UserBalance';
const USER_PHOTO_MSG = 'Solis.Common.Proto.Transaction.UserPhoto';
const USER_PHOTO_ABILITY_MSG = 'Solis.Common.Proto.Transaction.UserPhotoAbility';

// ResourceType 25 (`CardRarityExpLimitChange`) is a per-card 才能開花Pt with
// real card semantics (auto-bloom, ★10 overflow → Bloom Pieces); the
// implementation lives in `src/services/cardBloom.ts`.

/**
 * Resource types that are "own/unlock" entries in a `User:Get` collection:
 * granting one ensures an element keyed by the resource id exists. Amount is
 * ignored (the collections carry no count).
 */
const COLLECTION_GRANTS: Record<number, { field: string; key: string; msg: string }> = {
  3: { field: 'Accessories', key: 'AccessoryId', msg: 'Solis.Common.Proto.Transaction.UserAccessory' },
  4: { field: 'Characters', key: 'CharacterId', msg: 'Solis.Common.Proto.Transaction.UserCharacter' },
  5: { field: 'Costumes', key: 'CostumeId', msg: 'Solis.Common.Proto.Transaction.UserCostume' },
  17: { field: 'Emblems', key: 'EmblemId', msg: 'Solis.Common.Proto.Transaction.UserEmblem' },
  26: { field: 'Decorations', key: 'DecorationId', msg: 'Solis.Common.Proto.Transaction.UserDecoration' },
  27: { field: 'PhotoRecipes', key: 'PhotoRecipeId', msg: 'Solis.Common.Proto.Transaction.UserPhotoRecipe' },
  28: { field: 'Hairs', key: 'HairId', msg: 'Solis.Common.Proto.Transaction.UserHair' },
  34: { field: 'PhotoPoses', key: 'PhotoPoseId', msg: 'Solis.Common.Proto.Transaction.UserPhotoPose' },
};

const NAME_TO_VALUE: Record<string, number> = {};
for (const [value, name] of Object.entries(enumValues[RES_TYPE_MSG] ?? {})) {
  NAME_TO_VALUE[toSnake(name)] = Number(value);
}

function toSnake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/^_/, '')
    .toLowerCase();
}

export const ResourceTypeValue = NAME_TO_VALUE;

export type Grant = { resourceType: number; resourceId: string; amount: number };

export type ApplyResult = {
  updated: Decoded | null;
  results: Decoded[];
  grants: Grant[];
};

/** Parse a single reward reference into concrete grants (no DB for inline). */
export async function parseRewardRef(ref: string): Promise<Grant[]> {
  if (!ref) return [];
  if (ref.startsWith('rd_auto;')) {
    const [, typeName, resourceId = '', amountRaw = '1'] = ref.split(';');
    const resourceType = NAME_TO_VALUE[typeName];
    if (!resourceType) return [];
    return [{ resourceType, resourceId, amount: Number(amountRaw) || 0 }];
  }
  const reward = await getReward(ref);
  const resources = (reward?.Resources as Decoded[] | null) ?? [];
  const out: Grant[] = [];
  for (const r of resources) {
    const resourceType = Number(r.ResourceType ?? 0);
    const resourceId = r.ResourceId == null ? '' : String(r.ResourceId);
    const amount = Number(r.Amount ?? 0);
    if (resourceType === 999) {
      // `Set` points at another Reward row; flatten one level (guard against loops).
      if (resourceId && resourceId !== ref) out.push(...(await parseRewardRef(resourceId)));
      continue;
    }
    if (resourceType) out.push({ resourceType, resourceId, amount });
  }
  return out;
}

export async function resolveRewardRefs(refs: string[]): Promise<Grant[]> {
  const out: Grant[] = [];
  for (const ref of refs) out.push(...(await parseRewardRef(ref)));
  return out;
}

async function readPlayer(playerId: string, exec: Executor) {
  const [row] = await exec.select().from(players).where(eq(players.id, playerId)).limit(1);
  return row ?? null;
}

/**
 * Apply concrete grants to the player and build the matching `UpdatedData`
 * fragment plus `RewardResult` list. Unknown resource types are skipped (never
 * throw) so a single unsupported reward cannot fail the whole claim.
 */
export async function applyGrants(
  playerId: string,
  grants: Grant[],
  exec: Executor = db,
): Promise<ApplyResult> {
  const items: Decoded[] = [];
  const points: Decoded[] = [];
  const results: Decoded[] = [];
  const collections = new Map<string, Decoded[]>();
  const cards: Decoded[] = [];
  const photos: Decoded[] = [];
  let balance: Decoded | null = null;

  for (const g of grants) {
    const coll = COLLECTION_GRANTS[g.resourceType];
    if (coll) {
      const existing = await listElements(playerId, coll.field, exec);
      const found = existing.find((e) => String(e[coll.key]) === g.resourceId);
      if (!found) {
        const element = { __msg: coll.msg, [coll.key]: g.resourceId } as Decoded;
        await putElements(playerId, coll.field, [element], exec);
        const list = collections.get(coll.field) ?? [];
        list.push(element);
        collections.set(coll.field, list);
      }
      results.push({ ...result(g, found ? 1 : 0, 1), IsNew: found ? false : true } as Decoded);
      continue;
    }
    switch (g.resourceType) {
      case 1: {
        const b = await getItemAmount(playerId, g.resourceId, exec);
        await grantItem(playerId, g.resourceId, g.amount, exec);
        const after = b + g.amount;
        items.push({ __msg: USER_ITEM_MSG, ItemId: g.resourceId, Amount: after } as Decoded);
        results.push(result(g, b, after));
        break;
      }
      case 8: {
        const b = await getCurrency(playerId, 'gold', exec);
        await grantCurrency(playerId, 'gold', g.amount, exec);
        points.push({ __msg: USER_POINT_MSG, PointType: 1, Amount: b + g.amount } as Decoded);
        results.push(result(g, b, b + g.amount));
        break;
      }
      case 15:
      case 16: {
        const type: Currency = g.resourceType === 15 ? 'freeJewel' : 'paidJewel';
        const b = await getCurrency(playerId, type, exec);
        await grantCurrency(playerId, type, g.amount, exec);
        const row = await readPlayer(playerId, exec);
        balance = {
          __msg: USER_BALANCE_MSG,
          FreeBalance: Number(row?.freeJewel ?? 0),
          PaidBalance: Number(row?.paidJewel ?? 0),
        } as Decoded;
        results.push(result(g, b, b + g.amount));
        break;
      }
      case 14: {
        const row = await readPlayer(playerId, exec);
        const b = Number(row?.exp ?? 0);
        await exec
          .update(players)
          .set({ exp: b + g.amount })
          .where(eq(players.id, playerId));
        results.push(result(g, b, b + g.amount));
        break;
      }
      case 2: {
        const existing = await getCard(playerId, g.resourceId, exec);
        await grantCard(playerId, { CardId: g.resourceId } as Decoded, exec);
        // Surface the card in UpdatedData so result screens can resolve the
        // obtained card (a missing entry makes GachaResultScreenModel NRE).
        const granted = await getCard(playerId, g.resourceId, exec);
        if (granted) cards.push(granted);
        results.push({
          ...result(g, existing ? 1 : 0, existing ? 1 : 1),
          IsNew: existing ? false : true,
        } as Decoded);
        break;
      }
      case 25: {
        const bloom = await applyCardBloomPt(playerId, g.resourceId, g.amount, exec);
        for (const r of bloom.results) results.push(r);
        for (const it of bloom.items) items.push(it);
        if (bloom.card) cards.push(bloom.card);
        break;
      }
      case 7: {
        // PhotoAllInOne: mint a photo from the master template into the
        // player's Photos collection (grant the template, ignore amount).
        const template = await getPhotoAllInOne(g.resourceId);
        if (!template) {
          // Unknown template: record the intent but do not mutate state.
          break;
        }
        const photo: Decoded = {
          __msg: USER_PHOTO_MSG,
          PhotoId: randomUUID(),
          AssetId: template.AssetId ?? template.Id,
          ImageType: 2,
          CharacterIds: [],
          Name: template.Name ?? '',
          Rarity: Number(template.Rarity ?? 1),
          PlaceName: template.PlaceName ?? '',
          EventName: template.EventName ?? '',
          Locked: false,
          Level: Number(template.Level ?? 1),
          Rerollable: false,
          Abilities: ((template.Abilities as Decoded[] | null) ?? []).map((a) => ({
            __msg: USER_PHOTO_ABILITY_MSG,
            PhotoAbilityId: String(a.PhotoAbilityId ?? ''),
            EffectValue: Number(a.EffectValue ?? 0),
            Grade: Number(a.Grade ?? 1),
          })),
          ShootingTime: Date.now(),
        } as Decoded;
        await putElements(playerId, 'Photos', [photo], exec);
        photos.push(photo);
        results.push({ ...result(g, 0, 1), IsNew: true } as Decoded);
        break;
      }
      case 6:
      case 21:
      case 29: {
        // PhotoSituation / PhotoGift / ActivatePhotoShootingStoryTicket: no
        // master data and no player collection exist in the current corpus
        // (documented gap, see docs/PHOTOS.md). Surface the claim as a
        // zero-delivery RewardResult so the client sees the reward consumed.
        results.push({ ...result(g, 0, 0), IsNew: true } as Decoded);
        break;
      }
      default:
        // Unsupported resource type: record the intent but do not mutate state.
        break;
    }
  }

  const updated: Decoded = { __msg: UPDATED_MSG } as Decoded;
  if (items.length) updated.Items = items;
  if (points.length) updated.Points = points;
  if (balance) updated.Balance = balance;
  if (cards.length) updated.Cards = cards;
  if (photos.length) updated.Photos = photos;
  for (const [field, els] of collections) updated[field] = els;

  const touched = items.length || points.length || balance || collections.size || cards.length || photos.length;
  return { updated: touched ? updated : null, results, grants };
}

function result(g: Grant, before: number, after: number): Decoded {
  return {
    __msg: REWARD_RESULT_MSG,
    ResourceType: g.resourceType,
    ...(g.resourceId ? { ResourceId: g.resourceId } : {}),
    BeforeAmount: before,
    AfterAmount: after,
    AmountI64: g.amount,
  } as Decoded;
}

/** Convenience: resolve references and apply them in one call. */
export async function applyRewardRefs(
  playerId: string,
  refs: string[],
  exec: Executor = db,
): Promise<ApplyResult> {
  const grants = await resolveRewardRefs(refs);
  const applied = await applyGrants(playerId, grants, exec);
  return { ...applied, grants };
}
