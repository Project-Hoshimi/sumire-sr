// Canonical JSON and draft-hash tests: key order must not matter, array order
// must, and the hash must be stable across structurally equal drafts.
//
//   node --test src/services/events/canonicalJson.test.ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalJson, draftHash } from './canonicalJson.ts';

test('canonicalJson sorts object keys recursively', () => {
  const left = { b: 2, a: { d: 4, c: 3 } };
  const right = { a: { c: 3, d: 4 }, b: 2 };
  assert.equal(canonicalJson(left), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(canonicalJson(left), canonicalJson(right));
});

test('canonicalJson preserves array order', () => {
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  assert.notEqual(canonicalJson([3, 1, 2]), canonicalJson([1, 2, 3]));
});

test('canonicalJson keeps JSON.stringify semantics for undefined', () => {
  assert.equal(canonicalJson({ keep: 1, drop: undefined }), '{"keep":1}');
  assert.equal(canonicalJson([undefined, 1]), '[null,1]');
});

test('draftHash is key-order independent', () => {
  const left = { name: 'Event', boxGachas: { box1: { items: [{ order: 1 }] } } };
  const right = { boxGachas: { box1: { items: [{ order: 1 }] } }, name: 'Event' };
  assert.equal(draftHash(left), draftHash(right));
  assert.match(draftHash(left), /^[0-9a-f]{64}$/);
});

test('draftHash differs when a value differs', () => {
  assert.notEqual(draftHash({ name: 'Event' }), draftHash({ name: 'Event ' }));
});

test('draftHash matches an independent SHA-256 of the canonical text', () => {
  const value = { z: [true, null, 'x'], a: 1 };
  const expected = createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
  assert.equal(draftHash(value), expected);
});
