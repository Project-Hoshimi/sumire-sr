// A1.1 perf: hot-path encode/decode of a ~55KB payload (Master:Get scale).
// Run: node verify/perf_hotpath.ts
import { Reader, Writer, encodeMessage, decodeMessage, msgRegistry } from '../runtime/proto.ts';
import '../src/gen/registry.ts';

const Msg = msgRegistry.get('Solis.Common.Proto.Api.UserGetResponse');
if (!Msg) { console.log('UserGetResponse not found'); process.exit(1); }
console.log('shape fields:', Msg.fields.length);

// ~26B/card * 2200 ≈ 57KB
const cards = Array.from({ length: 2200 }, (_, i) => ({
  Id: `uc-${i}-aaaaaaaaaa`,
  CardId: 'card-ai-03-schl-00',
  Exp: i,
  Level: i % 10,
  Rarity: i % 5,
  IsNew: false,
  SerialNumber: i * 7,
  CreatedAt: 1789_000000000 + i,
  UpdatedAt: 1789_000000000 + i,
}));

// warmup
{
  const w = new Writer();
  encodeMessage(Msg, { Cards: cards }, w);
  decodeMessage(Msg, new Reader(w.toBytes()));
}

const iters = 50;
let t0 = Date.now();
let size = 0;
for (let i = 0; i < iters; i++) {
  const w = new Writer();
  encodeMessage(Msg, { Cards: cards }, w);
  size = w.toBytes().length;
}
let t1 = Date.now();
console.log(`encode x${iters}: ${t1 - t0}ms => ${Math.round(size * iters / (t1 - t0) / 1e6 * 1000) / 1000} MB/s (payload ${Math.round(size / 1024)}KB)`);

t0 = Date.now();
let dec;
{
  const w = new Writer();
  encodeMessage(Msg, { Cards: cards }, w);
  for (let i = 0; i < iters; i++) dec = decodeMessage(Msg, new Reader(w.toBytes()));
}
t1 = Date.now();
console.log(`decode x${iters}: ${t1 - t0}ms => ${Math.round(size * iters / (t1 - t0) / 1e6 * 1000) / 1000} MB/s`);
console.log('decoded cards:', dec.Cards.length);