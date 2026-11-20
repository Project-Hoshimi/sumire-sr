/**
 * Canonical JSON and content hashing for event drafts.
 *
 * The publish preview and the publish request must agree on exactly the same
 * draft. `draftHash` is the SHA-256 hex digest of a canonical JSON encoding:
 * object keys are sorted recursively so two structurally equal drafts hash the
 * same regardless of key order, while array order and values are preserved.
 *
 * The admin UI mirrors this module in `admin/src/hash.ts` because it computes
 * the same hash with `crypto.subtle`.
 */
import { createHash } from 'node:crypto';

/**
 * Canonical JSON text for `value` (JSON.stringify semantics, object keys sorted
 * recursively). `undefined` inside an object is omitted, as JSON.stringify does;
 * `undefined` inside an array becomes `null`.
 */
export function canonicalJson(value: unknown): string {
  return canonicalText(value) ?? 'null';
}

function canonicalText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalText(entry) ?? 'null').join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalText(entry) ?? 'null'}`)
      .join(',')}}`;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  // undefined, functions and symbols have no JSON text of their own.
  return undefined;
}

/** SHA-256 hex digest of the canonical JSON encoding of `value`. */
export function draftHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
