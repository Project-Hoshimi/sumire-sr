// Phase A2 — clone a CharacterGroup row into the staff group and repoint the
// staff characters at it. Reads [{Id, data}] (base64 proto rows of one master
// table), merges a JSON object of field overrides into every row and writes the
// re-encoded rows as [{Id, data}]. With `--decode` it instead writes the decoded
// rows as [{Id, decoded}], which lets the caller read fields (for example
// Character.ShortProfile) before building overrides.
// Usage: node script/patch_staff_group.ts <Table> <overridesJson> <in.json> <out.json> [--decode]
import fs from 'node:fs';
import { Reader, Writer, decodeMessage, encodeMessage, msgRegistry } from '../../fastify-api/runtime/proto.ts';
import '../../fastify-api/src/gen/registry.ts';

const [table, overridesJson, inPath, outPath] = process.argv.slice(2);
const decodeOnly = process.argv[6] === '--decode';
const msgName = `Solis.Common.Proto.Master.${table}`;
const shape = msgRegistry.get(msgName);
if (!shape) throw new Error(`${msgName} not registered`);
const overrides: Record<string, unknown> = JSON.parse(overridesJson);

type Row = { Id: string; data: string };
const rows: Row[] = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const out: { Id: string; data?: string; decoded?: unknown }[] = [];

for (const r of rows) {
  const dec = decodeMessage(shape, new Reader(Buffer.from(r.data, 'base64'))) as any;
  if (decodeOnly) {
    out.push({ Id: r.Id, decoded: dec });
    continue;
  }
  const w = new Writer();
  encodeMessage(shape, { ...dec, ...overrides }, w);
  out.push({ Id: (overrides.Id as string | undefined) ?? r.Id, data: Buffer.from(w.toBytes()).toString('base64') });
}

// Decoded rows can contain BigInt (64-bit proto fields); JSON has no BigInt.
const replacer = (_key: string, value: unknown) =>
  typeof value === 'bigint'
    ? (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString())
    : value;

fs.writeFileSync(outPath, JSON.stringify(out, replacer));
console.log(`${decodeOnly ? 'decoded' : 'patched'} ${out.length} ${table} rows`);
