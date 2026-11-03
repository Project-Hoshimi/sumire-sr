import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';

const DEV_DIR = join(import.meta.dirname, '../../keys');

export type KeyPair = { publicKeyPem: string; privateKeyPem: string };

export function loadOrCreateKeyPair(force = false): KeyPair {
  const pubPath = join(DEV_DIR, 'jwt_public.pem');
  const privPath = join(DEV_DIR, 'jwt_private.pem');

  if (!force && config.jwt.publicKeyPem && config.jwt.privateKeyPem) {
    return { publicKeyPem: config.jwt.publicKeyPem, privateKeyPem: config.jwt.privateKeyPem };
  }
  if (!force && existsSync(pubPath) && existsSync(privPath)) {
    return { publicKeyPem: readFileSync(pubPath, 'utf8'), privateKeyPem: readFileSync(privPath, 'utf8') };
  }

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  mkdirSync(DEV_DIR, { recursive: true });
  writeFileSync(pubPath, publicKey, { mode: 0o644 });
  writeFileSync(privPath, privateKey, { mode: 0o600 });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}