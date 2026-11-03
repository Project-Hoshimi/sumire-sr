// Phase A2 — decode every harvested master row's data blob via the A1 Master schemas.
// Usage: node script/decode_master.ts [--summary-only]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Reader, decodeMessage, msgRegistry } from '../../fastify-api/runtime/proto.ts';
import '../../fastify-api/src/gen/registry.ts';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(ROOT, '..', '..');
const BASE = path.join(process.env.SUMIRE_DATA_DIR ? path.resolve(process.env.SUMIRE_DATA_DIR) : REPO_ROOT, 'phaseA2');
const OUT = path.join(BASE, 'out');

const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
const tables = JSON.parse(fs.readFileSync(path.join(OUT, 'tables.json'), 'utf8'));

const summaryOnly = process.argv.includes('--summary-only');
fs.mkdirSync(path.join(OUT, 'structured'), { recursive: true });

const summary = [];
let totalOk = 0, totalFail = 0;
const triage = [];
const missingShapes = [];

for (const p of manifest.partitions) {
  const type = p.type;
  const shapeName = `Solis.Common.Proto.Master.${type}`;
  const shape = msgRegistry.get(shapeName);
  const rowsPath = path.join(OUT, 'rows', `${type}.jsonl`);
  if (!fs.existsSync(rowsPath)) { summary.push({ type, status: 'no-rows-file' }); continue; }
  let shapeOk = 'ok';
  if (!shape) { shapeOk = 'no-shape'; missingShapes.push(type); }

  const lines = fs.readFileSync(rowsPath, 'utf8').trim().split('\n').filter(Boolean);
  const cols = (tables[type] || {}).columns || [];
  const decoded = []; let ok = 0, failed = 0;
  for (const line of lines) {
    const rec = JSON.parse(line);
    const key = Object.fromEntries(cols.filter(c => c !== 'data').map((c, i) => [c, rec.key[i]]));
    const bytes = Buffer.from(rec.data, 'base64');
    if (!shape) { decoded.push({ ...key, __undecoded: true }); failed++; continue; }
    try {
      const out = decodeMessage(shape, new Reader(bytes));
      decoded.push({ ...key, ...out });
      ok++;
    } catch (e) {
      failed++;
      triage.push({ type, key, error: String(e).slice(0, 160), bytes: bytes.length });
    }
  }
  totalOk += ok; totalFail += failed;
  summary.push({ type, rows: lines.length, ok, failed, shape: shapeOk, cols });
  if (!summaryOnly) {
    const replacer = (_k, v) => typeof v === 'bigint' ? (Number(v) <= Number.MAX_SAFE_INTEGER ? Number(v) : v.toString()) : v;
    fs.writeFileSync(path.join(OUT, 'structured', `${type}.json`), JSON.stringify(decoded, replacer) + '\n');
  }
}

fs.writeFileSync(path.join(OUT, 'A2_DECODE_SUMMARY.json'), JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(OUT, 'A2_TRIAGE.json'), JSON.stringify(triage, null, 1));
fs.writeFileSync(path.join(OUT, 'A2_MISSING_SHAPES.json'), JSON.stringify(missingShapes, null, 1));

console.log(`partitions=${summary.length} rows_ok=${totalOk} rows_failed=${totalFail}`);
console.log('no-shape partitions:', missingShapes.length, missingShapes.slice(0, 40).join(', '));
console.log('decode failures:', triage.length);
