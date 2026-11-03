// A1.1 runtime self-test: byte-exact decode→re-encode of the Home:Login seed.
// Run: node verify/self_test.ts
import { Reader, Writer, decodeMessage, encodeMessage, msgRegistry } from '../runtime/proto.ts';
import '../src/gen/registry.ts';

const HEX = '0a 12 08 32 10 32 18 46 20 03 28 1e 30 01 38 01 40 01 48 01';
const bytes = Uint8Array.from(HEX.split(' ').map(h => parseInt(h, 16)));
// the seed is HomeLoginRequest wrapping SettingInfo at field 1 (LEN 18): strip the
// 0a 12 tag+len and decode the inner SettingInfo payload directly.
const inner = bytes.subarray(2);

function shape(name) {
  const s = msgRegistry.get(name);
  if (!s) throw new Error(`unregistered ${name}`);
  return s;
}

function roundtrip(shapeName, wire) {
  const r = new Reader(wire);
  const m = shape(shapeName);
  const decoded = decodeMessage(m, r);
  const w = new Writer();
  encodeMessage(m, decoded, w);
  const out = w.toBytes();
  let same = out.length === wire.length;
  if (same) for (let i = 0; i < out.length; i++) if (out[i] !== wire[i]) { same = false; break; }
  return { decoded, reencoded: out, byteExact: same };
}

console.log('registry size:', msgRegistry.size);
const res = roundtrip('Solis.Common.Proto.Api.SettingInfo', inner);
console.log('decoded:', JSON.stringify(res.decoded, (k, v) => typeof v === 'bigint' ? v.toString() : v));
console.log('byteExact:', res.byteExact);
console.log('reencode hex:', Buffer.from(res.reencoded).toString('hex'));
console.log('original hex:', Buffer.from(inner).toString('hex'));
if (!res.byteExact) process.exit(1);
console.log('SELF-TEST PASS');

(End of file - total 37 lines)
