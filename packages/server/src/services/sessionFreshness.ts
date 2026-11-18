/**
 * Per-session event-state freshness tracking.
 *
 * Every authenticated session remembers the event-state fingerprint it first
 * saw. When the current fingerprint differs, the next RPC is rejected with a
 * title-screen action so the client re-logs in; the stamp is dropped so the
 * request that follows (and any request after the relog) is allowed again.
 *
 * The map is in-memory: a server restart forgets every stamp, which is exactly
 * what we want (no mass relog on restart). Bounded to avoid unbounded growth
 * from expired/abandoned tokens; the oldest insertion is evicted past the cap
 * (Map iteration order is insertion order).
 */

/** Default cap on tracked sessions; oldest insertion is evicted past this. */
export const DEFAULT_SESSION_FRESHNESS_LIMIT = 10_000;

export type FreshnessResult = 'fresh' | 'changed';

/** In-memory sessionKey → fingerprint map with a bounded size. */
export class SessionFreshnessTracker {
  private readonly stamps = new Map<string, string>();
  private readonly limit: number;

  constructor(limit: number = DEFAULT_SESSION_FRESHNESS_LIMIT) {
    this.limit = limit;
  }

  /** Number of tracked sessions (tests/logging). */
  get size(): number {
    return this.stamps.size;
  }

  /**
   * Compare `fingerprint` against the stamp for `sessionKey`:
   * - no stamp yet: store it and let the request through (fresh login/restart)
   * - same stamp: let it through
   * - different stamp: drop the stamp and report `changed`; the caller rejects
   *   this request, and the next one stamps the new fingerprint and proceeds.
   */
  check(sessionKey: string, fingerprint: string): FreshnessResult {
    const stored = this.stamps.get(sessionKey);
    if (stored === undefined) {
      this.stampNew(sessionKey, fingerprint);
      return 'fresh';
    }
    if (stored === fingerprint) return 'fresh';
    this.stamps.delete(sessionKey);
    return 'changed';
  }

  /** Forget every stamp (tests). */
  clear(): void {
    this.stamps.clear();
  }

  private stampNew(sessionKey: string, fingerprint: string): void {
    if (this.stamps.size >= this.limit) {
      const oldest = this.stamps.keys().next();
      if (!oldest.done) this.stamps.delete(oldest.value);
    }
    this.stamps.set(sessionKey, fingerprint);
  }
}

/** Process-wide tracker used by the RPC dispatch path. */
export const sessionFreshness = new SessionFreshnessTracker();

/** Forget every stamp (tests). */
export function resetSessionFreshnessForTests(): void {
  sessionFreshness.clear();
}

/**
 * RPCs (and RPC prefixes) that run on or before the title screen or as part of
 * login: they must never be forced back to the title screen. Everything else
 * the server already refuses without a session is not exempt.
 */
const EXEMPT_RPC_PREFIXES = ['Auth:', 'Master:'] as const;
const EXEMPT_RPCS: ReadonlySet<string> = new Set(['System:Check']);

/**
 * True when the forced-relog check applies to `name`. Auth/Master cover login
 * and the title-screen master data fetch; System:Check is the boot check the
 * client calls before it has a usable session.
 */
export function eventRelogAppliesTo(name: string): boolean {
  if (EXEMPT_RPCS.has(name)) return false;
  return !EXEMPT_RPC_PREFIXES.some((prefix) => name.startsWith(prefix));
}
