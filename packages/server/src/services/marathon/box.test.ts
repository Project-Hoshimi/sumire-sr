// Marathon box-gacha maths. Pure unit tests; no database.
//
//   node --test src/services/marathon/box.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boxItemStocks,
  canResetBox,
  isBoxFull,
  pickBoxDraws,
  remainingStock,
  remainResetCount,
  resolveDrawCount,
  type BoxItemDef,
} from './box.ts';

/** A finite item (`isLimited: true`) unless `extra` says otherwise. */
function item(order: number, initialStock: number, extra: Partial<BoxItemDef> = {}): BoxItemDef {
  return { order, itemType: 1, initialStock, isLimited: true, ...extra };
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
  assert.deepEqual(pickBoxDraws(items, {}, 3, sequence([0])), [1, 1, 2]);
  // Drawing more than the box holds never exceeds the remaining stock.
  assert.deepEqual(pickBoxDraws(items, {}, 10, sequence([0])), [1, 1, 2]);
  // rng near 1 walks to the last positive bucket first.
  assert.deepEqual(pickBoxDraws(items, {}, 3, sequence([0.999])), [2, 1, 1]);
});

test('pickBoxDraws honours already drawn copies and does not mutate inputs', () => {
  const items = [item(1, 2)];
  const drawn = { '1': 1 };
  const before = structuredClone({ items, drawn });
  assert.deepEqual(pickBoxDraws(items, drawn, 5, sequence([0])), [1]);
  const after = structuredClone({ items, drawn });
  assert.deepEqual(after, before);
});

test('an infinite item keeps its stock after being drawn', () => {
  const infinite = item(1, 5, { isLimited: false });
  assert.deepEqual(boxItemStocks([infinite], { '1': 3 }), [{ def: infinite, stock: 5 }]);
  // Drawing it does not shrink its weight: with rng 0 it is drawn every time.
  assert.deepEqual(pickBoxDraws([infinite], {}, 4, sequence([0])), [1, 1, 1, 1]);
  assert.deepEqual(pickBoxDraws([infinite], { '1': 99 }, 2, sequence([0])), [1, 1]);
});

test('an infinite item weighs its initial stock and a finite item still runs down', () => {
  const items = [item(1, 2, { isLimited: false }), item(2, 1)];
  // pInf = 2 / (2 + 1). rng 0 picks the infinite tier each draw, then item 1.
  assert.deepEqual(pickBoxDraws(items, {}, 3, sequence([0])), [1, 1, 1]);
  // rng 0.999 picks the finite tier first (one finite item left), then only the
  // infinite item remains.
  assert.deepEqual(pickBoxDraws(items, {}, 3, sequence([0.999])), [2, 1, 1]);
});

test('infinite odds stay constant after finite stock is partly drawn', () => {
  // infInit 10, finInit 90: pInf = 0.1 for every draw.
  const items = [item(1, 10, { isLimited: false }), item(2, 90)];
  const drawnMost = { '2': 85 }; // 5 finite left
  // Fresh box: rng 0.05 < 0.1 gives the infinite item, rng 0.15 gives the finite item.
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.05, 0])), [1]);
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.15, 0])), [2]);
  // Same odds after most finite stock is gone.
  assert.deepEqual(pickBoxDraws(items, drawnMost, 1, sequence([0.05, 0])), [1]);
  assert.deepEqual(pickBoxDraws(items, drawnMost, 1, sequence([0.15, 0])), [2]);
});

test('once finite stock is exhausted only infinite items are drawn', () => {
  const items = [item(1, 3), item(2, 4, { isLimited: false })];
  const drawn = { '1': 3 };
  // rng 0.9 walks to the last positive infinite bucket on every draw.
  assert.deepEqual(pickBoxDraws(items, drawn, 3, sequence([0.9])), [2, 2, 2]);
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
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.69, 0]), 0.7), [1]);
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.71, 0]), 0.7), [2]);
});

test('infiniteRate undefined keeps the initial-stock ratio', () => {
  // infInit 10, finInit 90: pInf = 0.1, so rng 0.15 picks finite.
  const items = [item(1, 10, { isLimited: false }), item(2, 90)];
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.05, 0]), undefined), [1]);
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.15, 0]), undefined), [2]);
});

test('infiniteRate 0.7 with no infinite items always draws finite', () => {
  const items = [item(1, 3), item(2, 2)];
  // No infinite items: no tier roll, so rng 0 walks to the first finite bucket each time.
  assert.deepEqual(pickBoxDraws(items, {}, 5, sequence([0]), 0.7), [1, 1, 1, 2, 2]);
});

test('infiniteRate 0.7 with finite stock exhausted always draws infinite', () => {
  const items = [item(1, 1), item(2, 4, { isLimited: false })];
  const drawn = { '1': 1 };
  assert.deepEqual(pickBoxDraws(items, drawn, 3, sequence([0.99]), 0.7), [2, 2, 2]);
});

test('infiniteRate is clamped to [0, 1]', () => {
  const items = [item(1, 5, { isLimited: false }), item(2, 5)];
  // 1.5 clamps to 1: every tier roll below 1 picks infinite.
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0.99, 0]), 1.5), [1]);
  // -0.5 clamps to 0: every tier roll picks finite.
  assert.deepEqual(pickBoxDraws(items, {}, 1, sequence([0, 0]), -0.5), [2]);
});

test('with no infinite items the draw is plain remaining-stock weighting', () => {
  const items = [item(1, 2), item(2, 1)];
  let calls = 0;
  const rng = (): number => {
    calls++;
    return 0;
  };
  assert.deepEqual(pickBoxDraws(items, {}, 3, rng), [1, 1, 2]);
  // One rng call per draw: no tier choice when there is no infinite item.
  assert.equal(calls, 3);
});

test('a finite item with zero remaining is never picked', () => {
  const items = [item(1, 2), item(2, 1), item(3, 5, { isLimited: false })];
  const drawn = { '1': 2 }; // order 1 is exhausted
  for (const r of [0, 0.3, 0.6, 0.99]) {
    const orders = pickBoxDraws(items, drawn, 6, () => r);
    assert.equal(orders.includes(1), false, `rng ${r} picked an exhausted item`);
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
