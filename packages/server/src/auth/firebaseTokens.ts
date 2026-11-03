import { randomInt } from 'node:crypto';
import { signJwt, verifyJwt } from './jwt.ts';

// Firebase project emulated by this server. The game client is redirected here
// for identitytoolkit / securetoken, so we mint the same token shapes Google
// would, signed with our own RS256 key pair.
export const FIREBASE_PROJECT_ID = 'solis-firebase';
export const FIREBASE_ADMIN_ISSUER = 'firebase-adminsdk@sumire-sr.local';
export const IDENTITY_TOOLKIT_AUD =
  'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
export const SECURE_TOKEN_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
export const ID_TOKEN_KID = 'sumire-sr';

/** Custom / ID tokens live for one hour, like Firebase's. */
export const TOKEN_TTL_SECONDS = 3600;
/** Refresh tokens are stateless JWTs with a long life (no DB table). */
export const REFRESH_TOKEN_TTL_SECONDS = 365 * 24 * 3600;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Generate a Firebase-style UID: 28 base62 characters. */
export function generateFirebaseUid(length = 28): string {
  let out = '';
  for (let i = 0; i < length; i++) out += BASE62[randomInt(BASE62.length)];
  return out;
}

/**
 * Mint a Firebase custom token. The client exchanges it at
 * `signInWithCustomToken` for an ID token + refresh token.
 */
export function mintCustomToken(uid: string, iat: number = nowSeconds()): string {
  return signJwt({
    iss: FIREBASE_ADMIN_ISSUER,
    sub: FIREBASE_ADMIN_ISSUER,
    aud: IDENTITY_TOOLKIT_AUD,
    uid,
    iat,
    exp: iat + TOKEN_TTL_SECONDS,
  });
}

export type VerifiedUidToken = { uid: string; claims: Record<string, unknown> };

/** Verify a custom token minted by us and return its UID, or null. */
export function verifyCustomToken(token: string): VerifiedUidToken | null {
  const result = verifyJwt(token, { audience: IDENTITY_TOOLKIT_AUD, issuer: FIREBASE_ADMIN_ISSUER });
  if (!result.ok) return null;
  const { uid, sub } = result.claims;
  if (sub !== FIREBASE_ADMIN_ISSUER) return null;
  if (typeof uid !== 'string' || uid.length === 0) return null;
  return { uid, claims: result.claims };
}

/**
 * Mint a Firebase ID token with the official claim shape. `parseFirebaseUid`
 * reads `user_id`, so `Auth:Login` accepts these unchanged. Like Solis
 * (securetoken / verifyCustomToken), the token carries the player's public
 * user id as `puid` once the account exists; the emulated Firebase Storage
 * uses it to authorise `Photo/<puid>/...` objects.
 */
export function mintIdToken(uid: string, iat: number = nowSeconds(), puid?: string): string {
  return signJwt(
    {
      ...(puid ? { puid } : {}),
      iss: SECURE_TOKEN_ISSUER,
      aud: FIREBASE_PROJECT_ID,
      auth_time: iat,
      user_id: uid,
      sub: uid,
      iat,
      exp: iat + TOKEN_TTL_SECONDS,
      firebase: { identities: {}, sign_in_provider: 'custom' },
    },
    { kid: ID_TOKEN_KID },
  );
}

/** Verify an ID token minted by us and return its UID, or null. */
export function verifyIdToken(token: string): VerifiedUidToken | null {
  const result = verifyJwt(token, {
    audience: FIREBASE_PROJECT_ID,
    issuer: SECURE_TOKEN_ISSUER,
  });
  if (!result.ok) return null;
  const uid = typeof result.claims.user_id === 'string' ? result.claims.user_id : result.claims.sub;
  if (typeof uid !== 'string' || uid.length === 0) return null;
  return { uid, claims: result.claims };
}

/** Mint a stateless refresh token (`{typ:'refresh', uid}`). */
export function mintRefreshToken(uid: string, iat: number = nowSeconds()): string {
  return signJwt({
    typ: 'refresh',
    uid,
    iat,
    exp: iat + REFRESH_TOKEN_TTL_SECONDS,
  });
}

/** Verify a refresh token minted by us and return its UID, or null. */
export function verifyRefreshToken(token: string): VerifiedUidToken | null {
  const result = verifyJwt(token, { typ: 'refresh' });
  if (!result.ok) return null;
  const { uid } = result.claims;
  if (typeof uid !== 'string' || uid.length === 0) return null;
  return { uid, claims: result.claims };
}
