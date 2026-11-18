// Unit tests for the editor's draw-rate budget helpers. These mirror the
// server-side `boxRateBudget` tests in marathon/box.test.ts.
import { describe, expect, it } from 'vitest';
import { boxHasInfiniteItems, boxRateBudget, formatRate, impliedItemRate, unratedPoolWeight } from './boxRates.ts';
import type { DraftBoxItem } from './draft.ts';

function item(order: number, initialStock: number, extra: Partial<DraftBoxItem> = {}): DraftBoxItem {
  return { order, itemKey: String(order), itemType: 1, initialStock, isLimited: true, ...extra };
}

describe('boxRateBudget', () => {
  it('derives the finite budget from the authored infinite rate', () => {
    const items = [item(1, 5, { isLimited: false }), item(2, 5, { rate: 0.01 })];
    const budget = boxRateBudget(items, 0.7);
    expect(budget.pInf).toBe(0.7);
    expect(budget.finiteBudget).toBeCloseTo(0.3, 10);
    expect(budget.assigned).toBe(0.01);
    expect(budget.available).toBeCloseTo(0.29, 10);
  });

  it('uses the initial-stock ratio when no infinite rate is set', () => {
    const budget = boxRateBudget([item(1, 2, { isLimited: false }), item(2, 2)]);
    expect(budget.pInf).toBe(0.5);
    expect(budget.finiteBudget).toBe(0.5);
    expect(budget.available).toBe(0.5);
  });

  it('gives a box with no infinite items the whole budget', () => {
    const budget = boxRateBudget([item(1, 1, { rate: 0.25 }), item(2, 3)], 0.7);
    expect(budget.pInf).toBe(0);
    expect(budget.finiteBudget).toBe(1);
    expect(budget.assigned).toBe(0.25);
    expect(budget.available).toBe(0.75);
  });

  it('reports an overspent finite budget as negative available', () => {
    const items = [item(1, 5, { isLimited: false }), item(2, 5, { rate: 0.2 }), item(3, 5, { rate: 0.2 })];
    const budget = boxRateBudget(items, 0.7);
    expect(budget.assigned).toBeCloseTo(0.4, 10);
    expect(budget.available).toBeCloseTo(-0.1, 10);
  });
});

describe('boxHasInfiniteItems', () => {
  it('is true only when an unlimited item has positive stock', () => {
    expect(boxHasInfiniteItems([item(1, 5, { isLimited: false }), item(2, 3)])).toBe(true);
    // No item at all, only limited items, or an unlimited item with no stock.
    expect(boxHasInfiniteItems([])).toBe(false);
    expect(boxHasInfiniteItems([item(1, 3)])).toBe(false);
    expect(boxHasInfiniteItems([item(1, 0, { isLimited: false }), item(2, 3)])).toBe(false);
  });
});

describe('unratedPoolWeight and impliedItemRate', () => {
  it('splits the pool weight between unrated items by initial stock', () => {
    const items = [
      item(1, 5, { rate: 0.2 }),
      item(2, 30),
      item(3, 10),
      item(4, 5, { isLimited: false }),
    ];
    expect(unratedPoolWeight(items, 0.7)).toBeCloseTo(0.1, 10);
    expect(impliedItemRate(items[1], items, 0.7)).toBeCloseTo(0.075, 10);
    expect(impliedItemRate(items[2], items, 0.7)).toBeCloseTo(0.025, 10);
    expect(impliedItemRate(items[0], items, 0.7)).toBe(0);
  });

  it('never reports a negative pool weight', () => {
    const items = [item(1, 5, { isLimited: false }), item(2, 5, { rate: 0.5 }), item(3, 5, { rate: 0.5 })];
    expect(unratedPoolWeight(items, 0.7)).toBe(0);
  });
});

describe('formatRate', () => {
  it('trims to at most four decimals', () => {
    expect(formatRate(0.29000000000000004)).toBe('0.29');
    expect(formatRate(0.0123456)).toBe('0.0123');
    expect(formatRate(0.7)).toBe('0.7');
    expect(formatRate(1)).toBe('1');
    expect(formatRate(-0.05000000001)).toBe('-0.05');
  });

  it('renders negative zero as zero', () => {
    expect(formatRate(-0)).toBe('0');
  });
});
