/**
 * Postgres unique-constraint detection shared by the Drizzle stores.
 *
 * Drizzle wraps driver errors, so the SQLSTATE may sit a few `cause` levels
 * below the error the caller sees. Inspect a bounded chain: a shorter one is
 * enough for every driver this server uses, and the bound keeps a cyclic cause
 * chain from looping forever.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
