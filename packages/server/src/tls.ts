import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { config } from './config.ts';
import { tlsPaths } from './tlsPaths.ts';

const TLS_PATHS = tlsPaths();
/** `<repo>/tls` in both the private repo and the public `packages/server` export. */
export const DEFAULT_TLS_DIR = TLS_PATHS.tlsDir;
/** `<repo>/packages/tls` in older public exports; null elsewhere. */
export const LEGACY_TLS_DIR = TLS_PATHS.legacyTlsDir;
export const REPO_ROOT = TLS_PATHS.repoRoot;

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
    else {
      console.warn(
        `[tls] WARNING: ignoring invalid HOST ${JSON.stringify(host)}; ` +
          'it is neither an IP address nor a valid DNS name, so it is left out of the certificate SANs.',
      );
    }
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
    LEGACY_TLS_DIR !== null &&
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

  // Every file is produced under a temporary name in the TLS directory and only
  // renamed into place once openssl succeeded, so a failure (bad CA key, killed
  // process) never leaves a half-written api.key/api.crt behind for the partial
  // leaf check to trip over on the next boot.
  const temps = {
    caKey: tempPath(tlsDir, 'ca.key'),
    caCrt: tempPath(tlsDir, 'ca.crt'),
    key: tempPath(tlsDir, 'api.key'),
    csr: tempPath(tlsDir, 'api.csr'),
    ext: tempPath(tlsDir, 'api.ext'),
    crt: tempPath(tlsDir, 'api.crt'),
  };
  const allTemps = Object.values(temps);

  // Private keys must never be readable by others, not even between creation and
  // the chmod() below; 0o077 also keeps the temp files themselves private.
  const previousUmask = process.umask(0o077);
  try {
    if (!hasCaCrt && !hasCaKey) {
      runOpenSsl(openssl, [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
        '-subj', '/CN=Idoly Pride Dev CA',
        '-keyout', temps.caKey,
        '-out', temps.caCrt,
      ]);
      restrictPrivateKeyPermissions(temps.caKey);
      renameSync(temps.caCrt, caCrt);
      renameSync(temps.caKey, caKey);
    } else {
      assertCaPairMatches(openssl, caCrt, caKey, tlsDir);
    }

    runOpenSsl(openssl, [
      'req', '-newkey', 'rsa:2048', '-nodes',
      '-subj', '/CN=api.game-idolypride.jp',
      '-keyout', temps.key,
      '-out', temps.csr,
    ]);
    restrictPrivateKeyPermissions(temps.key);
    writeFileSync(temps.ext, buildSanExtension(host), 'utf8');
    runOpenSsl(openssl, [
      'x509', '-req',
      '-in', temps.csr,
      '-CA', caCrt,
      '-CAkey', caKey,
      // -set_serial keeps openssl from dropping a ca.srl next to the CA.
      '-set_serial', randomSerialNumber(),
      '-out', temps.crt,
      '-days', '3650',
      '-sha256',
      '-extfile', temps.ext,
    ]);
    renameSync(temps.crt, crt);
    renameSync(temps.key, key);
  } finally {
    process.umask(previousUmask);
    for (const path of allTemps) removeIfPresent(path);
    // Intermediates from this and older versions: they must not stay in tls/.
    removeIfPresent(csr);
    removeIfPresent(ext);
    removeIfPresent(join(tlsDir, 'ca.srl'));
  }

  return { key: readFileSync(key), cert: readFileSync(crt), allowHTTP1: true };
}

/** Temporary sibling of `name` in `dir`, unique per process. */
function tempPath(dir: string, name: string): string {
  return join(dir, `${name}.tmp-${process.pid}`);
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** A positive, non-zero 128-bit cert serial for `openssl x509 -set_serial`. */
function randomSerialNumber(): string {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] & 0x7f) | 0x40;
  return `0x${bytes.toString('hex')}`;
}

function captureOpenSsl(openssl: string, args: string[]): { status: number | null; stdout: string } {
  const res = spawnSync(openssl, args, {
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  return { status: res.status, stdout: res.stdout ?? '' };
}

/**
 * Fail loudly when `ca.crt` and `ca.key` are not a pair: signing a leaf with a
 * mismatched key produces a certificate no client can verify, and the error is
 * otherwise only visible much later on the phone.
 */
function assertCaPairMatches(openssl: string, caCrt: string, caKey: string, tlsDir: string): void {
  const fromCert = captureOpenSsl(openssl, ['x509', '-noout', '-pubkey', '-in', caCrt]);
  const fromKey = captureOpenSsl(openssl, ['pkey', '-pubout', '-in', caKey]);
  const normalize = (pem: string): string => pem.replace(/\r/g, '').trim();
  if (
    fromCert.status !== 0 ||
    fromKey.status !== 0 ||
    normalize(fromCert.stdout) !== normalize(fromKey.stdout)
  ) {
    throw new Error(
      `CA files in ${tlsDir} do not belong together: ca.crt and ca.key hold different keys ` +
        '(or one of them is unreadable). Restore the matching pair, or remove both files to ' +
        'generate a new CA (clients will have to trust the new ca.crt).',
    );
  }
}
