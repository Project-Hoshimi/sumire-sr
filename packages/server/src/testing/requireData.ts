import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { DATA_DIR, config } from '../config.ts';

export type DataRequirements = {
  /** Require `$SUMIRE_DATA_DIR/captures` (default: true). */
  captures?: boolean;
  /** Require recorded requests too; the published data ships responses only. */
  requestCaptures?: boolean;
  /** Require a reachable PostgreSQL listener at `DATABASE_URL` (default: false). */
  db?: boolean;
};

function skip(reason: string): never {
  console.log(`skipped: set SUMIRE_DATA_DIR / DATABASE_URL (${reason})`);
  process.exit(0);
}

function tcpReachable(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve(false);
      return;
    }
    const socket = connect({
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
    });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Gate a data-dependent test entry point. Prints a single clear line and exits
 * 0 when the required private inputs are absent, so `npm run check` stays green
 * on a clean public clone while the full suite remains runnable with data.
 */
export async function requireData(opts: DataRequirements = {}): Promise<void> {
  if (opts.captures !== false) {
    const captures = join(DATA_DIR, 'captures');
    if (!existsSync(captures)) skip(`no captures at ${captures}`);
  }
  if (opts.requestCaptures) {
    const request = join(DATA_DIR, 'captures', '2026-09-14_a12r', 'raw', '00002.req-plain.Auth:Login.bin');
    if (!existsSync(request)) skip(`needs recorded requests, not in the published data: ${request}`);
  }
  if (opts.db) {
    if (!(await tcpReachable(config.databaseUrl))) {
      skip(`database unreachable at ${config.databaseUrl}`);
    }
  }
}
