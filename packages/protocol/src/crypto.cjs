'use strict';
/*
 * Idoly Pride wire crypto — VERIFIED byte-for-byte against live captures
 * (Phase 3F/3G). Implemented in pure Node.js (crypto primitives).
 *
 * Verified facts (see test_crypto.js):
 *   - secKey (static): WIRE_SEC_KEY (environment variable, see fastify-api/.env.example)
 *   - AES-128-CBC key       = MD5(secKey)
 *   - IV per message        = MD5(secKey || frameRequestId)
 *   - frame header          = [0]=headerLen-2, [1..2]=0, [3]=idLen, idBytes
 *   - payload padding       = PKCS7
 *   - envelope (on wire)    = frameHeader | AES-CBC(cipher)
 *   - Encrypt == AES-CBC-encrypt(PKCS7(plain), key, iv)   [47/47 full blocks match]
 *   - Decrypt == AES-CBC-decrypt(cipher[4+idLen..], key, iv)
 *
 * Request signing (x-app-request-signature via ApiBase.CreateRequestSignature)
 * is a per-request opt-in (ApiRequest.EnableRequestSignature @ +0x3b) that does
 * NOT fire for any gameplay flow exercised so far (login, tutorial, gacha,
 * shop/market/gift/mission, quest start). Documented; not required for the
 * phases that succeeded against the live server.
 */

const crypto = require('crypto');

let cachedSecKey = null;

/** Wire secret key from WIRE_SEC_KEY, resolved lazily on first use. */
function getSecKey() {
  if (cachedSecKey) return cachedSecKey;
  const raw = process.env.WIRE_SEC_KEY;
  if (!raw) throw new Error('WIRE_SEC_KEY is not set (see .env.example)');
  cachedSecKey = Buffer.from(raw);
  return cachedSecKey;
}

const md5 = (b) => crypto.createHash('md5').update(b).digest();

async function md5Raw(b) { return md5(b); }

/** AES-128-CBC key for the session. */
function createKey(secKey = getSecKey()) {
  return md5(secKey);
}

/** Per-message IV = MD5(secKey || requestId). */
function createIv(secKey, requestIdBytes) {
  return md5(Buffer.concat([secKey, requestIdBytes]));
}

/** Frame header request-id: [0]=len-2 [1..2]=0 [3]=idLen id... */
function parseFrameHeader(frame) {
  if (frame.length < 4) throw new Error('frame too short');
  const idLen = frame[3];
  const headerLen = 4 + idLen;
  if (frame.length < headerLen) throw new Error('header truncated');
  return {
    headerLen,
    id: frame.slice(4, headerLen),
  };
}

function buildFrameHeader(requestIdBytes) {
  const idLen = requestIdBytes.length;
  const headerLen = 4 + idLen;
  if (idLen > 0xff) throw new Error('request id too long');
  const h = Buffer.alloc(headerLen);
  h[0] = headerLen - 2;
  h[1] = 0; h[2] = 0;
  h[3] = idLen;
  h.set(requestIdBytes, 4);
  return h;
}

function pkcs7Pad(data, block = 16) {
  const pad = block - (data.length % block);
  const out = Buffer.alloc(data.length + pad);
  out.set(data, 0);
  out.fill(pad, data.length);
  return out;
}

function pkcs7Unpad(data, block = 16) {
  if (data.length === 0 || data.length % block !== 0) throw new Error('bad length');
  const pad = data[data.length - 1];
  if (pad === 0 || pad > block) throw new Error('bad padding byte');
  for (let i = data.length - pad; i < data.length; i++) if (data[i] !== pad) throw new Error('bad padding');
  return data.subarray(0, data.length - pad);
}

/** Encrypt a plaintext protobuf message for a request. Returns full envelope. */
function encrypt(plain, requestId) {
  const secKey = getSecKey();
  const key = createKey(secKey);
  const iv = createIv(secKey, requestId);
  const e = crypto.createCipheriv('aes-128-cbc', key, iv);
  e.setAutoPadding(false);
  const ct = Buffer.concat([e.update(pkcs7Pad(plain)), e.final()]);
  return Buffer.concat([buildFrameHeader(requestId), ct]);
}

/**
 * Decrypt a full enveloped response. `frame` = header|ciphertext exactly as
 * received. Returns the plaintext protobuf bytes (padded already stripped).
 */
function decrypt(frame) {
  const { headerLen, id } = parseFrameHeader(frame);
  const secKey = getSecKey();
  const key = createKey(secKey);
  const iv = createIv(secKey, id);
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  d.setAutoPadding(false);
  const raw = Buffer.concat([d.update(frame.subarray(headerLen)), d.final()]);
  return pkcs7Unpad(raw);
}

module.exports = { getSecKey, createKey, createIv, encrypt, decrypt, parseFrameHeader, buildFrameHeader, pkcs7Pad, pkcs7Unpad, md5 };
