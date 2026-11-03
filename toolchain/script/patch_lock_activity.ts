// Phase A2 — lock the Work (おしごと) activities behind a condition that never
// opens. Two modes:
//   relock <conditionId> <in.json> <out.json>
//     Reads [{Id, data}] FunctionLock rows, points each at <conditionId>.
//   new <conditionId> <description> <out.json>
//     Encodes one Condition and one ConditionDescription row for <conditionId>.
// Usage: node script/patch_lock_activity.ts <mode> ...
import fs from 'node:fs';
import { Reader, Writer, decodeMessage, encodeMessage, msgRegistry } from '../../fastify-api/runtime/proto.ts';
import '../../fastify-api/src/gen/registry.ts';

// 2^42 - 1: a NowAfter no client clock will ever reach.
const NOW_AFTER_NEVER = 4398046511103;

function shapeOf(table: string) {
  const shape = msgRegistry.get(`Solis.Common.Proto.Master.${table}`);
  if (!shape) throw new Error(`Solis.Common.Proto.Master.${table} not registered`);
  return shape;
}

function encode(table: string, msg: unknown): string {
  const w = new Writer();
  encodeMessage(shapeOf(table), msg as any, w);
  return Buffer.from(w.toBytes()).toString('base64');
}

const [mode, conditionId, ...rest] = process.argv.slice(2);

if (mode === 'relock') {
  const [inPath, outPath] = rest;
  type Row = { Id: number; data: string };
  const rows: Row[] = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const shape = shapeOf('FunctionLock');
  const out = rows.map((r) => {
    const dec = decodeMessage(shape, new Reader(Buffer.from(r.data, 'base64'))) as any;
    dec.UnlockConditionId = conditionId;
    return { Id: r.Id, data: encode('FunctionLock', dec) };
  });
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`relocked ${out.length} FunctionLock rows -> ${conditionId}`);
} else if (mode === 'new') {
  const [description, outPath] = rest;
  const out = {
    Condition: encode('Condition', {
      Id: conditionId,
      Settings: [{ Term: { NowAfter: NOW_AFTER_NEVER } }],
    }),
    ConditionDescription: encode('ConditionDescription', { Id: conditionId, Description: description }),
  };
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`encoded condition ${conditionId}`);
} else {
  throw new Error(`unknown mode ${mode}`);
}
