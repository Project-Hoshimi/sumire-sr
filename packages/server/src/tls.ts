import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { config } from './config.ts';

const TLS_DIR = join(import.meta.dirname, '..', '..', '..', 'tls');
const CA_KEY = join(TLS_DIR, 'ca.key');
const CA_CRT = join(TLS_DIR, 'ca.crt');
const KEY = join(TLS_DIR, 'api.key');
const CSR = join(TLS_DIR, 'api.csr');
const EXT = join(TLS_DIR, 'api.ext');
const CRT = join(TLS_DIR, 'api.crt');

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
  if (res.status !== 0) {
    throw new Error(`openssl ${args[0]} failed (exit ${res.status}): ${res.stderr || res.error?.message || ''}`);
  }
}

function buildSanExtension(): string {
  const dns = new Set<string>(GAME_DNS_SANS);
  const ips = new Set<string>(['127.0.0.1']);

  if (config.host && config.host !== '0.0.0.0' && config.host !== '::') {
    if (isIP(config.host)) ips.add(config.host);
    else dns.add(config.host);
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
 * Ensure the dev CA (`tls/ca.crt`) and leaf certificate (`tls/api.crt`) exist.
 * When missing, generates a private dev CA and signs the leaf certificate with
 * all game, master, Octo, and Firebase Auth emulation SANs so fresh clones work
 * across Linux, macOS, and Windows without manual openssl steps.
 */
export function ensureTlsCert(): { key: Buffer; cert: Buffer; allowHTTP1: boolean } {
  if (existsSync(KEY) && existsSync(CRT) && existsSync(CA_CRT)) {
    return { key: readFileSync(KEY), cert: readFileSync(CRT), allowHTTP1: true };
  }
  mkdirSync(TLS_DIR, { recursive: true });
  const openssl = findOpenSsl();

  if (!existsSync(CA_KEY) || !existsSync(CA_CRT)) {
    runOpenSsl(openssl, [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-subj', '/CN=Idoly Pride Dev CA',
      '-keyout', CA_KEY,
      '-out', CA_CRT,
    ]);
  }

  runOpenSsl(openssl, [
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-subj', '/CN=api.game-idolypride.jp',
    '-keyout', KEY,
    '-out', CSR,
  ]);
  writeFileSync(EXT, buildSanExtension(), 'utf8');
  runOpenSsl(openssl, [
    'x509', '-req',
    '-in', CSR,
    '-CA', CA_CRT,
    '-CAkey', CA_KEY,
    '-CAcreateserial',
    '-out', CRT,
    '-days', '3650',
    '-sha256',
    '-extfile', EXT,
  ]);

  return { key: readFileSync(KEY), cert: readFileSync(CRT), allowHTTP1: true };
}
