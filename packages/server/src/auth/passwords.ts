/**
 * Link passwords and one-time transfer tokens (docs/LOGIN_FLOW.md §1).
 *
 * Passwords are scrypt hashes (`scrypt$N$r$p$saltB64$hashB64`); invite and
 * one-time tokens are only ever stored as SHA-256 hex digests. Nothing in this
 * module logs or returns a plaintext password.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** scrypt cost parameters; `N` must be a power of two. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

const LINK_PASSWORD = /^[A-Za-z0-9]{8,16}$/;

/** The game accepts exactly 8–16 ASCII letters/digits as a link password. */
export function isValidLinkPassword(password: unknown): password is string {
  return typeof password === 'string' && LINK_PASSWORD.test(password);
}

/** Hash a link password into the `scrypt$N$r$p$saltB64$hashB64` form. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(password, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/**
 * Check `password` against a stored hash. Malformed hashes and any parse error
 * return false instead of throwing, so a corrupt row cannot take the RPC down.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = scryptSync(password, salt, expected.length, { N: n, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Fixed hash used when the account or credential row is missing, so a failed
 * `Migration:MigratePassword` spends the same scrypt time as a wrong password
 * and does not leak whether the user id exists.
 */
export const DUMMY_PASSWORD_HASH = hashPassword('dummy-password-0000');

/** 128-bit URL-safe token (invite links and one-time transfer tokens). */
export function randomToken(): string {
  return randomBytes(16).toString('base64url');
}

/** Hex SHA-256 of a token; only this digest is stored. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Random password that satisfies `isValidLinkPassword` (admin reset, 12 chars). */
export function generateLinkPassword(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  return out;
}
