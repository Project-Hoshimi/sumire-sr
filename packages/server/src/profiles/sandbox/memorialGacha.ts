/**
 * Sandbox "Memorial" gacha category pools.
 *
 * Each memorial banner draws ★5 only from the cards of one category. Category
 * membership is derived from the historical banners that featured a card
 * (`PickupCardIds` / `SelectCardIds`) plus the character's unit group; cards
 * that never appeared in any gacha are normal-pool cards. Memorial banners are
 * sandbox-only and deliberately have no featured rate-up. The excursion pool
 * is the おでかけシリーズ outfit set (`card-*-05-casl-04`), which also aired in
 * limited banners but gets its own sandbox-only memorial banner. The premium
 * pool is the プレミアムガチャ cards (`card-*-05-prem-*`), which never appear as
 * banner pickups.
 *
 * This module is intentionally free of database/service imports so it can be
 * unit-tested without game master data (see `sandbox.test.ts`).
 */

export type MemorialCategory =
  | 'birthday'
  | 'fes'
  | 'excursion'
  | 'limited1'
  | 'limited2'
  | 'link'
  | 'normal'
  | 'collab'
  | 'premium';

/** Memorial banner id -> the single ★5 category pool it draws from. */
export const MEMORIAL_GACHA_CATEGORY: Readonly<Record<string, MemorialCategory>> = {
  'gacha-birthday-26-1030-01': 'birthday',
  'gacha-fes-26-1030-01': 'fes',
  'gacha-sandbox-excursion-memorial': 'excursion',
  'gacha-limited-26-1030-01': 'limited1',
  'gacha-limited-26-1030-02': 'limited2',
  'gacha-link-26-1030-01': 'link',
  'gacha-normal-26-1030-01': 'normal',
  'gacha-sandbox-collab-memorial': 'collab',
  'gacha-sandbox-premium-memorial': 'premium',
};

export const MEMORIAL_GACHA_IDS: readonly string[] = Object.keys(MEMORIAL_GACHA_CATEGORY);

export function isMemorialGachaId(id: unknown): boolean {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(MEMORIAL_GACHA_CATEGORY, id);
}

/** Memorial banners use the festival rarity table (no featured rate-up). */
export const MEMORIAL_RATES = { 5: 7.0, 4: 15.0, 3: 78.0 } as const;

const MEMORIAL_CATEGORIES: readonly MemorialCategory[] = [
  'birthday',
  'fes',
  'excursion',
  'limited1',
  'limited2',
  'link',
  'normal',
  'collab',
  'premium',
];

const LIMITED1_GROUPS = new Set(['character_group_1', 'character_group_4', 'character_group_6']);
const LIMITED2_GROUPS = new Set(['character_group_2', 'character_group_3', 'character_group_5']);

/**
 * The historical banner family for a gacha id: strip the `gacha-` prefix, drop
 * the `-0N-` release marker, then drop the trailing `-YY-YYYY...` date suffix.
 * e.g. `gacha-all-star-01-26-0817` -> `all-star`.
 */
export function gachaFamily(gachaId: string): string {
  return gachaId
    .replace(/^gacha-/, '')
    .replace(/-0\d-/g, '-')
    .replace(/-\d\d-\d{4}.*$/, '');
}

/**
 * Classify a ★5 card into its memorial category. Precedence matters: a card
 * that belongs to several historical banners keeps the earliest rule (link
 * cards stay link even when an `fs-set-*` fes banner also featured them).
 * The excursion rule sits after fes and before the limited rules: excursion
 * outfit cards also appear in limited banners, but they belong to the
 * おでかけシリーズ pool (`card-*-05-casl-04`). The premium pool is the
 * プレミアムガチャ cards (`card-*-05-prem-*`), which never appear as banner
 * pickups.
 */
export function memorialCategoryOf(
  cardId: string,
  families: ReadonlySet<string>,
  characterGroupId: string | undefined,
): MemorialCategory {
  const tag = cardId.split('-')[3];
  for (const family of families) {
    if (family.startsWith('birthday') || family.startsWith('bir-') || family.startsWith('rev-birthday')) {
      return 'birthday';
    }
  }
  if (tag === 'link') return 'link';
  if (tag === 'fest') return 'fes';
  if (tag === 'prem') return 'premium';
  for (const family of families) {
    if (family.startsWith('fes') || family.startsWith('fs-')) return 'fes';
  }
  for (const family of families) {
    if (family.startsWith('excursion')) return 'excursion';
  }
  for (const family of families) {
    if (!/^(rev-)?(limited|lm-set|excursion)/.test(family)) continue;
    if (characterGroupId && LIMITED1_GROUPS.has(characterGroupId)) return 'limited1';
    if (characterGroupId && LIMITED2_GROUPS.has(characterGroupId)) return 'limited2';
    return 'collab';
  }
  return 'normal';
}

export type MemorialCardLike = {
  Id?: unknown;
  InitialRarity?: unknown;
  CharacterId?: unknown;
};

export type MemorialGachaLike = {
  Id?: unknown;
  PickupCardIds?: unknown;
  SelectCardIds?: unknown;
};

export type MemorialCharacterLike = {
  Id?: unknown;
  CharacterGroupId?: unknown;
};

/**
 * Build every memorial category's ★5 pool from master rows. Families are
 * collected from all non-memorial gachas; only ★5 cards are classified. Every
 * category is present (possibly empty) and the ids in each pool are sorted.
 */
export function buildMemorialPools(input: {
  cards: readonly MemorialCardLike[];
  gachas: readonly MemorialGachaLike[];
  characters: readonly MemorialCharacterLike[];
}): Map<MemorialCategory, string[]> {
  const groupByCharacter = new Map<string, string | undefined>();
  for (const character of input.characters) {
    const id = character.Id == null ? '' : String(character.Id);
    if (!id) continue;
    groupByCharacter.set(
      id,
      character.CharacterGroupId == null ? undefined : String(character.CharacterGroupId),
    );
  }

  const familiesByCard = new Map<string, Set<string>>();
  for (const gacha of input.gachas) {
    const id = gacha.Id == null ? '' : String(gacha.Id);
    if (!id || isMemorialGachaId(id)) continue;
    const family = gachaFamily(id);
    for (const list of [gacha.PickupCardIds, gacha.SelectCardIds]) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const cardId = raw == null ? '' : String(raw);
        if (!cardId) continue;
        const families = familiesByCard.get(cardId) ?? new Set<string>();
        families.add(family);
        familiesByCard.set(cardId, families);
      }
    }
  }

  const pools = new Map<MemorialCategory, string[]>();
  for (const category of MEMORIAL_CATEGORIES) pools.set(category, []);
  for (const card of input.cards) {
    if (Number(card.InitialRarity ?? 0) !== 5) continue;
    const id = card.Id == null ? '' : String(card.Id);
    if (!id) continue;
    const characterId = card.CharacterId == null ? '' : String(card.CharacterId);
    const category = memorialCategoryOf(
      id,
      familiesByCard.get(id) ?? new Set<string>(),
      groupByCharacter.get(characterId),
    );
    pools.get(category)!.push(id);
  }
  for (const ids of pools.values()) ids.sort();
  return pools;
}

/**
 * Drawable buckets for a memorial banner: ★5 is the category pool, ★4/★3 are
 * the whole master catalogue's matching InitialRarity (★1/★2 never appear).
 */
export function memorialBuckets(
  category: MemorialCategory,
  pools: ReadonlyMap<MemorialCategory, readonly string[]>,
  cards: readonly MemorialCardLike[],
): Map<number, string[]> {
  const buckets = new Map<number, string[]>();
  buckets.set(5, [...(pools.get(category) ?? [])]);
  buckets.set(4, []);
  buckets.set(3, []);
  for (const card of cards) {
    const id = card.Id == null ? '' : String(card.Id);
    if (!id) continue;
    const rarity = Number(card.InitialRarity ?? 0);
    if (rarity !== 4 && rarity !== 3) continue;
    buckets.get(rarity)!.push(id);
  }
  return buckets;
}
