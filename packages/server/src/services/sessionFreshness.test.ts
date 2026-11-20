// Session freshness tracker tests: stamping, forced relog, eviction, exemptions.
//
//   node --test src/services/sessionFreshness.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SESSION_FRESHNESS_LIMIT,
  SessionFreshnessTracker,
  eventRelogAppliesTo,
  type FreshnessResult,
} from './sessionFreshness.ts';

test('the first request stamps and is allowed', () => {
  const tracker = new SessionFreshnessTracker();
  assert.equal(tracker.check('token-a', 'fp-1'), 'fresh');
  assert.equal(tracker.size, 1);
});

test('the same fingerprint is allowed', () => {
  const tracker = new SessionFreshnessTracker();
  tracker.check('token-a', 'fp-1');
  assert.equal(tracker.check('token-a', 'fp-1'), 'fresh');
});

test('a changed fingerprint rejects once, then the next request re-stamps', () => {
  const tracker = new SessionFreshnessTracker();
  tracker.check('token-a', 'fp-1');
  assert.equal(tracker.check('token-a', 'fp-2'), 'changed');
  assert.equal(tracker.size, 0, 'the stale stamp is dropped on rejection');
  assert.equal(tracker.check('token-a', 'fp-2'), 'fresh');
  assert.equal(tracker.check('token-a', 'fp-2'), 'fresh');
});

test('sessions are tracked independently', () => {
  const tracker = new SessionFreshnessTracker();
  tracker.check('token-a', 'fp-1');
  tracker.check('token-b', 'fp-2');
  assert.equal(tracker.check('token-a', 'fp-2'), 'changed');
  assert.equal(tracker.check('token-b', 'fp-2'), 'fresh');
});

test('the map is capped and evicts the oldest insertion', () => {
  const tracker = new SessionFreshnessTracker(2);
  tracker.check('first', 'fp');
  tracker.check('second', 'fp');
  assert.equal(tracker.size, 2);
  tracker.check('third', 'fp');
  assert.equal(tracker.size, 2);
  // `first` was evicted, so it is treated as a brand-new session again.
  assert.equal(tracker.check('first', 'fp-next'), 'fresh');
  assert.equal(tracker.size, 2);
});

test('the default cap is 10,000 sessions', () => {
  assert.equal(DEFAULT_SESSION_FRESHNESS_LIMIT, 10_000);
});

test('Auth, Master and System:Check are exempt; other RPCs are checked', () => {
  const exempt = [
    'Auth:Login',
    'Auth:Create',
    'Auth:Recreate',
    'Master:Get',
    'System:Check',
  ];
  for (const name of exempt) assert.equal(eventRelogAppliesTo(name), false, name);
  const checked = [
    'System:GetMetadata',
    'Notice:List',
    'Home:Get',
    'Marathon:Top',
    'User:Get',
    'Migration:List',
  ];
  for (const name of checked) assert.equal(eventRelogAppliesTo(name), true, name);
});

test('the result type is one of fresh/changed', () => {
  const tracker = new SessionFreshnessTracker();
  const first: FreshnessResult = tracker.check('t', 'a');
  const second: FreshnessResult = tracker.check('t', 'b');
  assert.deepEqual([first, second], ['fresh', 'changed']);
});
