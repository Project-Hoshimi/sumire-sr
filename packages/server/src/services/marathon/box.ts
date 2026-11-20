/**
 * Pure box-gacha mathematics for the Marathon event.
 *
 * There is no master table for box contents; the catalogue JSON authors them
 * (`MarathonConfig.boxGachas`). Per-player draw counts live in `state.ts` keyed
 * by `itemKey`, so everything here takes `drawn` explicitly and never touches
 * the database.
 */

/**
 * One authored entry in a box. `order` is the displayed position; `itemKey` is
 * the stable identity used by saved draw counts, so reordering the box never
 * moves a player's progress to another item. Catalogue authors may omit
 * `itemKey`, in which case the parser defaults it to `String(order)`.
 */
export interface BoxItemDef {
  order: number;
  itemKey?: string;
  itemType: number;
  rewardId?: string;
  liveBonusGroupId?: string;
  initialStock: number;
  /** true: finite stock (counted and decremented). false: infinite, never runs out. */
  isLimited?: boolean;
  /** Pickup prize: drives reset eligibility and PickupResults. */
  isPickup?: boolean;
  /**
   * Optional overall per-draw chance of this item while it still has stock.
   * Only meaningful on a limited item (`isLimited: true`). Unrated limited
   * items share the remainder of the finite budget by remaining stock. Once a
   * rated item is exhausted its rate moves to the infinite tier instead of
   * being renormalised across the remaining finite items.
   */
  rate?: number;
  assetId?: string;
  description?: string;
}

/** A parsed box item: the plugin has resolved `itemKey` on every item. */
export interface CompiledBoxItemDef extends BoxItemDef {
  itemKey: string;
}

/** One box definition in the catalogue: its ordered contents. */
export interface BoxDef {
  items: BoxItemDef[];
}

/** One compiled box definition: every item carries its resolved `itemKey`. */
export interface CompiledBoxDef {
  items: CompiledBoxItemDef[];
}

/** Per-player progress for one box: how many of each item key were drawn. */
export interface BoxDrawState {
  drawn: Record<string, number>;
  resetCount: number;
}

export interface BoxResetRule {
  canReset: boolean;
  resetLimitCount: number;
}

function drawnCount(drawn: Record<string, number>, itemKey: string): number {
  return drawn[itemKey] ?? 0;
}

/**
 * Stock per item, sorted by `order`. A finite item (`isLimited: true`) has its
 * authored initial stock minus the draws recorded for that item key, never below
 * zero. An infinite item (`isLimited` not true) always reports its initial stock,
 * ignoring any recorded draws. Does not mutate `items` or `drawn`.
 */
export function boxItemStocks(
  items: CompiledBoxItemDef[],
  drawn: Record<string, number>,
): { def: CompiledBoxItemDef; stock: number }[] {
  return [...items]
    .sort((a, b) => a.order - b.order)
    .map((def) => ({ def, stock: itemStock(def, drawn) }));
}

function itemStock(def: CompiledBoxItemDef, drawn: Record<string, number>): number {
  if (def.isLimited !== true) return def.initialStock;
  return Math.max(0, def.initialStock - drawnCount(drawn, def.itemKey));
}

/** Total remaining finite stock. Infinite items are excluded from the count. */
export function remainingStock(items: CompiledBoxItemDef[], drawn: Record<string, number>): number {
  return items
    .filter((def) => def.isLimited === true)
    .reduce((sum, def) => sum + itemStock(def, drawn), 0);
}

/**
 * True when nothing has been taken out of the box yet: every finite item
 * (`isLimited: true`) still has stock equal to its initial stock. Infinite items
 * are ignored, and a box with no finite items is full.
 */
export function isBoxFull(items: CompiledBoxItemDef[], drawn: Record<string, number>): boolean {
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

/** The per-box draw-rate budget implied by the authored items and infinite rate. */
export interface BoxRateBudget {
  /** Chance of the infinite tier: authored rate, else the initial-stock ratio. */
  pInf: number;
  /** Total weight left for the finite tier (`1 - pInf`). */
  finiteBudget: number;
  /** Sum of every configured limited-item `rate` in the box. */
  assigned: number;
  /** `finiteBudget - assigned`; negative means the authored rates overspend. */
  available: number;
}

/**
 * Per-box draw-rate budget. `pInf` is the authored `infiniteRate` clamped to
 * [0, 1] when the box has an infinite item with stock, the initial-stock ratio
 * `infInit / (infInit + finInit)` when no rate is authored, and 0 when the box
 * has no infinite items. `assigned` sums every authored limited-item rate,
 * regardless of remaining stock, so the unrated pool's weight stays fixed for
 * the whole box. `available` may be negative when the rates overspend.
 */
export function boxRateBudget(
  items: readonly BoxItemDef[],
  infiniteRate?: number,
): BoxRateBudget {
  let infInit = 0;
  let finInit = 0;
  let assigned = 0;
  for (const def of items) {
    if (def.isLimited === true) {
      finInit += def.initialStock;
      if (typeof def.rate === 'number' && Number.isFinite(def.rate)) assigned += def.rate;
    } else if (def.initialStock > 0) {
      infInit += def.initialStock;
    }
  }
  let pInf: number;
  if (infInit <= 0) {
    pInf = 0;
  } else if (typeof infiniteRate === 'number' && Number.isFinite(infiniteRate)) {
    pInf = Math.min(1, Math.max(0, infiniteRate));
  } else {
    pInf = infInit + finInit > 0 ? infInit / (infInit + finInit) : 0;
  }
  const finiteBudget = 1 - pInf;
  return { pInf, finiteBudget, assigned, available: finiteBudget - assigned };
}

/**
 * Pick `count` item keys without replacement.
 *
 * Each draw first chooses a tier, then an item inside that tier. Infinite items
 * are weighted by their initial stock; finite items by their remaining stock.
 * When both tiers still have items, the infinite tier is chosen with the fixed
 * chance `infInit / (infInit + finInit)` (initial stock totals, set once per box),
 * so drawing finite stock never shifts odds toward infinite items. When one tier
 * is empty, the other tier is used. Only finite items are decremented after a pick.
 * `rng` returns [0, 1). Stops early when no item can be drawn. The result holds
 * `itemKey`s, the same identity the box state records draws under.
 * Does not mutate `items` or `drawn`.
 *
 * On the rate path (the box authors at least one limited-item `rate`) an
 * exhausted finite candidate's weight is not spread over the remaining finite
 * items: the fixed chance above is raised by the exhausted shares, clamped to
 * [0, 1], before the tier roll.
 *
 * When `infiniteRate` is a finite number it replaces the ratio as the infinite
 * tier chance, clamped to [0, 1]. It is only consulted while both tiers still
 * have items.
 *
 * A limited item may author a `rate`, its overall per-draw chance while in
 * stock. Inside the finite tier a rated item is weighted by that rate and the
 * unrated items together by `max(0, finiteBudget - sum of all authored rates)`,
 * split between them by remaining stock. With an infinite tier present, an
 * exhausted candidate's weight does not renormalise onto the remaining finite
 * items: each exhausted rated item's rate is added to the infinite tier chance,
 * and when the unrated pool has no stock left (every unrated limited item is
 * exhausted, or there are none) the pool weight moves there too. The per-draw
 * infinite chance is therefore `clamp(pInf + sum of exhausted rates + (pool
 * exhausted ? poolWeight : 0), 0, 1)`. When the box has no infinite items there
 * is nowhere to send that share, so the exhausted weights renormalise among the
 * in-stock finite items instead. When every candidate weighs 0, the draw falls
 * back to plain remaining-stock weighting over the in-stock finite items.
 * With no rates authored anywhere, the finite tier is exactly the old
 * remaining-stock weighting, including the rng call order.
 */
export function pickBoxDraws(
  items: CompiledBoxItemDef[],
  drawn: Record<string, number>,
  count: number,
  rng: () => number,
  infiniteRate?: number,
): string[] {
  const remaining = boxItemStocks(items, drawn).map(({ def, stock }) => ({
    itemKey: def.itemKey,
    stock,
    finite: def.isLimited === true,
    rate:
      def.isLimited === true && typeof def.rate === 'number' && Number.isFinite(def.rate)
        ? def.rate
        : undefined,
  }));
  let infInit = 0;
  for (const def of items) {
    if (def.isLimited !== true && def.initialStock > 0) infInit += def.initialStock;
  }
  const budget = boxRateBudget(items, infiniteRate);
  const pInf = budget.pInf;
  // The unrated pool is weighted from the configured rates, not only the
  // in-stock ones, so an exhausted rated item does not inflate the pool.
  const poolWeight = Math.max(0, budget.available);
  const hasRates = items.some((def) => def.isLimited === true && def.rate !== undefined);
  const hasInfinite = infInit > 0;
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    const finRemain = remaining.reduce((sum, item) => (item.finite ? sum + item.stock : sum), 0);
    if (finRemain <= 0 && !hasInfinite) break;
    let pickInfinite: boolean;
    let finitePoolWeight = poolWeight;
    if (finRemain <= 0) {
      pickInfinite = true;
    } else if (!hasInfinite) {
      pickInfinite = false;
    } else {
      // Exhausted finite weight goes to the infinite tier, not to the
      // remaining finite candidates.
      let pInfEff = pInf;
      if (hasRates) {
        let poolStock = 0;
        for (const item of remaining) {
          if (!item.finite) continue;
          if (item.rate !== undefined) {
            if (item.stock <= 0) pInfEff += item.rate;
          } else {
            poolStock += item.stock;
          }
        }
        if (poolStock <= 0) {
          pInfEff += poolWeight;
          finitePoolWeight = 0;
        }
      }
      pInfEff = Math.min(1, Math.max(0, pInfEff));
      pickInfinite = rng() < pInfEff;
    }
    let chosen = -1;
    if (!pickInfinite && hasRates) {
      chosen = pickRatedFinite(remaining, finitePoolWeight, rng);
    } else {
      const tierTotal = pickInfinite ? infInit : finRemain;
      const weight = (item: { stock: number; finite: boolean }): number => {
        if (item.finite) return pickInfinite ? 0 : item.stock;
        return pickInfinite && item.stock > 0 ? item.stock : 0;
      };
      let target = rng() * tierTotal;
      for (let j = 0; j < remaining.length; j++) {
        const w = weight(remaining[j]);
        if (w <= 0) continue;
        chosen = j;
        target -= w;
        if (target < 0) break;
      }
    }
    if (chosen < 0) break;
    keys.push(remaining[chosen].itemKey);
    if (remaining[chosen].finite) remaining[chosen].stock -= 1;
  }
  return keys;
}

/**
 * Pick one item inside the finite tier when at least one item authors a rate.
 * Rated items weigh their rate; the unrated pool weighs `poolWeight` in total,
 * split between its items by remaining stock. The caller lowers `poolWeight` to
 * 0 when the pool is exhausted, because that share has moved to the infinite
 * tier. Candidates with no weight drop out. When every candidate weighs 0 (for
 * example the pool weight is 0 and only unrated items are left in stock), the
 * draw falls back to plain remaining-stock weighting over the in-stock finite
 * items.
 */
function pickRatedFinite(
  remaining: readonly { stock: number; finite: boolean; rate?: number }[],
  poolWeight: number,
  rng: () => number,
): number {
  let poolStock = 0;
  for (const item of remaining) {
    if (item.finite && item.stock > 0 && item.rate === undefined) poolStock += item.stock;
  }
  const weights: number[] = [];
  let total = 0;
  for (const item of remaining) {
    let w = 0;
    if (item.finite && item.stock > 0) {
      if (item.rate !== undefined) w = item.rate;
      else if (poolStock > 0) w = (poolWeight * item.stock) / poolStock;
    }
    weights.push(w);
    total += w;
  }
  if (!(total > 0)) {
    total = 0;
    for (let j = 0; j < remaining.length; j++) {
      const w = remaining[j].finite ? remaining[j].stock : 0;
      weights[j] = w;
      total += w;
    }
  }
  let target = rng() * total;
  let chosen = -1;
  for (let j = 0; j < weights.length; j++) {
    const w = weights[j];
    if (w <= 0) continue;
    chosen = j;
    target -= w;
    if (target < 0) break;
  }
  return chosen;
}

/**
 * A box can be reset when the master row allows it, a reset is still within
 * the limit (`<= 0` means unlimited), and its reset condition holds: every
 * `isPickup` item is exhausted, or — when no item is a pickup — every finite
 * item is exhausted (infinite items are ignored).
 */
export function canResetBox(
  box: BoxResetRule,
  items: CompiledBoxItemDef[],
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
