// A1.2 descriptor-patch (v2) — apply zigzag facts from the device-captured
// FieldDescriptorProto corpus to out/schemas/messages.json.
//
// Unlike apply_descriptor_patch.ts (which re-reads raw `[A1.2]` log lines from
// descriptor_dump.js), this engine consumes the fully-reconciled patch list that
// was produced host-side by decoding the 351 captured [DESC] base64 blobs with
// python google.protobuf descriptor_pb2. Patch entry shape:
//   { msgIndex: <index into messages.json>, fieldNumber: <proto field#>,
//     zigzag: <bool>, name: <message short name>, fieldName: <proto field name> }
//
// Zigzag facts: FieldDescriptorProto.TYPE_INT32(5)/TYPE_INT64(3) -> false;
// TYPE_SINT32(17)/TYPE_SINT64(18) -> true. Every int32/int64 varint field in the
// catalog resolves to one of these four, so zigzag:null always becomes a real bool.
//
// Options:
//   node verify/apply_proto_descriptors.ts [patch.json] [--apply] [--self-test]
//     patch.json   default /tmp/zigzag_patch.json  (host reconcile output)
//     --apply      write patched messages.json back (default: dry-run + report)
//     --self-test  run built-in assertions and exit
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SC = path.join(ROOT, 'out', 'schemas');
const MSG_FILE = process.env.A12_MSG || path.join(SC, 'messages.json');
const PATCH_DEFAULT = path.join(SC, 'zigzag_patch.json');

// ---------------------------------------------------------------------------
// Residuals — the AMBIGUOUS-LEAF metric (matches the A1.2 acceptance number):
// a leaf whose wire is `varint`, label int32|int64, and zigzag still null.
// Leaf = f itself (direct scalar), f.element (repeated), or f.key/f.value (map).
// Container fields statically carry wire=null/label=null for repeated/map; only
// counts at the leaf resolve the ambiguity, so enums/strings/messages never
// count here. Total across the catalog = 2,173 pre-patch, 0 post-patch.
// ---------------------------------------------------------------------------
function isAmbiguousLeaf(x) {
  return (x.zigzag === null || x.zigzag === undefined) && x.wire === 'varint'
    && (x.label === 'int32' || x.label === 'int64');
}

function countResiduals(messages) {
  let ambiguous = 0, zigzagNull = 0, wireNull = 0, fields = 0;
  for (const mm of messages) for (const f of mm.fields) {
    fields++;
    const leaves = [];
    if (f.element) leaves.push(f.element);
    else if (f.map) { if (f.key) leaves.push(f.key); if (f.value) leaves.push(f.value); }
    else leaves.push(f);
    for (const leaf of leaves) {
      if (leaf.zigzag === null || leaf.zigzag === undefined) zigzagNull++;
      if (leaf.wire === null || leaf.wire === undefined) wireNull++;
      if (isAmbiguousLeaf(leaf)) ambiguous++;
    }
  }
  return { ambiguous, zigzagNull, wireNull, fields };
}

function deepClone(x) { return JSON.parse(JSON.stringify(x)); }

// ---------------------------------------------------------------------------
// Apply one patch entry; mirror container for repeated fields (so the
// field-level residual counters drop to 0, matching the harness behavior).
// ---------------------------------------------------------------------------
function applyEntry(msg, entry, stats) {
  const f = msg.fields.find(x => x.number === entry.fieldNumber);
  if (!f) { stats.missedField++; return; }

  let target = null;
  let isElement = false;
  if (f.element) { target = f.element; isElement = true; }
  else if (f.map) {
    // map<int32|int64, V>  -> key leaf; map<K, int32|int64> -> value leaf.
    // Exactly one of key/value carries the ambiguous scalar.
    if (f.key && (f.key.zigzag === null || f.key.zigzag === undefined)) target = f.key;
    else if (f.value) target = f.value;
  } else {
    target = f;
  }
  if (!target) { stats.missedTarget++; return; }

  if (target.zigzag === null || target.zigzag === undefined) {
    target.zigzag = entry.zigzag;
    if (entry.zigzag) stats.zigzagTrue++; else stats.zigzagFalse++;
    stats.fieldsPatched++;
  }

  // repeat container though container f.wire/label are statically set elsewhere
  if (isElement && (f.zigzag === null || f.zigzag === undefined)) {
    f.zigzag = entry.zigzag;
  }
}

function applyAll(messages, patch, bytes) {
  const stats = { zigzagTrue: 0, zigzagFalse: 0, fieldsPatched: 0, missedField: 0, missedTarget: 0, patchCount: patch.length };
  for (const e of patch) {
    const msg = messages[e.msgIndex];
    if (!msg) { stats.missedField++; continue; }
    applyEntry(msg, e, stats);
  }
  return { stats, sizeBefore: bytes.length };
}

// ---------------------------------------------------------------------------
// Self-test: weave real, currently-pathological catalog fields so the assertion
// proves actual residual resolution. Entries come from the reconcile patch
// itself (msgIndex/fieldNumber/etc. already validated against the catalog).
// ---------------------------------------------------------------------------
function selfTest(messages, patch) {
  const errors = [];
  if (!Array.isArray(patch) || patch.length !== 2173) {
    errors.push(`expected 2173 patch entries, got ${patch ? patch.length : 'none'}`);
  }
  // sanity: every patch entry must address an existing message field
  for (const e of patch) {
    const msg = messages[e.msgIndex];
    if (!msg) { errors.push(`msgIndex ${e.msgIndex} out of range`); break; }
    const f = msg.fields.find(x => x.number === e.fieldNumber);
    if (!f) { errors.push(`${msg.qualifiedName}: field ${e.fieldNumber} missing`); break; }
  }
  if (errors.length) throw new Error('self-test FAIL: ' + errors.join('; '));

  // Reconstruct the PRE-apply catalog state: null out any zigzag that the patch
  // would set (state-independent self-test — works before or after --apply).
  const clone = deepClone(messages);
  for (const e of patch) {
    const m = clone[e.msgIndex];
    const f = m.fields.find(x => x.number === e.fieldNumber);
    const leaves = [];
    if (f.element) leaves.push(f.element);
    else if (f.map) { if (f.key) leaves.push(f.key); if (f.value) leaves.push(f.value); }
    else leaves.push(f);
    for (const leaf of leaves) {
      if (leaf.wire === 'varint' && (leaf.label === 'int32' || leaf.label === 'int64')) {
        leaf.zigzag = null; // force pre-apply ambiguity
      }
    }
  }
  const before = countResiduals(clone);
  if (before.ambiguous !== 2173) errors.push(`expected 2173 ambiguous leaves pre-patch, got ${before.ambiguous}`);

  applyAll(clone, patch, Buffer.from(''));
  const after = countResiduals(clone);
  if (after.ambiguous !== 0) errors.push(`expected ambiguous residual 0, got ${after.ambiguous}`);
  if (after.wireNull !== before.wireNull) errors.push(`wireNull changed unexpectedly ${before.wireNull} -> ${after.wireNull}`);

  // idempotence: a second apply over the fully-resolved catalog must be a no-op
  const snap = JSON.stringify(clone);
  applyAll(clone, patch, Buffer.from(''));
  if (JSON.stringify(clone) !== snap) errors.push('second apply mutated');

  if (errors.length) throw new Error('self-test FAIL: ' + errors.join('; '));
  console.log(`[proto-descriptors-self-test] PASS (patch=${patch.length}, ambiguous ${before.ambiguous}->${after.ambiguous}, idempotent)`);
  return true;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const doApply = argv.includes('--apply');
  const doSelfTest = argv.includes('--self-test');
  const patchArg = argv.find(a => !a.startsWith('--')) ?? PATCH_DEFAULT;
  const patch = JSON.parse(fs.readFileSync(patchArg, 'utf8'));
  const messages = JSON.parse(fs.readFileSync(MSG_FILE, 'utf8'));
  const before = countResiduals(messages);

  if (doSelfTest) { selfTest(messages, patch); return; }

  const buf = fs.readFileSync(MSG_FILE);
  const { stats, sizeBefore } = applyAll(messages, patch, buf);
  const after = countResiduals(messages);

  console.log(JSON.stringify({
    patchFile: patchArg,
    patchCount: stats.patchCount,
    fieldsPatched: stats.fieldsPatched,
    zigzagTrue: stats.zigzagTrue,
    zigzagFalse: stats.zigzagFalse,
    missedField: stats.missedField,
    missedTarget: stats.missedTarget,
  }, null, 2));
  console.log('residuals: before', JSON.stringify(before));
  console.log('residuals: after ', JSON.stringify(after));

  if (doApply) {
    fs.writeFileSync(MSG_FILE, JSON.stringify(messages) + '\n');
    console.log(`[proto-descriptors] wrote ${MSG_FILE}`);
  } else {
    console.log('[proto-descriptors] dry-run (no write). Pass --apply to persist to messages.json.');
  }
}

main();
