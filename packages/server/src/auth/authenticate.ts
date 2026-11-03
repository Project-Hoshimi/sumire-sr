import { verifyToken, extractBearer, type JwtClaims } from './jwt.ts';

export type AuthState = { ok: boolean; claims?: JwtClaims; reason?: string };

/**
 * A verified guest session (invite/closed mode): the token is valid, but its
 * `sub` is not an account id and must never be used to load player state.
 */
export function isGuestAuth(auth: AuthState): boolean {
  return auth.ok === true && auth.claims?.guest === true;
}

export function authenticate(authHeader?: string): AuthState {
  const token = extractBearer(authHeader);
  if (!token) return { ok: false, reason: 'missing token' };
  const result = verifyToken(token);
  if (result.ok) return { ok: true, claims: result.claims };
  return { ok: false, reason: result.reason };
}