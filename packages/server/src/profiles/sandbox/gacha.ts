/**
 * Sandbox-only gacha pool overrides.
 *
 * The official `services/gacha.ts` buckets drawable cards by their master
 * `InitialRarity` and only keeps ★3/★4/★5. In sandbox mode every card in the
 * master catalogue must be drawable from every banner, so the whole catalogue
 * is bucketed (cards with a non-drawable rarity are folded into the ★3 pool so
 * the existing weighted model can still reach them).
 *
 * This module is intentionally free of database/service imports so it can be
 * unit-tested without game master data (see `sandbox.test.ts`).
 */

export const SANDBOX_GACHA_RARITIES = [5, 4, 3] as const;

export type MasterCardLike = {
  Id?: unknown;
  InitialRarity?: unknown;
};

/** Rarity bucket a card belongs to in sandbox mode (all cards stay drawable). */
export function sandboxRarityOf(card: MasterCardLike): number {
  const rarity = Number(card.InitialRarity ?? 0);
  return (SANDBOX_GACHA_RARITIES as readonly number[]).includes(rarity) ? rarity : 3;
}

/**
 * Bucket every card in the catalogue. Unlike the official bucketing this never
 * drops a card: ids with a rarity outside ★3/★4/★5 join the ★3 bucket.
 */
export function sandboxCardBuckets(cards: readonly MasterCardLike[]): Map<number, string[]> {
  const byRarity = new Map<number, string[]>();
  for (const card of cards) {
    const id = card.Id == null ? '' : String(card.Id);
    if (!id) continue;
    const rarity = sandboxRarityOf(card);
    const bucket = byRarity.get(rarity) ?? [];
    bucket.push(id);
    byRarity.set(rarity, bucket);
  }
  return byRarity;
}
