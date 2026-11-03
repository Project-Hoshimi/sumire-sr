'use strict';
/*
 * Unit tests for crypto.js — portable key/roundtrip checks plus REAL captured
 * traffic vectors when WIRE_SEC_KEY matches the capture session key.
 * Run: node test_crypto.js  (reads $CAP3F_LOG, default /tmp/cap3f.log, if present)
 */
const assert = require('assert');
const fs = require('fs');
const crypto = require('crypto');
const C = require('../src/crypto.cjs');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
}
const hx = (b) => Buffer.from(b.replace(/\s+/g, ''), 'hex');
const md5 = (x) => crypto.createHash('md5').update(x).digest();

if (!process.env.WIRE_SEC_KEY) {
  process.env.WIRE_SEC_KEY = 'selfcheck-dummy-key';
  console.log('  note WIRE_SEC_KEY unset; using a test-only dummy key');
}
const secKey = C.getSecKey();
const KEY = C.createKey(secKey);
const REQUEST_ID = Buffer.from('Rh8Pz5mynoouGq8WA8F6XyFzhDGH');
const CAPTURED_KEY = hx('ec f5 22 11 9c e6 d7 0f 58 ac d9 bb 7c c2 22 f2');
const CAPTURED_IV = hx('4c eb e1 42 a0 c2 24 28 83 02 4d fb f8 74 11 bf');

console.log('== key derivation ==');
ok('createKey == MD5(secKey)', KEY.equals(md5(secKey)));
ok('createIv == MD5(secKey || requestId)',
   C.createIv(secKey, REQUEST_ID).equals(md5(Buffer.concat([secKey, REQUEST_ID]))));

if (KEY.equals(CAPTURED_KEY)) {
  console.log('== captured vectors ==');
  ok('createKey == captured AES key', true);
  ok('createIv(secKey, "Rh8Pz5mynoouGq8WA8F6XyFzhDGH") == captured IV',
     C.createIv(secKey, REQUEST_ID).equals(CAPTURED_IV));

  console.log('== decrypt real response (full=true capture) ==');
  // frame: header[04 00 00 02 "cb"] + 32-byte AES-CBC cipher
  const frame = hx('04 00 00 02 63 62 dd 02 80 38 71 44 fb 4d 5a 52 5c 50 88 66 ec 9f 81 d1 eb f8 0b 21 ec e0 db 9c 55 08 f7 38 07 e9');
  const pt = C.decrypt(frame);
  ok('decrypted plaintext matches captured DEC out plain',
     pt.toString('hex').startsWith('0a00120018e0d4032088272801300138'));
  ok('PKCS7 unpadded cleanly to 17 bytes', pt.length === 17);
} else {
  console.log('== captured vectors skipped (WIRE_SEC_KEY is not the capture session key) ==');
}

console.log('== roundtrip ==');
const samples = [Buffer.from([0x0a, 0x00]), Buffer.from([0x0a, 0x24, 0x74, 0x69, 0x63, 0x6b, 0x65, 0x74]), crypto.randomBytes(33)];
for (const s of samples) {
  const id = Buffer.from(`req-${crypto.randomBytes(4).toString('hex')}`);
  const env = C.encrypt(s, id);
  const back = C.decrypt(env);
  ok(`roundtrip len=${s.length}`, back.equals(s));
}

console.log('== bulk: verify Encrypt primitives against every complete capture ==');
let verified = 0, skipped = 0;
const CAP3F_LOG = process.env.CAP3F_LOG || '/tmp/cap3f.log';
const haveBulkLog = fs.existsSync(CAP3F_LOG);
if (haveBulkLog) {
  const lines = fs.readFileSync(CAP3F_LOG, 'utf8').split('\n');
  const hxL = (l) => {
    const i = l.indexOf(':'); let s = l.slice(i + 1);
    const m = s.match(/bytes=(\d+) ?/);
    if (m) { if (Number(m[1]) > 512) return null; s = s.slice(m[0].length); }
    else if (s.includes('(truncated)')) return null;
    return Buffer.from(s.replace(/[^0-9a-f]/g, ''), 'hex');
  };
  let cur = null;
  const blocks = [];
  for (const l of lines) {
    if (l.includes('IV  out iv')) { cur = { plain: null, key: null, iv: null, out: null }; blocks.push(cur); }
    else if (!cur) continue;
    else if (l.includes('ENC in  plain')) cur.plain = hxL(l);
    else if (l.includes('ENC in  key')) cur.key = hxL(l);
    else if (l.includes('ENC in  iv')) cur.iv = hxL(l);
    else if (l.includes('ENC out cipher')) cur.out = hxL(l);
  }
  for (const b of blocks) {
    if (!b.plain || !b.key || !b.iv || !b.out || b.key.length !== 16 || b.iv.length !== 16) { skipped++; continue; }
    const e = crypto.createCipheriv('aes-128-cbc', b.key, b.iv);
    const ct = Buffer.concat([e.update(b.plain), e.final()]);
    if (ct.equals(b.out)) verified++; else { fail++; console.log(`FAIL bulk block (plain len ${b.plain.length})`); }
  }
}
if (haveBulkLog) {
  ok(`bulk ENC verified (${verified} blocks, ${skipped} truncated/skipped)`, verified >= 40);
} else {
  console.log(`  skip bulk ENC (no ${CAP3F_LOG}; set CAP3F_LOG to enable)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
