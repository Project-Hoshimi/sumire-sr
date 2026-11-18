// Marathon box-gacha maths. Pure unit tests; no database.
//
//   node --test src/services/marathon/box.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boxItemStocks,
  boxRateBudget,
  canResetBox,
  isBoxFull,
  pickBoxDraws,
  remainingStock,
  remainResetCount,
  resolveDrawCount,
  type CompiledBoxItemDef,
} from './box.ts';

/**
 * A finite item (`isLimited: true`) unless `extra` says otherwise. The default
 * `itemKey` mirrors what the plugin resolves, so tests can assert on keys.
 */
function item(
  order: number,
  initialStock: number,
  extra: Partial<CompiledBoxItemDef> = {},
): CompiledBoxItemDef {
  return {
    order,
    itemKey: String(order),
    itemType: 1,
    initialStock,
    isLimited: true,
    ...extra,
  };
}

/** Deterministic rng: yields the given values in order, then holds the last. */
function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

test('boxItemStocks subtracts draws, clamps at zero and sorts by order', () => {
  const items = [item(2, 1), item(1, 3)];
  assert.deepEqual(
    boxItemStocks(items, { '1': 2, '2': 5 }),
    [
      { def: items[1], stock: 1 },
      { def: items[0], stock: 0 },
    ],
  );
});

test('isBoxFull is true for an untouched box', () => {
  assert.equal(isBoxFull([item(1, 2), item(2, 3)], {}), true);
});

test('isBoxFull is false once a finite item has been drawn', () => {
  assert.equal(isBoxFull([item(1, 2), item(2, 3)], { '2': 1 }), false);
});

test('isBoxFull ignores infinite items', () => {
  const items = [item(1, 2), item(2, 5, { isLimited: false })];
  assert.equal(isBoxFull(items, { '2': 9 }), true);
});

test('isBoxFull is true again after a reset clears the draws', () => {
  const items = [item(1, 2), item(2, 3)];
  assert.equal(isBoxFull(items, {}), true);
});

test('remainingStock sums the clamped stocks', () => {
  const items = [item(1, 2), item(2, 3)];
  assert.equal(remainingStock(items, { '1': 1, '2': 9 }), 1);
  assert.equal(remainingStock(items, {}), 5);
});

test('pickBoxDraws is weighted by remaining stock and stops at exhaustion', () => {
  const items = [item(1, 2), item(2, 1)];
  // rng 0 always walks into the first positive stock bucket.
  assert.deepEqual(pickBoxDraws(items, {}, 3, sequence([0])), ['1', '1', '2']);
  // Drawing more than the box holds never exceeds the remaining stock.
  assert.deepEqual(pickBoxDraws(items, {}, 10, sequence([0])), ['1', '1', '2']);
  // rng near 1 walks to the last positive bucket first.
  assert.deepEqual(pickBoxDraws(items, {}, 3, sequence([0.999])), ['2', '1', '1']);
});

test('pickBoxDraws honours already drawn copies and does not mutate inputs', () => {
  const items = [item(1, 2)];
  const drawn = { '1': 1 };
  const before = structuredClone({ items, drawn });
  assert.deepEqual(pickBoxDraws(items, drawn, 5, sequence([0])), ['1']);
  const after = structuredClone({ items, drawn });
  assert.deepEqual(after, before);
});

test('an infinite item keeps its stock after being drawn', () => {
  const infinite = item(1, 5, { isLimited: false });
  assert.deepEqual(boxItemStocks([infinite], { '1': 3 }), [{ def: infinite, stock: 5 }]);
  // Drawing it does not shrink its weight: with rng 0 it is drawn every time.
  assert.deepEqual(pickBoxDraws([infinite], {}, 4, sequence([0])), ['1', '1', '1', '1']);
  assert.deepEqual(pickBoxDraws([infinite], { '1': 99 }, 2, sequence([0])), ['1', '1']);
});

test('an infinite item weighs its initial stock and a finite item still runs down', () => {
  const items = [item(1, 2, { isLimited: false }), item(2, 1)];
  // pInf = 2 / (2 + 1). rng 0 picks the infinite tier each draw, then item 1.
  assert.deepEqual(pickBoxDraws(items, {}, 3, sequence([0])), ['1', '1', '1']);
  // rng 0.999 picks the finite tier first (one finite item left), then only the
  // infinite item remains.
  assert.deepEqual(pickBoxDraws(items, {}, 3, sequence([0.999])), ['2', '1', '1']);
});

test('infinite odds stay constant after finite stock is partly drawn', () => {
  // infInit 10, finInit 90: pInf = 0.1 for every draw.
  const items = [item(1, 10, { isLimited: false }), item(2, 90)];
  const drawnMost = { '2': 85 }; // 5 finite left
  // Fresh box: rng 0.05 < 0.1 gives the infinite item, rng 0.15 gives the finite item.
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.05, 0])), ['1']);
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.15, 0])), ['2']);
  // Same odds after most finite stock is gone.
  assert.deepEqual(pickBoxDraws(items, drawnMost, 1, sequence([0.05, 0])), ['1']);
  assert.deepEqual(pickBoxDraws(items, drawnMost, 1, sequence([0.15, 0])), ['2']);
});

test('once finite stock is exhausted only infinite items are drawn', () => {
  const items = [item(1, 3), item(2, 4, { isLimited: false })];
  const drawn = { '1': 3 };
  // rng 0.9 walks to the last positive infinite bucket on every draw.
  assert.deepEqual(pickBoxDraws(items, drawn, 3, sequence([0.9])), ['2', '2', '2']);
  // Each draw uses exactly one rng call once the finite tier is empty.
  let calls = 0;
  pickBoxDraws(items, drawn, 3, () => {
    calls++;
    return 0.9;
  });
  assert.equal(calls, 3);
});

test('infiniteRate 0.7 sets the tier chance: rng 0.69 picks infinite, 0.71 picks finite', () => {
  const items = [item(1, 5, { isLimited: false }), item(2, 5)];
  // First rng value is the tier roll, second is the item pick inside the tier.
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.69, 0]), 0.7), ['1']);
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.71, 0]), 0.7), ['2']);
});

test('infiniteRate undefined keeps the initial-stock ratio', () => {
  // infInit 10, finInit 90: pInf = 0.1, so rng 0.15 picks finite.
  const items = [item(1, 10, { isLimited: false }), item(2, 90)];
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.05, 0]), undefined), ['1']);
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.15, 0]), undefined), ['2']);
});

test('infiniteRate 0.7 with no infinite items always draws finite', () => {
  const items = [item(1, 3), item(2, 2)];
  // No infinite items: no tier roll, so rng 0 walks to the first finite bucket each time.
  assert.deepEqual(pickBoxDraws(items, {}, 5, sequence([0]), 0.7), ['1', '1', '1', '2', '2']);
});

test('infiniteRate 0.7 with finite stock exhausted always draws infinite', () => {
  const items = [item(1, 1), item(2, 4, { isLimited: false })];
  const drawn = { '1': 1 };
  assert.deepEqual(pickBoxDraws(items, drawn, 3, sequence([0.99]), 0.7), ['2', '2', '2']);
});

test('infiniteRate is clamped to [0, 1]', () => {
  const items = [item(1, 5, { isLimited: false }), item(2, 5)];
  // 1.5 clamps to 1: every tier roll below 1 picks infinite.
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.99, 0]), 1.5), ['1']);
  // -0.5 clamps to 0: every tier roll picks finite.
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0, 0]), -0.5), ['2']);
});

test('with no infinite items the draw is plain remaining-stock weighting', () => {
  const items = [item(1, 2), item(2, 1)];
  let calls = 0;
  const rng = (): number => {
    calls++;
    return 0;
  };
  assert.deepEqual(pickBoxDraws(items, {}, 3, rng), ['1', '1', '2']);
  // One rng call per draw: no tier choice when there is no infinite item.
  assert.equal(calls, 3);
});

test('a finite item with zero remaining is never picked', () => {
  const items = [item(1, 2), item(2, 1), item(3, 5, { isLimited: false })];
  const drawn = { '1': 2 }; // order 1 is exhausted
  for (const r of [0, 0.3, 0.6, 0.99]) {
    const keys = pickBoxDraws(items, drawn, 6, () => r);
    assert.equal(keys.includes('1'), false, `rng ${r} picked an exhausted item`);
  }
});

test('remainingStock and draw totals exclude infinite items', () => {
  const items = [item(1, 5, { isLimited: false }), item(2, 3)];
  assert.equal(remainingStock(items, { '1': 0, '2': 1 }), 2);
  assert.equal(remainingStock(items, { '2': 3 }), 0);
});

test('a box with only infinite items left counts as empty for draws', () => {
  const items = [item(1, 1), item(2, 5, { isLimited: false })];
  assert.equal(remainingStock(items, { '1': 1 }), 0);
});

test('canResetBox requires every pickup item to be exhausted', () => {
  const box = { canReset: true, resetLimitCount: 0 };
  const items = [item(1, 1, { isPickup: true }), item(2, 2)];
  assert.equal(canResetBox(box, items, { '1': 1 }, 0), true);
  assert.equal(canResetBox(box, items, {}, 0), false);
  assert.equal(canResetBox(box, items, { '1': 1, '2': 1 }, 0), true);
  // A finite non-pickup item being empty does not satisfy the pickup rule.
  assert.equal(canResetBox(box, items, { '2': 2 }, 0), false);
});

test('canResetBox without pickup items requires every finite item to be empty', () => {
  const box = { canReset: true, resetLimitCount: 0 };
  const items = [item(1, 1), item(2, 1)];
  assert.equal(canResetBox(box, items, { '1': 1 }, 0), false);
  assert.equal(canResetBox(box, items, { '1': 1, '2': 1 }, 0), true);
});

test('canResetBox ignores infinite items when checking emptiness', () => {
  const box = { canReset: true, resetLimitCount: 0 };
  const items = [item(1, 1), item(2, 5, { isLimited: false })];
  assert.equal(canResetBox(box, items, { '1': 1 }, 0), true);
});

test('canResetBox respects canReset and the reset limit', () => {
  const items = [item(1, 1)];
  const drawn = { '1': 1 };
  assert.equal(canResetBox({ canReset: false, resetLimitCount: 0 }, items, drawn, 0), false);
  assert.equal(canResetBox({ canReset: true, resetLimitCount: 2 }, items, drawn, 1), true);
  assert.equal(canResetBox({ canReset: true, resetLimitCount: 2 }, items, drawn, 2), false);
});

test('remainResetCount reports unlimited as 999 and caps at zero', () => {
  assert.equal(remainResetCount({ canReset: false, resetLimitCount: 0 }, 0), 0);
  assert.equal(remainResetCount({ canReset: true, resetLimitCount: 0 }, 7), 999);
  assert.equal(remainResetCount({ canReset: true, resetLimitCount: 3 }, 1), 2);
  assert.equal(remainResetCount({ canReset: true, resetLimitCount: 3 }, 5), 0);
});

const drawInput = {
  requested: 12,
  maxDraw: 100,
  affordable: 50,
  finiteRemaining: 40,
  hasInfinite: false,
};

test('resolveDrawCount honours the requested count exactly', () => {
  assert.equal(resolveDrawCount(drawInput), 12);
  assert.equal(resolveDrawCount({ ...drawInput, requested: 1 }), 1);
  assert.equal(resolveDrawCount({ ...drawInput, requested: 100, affordable: 100, finiteRemaining: 100 }), 100);
});

test('resolveDrawCount throws when requested exceeds affordable', () => {
  assert.throws(
    () => resolveDrawCount({ ...drawInput, requested: 12, affordable: 11 }),
    /insufficient item/,
  );
  assert.throws(
    () => resolveDrawCount({ ...drawInput, requested: 1, affordable: 0 }),
    /insufficient item/,
  );
});

test('resolveDrawCount throws when a box with no infinite items lacks stock', () => {
  assert.throws(
    () => resolveDrawCount({ ...drawInput, requested: 5, finiteRemaining: 4 }),
    /exceeds remaining stock 4/,
  );
  assert.throws(
    () => resolveDrawCount({ ...drawInput, requested: 1, finiteRemaining: 0 }),
    /box gacha is empty/,
  );
});

test('resolveDrawCount allows a draw from a box with infinite items even at zero finite stock', () => {
  assert.equal(
    resolveDrawCount({ ...drawInput, requested: 7, finiteRemaining: 0, hasInfinite: true }),
    7,
  );
});

test('resolveDrawCount throws for a requested count of zero or a non-integer', () => {
  assert.throws(() => resolveDrawCount({ ...drawInput, requested: 0 }), /invalid exec count: 0/);
  assert.throws(() => resolveDrawCount({ ...drawInput, requested: 1.5 }), /invalid exec count/);
});

test('resolveDrawCount throws when requested exceeds the max', () => {
  assert.throws(
    () => resolveDrawCount({ ...drawInput, requested: 101, affordable: 200, finiteRemaining: 200 }),
    /exceeds max 100/,
  );
});

// Draw rates

/** Deterministic LCG in [0, 1), for the statistical rate test. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('boxRateBudget derives the finite budget from the authored infinite rate', () => {
  const items = [item(1, 5, { isLimited: false }), item(2, 5, { rate: 0.01 })];
  const budget = boxRateBudget(items, 0.7);
  assert.equal(budget.pInf, 0.7);
  assert.equal(budget.assigned, 0.01);
  assert.ok(Math.abs(budget.finiteBudget - 0.3) < 1e-9);
  assert.ok(Math.abs(budget.available - 0.29) < 1e-9);
});

test('boxRateBudget uses the initial-stock ratio when no infinite rate is set', () => {
  const items = [item(1, 2, { isLimited: false }), item(2, 2)];
  const budget = boxRateBudget(items, undefined);
  assert.equal(budget.pInf, 0.5);
  assert.equal(budget.finiteBudget, 0.5);
  assert.equal(budget.assigned, 0);
  assert.equal(budget.available, 0.5);
});

test('boxRateBudget gives a box with no infinite items the whole budget', () => {
  const budget = boxRateBudget([item(1, 1, { rate: 0.25 }), item(2, 3)], 0.7);
  assert.equal(budget.pInf, 0);
  assert.equal(budget.finiteBudget, 1);
  assert.equal(budget.assigned, 0.25);
  assert.equal(budget.available, 0.75);
});

test('boxRateBudget reports an overspent finite budget as negative available', () => {
  const items = [item(1, 5, { isLimited: false }), item(2, 5, { rate: 0.2 }), item(3, 5, { rate: 0.2 })];
  const budget = boxRateBudget(items, 0.7);
  assert.equal(budget.assigned, 0.4);
  assert.ok(Math.abs(budget.available + 0.1) < 1e-9);
});

test('a rated limited item is picked with its authored rate', () => {
  // finiteBudget 1, one rated item at 0.3 and the unrated pool at 0.7.
  const items = [item(1, 10, { rate: 0.3 }), item(2, 90)];
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.2])), ['1']);
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.5])), ['2']);
});

test('an exhausted rated item drops out and the rest renormalise without an infinite tier', () => {
  // Both rated items weigh 0.2; no unrated item, so the pool is empty and there
  // is no infinite item to absorb the exhausted share.
  const items = [item(1, 1, { rate: 0.2 }), item(2, 1, { rate: 0.2 })];
  // Item 1 is exhausted: only item 2 can be drawn whatever the rng value.
  assert.deepEqual(pickBoxDraws(items, { '1': 1 }, 1, sequence([0])), ['2']);
  assert.deepEqual(pickBoxDraws(items, { '1': 1 }, 1, sequence([0.99])), ['2']);
});

test('an empty unrated pool leaves only the rated items in play', () => {
  // Budget 1, the single rated item claims all of it, leaving the pool 0.
  const items = [item(1, 2, { rate: 1 }), item(2, 5)];
  // Both draws go to the rated item until it runs out, then the fallback
  // (plain remaining-stock weighting) reaches the unrated item.
  assert.deepEqual(pickBoxDraws(items, {}, 4, sequence([0.99])), ['1', '1', '2', '2']);
});

test('with every candidate weight 0 the draw falls back to remaining stock', () => {
  // The only rated item is exhausted and the pool weight is 0 (rate 1).
  const items = [item(1, 1, { rate: 1 }), item(2, 5)];
  assert.deepEqual(pickBoxDraws(items, { '1': 1 }, 3, sequence([0.99])), ['2', '2', '2']);
});

test('a rated item respects its rate statistically against the unrated pool', () => {
  const items = [item(1, 100000, { rate: 0.25 }), item(2, 100000)];
  const rng = seeded(12345);
  const draws = pickBoxDraws(items, {}, 2000, rng);
  const rated = draws.filter((key) => key === '1').length;
  assert.ok(rated > 420 && rated < 580, `rated picks ${rated} outside the 0.25 ± 0.03 band`);
});

test('an exhausted rated item moves its rate to the infinite tier', () => {
  // Infinite 0.7, rated item 0.1 and the unrated pool 0.2.
  const items = [
    item(1, 5, { isLimited: false }),
    item(2, 1, { rate: 0.1 }),
    item(3, 20),
  ];
  const drawn = { '2': 1 };
  // 0.75 sits above the bare 0.7 but below the raised 0.8 chance: infinite now.
  assert.deepEqual(pickBoxDraws(items, drawn, 1, sequence([0.75, 0]), 0.7), ['1']);
  // Above the raised chance it still draws the unrated pool.
  assert.deepEqual(pickBoxDraws(items, drawn, 1, sequence([0.85, 0.99]), 0.7), ['3']);
  // While the rated item has stock the 0.7 boundary is unchanged.
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.75, 0.99]), 0.7), ['3']);
});

test('an exhausted unrated pool moves its weight to the infinite tier', () => {
  // Infinite 0.7, rated item 0.1 and the pool 0.2, with the only pool item gone.
  const items = [
    item(1, 5, { isLimited: false }),
    item(2, 10, { rate: 0.1 }),
    item(3, 1),
  ];
  const drawn = { '3': 1 };
  // pInfEff = 0.7 + 0.2 = 0.9, so 0.85 picks infinite and 0.95 picks finite.
  assert.deepEqual(pickBoxDraws(items, drawn, 1, sequence([0.85, 0]), 0.7), ['1']);
  assert.deepEqual(pickBoxDraws(items, drawn, 1, sequence([0.95, 0]), 0.7), ['2']);
});

test('a rated box with no pool items sends the pool weight to the infinite tier', () => {
  // Only rated items exist: finiteBudget 0.3, rated item 0.1, pool weight 0.2.
  const items = [item(1, 5, { isLimited: false }), item(2, 10, { rate: 0.1 })];
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.85, 0]), 0.7), ['1']);
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.95, 0]), 0.7), ['2']);
});

test('a box with no infinite items still renormalises after a rated item runs out', () => {
  const items = [item(1, 1, { rate: 0.2 }), item(2, 5, { rate: 0.3 })];
  const drawn = { '1': 1 };
  // pInf is 0 and there is nowhere else to put the 0.2: item 2 takes every draw.
  assert.deepEqual(pickBoxDraws(items, drawn, 3, sequence([0.99]), 0.7), ['2', '2', '2']);
});

test('pInfEff clamps to 1 when the exhausted shares overrun the budget', () => {
  // finiteBudget 0.3 but the rated item claims 0.5: available is negative, so
  // the pool weight is 0 and pInfEff = 0.7 + 0.5 = 1.2, clamped to 1.
  const items = [item(1, 5, { isLimited: false }), item(2, 1, { rate: 0.5 }), item(3, 5)];
  assert.deepEqual(pickBoxDraws(items, { '2': 1 }, 2, sequence([0.999]), 0.7), ['1', '1']);
});

test('a rated box with an infinite tier still uses one tier roll per draw', () => {
  const items = [
    item(1, 5, { isLimited: false }),
    item(2, 1, { rate: 0.1 }),
    item(3, 20),
  ];
  let calls = 0;
  pickBoxDraws(items, { '2': 1 }, 3, () => {
    calls += 1;
    return 0.1;
  }, 0.7);
  // Two rng calls per draw: the tier roll, then the item pick inside the tier.
  assert.equal(calls, 6);
});

test('the infinite frequency rises by the exhausted shares on a rated box', () => {
  const items = [
    item(1, 5, { isLimited: false }),
    item(2, 1, { rate: 0.1 }),
    item(3, 100000),
  ];
  const draws = pickBoxDraws(items, { '2': 1 }, 4000, seeded(98765), 0.7);
  const infinite = draws.filter((key) => key === '1').length;
  // pInfEff = 0.7 + 0.1 = 0.8 for every draw after the rated item is out.
  assert.ok(
    infinite > 4000 * 0.77 && infinite < 4000 * 0.83,
    `infinite picks ${infinite} outside the 0.8 ± 0.03 band`,
  );
});

test('a box without rates keeps the exact remaining-stock weighting and rng calls', () => {
  const items = [item(1, 2), item(2, 1)];
  const values = [0, 0.4, 0.999];
  let calls = 0;
  const draws = pickBoxDraws(items, {}, 3, () => {
    const value = values[Math.min(calls, values.length - 1)];
    calls += 1;
    return value;
  });
  assert.deepEqual(draws, ['1', '1', '2']);
  // One rng call per draw: no rates means no extra tier-free selection calls.
  assert.equal(calls, 3);
});
