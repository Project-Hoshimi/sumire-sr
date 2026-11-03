import 'dotenv/config';
import * as C from './gateway/crypto.ts';
import { createHash } from 'node:crypto';

let pass = 0;
const ok = (name: string, cond: boolean) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { console.log(`FAIL ${name}`); process.exitCode = 1; } };
const hx = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const md5 = (b: Buffer) => createHash('md5').update(b).digest();

if (!process.env.WIRE_SEC_KEY) {
  process.env.WIRE_SEC_KEY = 'selfcheck-dummy-key';
  console.log('  note WIRE_SEC_KEY unset; using a test-only dummy key');
}
const secKey = C.getSecKey();
const key = C.createKey(secKey);
const requestId = Buffer.from('Rh8Pz5mynoouGq8WA8F6XyFzhDGH');
const CAPTURED_KEY = hx('ec f5 22 11 9c e6 d7 0f 58 ac d9 bb 7c c2 22 f2');
const CAPTURED_IV = hx('4c eb e1 42 a0 c2 24 28 83 02 4d fb f8 74 11 bf');

ok('createKey == MD5(WIRE_SEC_KEY)', key.equals(md5(secKey)));
ok('createIv == MD5(WIRE_SEC_KEY || requestId)',
   C.createIv(secKey, requestId).equals(md5(Buffer.concat([secKey, requestId]))));

if (key.equals(CAPTURED_KEY)) {
  ok('createKey == captured AES key', true);
  ok('createIv == captured IV', C.createIv(secKey, requestId).equals(CAPTURED_IV));
  const frame = hx('04 00 00 02 63 62 dd 02 80 38 71 44 fb 4d 5a 52 5c 50 88 66 ec 9f 81 d1 eb f8 0b 21 ec e0 db 9c 55 08 f7 38 07 e9');
  const pt = C.decrypt(frame);
  ok('decrypt real resp -> captured plaintext prefix', pt.toString('hex').startsWith('0a00120018e0d4032088272801300138'));
  ok('PKCS7 unpadded to 17 bytes', pt.length === 17);
} else {
  console.log('  skip captured frame (WIRE_SEC_KEY is not the capture session key)');
}

const samples = [Buffer.from([0x0a, 0x00]), Buffer.from([0x0a, 0x24, 0x74, 0x69, 0x63, 0x6b, 0x65, 0x74]), Buffer.from('x'.repeat(33))];
for (const s of samples) {
  const id = Buffer.from(`req-${Math.random().toString(16).slice(2)}`);
  ok(`roundtrip len=${s.length}`, C.decrypt(C.encrypt(s, id)).equals(s));
}

console.log(`\n${pass} crypto checks passed`);
if (process.exitCode) process.exit(process.exitCode);