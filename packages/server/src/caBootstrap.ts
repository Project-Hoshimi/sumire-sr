import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { tlsCaCertPath } from './config.ts';

/**
 * Client CA bootstrap.
 *
 * The game client does not know the private dev CA (`tls/ca.crt`) in advance.
 * These unauthenticated routes let it fetch the CA and its fingerprint over the
 * same HTTPS listener (8443) it already talks to, for any Host/SNI. They are
 * registered before the Firebase emulation and the gRPC catch-alls.
 */

export interface CaInfo {
  /** PEM of the parsed certificate only (never the raw file). */
  pem: Buffer;
  /** `X509Certificate.fingerprint256`: uppercase hex, colon-separated. */
  sha256: string;
  /** First 8 bytes of the SHA-256, same format. */
  sha256Short: string;
}

interface CacheEntry {
  path: string;
  mtimeMs: number;
  info: CaInfo;
}

let cache: CacheEntry | null = null;

/**
 * Read and parse the configured CA. Returns null when the file is missing or
 * malformed so callers can answer 404 instead of crashing at startup/request.
 *
 * The result is cached per (path, mtime) so the certificate is not reparsed on
 * every request. Only the parsed certificate is served: if the file also
 * carries a private key, that block never leaves the process (see
 * `fileContainsPrivateKey`, which emits the startup warning).
 */
export function readCaInfo(): CaInfo | null {
  const path = tlsCaCertPath();
  if (!existsSync(path)) return null;
  try {
    const { mtimeMs } = statSync(path);
    if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.info;

    const fileContents = readFileSync(path);
    const cert = new X509Certificate(fileContents);
    const sha256 = cert.fingerprint256;
    const info: CaInfo = {
      pem: Buffer.from(cert.toString()),
      sha256,
      sha256Short: shortFingerprint(sha256),
    };
    cache = { path, mtimeMs, info };
    return info;
  } catch {
    return null;
  }
}

/** True when the file at `path` contains any PEM private-key block. */
export function fileContainsPrivateKey(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes('PRIVATE KEY');
  } catch {
    return false;
  }
}

function shortFingerprint(fingerprint256: string): string {
  return fingerprint256.split(':').slice(0, 8).join(':');
}

const CA_PEM_ROUTE = '/.well-known/sumire/ca.pem';
const SERVER_JSON_ROUTE = '/.well-known/sumire/server.json';

export function registerCaBootstrap(app: FastifyInstance): void {
  app.get(CA_PEM_ROUTE, (_req, reply) => {
    const ca = readCaInfo();
    if (!ca) return reply.code(404).header('content-type', 'text/plain').send('CA certificate unavailable');
    return reply.header('content-type', 'application/x-pem-file').send(ca.pem);
  });

  app.get(SERVER_JSON_ROUTE, (_req, reply) => {
    const ca = readCaInfo();
    if (!ca) return reply.code(404).header('content-type', 'text/plain').send('CA certificate unavailable');
    return reply.send({
      name: process.env.SUMIRE_SERVER_NAME || 'sumire-sr',
      caSha256: ca.sha256,
      caSha256Short: ca.sha256Short,
    });
  });
}

/** Emit the startup fingerprint line, or a warning when the CA is missing. */
export function logCaFingerprint(log: FastifyBaseLogger): void {
  const path = tlsCaCertPath();
  const ca = readCaInfo();
  if (!ca) {
    log.warn(`CA certificate not found at ${path}; ${CA_PEM_ROUTE} and ${SERVER_JSON_ROUTE} will return 404`);
    return;
  }
  if (fileContainsPrivateKey(path)) {
    log.warn('TLS_CA_CERT contains a private key; only the certificate is served');
  }
  log.info(`CA fingerprint (SHA-256): ${ca.sha256}  short: ${ca.sha256Short}`);
}
