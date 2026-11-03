// Phase A2 — emit a typed Drizzle (drizzle-orm/pg-core) schema for all master tables.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..', '..');
const BASE = path.join(process.env.SUMIRE_DATA_DIR ? path.resolve(process.env.SUMIRE_DATA_DIR) : REPO_ROOT, 'phaseA2');
const OUT = path.join(BASE, 'out');
const inv = JSON.parse(fs.readFileSync(path.join(OUT, 'A2_FIELD_INVENTORY.json'), 'utf8'));
const version = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')).version;

const TAB = '  ';
function pgType(f) {
  if (f.repeated || f.map) return 'jsonb';
  const l = f.label;
  if (l === 'string') return 'text';
  if (l === 'bytes') return 'bytea';
  if (l === 'message') return 'jsonb';
  if (l === 'boolean' || l === 'bool') return 'boolean';
  if (l === 'float' || l === 'double') return 'doublePrecision';
  return 'integer';
}
function isIdent(n) { return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(n); }
function qcol(n) { return isIdent(n) ? n : `"${n}"`; }

const lines = [];
lines.push('// Phase A2 — auto-generated typed Drizzle schema for the master database.');
lines.push('// Source: Solis.Common.Proto.Master.* schemas (A1) + A2 partition harvest (202 tables).');
lines.push(`// Master version: ${version}`);
lines.push("import { pgTable, text, integer, jsonb, boolean, doublePrecision, bytea } from 'drizzle-orm/pg-core';");
lines.push('');

let tableCount = 0;
for (const m of inv) {
  if (m.shape !== 'ok' || m.fields.length === 0 && (m.pk || []).length === 0) {
    lines.push(`// ${m.type}: no partition data / no schema in this version`);
    lines.push('');
    continue;
  }
  const pkSet = new Set(m.pk || []);
  const cols = [];
  for (const pk of (m.pk || [])) {
    cols.push(`${TAB}${qcol(pk)}: text.primaryKey(),`);
  }
  for (const f of m.fields) {
    if (pkSet.has(f.name)) continue;
    cols.push(`${TAB}${qcol(f.name)}: ${pgType(f)},`);
  }
  lines.push(`export const master${m.type} = pgTable('master_${m.type}', {`);
  lines.push(cols.join('\n'));
  lines.push('});');
  lines.push('');
  tableCount++;
}
fs.writeFileSync(path.join(OUT, 'master_schema.ts'), lines.join('\n'));
console.log(`master_schema.ts written: ${tableCount} tables`);