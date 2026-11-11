import { createHash, createPublicKey, createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.ts';

const b64url = (buf: Buffer) => buf.toString('base64url');
const unb64url = (s: string) => Buffer.from(s, 'base64url');

export type JwtClaims = {
  sub: string;
  seedId?: string;
  uid?: string;
  email?: string;
  isR?: boolean;
  /** Set on guest sessions (invite/closed mode): `sub` is not an account id. */
  guest?: boolean;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
  [k: string]: unknown;
};

/** Short, log-safe identifier for a public key (SHA-256 of its SPKI DER). */
function fingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

function loadOrCreateKeys(): { privateKeyPem: string; publicKeyPem: string } {
  if (config.jwt.privateKeyPem && config.jwt.publicKeyPem) {
    console.log(`[jwt] key pair from JWT_PRIVATE_KEY_PEM (public sha256:${fingerprint(config.jwt.publicKeyPem)})`);
    return { privateKeyPem: config.jwt.privateKeyPem, publicKeyPem: config.jwt.publicKeyPem };
  }
  const privPath = config.jwtPrivateKeyPath;
  if (existsSync(privPath)) {
    const privateKeyPem = readFileSync(privPath, 'utf8');
    // Derive the public half from the private key: only the private key file is
    // authoritative, so a deployment only has to provision one secret.
    const publicKeyPem = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }) as string;
    console.log(`[jwt] key pair from ${privPath} (public sha256:${fingerprint(publicKeyPem)})`);
    return { privateKeyPem, publicKeyPem };
  }
  mkdirSync(dirname(privPath), { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(privPath, privateKey, { mode: 0o600 });
  // Never rotate the key silently: a fresh key invalidates every GameAuthToken
  // this server ever issued, which clients experience as a failing API call
  // until they log in again.
  console.warn(
    [
      '',
      '[jwt] ==================================================================',
      `[jwt] WARNING: no JWT key pair at ${privPath}`,
      '[jwt] A NEW RSA key pair was generated. Every GameAuthToken issued',
      '[jwt] before this moment is now invalid and clients must log in again.',
      '[jwt] Keep this file (git-ignored) stable across restarts and point all',
      '[jwt] server processes at the same key via JWT_PRIVATE_KEY_PATH — see',
      '[jwt] .env.example.',
      '[jwt] ==================================================================',
      '',
    ].join('\n'),
  );
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

let memo: { privateKeyPem: string; publicKeyPem: string } | null = null;
const keys = () => (memo ??= loadOrCreateKeys());

/**
 * Drop the in-process key cache so the next operation re-reads the key from
 * disk. A real restart does the same; tests use it to simulate one.
 */
export function resetKeyCache(): void {
  memo = null;
}

/** Where the key pair currently in use came from (for startup logging/tests). */
export function keySource(): string {
  return config.jwt.privateKeyPem ? '<JWT_PRIVATE_KEY_PEM>' : config.jwtPrivateKeyPath;
}

/** Log-safe fingerprint of the public key currently in use. */
export function publicKeyFingerprint(): string {
  return fingerprint(keys().publicKeyPem);
}

/** Mint a self-issued RS256 JWT (replaces Firebase securetoken chain, §3.4). */
export function mintToken(payload: { sub: string; seedId?: string } & Partial<JwtClaims>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const body = b64url(
    Buffer.from(
      JSON.stringify({
        iss: config.jwt.issuer,
        aud: config.jwt.audience,
        iat: now,
        exp: now + config.jwt.ttlSeconds,
        ...payload,
      }),
    ),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${b64url(signer.sign(keys().privateKeyPem))}`;
}

export type VerifyResult = { ok: true; claims: JwtClaims } | { ok: false; reason: string };

/** Verify a self-issued JWT (RS256, iss/aud/exp checked). */
export function verifyToken(token: string): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  try {
    const [h, b, s] = parts;
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${b}`);
    if (!verifier.verify(keys().publicKeyPem, unb64url(s))) {
      return { ok: false, reason: 'bad signature' };
    }
    const claims = JSON.parse(unb64url(b).toString('utf8')) as JwtClaims;
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp !== undefined && now >= claims.exp) return { ok: false, reason: 'expired' };
    if (claims.aud !== undefined && claims.aud !== config.jwt.audience) return { ok: false, reason: 'bad audience' };
    return { ok: true, claims };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? 'error' };
  }
}

export type JwtVerifyResult =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; reason: string };

export type JwtSignOptions = {
  /** JOSE `typ` header. Defaults to `JWT`. */
  typ?: string;
  /** Optional `kid` header, e.g. the Firebase emulator key id. */
  kid?: string;
};

/**
 * Sign an arbitrary claim set as an RS256 JWT with the server key pair.
 * Shared by the Firebase emulation tokens (custom / id / refresh), which all
 * use different `iss`/`aud` values than the game auth token.
 */
export function signJwt(claims: Record<string, unknown>, opts: JwtSignOptions = {}): string {
  const header: Record<string, unknown> = { alg: 'RS256', typ: opts.typ ?? 'JWT' };
  if (opts.kid) header.kid = opts.kid;
  const encodedHeader = b64url(Buffer.from(JSON.stringify(header)));
  const encodedBody = b64url(Buffer.from(JSON.stringify(claims)));
  const signer = createSign('RSA-SHA256');
  signer.update(`${encodedHeader}.${encodedBody}`);
  return `${encodedHeader}.${encodedBody}.${b64url(signer.sign(keys().privateKeyPem))}`;
}

export type JwtVerifyOptions = {
  /** Expected `aud` (or one of them). Pass `false` to skip the audience check. */
  audience?: string | string[] | false;
  /** Expected `iss` (or one of them). Pass `false` to skip the issuer check. */
  issuer?: string | string[] | false;
  /** Expected claim named `typ` (e.g. `refresh`). */
  typ?: string;
};

function claimIn(value: unknown, expected: string | string[]): boolean {
  if (typeof value !== 'string') return false;
  return Array.isArray(expected) ? expected.includes(value) : value === expected;
}

/**
 * Verify an RS256 JWT signed with the server key pair. `exp`/`nbf` are always
 * checked when present; `aud`/`iss` are checked when requested.
 */
export function verifyJwt(token: string, opts: JwtVerifyOptions = {}): JwtVerifyResult {
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  try {
    const [h, b, s] = parts;
    const header = JSON.parse(unb64url(h).toString('utf8')) as { alg?: unknown };
    if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported alg' };
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${b}`);
    if (!verifier.verify(keys().publicKeyPem, unb64url(s))) {
      return { ok: false, reason: 'bad signature' };
    }
    const claims = JSON.parse(unb64url(b).toString('utf8')) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === 'number' && now >= claims.exp) return { ok: false, reason: 'expired' };
    if (typeof claims.nbf === 'number' && now < claims.nbf) return { ok: false, reason: 'not yet valid' };
    if (opts.audience !== undefined && opts.audience !== false) {
      if (!claimIn(claims.aud, opts.audience)) return { ok: false, reason: 'bad audience' };
    }
    if (opts.issuer !== undefined && opts.issuer !== false) {
      if (!claimIn(claims.iss, opts.issuer)) return { ok: false, reason: 'bad issuer' };
    }
    if (opts.typ !== undefined && claims.typ !== opts.typ) return { ok: false, reason: 'bad type' };
    return { ok: true, claims };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? 'error' };
  }
}

/** Parse `Bearer <jwt>` or bare JWT from a header value. */
export function extractBearer(header?: string): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : header.trim();
}