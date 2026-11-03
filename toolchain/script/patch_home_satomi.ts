// Phase A2 — unpin a character from the home stays. Reads [{Id, data}] (base64
// proto rows) of HomeMainCharacterStay, clears `FixedCharacterId` on the rows
// pinned to <characterId> and writes only those rows back.
// Usage: node script/patch_home_satomi.ts <characterId> <in.json> <out.json>
import fs from 'node:fs';
import { Reader, Writer, decodeMessage, encodeMessage, msgRegistry } from '../../fastify-api/runtime/proto.ts';
import '../../fastify-api/src/gen/registry.ts';

const [characterId, inPath, outPath] = process.argv.slice(2);
const msgName = 'Solis.Common.Proto.Master.HomeMainCharacterStay';
const shape = msgRegistry.get(msgName);
if (!shape) throw new Error(`${msgName} not registered`);

type Row = { Id: string; data: string };
const rows: Row[] = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const out: Row[] = [];

for (const r of rows) {
  const dec = decodeMessage(shape, new Reader(Buffer.from(r.data, 'base64'))) as any;
  if (dec.FixedCharacterId !== characterId) continue;
  delete dec.FixedCharacterId;
  const w = new Writer();
  encodeMessage(shape, dec, w);
  out.push({ Id: r.Id, data: Buffer.from(w.toBytes()).toString('base64') });
}

fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`unpinned ${characterId} from ${out.length} HomeMainCharacterStay rows: ${out.map((r) => r.Id).join(', ')}`);
