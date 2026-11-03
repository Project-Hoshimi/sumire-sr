// Phase A2 — let every outfit type into the photo Pose/Work areas. Reads
// [{Id, data}] (base64 proto rows) of one master table, sets each row's
// `CostumeTypeIds` to the given list and writes the re-encoded rows back.
// Usage: node script/patch_photo_costumes.ts <Table> <costumeTypeIdsJson> <in.json> <out.json>
import fs from 'node:fs';
import { Reader, Writer, decodeMessage, encodeMessage, msgRegistry } from '../../fastify-api/runtime/proto.ts';
import '../../fastify-api/src/gen/registry.ts';

const [table, costumeTypeIdsJson, inPath, outPath] = process.argv.slice(2);
const msgName = `Solis.Common.Proto.Master.${table}`;
const shape = msgRegistry.get(msgName);
if (!shape) throw new Error(`${msgName} not registered`);
const costumeTypeIds: string[] = JSON.parse(costumeTypeIdsJson);

type Row = { Id: string; data: string };
const rows: Row[] = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const out: Row[] = [];

for (const r of rows) {
  const dec = decodeMessage(shape, new Reader(Buffer.from(r.data, 'base64'))) as any;
  dec.CostumeTypeIds = [...costumeTypeIds];
  const w = new Writer();
  encodeMessage(shape, dec, w);
  out.push({ Id: r.Id, data: Buffer.from(w.toBytes()).toString('base64') });
}

fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`patched ${out.length} ${table} rows`);
