/**
 * Server-wide runtime profile.
 *
 * `sandbox` is the default: a maxed-out private sandbox (see
 * `src/profiles/sandbox/`). `official` preserves the original game behaviour
 * and must be selected explicitly until the full mode is built. The profile is
 * selected once at import time via `SUMIRE_PROFILE`; anything other than the
 * two known values is a configuration error and fails fast instead of silently
 * running with the wrong behaviour.
 */
export type Profile = 'sandbox' | 'official';

/**
 * Parse a raw `SUMIRE_PROFILE` value. Exported so the sandbox tests can cover
 * the validation without spawning a process or mutating `process.env`.
 */
export function parseProfile(value: string | undefined): Profile {
  if (value === undefined) return 'sandbox';
  if (value === 'sandbox' || value === 'official') return value;
  throw new Error(
    `Invalid SUMIRE_PROFILE ${JSON.stringify(value)}: expected "sandbox" or "official" (or leave it unset for "sandbox")`,
  );
}

export const PROFILE: Profile = parseProfile(process.env.SUMIRE_PROFILE);

export function isSandbox(): boolean {
  return PROFILE === 'sandbox';
}
