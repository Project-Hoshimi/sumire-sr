import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

const TLS_DIR = join(import.meta.dirname, '..', '..', 'tls');
const KEY = join(TLS_DIR, 'api.key');
const CRT = join(TLS_DIR, 'api.crt');

/** Generate a self-signed cert for api.octo-cloud.com (verify is disabled on device). */
export function ensureTlsCert(): { key: Buffer; cert: Buffer; allowHTTP1: boolean } {
  if (existsSync(KEY) && existsSync(CRT)) {
    return { key: readFileSync(KEY), cert: readFileSync(CRT), allowHTTP1: true };
  }
  mkdirSync(TLS_DIR, { recursive: true });
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout '${KEY}' -out '${CRT}' -days 3650 ` +
      `-subj '/CN=api.octo-cloud.com' -addext 'subjectAltName=DNS:api.octo-cloud.com,DNS:${config.host}'`,
  );
  return { key: readFileSync(KEY), cert: readFileSync(CRT), allowHTTP1: true };
}
