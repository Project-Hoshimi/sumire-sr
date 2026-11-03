import { db } from '../db/client.ts';
import { type Executor } from '../db/tx.ts';
import { getCard as getMasterCard, getCostume } from '../master/index.ts';
import type { Grant } from '../master/reward.ts';
import { listElements } from './playerState.ts';

/**
 * Cosmetics tied to a master `Card`.
 *
 * When a player obtains a card, the outfit (`RewardCostumeId`) and hairstyles
 * (`RewardHairIds` plural, falling back to the scalar `RewardHairId`, then the
 * costume's `DefaultHairId`) are meant to be granted alongside it. These helpers
 * build those collection grants and can reconcile already-owned cards, which may
 * predate the grant (e.g. cards acquired via non-gacha paths or imported from the
 * corpus template).
 */

const RES_COSTUME = 5;
const RES_HAIR = 28;

/**
 * Build the collection grants for the cosmetics tied to a newly obtained card:
 * its `RewardCostumeId` and every hair in `RewardHairIds` (plural), falling
 * back to the scalar `RewardHairId` and then the costume's `DefaultHairId`.
 */
export async function cosmeticGrantsForCard(
  masterCard: { RewardCostumeId?: unknown; RewardHairId?: unknown; RewardHairIds?: unknown } | null | undefined,
): Promise<Grant[]> {
  const extraGrants: Grant[] = [];
  const hairIds = new Set<string>();
  const pluralHairs = Array.isArray(masterCard?.RewardHairIds)
    ? (masterCard.RewardHairIds as unknown[])
    : [];
  for (const h of pluralHairs) if (h) hairIds.add(String(h));
  if (masterCard?.RewardHairId) hairIds.add(String(masterCard.RewardHairId));
  if (masterCard?.RewardCostumeId) {
    const costumeId = String(masterCard.RewardCostumeId);
    extraGrants.push({ resourceType: RES_COSTUME, resourceId: costumeId, amount: 1 });
    if (hairIds.size === 0) {
      const costume = await getCostume(costumeId);
      if (costume?.DefaultHairId) hairIds.add(String(costume.DefaultHairId));
    }
  }
  for (const h of hairIds) extraGrants.push({ resourceType: RES_HAIR, resourceId: h, amount: 1 });
  return extraGrants;
}

/**
 * Compute the cosmetics owed to a player for every card they already own but do
 * not yet have the tied outfit/hair for. Returns deduped grants ready to be
 * passed to `applyGrants`.
 */
export async function missingCardCosmetics(
  playerId: string,
  exec: Executor = db,
): Promise<Grant[]> {
  const [cards, costumes, hairs] = await Promise.all([
    listElements(playerId, 'Cards', exec),
    listElements(playerId, 'Costumes', exec),
    listElements(playerId, 'Hairs', exec),
  ]);
  const ownedCostumes = new Set(costumes.map((c) => String(c.CostumeId ?? '')));
  const ownedHairs = new Set(hairs.map((h) => String(h.HairId ?? '')));
  const seen = new Set<string>();
  const missing: Grant[] = [];
  for (const c of cards) {
    const cardId = String(c.CardId ?? '');
    if (!cardId) continue;
    const masterCard = await getMasterCard(cardId);
    if (!masterCard) continue;
    for (const g of await cosmeticGrantsForCard(masterCard)) {
      const id = String(g.resourceId ?? '');
      if (!id) continue;
      const owned = g.resourceType === RES_COSTUME ? ownedCostumes : ownedHairs;
      if (owned.has(id)) continue;
      const dedupeKey = `${g.resourceType}:${id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      missing.push(g);
    }
  }
  return missing;
}