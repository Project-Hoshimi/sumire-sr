import { loadCorpus } from './services/replay/corpus.ts';
import { decodeMessage, Reader, Writer, encodeMessage, msgRegistry } from '@sumire-sr/protocol/runtime/proto.ts';
import '@sumire-sr/protocol/gen/registry.ts';
import { requireData } from './testing/requireData.ts';

await requireData({ captures: true });

const c = loadCorpus();
const e = c.get('System:Check')!;
const shape = msgRegistry.get('Solis.Common.Proto.Api.SystemCheckResponse')!;
const d = decodeMessage(shape, new Reader(Uint8Array.from(e.response)));
console.log('captured System:Check decode:', JSON.stringify(d, (k,v)=>typeof v==='bigint'?Number(v):v));
// re-encode from decoded to confirm roundtrip
const w = new Writer(); encodeMessage(shape, d, w);
console.log('re-encode byte-exact:', Buffer.from(w.toBytes()).equals(e.response));
