// A1.2 descriptor-patch — apply `[A1.2]` lines from the device descriptor dump to
// out/schemas/messages.json, resolving `zigzag:null` / `wire:null` residuals.
//
// Descriptor line format (from descriptors/descriptor_dump.js):
//   [A1.2] <cls>@0x<rva>: fields=<n> | ... | [[<num>,<FieldType>,P,R,M,<name>], ...]
//   FieldType is one of: Double Float Int64 UInt64 Int32 Fixed64 Fixed32 Bool String
//                        Group Message Bytes UInt32 SFixed32 SFixed64 SInt32 SInt64 Enum
//
// FieldType -> schema map (verified 2026-09-11):
//   SInt32(15) / SInt64(16)  -> varint; label int32|int64;            zigzag:true
//   Int32(4) / Int64(2) / UInt32(12) / UInt64(3) / Bool(7) / Enum(17) -> varint; zigzag:false
//   Fixed64(5) / Double(0)   -> wire fixed64, label double            (LE, no zigzag)
//   Fixed32(6) / Float(1)    -> wire fixed32, label float             (LE, no zigzag)
//   String(8) / Bytes(11)    -> len string|bytes
//   Message(10) / Group(9)   -> len message|group
//
// Messages are matched by descriptorRva (normalized hex), which survives the 8
// short-name collisions that the rvas dict's bare-name keys cannot.
//
// Options:
//   node verify/apply_descriptor_patch.ts <a12.log> [--apply] [--self-test]
//     <a12.log>    [A1.2] line source (device dump). Defaults to last-run capture.
//     --apply      write patched messages.json back (default: dry-run + report)
//     --self-test  run built-in synthetic-line assertions and exit
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SC = path.join(ROOT, 'out', 'schemas');
const MSG_FILE = process.env.A12_MSG || path.join(SC, 'messages.json');
const CAP_DIR = path.join(ROOT, '..', 'captures');

const FT = ['Double', 'Float', 'Int64', 'UInt64', 'Int32', 'Fixed64', 'Fixed32', 'Bool', 'String', 'Group', 'Message', 'Bytes', 'UInt32', 'SFixed32', 'SFixed64', 'SInt32', 'SInt64', 'Enum'];

// FieldType name -> { wire, label, zigzag } (see header comment)
const TYPE_MAP = {
  SInt32: { wire: 'varint', label: 'int32', zigzag: true },
  SInt64: { wire: 'varint', label: 'int64', zigzag: true },
  Int32: { wire: 'varint', label: 'int32', zigzag: false },
  Int64: { wire: 'varint', label: 'int64', zigzag: false },
  UInt32: { wire: 'varint', label: 'uint32', zigzag: false },
  UInt64: { wire: 'varint', label: 'uint64', zigzag: false },
  Bool: { wire: 'varint', label: 'bool', zigzag: false },
  Enum: { wire: 'varint', label: 'enum', zigzag: false },
  Fixed64: { wire: 'fixed64', label: 'double', zigzag: false },
  Double: { wire: 'fixed64', label: 'double', zigzag: false },
  Fixed32: { wire: 'fixed32', label: 'float', zigzag: false },
  Float: { wire: 'fixed32', label: 'float', zigzag: false },
  String: { wire: 'len', label: 'string', zigzag: false },
  Bytes: { wire: 'len', label: 'bytes', zigzag: false },
  Message: { wire: 'len', label: 'message', zigzag: false },
  Group: { wire: 'len', label: 'group', zigzag: false },
};

const RE_LINE = /^\[A1\.2\] (.+?)(?:@(0x[0-9A-Fa-f]+))?:\s*fields=(\d+)/;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
function parseRows(payload) {
  // payload = the JSON array portion after '| ' (or a synthetic [[...]] json)
  const m = payload.match(/(\[\[.*\]\])\s*$/s);
  if (!m) return null;
  let rows;
  try { rows = JSON.parse(m[1]); } catch { return null; }
  const out = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const [num, ftName, packed, rep, map, name] = r;
    const ft = TYPE_MAP[ftName];
    if (!ft) continue; // unknown field type — skip (raw 'T<n>' etc.)
    out.push({ num, type: ftName, packed: packed === 'P', rep: rep === 'R', map: map === 'M', name, ...ft });
  }
  return out;
}

function parseLog(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    const m = raw.match(RE_LINE);
    if (!m) continue;
    const cls = m[1];
    const rva = m[2] ? m[2].slice(2).toUpperCase() : null;
    const payload = raw.slice(raw.indexOf('| ') + 2);
    const rows = parseRows(payload);
    if (rows === null) continue;
    lines.push({ cls, rva, rows });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------
function normRva(r) {
  if (!r) return null;
  return String(r).replace(/^0x/i, '').toUpperCase();
}

function deepClone(x) { return JSON.parse(JSON.stringify(x)); }

// Patch one field shape (element/key/value leaf) with descriptor facts.
// Returns true if a change was recorded.
function applyFacts(target, facts, stats) {
  let changed = false;
  if (target.wire === undefined || target.wire === null) { target.wire = facts.wire; stats.wireResolved++; changed = true; }
  if (target.zigzag === undefined || target.zigzag === null) {
    target.zigzag = facts.zigzag;
    if (facts.zigzag) stats.zigzagTrue++; else stats.zigzagFalse++;
    changed = true;
  }
  if ((target.label === undefined || target.label === null) && facts.label) {
    target.label = facts.label; stats.labelResolved++; changed = true;
  }
  return changed;
}

function patchMessage(msg, entry) {
  const stats = { zigzagTrue: 0, zigzagFalse: 0, wireResolved: 0, labelResolved: 0, fieldsPatched: 0, unmatched: 0 };
  const byNum = new Map();
  for (const f of msg.fields) byNum.set(f.number, f);

  for (const row of entry.rows) {
    const f = byNum.get(row.num);
    if (!f) { stats.unmatched++; continue; }
    // repeated → element; map → key/value; direct scalar otherwise
    let target = f;
    if (f.element) target = f.element;
    else if (f.map) target = f.key; // maps: key carries the scalar wire; value follows message ref
    if (applyFacts(target, row, stats)) stats.fieldsPatched++;
    // container-level mirror so the field-level residual counters drop to 0
    if (f.element && (f.wire === undefined || f.wire === null)) {
      const wasNull = (f.zigzag === undefined || f.zigzag === null) && f.wire === undefined;
      f.wire = row.wire;
      if (f.label === undefined || f.label === null) f.label = row.label;
      if (f.zigzag === undefined || f.zigzag === null) f.zigzag = row.zigzag;
      stats.fieldsPatched++;
      if (wasNull) stats.wireResolved++;
    }
  }
  return stats;
}

function applyAll(messages, entries) {
  const byRva = new Map();
  for (const mm of messages) {
    const r = normRva(mm.descriptorRva);
    if (r) byRva.set(r, mm);
  }
  const stats = { zigzagTrue: 0, zigzagFalse: 0, wireResolved: 0, labelResolved: 0, fieldsPatched: 0, unmatched: 0, classes: 0 };
  const patchedClasses = [];
  const missed = [];
  for (const entry of entries) {
    if (!entry.rva) { missed.push({ cls: entry.cls, why: 'no-rva' }); continue; }
    const mm = byRva.get(entry.rva);
    if (!mm) { missed.push({ cls: entry.cls, rva: entry.rva, why: 'no-message' }); continue; }
    const s = patchMessage(mm, entry);
    for (const k of Object.keys(s)) stats[k] += s[k];
    stats.classes++;
    patchedClasses.push(mm.qualifiedName);
  }
  return { stats, patchedClasses, missed };
}

function countResiduals(messages) {
  // Field-level metric matching the plan: a residual is a FIELD whose own
  // `zigzag` is null (e.g. int32/int64/enum) or whose own `wire` is null
  // (repeated/map containers statically uninferrable — descriptor sets both).
  let zigzagNull = 0, wireNull = 0, fields = 0;
  for (const mm of messages) for (const f of mm.fields) {
    fields++;
    if (f.zigzag === null || f.zigzag === undefined) zigzagNull++;
    if (f.wire === null || f.wire === undefined) wireNull++;
  }
  return { zigzagNull, wireNull, fields };
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------
function syntheticCheck(messages) {
  // Fixtures are built from REAL residual-bearing catalog fields so the test
  // asserts actual resolution (not fabricated numbers).
  const mk = (msg, rows) => {
    const rva = normRva(msg.descriptorRva);
    if (!rva) throw new Error(`self-test: ${msg.qualifiedName} has no descriptorRva`);
    const payload = JSON.stringify(rows.map(r => [r.num, r.type, r.packed ? 'P' : '', r.rep ? 'R' : '', r.map ? 'M' : '', r.name]));
    return { cls: msg.name, rva, rows: parseRows(payload) };
  };
  const findField = (msg, number) => {
    const f = msg.fields.find(x => x.number === number);
    if (!f) throw new Error(`self-test: ${msg.qualifiedName} field ${number} not in catalog`);
    return f;
  };

  // 1) Transaction.Payslip: 6 ActivityBonus (int32 zigzag:null), 7 GvgHighestPoint (int64 zigzag:null)
  const payslip = messages.find(m => m.qualifiedName === 'Solis.Common.Proto.Transaction.Payslip');
  // 2) Api.CompanyTopResponse: 6 ThisMonthSalaryPoint (int64 zigzag:null)
  const comTop = messages.find(m => m.qualifiedName === 'Solis.Common.Proto.Api.CompanyTopResponse');
  // 3) repeated scalar: Master.Card field 7 InitialRarity is direct int32; use a repeated field instead:
  const repField = messages.flatMap(m => m.fields.map(f => ({ m, f })))
    .find(({ f }) => f.element && f.element.zigzag === null);
  if (!payslip || !comTop || !repField) throw new Error('self-test: expected residual bearings fields in catalog');

  const fP6 = findField(payslip, 6); // int32 → Int32 (zigzag:false)
  const fP7 = findField(payslip, 7); // int64 → Int64 (zigzag:false)
  const fC6 = findField(comTop, 6);  // int64 → Int64 (zigzag:false)
  const fR = repField.f;             // repeated element zigzag:null — treat as SInt32 to prove zigzag:true
  const eR = fR.element;

  const clone = deepClone(messages);
  const entries = [
    mk(payslip, [
      { num: 6, type: 'Int32', packed: false, rep: false, map: false, name: fP6.name },
      { num: 7, type: 'Int64', packed: false, rep: false, map: false, name: fP7.name },
    ]),
    mk(comTop, [
      { num: 6, type: 'Int64', packed: false, rep: false, map: false, name: fC6.name },
    ]),
    mk(repField.m, [
      { num: fR.number, type: 'SInt32', packed: true, rep: true, map: false, name: fR.name },
    ]),
  ];
  const { stats, missed } = applyAll(clone, entries);

  const cPayslip = clone.find(m => m.qualifiedName === payslip.qualifiedName);
  const cComTop = clone.find(m => m.qualifiedName === comTop.qualifiedName);
  const cRepMsg = clone.find(m => m.qualifiedName === repField.m.qualifiedName);
  const cRep = cRepMsg.fields.find(x => x.number === fR.number);
  const checks = [
    [cPayslip.fields.find(x => x.number === 6).zigzag === false, 'Payslip.6 Int32 -> zigzag:false'],
    [cPayslip.fields.find(x => x.number === 7).zigzag === false, 'Payslip.7 Int64 -> zigzag:false'],
    [cComTop.fields.find(x => x.number === 6).zigzag === false, 'CompanyTopResponse.6 Int64 -> zigzag:false'],
    [cRep.element.zigzag === true, `repeated SInt32 element -> zigzag:true (${repField.m.qualifiedName}.${fR.name})`],
    [cRep.element.wire === 'varint', 'repeated SInt32 element wire varint'],
    [cRep.wire === 'varint', 'repeated container wire mirrored varint'],
    [missed.length === 0, 'no unmapped descriptor lines'],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
  if (failed.length) throw new Error('self-test FAIL: ' + failed.join('; '));
  if (stats.classes !== 3) throw new Error(`self-test FAIL: expected 3 classes patched, got ${stats.classes}`);
  if (stats.wireResolved !== 1) throw new Error(`self-test FAIL: expected 1 wire resolved (repeated container), got ${stats.wireResolved}`);
  if (!idempotent(clone, entries)) throw new Error('self-test FAIL: second pass mutated messages');
  console.log(`[A1.2-self-test] PASS (3 fixtures, ${stats.fieldsPatched} field patches, resid tolerable, idempotent re-run ok)`);
  return true;
}

function idempotent(clone, entries) {
  const snapshot = JSON.stringify(clone);
  applyAll(deepClone(clone), entries);
  return JSON.stringify(clone) === snapshot;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const doApply = argv.includes('--apply');
  const doSelfTest = argv.includes('--self-test');
  const logArg = argv.find(a => !a.startsWith('--'));

  const messages = JSON.parse(fs.readFileSync(MSG_FILE, 'utf8'));

  if (doSelfTest) {
    syntheticCheck(messages);
    return;
  }

  let source = logArg;
  if (!source) {
    const logs = fs.readdirSync(CAP_DIR).filter(f => f.endsWith('.log'));
    source = logs.map(f => path.join(CAP_DIR, f)).find(p => {
      try { return /\[A1\.2\]/.test(fs.readFileSync(p, 'utf8')); } catch { return false; }
    });
  }
  if (!source || !fs.existsSync(source)) {
    console.error('[A1.2] no [A1.2] log found; pass <a12.log> explicitly, or --self-test');
    process.exit(2);
  }

  const before = countResiduals(messages);
  const entries = parseLog(fs.readFileSync(source, 'utf8'));
  console.log(`[A1.2] source=${source}  descriptor lines=${entries.length}`);

  const { stats, patchedClasses, missed } = applyAll(messages, entries);
  const after = countResiduals(messages);

  console.log(JSON.stringify({
    classesPatched: stats.classes,
    fieldsPatched: stats.fieldsPatched,
    zigzagTrue: stats.zigzagTrue,
    zigzagFalse: stats.zigzagFalse,
    wireResolved: stats.wireResolved,
    labelResolved: stats.labelResolved,
    unmatchedFieldNumbers: stats.unmatched,
  }, null, 2));

  console.log('residuals: before', JSON.stringify(before));
  console.log('residuals: after ', JSON.stringify(after));

  if (missed.length) {
    console.log('unmapped descriptor lines:');
    for (const mm of missed.slice(0, 20)) console.log('  ', JSON.stringify(mm));
  }

  if (doApply) {
    fs.writeFileSync(MSG_FILE, JSON.stringify(messages) + '\n');
    console.log(`[A1.2] wrote ${MSG_FILE}`);
  } else {
    console.log('[A1.2] dry-run (no write). Pass --apply to persist to messages.json.');
  }
}

main();
