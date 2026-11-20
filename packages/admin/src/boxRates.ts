/**
 * Pure draw-rate budget helpers for the marathon draft editor.
 *
 * This mirrors `boxRateBudget` in
 * `fastify-api/src/services/marathon/box.ts` so the editor shows exactly the
 * budget the server validates. Keep the two formulas in step.
 */
import type { DraftBoxItem } from './draft.ts';

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

export function boxRateBudget(
  items: readonly DraftBoxItem[],
  infiniteRate?: number,
): BoxRateBudget {
  let infInit = 0;
  let finInit = 0;
  let assigned = 0;
  for (const item of items) {
    if (item.isLimited === true) {
      finInit += item.initialStock;
      if (typeof item.rate === 'number' && Number.isFinite(item.rate)) assigned += item.rate;
    } else if (item.initialStock > 0) {
      infInit += item.initialStock;
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

/** Weight the unrated limited items share: the budget left after every authored rate. */
export function unratedPoolWeight(
  items: readonly DraftBoxItem[],
  infiniteRate?: number,
): number {
  return Math.max(0, boxRateBudget(items, infiniteRate).available);
}

/**
 * True when the box has an infinite tier: at least one item that is not
 * limited and has positive initial stock, matching the server's `infInit > 0`.
 */
export function boxHasInfiniteItems(items: readonly DraftBoxItem[]): boolean {
  return items.some((item) => item.isLimited !== true && item.initialStock > 0);
}

/**
 * The per-draw chance an unrated limited item currently implies: its share of
 * the unrated pool, split by initial stock. Returns 0 outside the pool.
 */
export function impliedItemRate(
  item: DraftBoxItem,
  items: readonly DraftBoxItem[],
  infiniteRate?: number,
): number {
  if (item.isLimited !== true || item.rate !== undefined) return 0;
  let unratedStock = 0;
  for (const candidate of items) {
    if (candidate.isLimited === true && candidate.rate === undefined) {
      unratedStock += candidate.initialStock;
    }
  }
  if (unratedStock <= 0) return 0;
  return (unratedPoolWeight(items, infiniteRate) * item.initialStock) / unratedStock;
}

/** A rate as shown to authors: at most four decimals, trailing zeros trimmed. */
export function formatRate(value: number): string {
  if (!Number.isFinite(value)) return '';
  const rounded = Math.round(value * 10000) / 10000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}
