// Phase A2 — open every photo pose to every outfit and Pose area. Reads
// [{Id, data}] (base64 proto rows) of one master table, empties the named
// repeated fields on each row and writes the re-encoded rows back.
// Usage: node script/patch_photo_poses.ts <Table> <fieldsJson> <in.json> <out.json>
import fs from 'node:fs';
import { Reader, Writer, decodeMessage, encodeMessage, msgRegistry } from '../../fastify-api/runtime/proto.ts';
import '../../fastify-api/src/gen/registry.ts';

const [table, fieldsJson, inPath, outPath] = process.argv.slice(2);
const msgName = `Solis.Common.Proto.Master.${table}`;
const shape = msgRegistry.get(msgName);
if (!shape) throw new Error(`${msgName} not registered`);
const fields: string[] = JSON.parse(fieldsJson);

type Row = { Id: string; data: string };
const rows: Row[] = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const out: Row[] = [];
let cleared = 0;

for (const r of rows) {
  const dec = decodeMessage(shape, new Reader(Buffer.from(r.data, 'base64'))) as any;
  for (const f of fields) {
    if (dec[f]?.length) cleared++;
    dec[f] = [];
  }
  const w = new Writer();
  encodeMessage(shape, dec, w);
  out.push({ Id: r.Id, data: Buffer.from(w.toBytes()).toString('base64') });
}

fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`patched ${out.length} ${table} rows (${cleared} restrictions cleared)`);
