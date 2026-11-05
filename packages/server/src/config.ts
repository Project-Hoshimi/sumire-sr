import 'dotenv/config';
import { join, resolve } from 'node:path';

/**
 * Root of the data tree: the directory that holds `captures/`, `phaseA2/` and
 * `phase3d/`. Defaults to the repository root (computed from this file) so an
 * unset environment behaves exactly as before. `SUMIRE_DATA_DIR` must point at
 * an absolute path; relative values are resolved against the process cwd.
 */
export const DATA_DIR = process.env.SUMIRE_DATA_DIR
  ? resolve(process.env.SUMIRE_DATA_DIR)
  : resolve(import.meta.dirname, '..', '..');

export const config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  apiHost: process.env.API_HOST ?? 'api.octo-cloud.com',
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'https://api.game-idolypride.jp',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://idoly:idoly_dev_pw@127.0.0.1:5432/idoly',
  http2: process.env.HTTP2 === '1',
  tls: process.env.TLS === '1',
  debugRpc: process.env.DEBUG_RPC === '1',
  /** `empty` keeps the legacy empty-success reply for RPCs with no handler. */
  unhandledRpc: process.env.SUMIRE_UNHANDLED_RPC ?? 'error',
  jwt: {
    privateKeyPem: process.env.JWT_PRIVATE_KEY_PEM ?? '',
    publicKeyPem: process.env.JWT_PUBLIC_KEY_PEM ?? '',
    issuer: process.env.JWT_ISSUER ?? 'idoly-pride-dev',
    audience: process.env.JWT_AUDIENCE ?? 'idoly-pride-dev',
    ttlSeconds: Number(process.env.JWT_TTL_SECONDS ?? 7 * 24 * 3600),
  },
  masterDbPath: process.env.MASTER_DB_PATH ?? join(DATA_DIR, 'phaseA2', 'master.db'),
  jwtPrivateKeyPath: process.env.JWT_PRIVATE_KEY_PATH
    ? resolve(process.env.JWT_PRIVATE_KEY_PATH)
    : join(import.meta.dirname, '..', 'keys', 'jwt-private.pem'),
  // Root for server-stored resources (Solis `config.GetResourceDir()`); uploaded
  // photo images live under `<resourceDir>/Photo/<publicUserId>/<file>.jpg`.
  resourceDir: resolve(import.meta.dirname, '..', process.env.RESOURCE_DIR ?? 'data'),
  // Local asset mirror (docs/ASSET_MIRROR.md): directory of already-extracted
  // final artifacts served at `GET /assets/*`. Empty (unset) disables the route.
  assetMirrorDir: process.env.SUMIRE_ASSET_MIRROR_DIR ? resolve(process.env.SUMIRE_ASSET_MIRROR_DIR) : '',
};

export function hasJwtKeys(): boolean {
  return config.jwt.privateKeyPem.length > 0 && config.jwt.publicKeyPem.length > 0;
}

/**
 * Who may get an account: `open` auto-creates one on `Auth:Login` (the
 * pre-invite behaviour), `invite` only admits accounts created through an
 * invite link, `closed` additionally refuses new invite accounts. Read on every
 * call rather than at import time so tests can switch modes in one process.
 */
export type RegistrationMode = 'open' | 'invite' | 'closed';

export function registrationMode(): RegistrationMode {
  const raw = process.env.SUMIRE_REGISTRATION ?? 'open';
  if (raw === 'open' || raw === 'invite' || raw === 'closed') return raw;
  throw new Error(`SUMIRE_REGISTRATION must be open, invite or closed (got ${JSON.stringify(raw)})`);
}

/** Bearer token for `/sumire/admin/*`; empty disables those routes (404). */
export const ADMIN_TOKEN = process.env.SUMIRE_ADMIN_TOKEN || '';

/** Base URL used to build invite links; empty derives it from the request host. */
export const PUBLIC_URL = process.env.SUMIRE_PUBLIC_URL || '';