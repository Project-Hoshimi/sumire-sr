// Marathon stamina tests. Pure unit tests of `currentStamina`; no database.
//
//   node --test src/services/marathon/state.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { ALREADY_MAX_STAMINA_MESSAGE, applyStaminaItems, currentStamina } from './state.ts';

const MINUTE_MS = 60 * 1000;
const config = { initialStamina: 10, staminaRecoveryMinutes: 5 };
const INTERVAL_MS = config.staminaRecoveryMinutes * MINUTE_MS;
const BASE = 1_000_000_000_000;

test('no time passed: stamina and base time are unchanged', () => {
  const state = { stamina: 4, staminaUpdatedTime: BASE };
  assert.deepEqual(currentStamina(state, config, BASE), { stamina: 4, updated: BASE });
});

test('partial recovery: whole intervals only, base advances by those intervals', () => {
  const state = { stamina: 4, staminaUpdatedTime: BASE };
  const now = BASE + 2 * INTERVAL_MS + INTERVAL_MS / 2;
  assert.deepEqual(currentStamina(state, config, now), {
    stamina: 6,
    updated: BASE + 2 * INTERVAL_MS,
  });
});

test('recovery is capped at initialStamina and the base time becomes now', () => {
  const state = { stamina: 7, staminaUpdatedTime: BASE };
  const now = BASE + 100 * INTERVAL_MS;
  assert.deepEqual(currentStamina(state, config, now), { stamina: 10, updated: now });
});

test('already full: stamina is kept and the base time becomes now', () => {
  const state = { stamina: 10, staminaUpdatedTime: BASE };
  const now = BASE + 3 * INTERVAL_MS;
  assert.deepEqual(currentStamina(state, config, now), { stamina: 10, updated: now });
});

test('stamina above the cap (lowered config) is kept, not clamped', () => {
  const state = { stamina: 12, staminaUpdatedTime: BASE };
  assert.deepEqual(currentStamina(state, config, BASE + INTERVAL_MS), { stamina: 12, updated: BASE + INTERVAL_MS });
});

test('recovery minutes not above zero: no recovery, base time becomes now', () => {
  const state = { stamina: 4, staminaUpdatedTime: BASE };
  const now = BASE + 10 * INTERVAL_MS;
  const zero = { initialStamina: 10, staminaRecoveryMinutes: 0 };
  assert.deepEqual(currentStamina(state, zero, now), { stamina: 4, updated: now });
});

test('applyStaminaItems: normal use adds perItem for each item', () => {
  assert.deepEqual(applyStaminaItems({ stamina: 2, max: 10, perItem: 3, amount: 2 }), { stamina: 8 });
});

test('applyStaminaItems: exact fill to max', () => {
  assert.deepEqual(applyStaminaItems({ stamina: 4, max: 10, perItem: 3, amount: 2 }), { stamina: 10 });
});

test('applyStaminaItems: last item may overshoot max', () => {
  // needed = ceil((10 - 5) / 3) = 2; two items give 5 + 6 = 11, which is kept above max.
  assert.deepEqual(applyStaminaItems({ stamina: 5, max: 10, perItem: 3, amount: 2 }), { stamina: 11 });
});

test('applyStaminaItems: above max throws already maximum stamina', () => {
  assert.throws(
    () => applyStaminaItems({ stamina: 11, max: 10, perItem: 3, amount: 1 }),
    (err: Error) => err.message === ALREADY_MAX_STAMINA_MESSAGE,
  );
});

test('currentStamina: stamina above max is kept and does not recover', () => {
  const state = { stamina: 13, staminaUpdatedTime: BASE };
  assert.deepEqual(currentStamina(state, config, BASE + 10 * INTERVAL_MS), { stamina: 13, updated: BASE + 10 * INTERVAL_MS });
});

test('applyStaminaItems: at max throws already maximum stamina', () => {
  assert.throws(
    () => applyStaminaItems({ stamina: 10, max: 10, perItem: 3, amount: 1 }),
    (err: Error) => err.message === ALREADY_MAX_STAMINA_MESSAGE,
  );
});

test('applyStaminaItems: amount 0 and non-integer amounts throw', () => {
  for (const amount of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => applyStaminaItems({ stamina: 2, max: 10, perItem: 3, amount }),
      /invalid amount/,
    );
  }
});

test('applyStaminaItems: amount above usable items throws', () => {
  // needed = ceil((10 - 2) / 3) = 3
  assert.throws(
    () => applyStaminaItems({ stamina: 2, max: 10, perItem: 3, amount: 4 }),
    /amount 4 exceeds usable 3/,
  );
});
