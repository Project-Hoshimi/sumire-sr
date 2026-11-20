import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { config } from './config.ts';

export const DEFAULT_TLS_DIR = join(import.meta.dirname, '..', '..', '..', 'tls');
const LEGACY_TLS_DIR = join(import.meta.dirname, '..', '..', 'tls');

const GAME_DNS_SANS = [
  'api.game-idolypride.jp',
  'climaster.game-idolypride.jp',
  'api.octo-cloud.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'www.googleapis.com',
  'firebasestorage.googleapis.com',
  'localhost',
];

const VALID_HOSTNAME_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** Locate the openssl binary, falling back to Git for Windows on win32. */
export function findOpenSsl(): string {
  const probe = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  if (probe.status === 0) return 'openssl';
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
      'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'openssl';
}

function runOpenSsl(openssl: string, args: string[]): void {
  const res = spawnSync(openssl, args, {
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  const errCode = (res.error as NodeJS.ErrnoException | undefined)?.code;
  if (errCode === 'ENOENT') {
    const hint =
      process.platform === 'win32'
        ? 'Install OpenSSL or Git for Windows (which bundles openssl.exe) and ensure it is on PATH.'
        : 'Install openssl and ensure it is on PATH.';
    throw new Error(`openssl binary not found (${openssl}): ${hint}`);
  }
  if (res.status !== 0) {
    throw new Error(`openssl ${args[0]} failed (exit ${res.status}): ${res.stderr || res.error?.message || ''}`);
  }
}

function restrictPrivateKeyPermissions(path: string): void {
  if (process.platform !== 'win32') {
    chmodSync(path, 0o600);
  }
}

export function buildSanExtension(host: string = config.host): string {
  const dns = new Set<string>(GAME_DNS_SANS);
  const ips = new Set<string>(['127.0.0.1']);

  if (host && host !== '0.0.0.0' && host !== '::') {
    if (isIP(host)) ips.add(host);
    else if (VALID_HOSTNAME_RE.test(host)) dns.add(host);
  }

  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (!iface.internal && iface.family === 'IPv4' && iface.address) {
        ips.add(iface.address);
      }
    }
  }

  const entries = [
    ...[...dns].map((d) => `DNS:${d}`),
    ...[...ips].map((ip) => `IP:${ip}`),
  ];
  return [
    `subjectAltName=${entries.join(',')}`,
    'extendedKeyUsage=serverAuth',
    'keyUsage=digitalSignature,keyEncipherment',
    '',
  ].join('\n');
}

/**
 * Ensure the TLS key and certificate exist in `tlsDir` (default `<repo>/tls`).
 * Never overwrites existing TLS files:
 * - If `api.key` and `api.crt` already exist, returns them as-is.
 * - If only one of `api.key`/`api.crt` exists, throws instead of overwriting.
 * - If `api.key`/`api.crt` are absent and a complete CA (`ca.crt` + `ca.key`)
 *   exists, signs a new leaf with the existing CA.
 * - If only one of `ca.crt`/`ca.key` exists, throws instead of regenerating and
 *   invalidating clients that already trust `ca.crt`.
 * - If none of the four files exist, generates a private dev CA and signs a
 *   leaf cert with game, master, Octo, Firebase Auth emulation, and LAN SANs.
 */
export function ensureTlsCert(
  tlsDir: string = DEFAULT_TLS_DIR,
  host: string = config.host,
): { key: Buffer; cert: Buffer; allowHTTP1: boolean } {
  const caKey = join(tlsDir, 'ca.key');
  const caCrt = join(tlsDir, 'ca.crt');
  const key = join(tlsDir, 'api.key');
  const csr = join(tlsDir, 'api.csr');
  const ext = join(tlsDir, 'api.ext');
  const crt = join(tlsDir, 'api.crt');

  if (
    tlsDir === DEFAULT_TLS_DIR &&
    (existsSync(join(LEGACY_TLS_DIR, 'api.crt')) || existsSync(join(LEGACY_TLS_DIR, 'ca.crt')))
  ) {
    console.warn(
      `[tls] WARNING: found legacy TLS files in ${LEGACY_TLS_DIR}. ` +
        `sumire-sr now reads TLS certificates from ${DEFAULT_TLS_DIR}. ` +
        `Move your existing files there to keep your current CA and avoid re-trusting on clients.`,
    );
  }

  const hasKey = existsSync(key);
  const hasCrt = existsSync(crt);
  if (hasKey && hasCrt) {
    return { key: readFileSync(key), cert: readFileSync(crt), allowHTTP1: true };
  }
  if (hasKey !== hasCrt) {
    const present = hasKey ? key : crt;
    const missing = hasKey ? crt : key;
    throw new Error(
      `incomplete TLS leaf pair in ${tlsDir}: found ${present} without ${missing}; ` +
        `restore the missing file or remove the partial pair to regenerate`,
    );
  }

  const hasCaKey = existsSync(caKey);
  const hasCaCrt = existsSync(caCrt);
  if (hasCaCrt && !hasCaKey) {
    throw new Error(
      `found ${caCrt} without ${caKey}; cannot sign a new server certificate without the CA private key ` +
        `(refusing to overwrite existing CA)`,
    );
  }
  if (!hasCaCrt && hasCaKey) {
    throw new Error(
      `found ${caKey} without ${caCrt}; refusing to overwrite existing CA private key`,
    );
  }

  mkdirSync(tlsDir, { recursive: true });
  const openssl = findOpenSsl();

  if (!hasCaCrt && !hasCaKey) {
    runOpenSsl(openssl, [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-subj', '/CN=Idoly Pride Dev CA',
      '-keyout', caKey,
      '-out', caCrt,
    ]);
    restrictPrivateKeyPermissions(caKey);
  }

  runOpenSsl(openssl, [
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-subj', '/CN=api.game-idolypride.jp',
    '-keyout', key,
    '-out', csr,
  ]);
  restrictPrivateKeyPermissions(key);
  writeFileSync(ext, buildSanExtension(host), 'utf8');
  runOpenSsl(openssl, [
    'x509', '-req',
    '-in', csr,
    '-CA', caCrt,
    '-CAkey', caKey,
    '-CAcreateserial',
    '-out', crt,
    '-days', '3650',
    '-sha256',
    '-extfile', ext,
  ]);

  return { key: readFileSync(key), cert: readFileSync(crt), allowHTTP1: true };
}
