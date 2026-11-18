/**
 * Pure box-gacha mathematics for the Marathon event.
 *
 * There is no master table for box contents; the catalogue JSON authors them
 * (`MarathonConfig.boxGachas`). Per-player draw counts live in `state.ts`, so
 * everything here takes `drawn` explicitly and never touches the database.
 */

/** One authored entry in a box. `order` is the stable identity used by state. */
export interface BoxItemDef {
  order: number;
  itemType: number;
  rewardId?: string;
  liveBonusGroupId?: string;
  initialStock: number;
  /** true: finite stock (counted and decremented). false: infinite, never runs out. */
  isLimited?: boolean;
  /** Pickup prize: drives reset eligibility and PickupResults. */
  isPickup?: boolean;
  assetId?: string;
  description?: string;
}

/** One box definition in the catalogue: its ordered contents. */
export interface BoxDef {
  items: BoxItemDef[];
}

/** Per-player progress for one box: how many of each order were drawn. */
export interface BoxDrawState {
  drawn: Record<string, number>;
  resetCount: number;
}

export interface BoxResetRule {
  canReset: boolean;
  resetLimitCount: number;
}

function drawnCount(drawn: Record<string, number>, order: number): number {
  return drawn[String(order)] ?? 0;
}

/**
 * Stock per item, sorted by `order`. A finite item (`isLimited: true`) has its
 * authored initial stock minus the draws recorded for that order, never below
 * zero. An infinite item (`isLimited` not true) always reports its initial stock,
 * ignoring any recorded draws. Does not mutate `items` or `drawn`.
 */
export function boxItemStocks(
  items: BoxItemDef[],
  drawn: Record<string, number>,
): { def: BoxItemDef; stock: number }[] {
  return [...items]
    .sort((a, b) => a.order - b.order)
    .map((def) => ({ def, stock: itemStock(def, drawn) }));
}

function itemStock(def: BoxItemDef, drawn: Record<string, number>): number {
  if (def.isLimited !== true) return def.initialStock;
  return Math.max(0, def.initialStock - drawnCount(drawn, def.order));
}

/** Total remaining finite stock. Infinite items are excluded from the count. */
export function remainingStock(items: BoxItemDef[], drawn: Record<string, number>): number {
  return items
    .filter((def) => def.isLimited === true)
    .reduce((sum, def) => sum + itemStock(def, drawn), 0);
}

/**
 * True when nothing has been taken out of the box yet: every finite item
 * (`isLimited: true`) still has stock equal to its initial stock. Infinite items
 * are ignored, and a box with no finite items is full.
 */
export function isBoxFull(items: BoxItemDef[], drawn: Record<string, number>): boolean {
  return boxItemStocks(items, drawn).every(
    ({ def, stock }) => def.isLimited !== true || stock === def.initialStock,
  );
}

/** Inputs for {@link resolveDrawCount}. */
export interface DrawCountInput {
  requested: number;
  /** Safety bound on draws per request; not a gameplay limit. */
  maxDraw: number;
  /** Draws the player can pay for; `Infinity` when the box is free. */
  affordable: number;
  finiteRemaining: number;
  /** True when the box has at least one infinite item with stock. */
  hasInfinite: boolean;
}

/**
 * Validate a requested draw count and return it unchanged. Never clamps: a
 * request that cannot be honoured throws. Messages carry no RPC prefix; the
 * caller adds it.
 */
export function resolveDrawCount(input: DrawCountInput): number {
  const { requested, maxDraw, affordable, finiteRemaining, hasInfinite } = input;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`invalid exec count: ${requested}`);
  }
  if (requested > maxDraw) throw new Error(`exec count ${requested} exceeds max ${maxDraw}`);
  if (requested > affordable) {
    throw new Error(`insufficient item: exec count ${requested} exceeds affordable ${affordable}`);
  }
  if (!hasInfinite) {
    if (finiteRemaining <= 0) throw new Error('box gacha is empty');
    if (requested > finiteRemaining) {
      throw new Error(`exec count ${requested} exceeds remaining stock ${finiteRemaining}`);
    }
  }
  return requested;
}

/**
 * Pick `count` orders without replacement.
 *
 * Each draw first chooses a tier, then an item inside that tier. Infinite items
 * are weighted by their initial stock; finite items by their remaining stock.
 * When both tiers still have items, the infinite tier is chosen with the fixed
 * chance `infInit / (infInit + finInit)` (initial stock totals, set once per box),
 * so drawing finite stock never shifts odds toward infinite items. When one tier
 * is empty, the other tier is used. Only finite items are decremented after a pick.
 * `rng` returns [0, 1). Stops early when no item can be drawn.
 * Does not mutate `items` or `drawn`.
 *
 * When `infiniteRate` is a finite number it replaces the ratio as the infinite
 * tier chance, clamped to [0, 1]. It is only consulted while both tiers still
 * have items.
 */
export function pickBoxDraws(
  items: BoxItemDef[],
  drawn: Record<string, number>,
  count: number,
  rng: () => number,
  infiniteRate?: number,
): number[] {
  const remaining = boxItemStocks(items, drawn).map(({ def, stock }) => ({
    order: def.order,
    stock,
    finite: def.isLimited === true,
  }));
  let infInit = 0;
  let finInit = 0;
  for (const def of items) {
    if (def.isLimited === true) finInit += def.initialStock;
    else if (def.initialStock > 0) infInit += def.initialStock;
  }
  const ratioInf = infInit + finInit > 0 ? infInit / (infInit + finInit) : 0;
  const pInf =
    typeof infiniteRate === 'number' && Number.isFinite(infiniteRate)
      ? Math.min(1, Math.max(0, infiniteRate))
      : ratioInf;
  const orders: number[] = [];
  for (let i = 0; i < count; i++) {
    const finRemain = remaining.reduce((sum, item) => (item.finite ? sum + item.stock : sum), 0);
    if (finRemain <= 0 && infInit <= 0) break;
    let pickInfinite: boolean;
    if (finRemain <= 0) pickInfinite = true;
    else if (infInit <= 0) pickInfinite = false;
    else pickInfinite = rng() < pInf;
    const tierTotal = pickInfinite ? infInit : finRemain;
    const weight = (item: { stock: number; finite: boolean }): number => {
      if (item.finite) return pickInfinite ? 0 : item.stock;
      return pickInfinite && item.stock > 0 ? item.stock : 0;
    };
    let target = rng() * tierTotal;
    let chosen = -1;
    for (let j = 0; j < remaining.length; j++) {
      const w = weight(remaining[j]);
      if (w <= 0) continue;
      chosen = j;
      target -= w;
      if (target < 0) break;
    }
    if (chosen < 0) break;
    orders.push(remaining[chosen].order);
    if (remaining[chosen].finite) remaining[chosen].stock -= 1;
  }
  return orders;
}

/**
 * A box can be reset when the master row allows it, a reset is still within
 * the limit (`<= 0` means unlimited), and its reset condition holds: every
 * `isPickup` item is exhausted, or — when no item is a pickup — every finite
 * item is exhausted (infinite items are ignored).
 */
export function canResetBox(
  box: BoxResetRule,
  items: BoxItemDef[],
  drawn: Record<string, number>,
  resetCount: number,
): boolean {
  if (!box.canReset) return false;
  if (box.resetLimitCount > 0 && resetCount >= box.resetLimitCount) return false;
  const stocks = boxItemStocks(items, drawn);
  const pickups = stocks.filter((item) => item.def.isPickup === true);
  if (pickups.length > 0) return pickups.every((item) => item.stock === 0);
  return stocks
    .filter((item) => item.def.isLimited === true)
    .every((item) => item.stock === 0);
}

/**
 * Free resets still available. Unlimited reset limits (`<= 0`) render as 999,
 * matching the client's "effectively infinite" convention.
 */
export function remainResetCount(box: BoxResetRule, resetCount: number): number {
  if (!box.canReset) return 0;
  if (box.resetLimitCount <= 0) return 999;
  return Math.max(0, box.resetLimitCount - resetCount);
}
