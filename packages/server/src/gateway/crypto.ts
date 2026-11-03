import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

/**
 * Idoly Pride wire crypto — ported byte-for-byte from phase3f/crypto.js
 * (verified against live captures by phase3f/test_crypto.js).
 *
 *   secKey (static)          = WIRE_SEC_KEY (env, see .env.example)
 *   AES-128-CBC key          = MD5(secKey)
 *   IV per message           = MD5(secKey || frameRequestId)
 *   frame header             = [0]=headerLen-2, [1..2]=0, [3]=idLen, idBytes
 *   payload padding          = PKCS7 (manual)
 *   envelope (on wire)       = frameHeader | AES-CBC(cipher)
 *   Decrypt == AES-CBC-decrypt(cipher[4+idLen..], key, iv), then PKCS7-unpad
 */

let cachedSecKey: Buffer | null = null;

/**
 * Wire secret key, read from `WIRE_SEC_KEY` on first use. Deliberately lazy:
 * importing this module must not require the secret, so tools that only touch
 * frame helpers or types keep working without env configuration.
 */
export function getSecKey(): Buffer {
  if (cachedSecKey) return cachedSecKey;
  const raw = process.env.WIRE_SEC_KEY;
  if (!raw) throw new Error('WIRE_SEC_KEY is not set (see .env.example)');
  cachedSecKey = Buffer.from(raw);
  return cachedSecKey;
}

export function md5(b: Buffer): Buffer {
  return createHash('md5').update(b).digest();
}

/** AES-128-CBC key for the session. */
export function createKey(secKey: Buffer = getSecKey()): Buffer {
  return md5(secKey);
}

/** Per-message IV = MD5(secKey || requestId). */
export function createIv(secKey: Buffer, requestIdBytes: Buffer): Buffer {
  return md5(Buffer.concat([secKey, requestIdBytes]));
}

export type FrameHeader = { headerLen: number; id: Buffer };

/** Frame header request-id: [0]=len-2 [1..2]=0 [3]=idLen id... */
export function parseFrameHeader(frame: Buffer): FrameHeader {
  if (frame.length < 4) throw new Error('frame too short');
  const idLen = frame[3];
  const headerLen = 4 + idLen;
  if (frame.length < headerLen) throw new Error('header truncated');
  return { headerLen, id: frame.subarray(4, headerLen) };
}

export function buildFrameHeader(requestIdBytes: Buffer): Buffer {
  const idLen = requestIdBytes.length;
  const headerLen = 4 + idLen;
  if (idLen > 0xff) throw new Error('request id too long');
  const h = Buffer.alloc(headerLen);
  h[0] = headerLen - 2;
  h[1] = 0;
  h[2] = 0;
  h[3] = idLen;
  h.set(requestIdBytes, 4);
  return h;
}

export function pkcs7Pad(data: Buffer, block = 16): Buffer {
  const pad = block - (data.length % block);
  const out = Buffer.alloc(data.length + pad);
  out.set(data, 0);
  out.fill(pad, data.length);
  return out;
}

export function pkcs7Unpad(data: Buffer, block = 16): Buffer {
  if (data.length === 0 || data.length % block !== 0) throw new Error('bad length');
  const pad = data[data.length - 1];
  if (pad === 0 || pad > block) throw new Error('bad padding byte');
  for (let i = data.length - pad; i < data.length; i++) if (data[i] !== pad) throw new Error('bad padding');
  return data.subarray(0, data.length - pad);
}

/** Encrypt a plaintext protobuf message for a request. Returns full envelope. */
export function encrypt(plain: Buffer, requestId: Buffer): Buffer {
  const secKey = getSecKey();
  const key = createKey(secKey);
  const iv = createIv(secKey, requestId);
  const e = createCipheriv('aes-128-cbc', key, iv);
  e.setAutoPadding(false);
  const ct = Buffer.concat([e.update(pkcs7Pad(plain)), e.final()]);
  return Buffer.concat([buildFrameHeader(requestId), ct]);
}

/**
 * Decrypt a full enveloped response. `frame` = header|ciphertext exactly as
 * received. Returns the plaintext protobuf bytes (padding already stripped).
 */
export function decrypt(frame: Buffer): Buffer {
  const { headerLen, id } = parseFrameHeader(frame);
  const secKey = getSecKey();
  const key = createKey(secKey);
  const iv = createIv(secKey, id);
  const d = createDecipheriv('aes-128-cbc', key, iv);
  d.setAutoPadding(false);
  const raw = Buffer.concat([d.update(frame.subarray(headerLen)), d.final()]);
  return pkcs7Unpad(raw);
}