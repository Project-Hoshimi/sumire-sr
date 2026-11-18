// Marathon catalog tests. Pure unit tests: the JSON ships with the server, so
// no database or game master data is required.
//
//   node --test src/services/marathon/catalog.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { activeMarathon, marathonConfig, marathonWindow } from './catalog.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Unix ms after every checked-in authored schedule has closed. */
const AFTER_ALL_SCHEDULES = Date.UTC(2026, 11, 6);

/** Run `fn` with SUMIRE_MARATHON_ID temporarily set to `value`. */
function withMarathonId<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.SUMIRE_MARATHON_ID;
  if (value === undefined) delete process.env.SUMIRE_MARATHON_ID;
  else process.env.SUMIRE_MARATHON_ID = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.SUMIRE_MARATHON_ID;
    else process.env.SUMIRE_MARATHON_ID = previous;
  }
}

// Without the event registry, open events come from the catalog files'
// authored schedules, so `activeMarathon` (which reads `Date.now`) is only
// deterministic under a mocked clock.
test('activeMarathon is undefined when SUMIRE_MARATHON_ID is unset', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: AFTER_ALL_SCHEDULES });
  withMarathonId(undefined, () => assert.equal(activeMarathon(), undefined));
});

test('activeMarathon is undefined when SUMIRE_MARATHON_ID is empty', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: AFTER_ALL_SCHEDULES });
  withMarathonId('  ', () => assert.equal(activeMarathon(), undefined));
});

test('activeMarathon resolves the placeholder catalog', () => {
  const config = withMarathonId('marathon-placeholder', () => activeMarathon());
  assert.ok(config);
  assert.equal(config.id, 'marathon-placeholder');
  assert.ok(config.name.length > 0);
});

test('activeMarathon is undefined when the id names no catalog file', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: AFTER_ALL_SCHEDULES });
  withMarathonId('marathon-not-in-the-catalog', () => assert.equal(activeMarathon(), undefined));
});

test('marathonConfig loads the placeholder by id', () => {
  const config = marathonConfig('marathon-placeholder');
  assert.ok(config);
  assert.equal(config.id, 'marathon-placeholder');
  assert.equal(config.order, 1);
  assert.ok(config.initialStamina > 0);
  assert.ok(config.staminaRecoveryMinutes > 0);
});

test('marathonConfig parses boxInfiniteRate from the placeholder', () => {
  const config = marathonConfig('marathon-placeholder');
  assert.ok(config);
  assert.equal(config.boxInfiniteRate, 0.7);
});

test('marathonWindow derives a start in the past and an ordered event window', () => {
  const now = Date.UTC(2026, 10, 11, 16, 25, 0);
  const window = marathonWindow(now);

  assert.ok(window.startTime < window.endTime);
  assert.ok(window.endTime < window.exchangeEndTime);
  assert.ok(window.startTime <= now);
  assert.equal(window.startTime, Math.floor(now / DAY_MS) * DAY_MS - DAY_MS);
  assert.equal(window.endTime, window.startTime + 15 * DAY_MS);
  assert.equal(window.exchangeEndTime, window.endTime + 7 * DAY_MS);
});
