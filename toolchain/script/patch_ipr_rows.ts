// Phase A2 — convert official IPR master rows (camelCase protobuf-JSON) into
// the base64 proto bytes our master blobs store, and back again for checking.
//
// The rows vendored under `phaseA2/import/` come from MalitsPlus/ipr-master-diff
// and use lowerFirst names of our PascalCase proto fields (`id` -> `Id`,
// `assetId` -> `AssetId`, nested messages likewise, e.g. `episodes[].storyId`,
// `settings[].term.nowAfter`), with 64-bit integers as decimal strings and
// enums/bools as JSON numbers/booleans. This helper maps each row recursively
// onto the registered `Solis.Common.Proto.Master.<Table>` shape, converts the
// values to what `encodeMessage` expects (int64 string -> BigInt, int32 -> number,
// bool, enum, repeated, nested message) and writes `[{Id, data}]`. Keys that have
// no field in our shape are dropped and summarised once per table (never fatal),
// so a newer official row can still be imported when we have not generated a
// field yet.
//
// With `--decode` it instead reads `[{Id, data}]` and writes `[{Id, decoded}]`,
// exactly like patch_staff_group.ts, for byte/decoded verification.
//
// Usage:
//   node script/patch_ipr_rows.ts <Table> <in.json> <out.json>
//   node script/patch_ipr_rows.ts <Table> <in.json> <out.json> --decode
import fs from 'node:fs';
import { Reader, Writer, decodeMessage, encodeMessage, msgRegistry } from '../../fastify-api/runtime/proto.ts';
import type { FieldShape, MessageShape } from '../../fastify-api/runtime/proto.ts';
import '../../fastify-api/src/gen/registry.ts';

const [table, inPath, outPath] = process.argv.slice(2);
const decodeOnly = process.argv[5] === '--decode';
const msgName = `Solis.Common.Proto.Master.${table}`;
const shape = msgRegistry.get(msgName);
if (!shape) throw new Error(`${msgName} not registered`);

// Same BigInt-safe JSON replacer as patch_staff_group.ts: decoded rows carry
// 64-bit values, which JSON cannot represent natively.
const replacer = (_key: string, value: unknown) =>
  typeof value === 'bigint'
    ? (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString())
    : value;

type Row = { Id: string; data: string };
const rows: Row[] = JSON.parse(fs.readFileSync(inPath, 'utf8'));

if (decodeOnly) {
  const out: { Id: string; decoded?: unknown }[] = [];
  for (const r of rows) {
    const dec = decodeMessage(shape, new Reader(Buffer.from(r.data, 'base64')));
    out.push({ Id: r.Id, decoded: dec });
  }
  fs.writeFileSync(outPath, JSON.stringify(out, replacer));
  console.log(`decoded ${out.length} ${table} rows`);
} else {
  const dropped = new Map<string, number>();
  const out: { Id: string; data: string }[] = [];

  function convertValue(f: FieldShape, value: any, path: string): any {
    if (value === null || value === undefined) return value;
    if (f.repeated && f.element) {
      if (!Array.isArray(value)) return value;
      return value.map((v: any) => convertValue(f.element!, v, `${path}[]`));
    }
    if (f.map) {
      if (typeof value !== 'object' || Array.isArray(value)) return value;
      const m: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        m[k] = f.value ? convertValue(f.value, v, `${path}.${k}`) : v;
      }
      return m;
    }
    if (f.message) {
      if (typeof value !== 'object' || Array.isArray(value)) return value;
      const sub = msgRegistry.get(f.message);
      if (!sub) throw new Error(`schema not registered: ${f.message}`);
      return convertRow(sub, value, path);
    }
    if (f.label === 'bytes') {
      return typeof value === 'string' ? Uint8Array.from(Buffer.from(value, 'base64')) : value;
    }
    if (f.wire === 'varint') {
      if (f.label === 'bool') {
        if (typeof value === 'string') return value === 'true';
        return Boolean(value);
      }
      if (typeof value === 'string' && /^-?\d+$/.test(value)) {
        return f.label === 'int64' || f.label === 'uint64' || f.label === 'sint64'
          ? BigInt(value)
          : Number(value);
      }
      return value;
    }
    return value;
  }

  function convertRow(sub: MessageShape, obj: Record<string, any>, prefix: string): Record<string, any> {
    const converted: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      const name = key.charAt(0).toUpperCase() + key.slice(1);
      const path = prefix ? `${prefix}.${key}` : key;
      const f = sub.fields.find(x => x.name === name);
      if (!f) {
        dropped.set(path, (dropped.get(path) ?? 0) + 1);
        continue;
      }
      converted[f.name!] = convertValue(f, value, path);
    }
    return converted;
  }

  for (const r of rows as any[]) {
    const converted = convertRow(shape, r, '');
    if (typeof converted.Id !== 'string' || !converted.Id) {
      throw new Error(`${table}: row has no Id: ${JSON.stringify(r).slice(0, 120)}`);
    }
    const w = new Writer();
    encodeMessage(shape, converted, w);
    out.push({ Id: converted.Id, data: Buffer.from(w.toBytes()).toString('base64') });
  }

  const summary = [...dropped.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, count]) => `${path} x${count}`);
  console.log(`${table}: dropped paths: ${summary.length ? summary.join(', ') : 'none'}`);

  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`encoded ${out.length} ${table} rows`);
}
