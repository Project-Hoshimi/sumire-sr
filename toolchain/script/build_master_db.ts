// Phase A2 — emit a queryable SQLite master DB (node:sqlite).
// Source: out/structured/<Type>.json (fully decoded per-message rows).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { msgRegistry } from '../../fastify-api/runtime/proto.ts';
import '../../fastify-api/src/gen/registry.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..', '..');
const BASE = path.join(process.env.SUMIRE_DATA_DIR ? path.resolve(process.env.SUMIRE_DATA_DIR) : REPO_ROOT, 'phaseA2');
const OUT = path.join(BASE, 'out');
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
const tables = JSON.parse(fs.readFileSync(path.join(OUT, 'tables.json'), 'utf8'));
const DB = path.join(OUT, 'master.db');
if (fs.existsSync(DB)) fs.unlinkSync(DB);

const db = new DatabaseSync(DB);
db.exec('PRAGMA journal_mode=OFF');
const maxSafe = 9007199254740991n;
const toJson = (v) => typeof v === 'bigint' ? (v > maxSafe ? v.toString() : Number(v)) : v;

let totalRows = 0;
const dbSummary = [];
for (const p of manifest.partitions) {
  const type = p.type;
  const shape = msgRegistry.get(`Solis.Common.Proto.Master.${type}`);
  const sp = path.join(OUT, 'structured', `${type}.json`);
  if (!fs.existsSync(sp)) continue;
  let rows;
  try { rows = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch { continue; }
  if (!Array.isArray(rows) || rows.length === 0) continue;
  const pkCols = (tables[type]?.columns || []).filter(c => c !== 'data');
  const fieldShapes = (shape?.fields || []).filter(f => !pkCols.includes(f.name));
  const skip = (k) => k === '__msg' || k === '__unknown';
  let colNames = [...pkCols, ...fieldShapes.map(f => f.name)];
  colNames = colNames.filter(k => !skip(k));
  const colDefs = colNames.map(c => `"${c}"`);
  db.exec(`CREATE TABLE "${type}" (${colDefs.join(', ')})`);
  const ins = db.prepare(`INSERT INTO "${type}" VALUES (${colDefs.map(() => '?').join(', ')})`);
  db.exec('BEGIN');
  for (const rec of rows) {
    const row = colNames.map(c => {
      const v = rec[c];
      if (v === undefined || v === null) return null;
      if (typeof v === 'object') return JSON.stringify(v, (_k, x) => toJson(x));
      return toJson(v);
    });
    ins.run(...row);
    totalRows++;
  }
  db.exec('COMMIT');
  dbSummary.push({ type, table: type, rows: rows.length, pk: pkCols, fields: colNames.filter(c => !pkCols.includes(c)) });
}
db.exec(`CREATE TABLE _meta (version TEXT, totalRows INTEGER)`);
db.prepare('INSERT INTO _meta VALUES (?, ?)').run(manifest.version, totalRows);
console.log(`master.db: ${dbSummary.length} tables, ${totalRows} rows total`);
fs.writeFileSync(path.join(OUT, 'A2_DB_SUMMARY.json'), JSON.stringify(dbSummary, null, 1));
db.close();