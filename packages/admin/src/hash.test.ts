/**
 * Draft-hash tests: key order must not matter, array order must, and the digest
 * must be a stable 64-character SHA-256 hex string.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJson, draftHash } from './hash.ts';

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('draftHash', () => {
  it('is key-order independent', async () => {
    const left = { name: 'Event', boxGachas: { box1: { items: [{ order: 1 }] } } };
    const right = { boxGachas: { box1: { items: [{ order: 1 }] } }, name: 'Event' };
    const hash = await draftHash(left);
    expect(hash).toBe(await draftHash(right));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a value changes', async () => {
    expect(await draftHash({ name: 'Event' })).not.toBe(await draftHash({ name: 'Event ' }));
  });
});
