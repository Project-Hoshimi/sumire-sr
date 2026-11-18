// Inline reward reference parsing. Pure unit tests; no database.
//
//   node --test src/master/reward.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInlineRewardRef, parseRewardRef, ResourceTypeValue, resourceTypeSnakeName } from './reward.ts';

test('parses a valid inline item reward', () => {
  assert.deepEqual(parseInlineRewardRef('rd_auto;item;item-gacha_ticket;1'), [
    { resourceType: 1, resourceId: 'item-gacha_ticket', amount: 1 },
  ]);
});

test('parses a valid inline reward with an empty resource id', () => {
  assert.deepEqual(parseInlineRewardRef('rd_auto;stone;;100'), [
    { resourceType: 15, resourceId: '', amount: 100 },
  ]);
});

test('returns null for a non-inline reference', () => {
  assert.equal(parseInlineRewardRef('rd_backside-21-0831-mission-clear_count'), null);
  assert.equal(parseInlineRewardRef(''), null);
});

test('returns [] for an inline reference with an unknown type', () => {
  assert.deepEqual(parseInlineRewardRef('rd_auto;bogus;;1'), []);
});

test('every mapped resource type round-trips through rd_auto', () => {
  const entries = Object.entries(ResourceTypeValue).filter(([, value]) => value !== 0);
  assert.ok(entries.length >= 30, `only ${entries.length} mapped types`);
  for (const [snakeName, resourceType] of entries) {
    assert.equal(resourceTypeSnakeName(resourceType), snakeName, snakeName);
    const ref = `rd_auto;${snakeName};res-${resourceType};7`;
    assert.deepEqual(
      parseInlineRewardRef(ref),
      [{ resourceType, resourceId: `res-${resourceType}`, amount: 7 }],
      snakeName,
    );
  }
  // Type 0 (Unknown) is not a grantable resource, so it deliberately fails.
  assert.equal(resourceTypeSnakeName(0), 'unknown');
  assert.deepEqual(parseInlineRewardRef('rd_auto;unknown;res;1'), []);
});

test('a bad amount becomes 0, a missing amount becomes 1', () => {
  // Existing behaviour: Number(amount) || 0, with a default of '1' when the
  // segment is absent. Pinned so a refactor cannot silently change it.
  assert.deepEqual(parseInlineRewardRef('rd_auto;item;item-a;abc'), [
    { resourceType: 1, resourceId: 'item-a', amount: 0 },
  ]);
  assert.deepEqual(parseInlineRewardRef('rd_auto;item;item-a;'), [
    { resourceType: 1, resourceId: 'item-a', amount: 0 },
  ]);
  assert.deepEqual(parseInlineRewardRef('rd_auto;item;item-a'), [
    { resourceType: 1, resourceId: 'item-a', amount: 1 },
  ]);
});

test('parseRewardRef returns [] for an empty reference', async () => {
  assert.deepEqual(await parseRewardRef(''), []);
});

test('parseRewardRef resolves the inline branch without a DB read', async () => {
  assert.deepEqual(await parseRewardRef('rd_auto;item;item-a;3'), [
    { resourceType: 1, resourceId: 'item-a', amount: 3 },
  ]);
  assert.deepEqual(await parseRewardRef('rd_auto;bogus;;1'), []);
});
