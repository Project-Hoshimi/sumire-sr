// Phase A2 — let every outfit type onto every outing. Reads [{Id, data}]
// (base64 proto rows) of one master table, sets each row's
// `NotWearableCostumeTypeIds`, `AdvNotWearableCostumeTypeIds` and
// `FinishAdvNotWearableCostumeTypeIds` (deny-lists) to the given list and
// writes the re-encoded rows back.
// Usage: node script/patch_excursion_costumes.ts <Table> <notWearableTypeIdsJson> <in.json> <out.json>
import fs from 'node:fs';
import { Reader, Writer, decodeMessage, encodeMessage, msgRegistry } from '../../fastify-api/runtime/proto.ts';
import '../../fastify-api/src/gen/registry.ts';

const [table, notWearableTypeIdsJson, inPath, outPath] = process.argv.slice(2);
const msgName = `Solis.Common.Proto.Master.${table}`;
const shape = msgRegistry.get(msgName);
if (!shape) throw new Error(`${msgName} not registered`);
const notWearableTypeIds: string[] = JSON.parse(notWearableTypeIdsJson);

type Row = { Id: string; data: string };
const rows: Row[] = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const out: Row[] = [];

for (const r of rows) {
  const dec = decodeMessage(shape, new Reader(Buffer.from(r.data, 'base64'))) as any;
  dec.NotWearableCostumeTypeIds = [...notWearableTypeIds];
  dec.AdvNotWearableCostumeTypeIds = [...notWearableTypeIds];
  dec.FinishAdvNotWearableCostumeTypeIds = [...notWearableTypeIds];
  const w = new Writer();
  encodeMessage(shape, dec, w);
  out.push({ Id: r.Id, data: Buffer.from(w.toBytes()).toString('base64') });
}

fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`patched ${out.length} ${table} rows`);
