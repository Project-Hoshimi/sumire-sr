// Perf smoke: import registry, roundtrip synthetic large-ish messages.
import { Reader, Writer, decodeMessage, encodeMessage, msgRegistry } from '../runtime/proto.ts';
import '../src/gen/registry.ts';

const t0 = Date.now();
console.log('registry import:', Date.now() - t0, 'ms, messages:', msgRegistry.size);

// synthetic 55KB-ish SettingInfo-like: reuse SystemCheckResponse? Just build a big repeated string list
const shape = msgRegistry.get('Solis.Common.Proto.Api.NoticeListResponse');
if (!shape) { console.log('shape missing'); process.exit(1); }

const w = new Writer();
// build a large payload: NoticeInfo list
const notice = { Id: 'id-123', Title: 'x'.repeat(400), Text: 'y'.repeat(400), AssetId: 'abc', Order: 1, IsNew: false, ImageUrl: 'z'.repeat(200) };
// Just measure encode+decode of a big repeated field using a master-like message
// Use MasterGetResponse? Simpler: reuse NoticeListResponse with many infos.
const big = { Notices: Array.from({ length: 200 }, (_, i) => ({ ...notice })) };
const enc = new Writer();
encodeMessage(shape, big, enc);
const buf = enc.toBytes();
console.log('encode size:', buf.length, 'bytes, time:', Date.now() - t0, 'ms');
const t1 = Date.now();
const dec = decodeMessage(shape, new Reader(buf));
console.log('decode ms:', Date.now() - t1);
console.log('decoded infos:', dec.Notices ? dec.Notices.length : (dec.Infos ? dec.Infos.length : 0));