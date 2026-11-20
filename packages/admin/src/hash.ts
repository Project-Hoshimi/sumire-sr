/**
 * Canonical JSON + SHA-256 draft hashing, mirrored from
 * `fastify-api/src/services/events/canonicalJson.ts`.
 *
 * The publish preview returns `draftHash`; the screen hashes the detail draft
 * with the same rules to detect a draft that changed between the two reads, and
 * echoes the preview hash back on publish. Keep this encoding in sync with the
 * server module: object keys sorted recursively, array order preserved.
 */

/** Canonical JSON text (JSON.stringify semantics, object keys sorted). */
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
  return undefined;
}

/** SHA-256 hex digest of the canonical JSON encoding of `value`. */
export async function draftHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
