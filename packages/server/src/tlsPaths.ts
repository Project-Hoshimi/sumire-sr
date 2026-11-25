import { basename, dirname, join } from 'node:path';

/**
 * Where the TLS material lives for the current layout.
 *
 * This file exists on its own (rather than inside `tls.ts`) because `tls.ts`
 * imports `config.ts`; `config.ts` importing the helper back out of `tls.ts`
 * would create an import cycle.
 *
 * Two layouts ship the same source:
 * - private repo: `fastify-api/src` -> package dir `<repo>/fastify-api`, so the
 *   TLS directory is `<repo>/tls`.
 * - public export: `packages/server/src` -> package dir `<repo>/packages/server`,
 *   whose parent is named `packages`; the repository root is one level above it
 *   and the TLS directory is still `<repo>/tls`. Older exports kept the files in
 *   `<repo>/packages/tls`, which is only reported as a legacy location.
 */
export interface TlsPaths {
  /** Repository root that holds `tls/`. */
  repoRoot: string;
  /** Directory `ensureTlsCert()` reads and writes (`<repoRoot>/tls`). */
  tlsDir: string;
  /** Pre-1.0 location inside the public export, or null when it cannot exist. */
  legacyTlsDir: string | null;
}

export function tlsPaths(): TlsPaths {
  const pkgDir = join(import.meta.dirname, '..');
  const parent = dirname(pkgDir);
  if (basename(parent) === 'packages') {
    const repoRoot = dirname(parent);
    return { repoRoot, tlsDir: join(repoRoot, 'tls'), legacyTlsDir: join(parent, 'tls') };
  }
  return { repoRoot: parent, tlsDir: join(parent, 'tls'), legacyTlsDir: null };
}
