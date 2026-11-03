// Phase A2 — give the collab idols photo motions. Reads [{Id, data}] (base64
// rows of the donor idols from a per-character motion table), re-encodes each
// row with `CharacterId` swapped to every collab idol that uses that donor and
// the named fields cleared, and writes [{Id, CharacterId, data}].
// Usage: node script/patch_photo_collab.ts <Table> <donorsJson> <clearFieldsJson> <in.json> <out.json>
// donorsJson maps collab CharacterId -> donor CharacterId.
import fs from 'node:fs';
import { Reader, Writer, decodeMessage, encodeMessage, msgRegistry } from '../../fastify-api/runtime/proto.ts';
import '../../fastify-api/src/gen/registry.ts';

const [table, donorsJson, clearFieldsJson, inPath, outPath] = process.argv.slice(2);
const msgName = `Solis.Common.Proto.Master.${table}`;
const shape = msgRegistry.get(msgName);
if (!shape) throw new Error(`${msgName} not registered`);
const donors: Record<string, string> = JSON.parse(donorsJson);
const clearFields: string[] = JSON.parse(clearFieldsJson);

type Row = { Id: string; data: string };
const rows: Row[] = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const out: { Id: string; CharacterId: string; data: string }[] = [];

for (const r of rows) {
  const dec = decodeMessage(shape, new Reader(Buffer.from(r.data, 'base64'))) as any;
  for (const [collab, donor] of Object.entries(donors)) {
    if (dec.CharacterId !== donor) continue;
    const w = new Writer();
    const row = { ...dec, CharacterId: collab };
    for (const f of clearFields) delete row[f];
    encodeMessage(shape, row, w);
    out.push({ Id: r.Id, CharacterId: collab, data: Buffer.from(w.toBytes()).toString('base64') });
  }
}

fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`built ${out.length} collab ${table} rows`);
