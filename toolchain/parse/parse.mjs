#!/usr/bin/env node
// A1.0 Parser — dump.cs → typed catalog (out/schemas/*.json)
// Phase A1 schema-extraction pipeline. See privateserver plan.
//
// Parses the Il2CppDumper dump.cs in ~/privateserver/phase3d/dump/ and emits:
//   out/schemas/index.json     — summary, counts, triage log
//   out/schemas/messages.json  — all IMessage classes (fields, wire types)
//   out/schemas/enums.json     — all public enums
//   out/schemas/endpoints.json — service:method → request/response types
//
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.SUMIRE_DATA_DIR
  ? path.resolve(process.env.SUMIRE_DATA_DIR)
  : path.resolve(ROOT, '..');
const DUMP = path.join(DATA_DIR, 'phase3d', 'dump', 'dump.cs');
const OUT = path.join(ROOT, 'out', 'schemas');

const RE_MSG    = /^public sealed class ([A-Za-z0-9_.]+) : .*IMessage</;
const RE_ENUM   = /^public enum ([A-Za-z0-9_.]+)/;
const RE_API    = /^public static class (Api\.[A-Za-z0-9_]+)/;
const RE_NS     = /^\/\/ Namespace:\s*(.*)$/;
const RE_FIELDNUM = /^\tpublic const int ([A-Za-z0-9_]+)FieldNumber = (\d+);$/;
const RE_PROP = /^\tpublic ((?:RepeatedField|MapField)<[^>]+>|[A-Za-z0-9_.]+) ([A-Za-z0-9_]+) \{ get; set; \}$/;
const RE_PROP_GET = /^\tpublic ((?:RepeatedField|MapField)<[^>]+>|[A-Za-z0-9_.]+) ([A-Za-z0-9_]+) \{ get; \}$/;
const RE_PRIV = /^\tprivate (?:readonly )?([A-Za-z0-9_<>.,\[\] ]+?) ([A-Za-z0-9_]+)_; \/\/ 0x[0-9a-fA-F]+/;
const RE_ENUMMEM = /^\tpublic const ([A-Za-z0-9_.]+) ([A-Za-z0-9_]+) = (-?\d+);$/;
const RE_APIMETH = /^\tpublic static UniTask<IApiRequest<([A-Za-z0-9_.]+), ([A-Za-z0-9_.]+)>> ([A-Za-z0-9_]+)Async\(/;

const log = (...a) => console.error(...a);

function countBraces(l) {
  let d = 0;
  for (const ch of l) { if (ch === '{') d++; else if (ch === '}') d--; }
  return d;
}

// ---------------------------------------------------------------------------
// Walk top-level blocks: message / enum / api classes.
// ---------------------------------------------------------------------------
function* blocks(lines) {
  let ns = '';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const nm = l.match(RE_NS);
    if (nm) { ns = nm[1].trim(); continue; }
    const kind = RE_API.test(l) ? 'api' : (RE_MSG.test(l) ? 'message' : (RE_ENUM.test(l) ? 'enum' : null));
    if (!kind) continue;
    // start counting from the first line after the header (the opening `{`)
    let depth = 0, j = i + 1;
    do { depth += countBraces(lines[j]); j++; } while (depth > 0 && j < lines.length);
    yield { kind, start: i, end: j - 1, ns, header: l };
    i = j - 1;
  }
}

// ---------------------------------------------------------------------------
// Wire-type inference
// ---------------------------------------------------------------------------
// Type indexes used during resolution (populated before the resolve pass):
//   namesByType: 'Enum'|'Msg' -> { shortName: [fqNames...] }   (fq = ns + '.' + name)
const enumsIndex = { byShort: new Map(), byFq: new Set() };
const msgsIndex  = { byShort: new Map(), byFq: new Set() };

const byFqKey = (ns, name) => (ns && ns.length ? `${ns}.${name}` : name);

function indexType(index, ns, name) {
  const fq = byFqKey(ns, name);
  index.byFq.add(fq);
  const short = shortOf(name);
  if (!index.byShort.has(short)) index.byShort.set(short, []);
  index.byShort.get(short).push(fq);
}

function primWire(t) {
  switch (t) {
    case 'string':     return { wire: 'len',    label: 'string',    zigzag: false, csharpType: t };
    case 'ByteString': return { wire: 'len',    label: 'bytes',     zigzag: false, csharpType: t };
    case 'int':        return { wire: 'varint', label: 'int32',     zigzag: null,  csharpType: t };
    case 'long':       return { wire: 'varint', label: 'int64',     zigzag: null,  csharpType: t };
    case 'uint':       return { wire: 'varint', label: 'uint32',    zigzag: false, csharpType: t };
    case 'ulong':      return { wire: 'varint', label: 'uint64',    zigzag: false, csharpType: t };
    case 'bool':       return { wire: 'varint', label: 'bool',      zigzag: false, csharpType: t };
    case 'float':      return { wire: 'fixed32', label: 'float',    zigzag: false, csharpType: t };
    case 'double':     return { wire: 'fixed64', label: 'double',   zigzag: false, csharpType: t };
    default:           return null;
  }
}

// Resolve a C# type ref to a message/enum descriptor with a QUALIFIED key so
// identical short names in different namespaces never collide.  The `ns` param
// is the referencing message's namespace: we prefer a same-namespace hit when a
// short name is ambiguous (mirrors the compiler's import resolution) but fall
// back to a deterministic single candidate (first registered) + triage note so
// the pipeline stays fully deterministic.
function resolveType(t, ns) {
  const tt = t.trim();
  const pw = primWire(tt);
  if (pw) return pw;
  const pick = (index, kind) => {
    // exact qualified match (nested types & self-named classes)
    if (tt.includes('.')) {
      if (index.byFq.has(tt)) return { key: tt, ambiguous: false };
      const cands = index.byShort.get(tt) || [];
      if (cands.length === 1) return { key: cands[0], ambiguous: false };
      if (cands.length > 1) return { key: cands[0], ambiguous: true };
      return null;
    }
    const fqs = index.byShort.get(tt) || [];
    if (fqs.length === 0) return null;
    if (fqs.length === 1) return { key: fqs[0], ambiguous: false };
    // ambiguous short name — prefer same namespace, else first registered
    const same = fqs.filter(fq => fq.startsWith(ns + '.'));
    if (same.length === 1) return { key: same[0], ambiguous: true };
    return { key: fqs[0], ambiguous: true };
  };
  const e = pick(enumsIndex, 'enum');
  if (e) return { wire: 'varint', label: 'enum', zigzag: null, csharpType: tt, enum: e.key, enumAmbiguous: e.ambiguous };
  const m = pick(msgsIndex, 'message');
  if (m) return { wire: 'len', label: 'message', zigzag: false, csharpType: tt, message: m.key, messageAmbiguous: m.ambiguous, namespace: m.key.slice(0, m.key.lastIndexOf('.')) };
  return { wire: null, label: 'UNRESOLVED', zigzag: null, csharpType: tt };
}

function shortOf(name) { const i = name.lastIndexOf('.'); return i < 0 ? name : name.slice(i + 1); }

// ---------------------------------------------------------------------------
// Message parser
// ---------------------------------------------------------------------------
function parseMessage(lines, start, end, ns) {
  const name = lines[start].match(RE_MSG)[1];
  const msg = { name, namespace: ns, typeDefIndex: 0, oneof: false, fields: [] };
  const tdm = lines[start].match(/TypeDefIndex: (\d+)/);
  if (tdm) msg.typeDefIndex = Number(tdm[1]);

  const fieldNums = []; // const name -> number
  const props = [];     // {name, csharpType, accessor}
  const privates = [];
  let zone = '';
  for (let i = start + 1; i < end; i++) {
    const l = lines[i];
    if (l.includes('// Fields')) { zone = 'fields'; continue; }
    if (l.includes('// Properties')) { zone = 'props'; continue; }
    if (l.includes('// Methods')) { zone = 'methods'; continue; }

    const fn = l.match(RE_FIELDNUM);
    if (fn) { fieldNums.push({ name: fn[1], number: Number(fn[2]) }); continue; }
    if (zone === 'props') {
      const pr = l.match(RE_PROP) || l.match(RE_PROP_GET);
      if (pr) { props.push({ name: pr[2], csharpType: pr[1], accessor: l.includes('set;') ? 'set' : 'get' }); }
    } else if (zone === 'fields') {
      const pf = l.match(RE_PRIV);
      if (pf && !l.includes('static')) privates.push({ storageName: pf[2], csharpType: pf[1].trim() });
    }
  }

  // static get_Descriptor() RVA for A1.2 descriptor-dump hook (device session)
  // The `// RVA:` comment PRECEDES its method line; searching forward grabs the
  // NEXT method's RVA (the pb::Google.Protobuf.IMessage.get_Descriptor() interface
  // slot impl, which is a different address).  Search backward instead.
  for (let i = start; i < end && !msg.descriptorRva; i++) {
    if (lines[i].includes('public static MessageDescriptor get_Descriptor()')) {
      for (let j = i - 1; j > Math.max(start, i - 8); j--) {
        const r = lines[j].match(/\/\/ RVA: (0x[0-9A-Fa-f]+)/);
        if (r) { msg.descriptorRva = r[1]; break; }
      }
    }
  }

  if (privates.some(p => p.csharpType === 'object')) msg.oneof = true;

  const constNames = new Set(fieldNums.map(f => normName(f.name)));
  const triage = [];

  for (const f of fieldNums) {
    // find property by const name (allow trailing-underscore variants)
    let prop = props.find(p => normName(p.name) === normName(f.name));
    if (!prop) {
      const priv = privates.find(p => p.storageName === camelToSnake(f.name)) ||
                   privates.find(p => normName(p.storageName) === normName(f.name));
      if (priv) prop = { name: f.name, csharpType: priv.csharpType, accessor: 'set', fromStorage: true };
      else { triage.push(`no-prop ${name}.${f.name}`); continue; }
    }

    const t = prop.csharpType;
    let desc = { number: f.number, name: f.name, csharpType: t, accessor: prop.accessor };

    const rm = t.match(/^RepeatedField<(.+)>$/);
    if (rm) {
      const el = resolveType(rm[1], ns);
      desc = { ...desc, repeated: true, element: el };
      // element re-resolved in pass 2 once the full catalog exists
      msg.fields.push(desc);
      continue;
    }
    const mm = t.match(/^MapField<(.+), (.+)>$/);
    if (mm) {
      const k = resolveType(mm[1], ns);
      const v = resolveType(mm[2], ns);
      desc = { ...desc, map: true, key: k, value: v };
      // resolved in pass 2 after full catalog
      msg.fields.push(desc);
      continue;
    }
    const pw = resolveType(t, ns);
    // resolved in pass 2 after full catalog
    desc = { ...desc, ...pw };
    msg.fields.push(desc);
  }

  for (const p of privates) {
    const sn = normName(p.storageName);
    if (!constNames.has(sn) && !/^(parser|unknownfields)$/.test(p.storageName)) {
      // oneof backing boxes (object xxx_, xxxCase_) and interface backing fields are expected
      if (!/^(object|empty|unknownfields)$/.test(p.csharpType) &&
          !/Case$/.test(p.storageName) &&
          !/<.*>k__BackingField/.test(p.storageName)) {
        triage.push(`unpaired-private ${name}.${p.storageName}`);
      }
    }
  }
  return { msg, triage };
}

function normName(s) {
  // strip trailing underscores + lowercase (matches proto FieldNumber const to storage/prop names)
  return s.replace(/_+$/g, '').toLowerCase();
}

function camelToSnake(s) {
  return s.replace(/[A-Z]/g, c => '_' + c.toLowerCase()).replace(/^_|_$/g, '').toLowerCase();
}

function parseEnumBlock(lines, start, ns) {
  const name = lines[start].match(RE_ENUM)[1];
  const e = { name, namespace: ns, typeDefIndex: 0, values: [] };
  const tdm = lines[start].match(/TypeDefIndex: (\d+)/);
  if (tdm) e.typeDefIndex = Number(tdm[1]);
  for (let i = start + 1; i < endOf(lines, start); i++) {
    const l = lines[i];
    const em = l.match(RE_ENUMMEM);
    if (em) e.values.push({ name: em[2], value: Number(em[3]) });
  }
  return e;
}

function parseApiBlock(lines, start) {
  const svc = lines[start].match(RE_API)[1].split('.')[1];
  const api = { service: svc, methods: [] };
  for (let i = start + 1; i < endOf(lines, start); i++) {
    const l = lines[i];
    const am = l.match(RE_APIMETH);
    if (am) api.methods.push({ name: am[3], requestType: am[1], responseType: am[2] });
  }
  return api;
}

function endOf(lines, start) {
  let depth = 0, i = start + 1;
  do { depth += countBraces(lines[i]); i++; } while (depth > 0 && i < lines.length);
  return i;
}

// ---------------------------------------------------------------------------
// Schema overrides — wire-truth corrections from FULLRAW captures that dump.cs
// cannot express (the client build dropped fields the server still sends).
// Keyed by qualifiedName; each override's fields are injected by number.
// Verified against the FULLRAW corpus (see verify/verify_fullraw.ts).
// ---------------------------------------------------------------------------
const SCHEMA_OVERRIDES = {
  // dump.cs (TypeDefIndex 14503) starts at PositionFieldNumber=2 — the client
  // build dropped field 1, but the server still emits `f1.w0 <deckNumber>` first
  // in every entry (observed in User:Get resp 00005). Sibling Transaction
  // variant (tdi 13560) still declares NumberFieldNumber=1.
  'Solis.Common.Proto.Api.UserDeckPosition': {
    insertFields: [{ number: 1, name: 'Number', wire: 'varint', label: 'int32', zigzag: null, csharpType: 'int' }],
  },
};

function applySchemaOverrides(messages) {
  for (const m of messages) {
    const ov = SCHEMA_OVERRIDES[byFqKey(m.namespace, m.name)];
    if (!ov) continue;
    for (const f of ov.insertFields) {
      if (!m.fields.some(x => x.number === f.number)) m.fields.push(f);
    }
    m.fields.sort((a, b) => a.number - b.number);
  }
}

// ---------------------------------------------------------------------------
async function main() {
  log(`[A1.0] reading ${DUMP}`);
  const whole = fs.readFileSync(DUMP, 'utf8');
  const sha = crypto.createHash('sha256').update(whole).digest('hex').slice(0, 16);
  const lines = whole.split('\n');
  log(`[A1.0] ${lines.length} lines, ${(whole.length / 1e6).toFixed(1)} MB, sha256=${sha}`);

  fs.mkdirSync(OUT, { recursive: true });

  const messages = [], enums = [], apis = [], triage = [];

  for (const b of blocks(lines)) {
    if (b.kind === 'message') {
      const { msg, triage: t } = parseMessage(lines, b.start, b.end, b.ns);
      messages.push(msg); triage.push(...t);
    } else if (b.kind === 'enum') {
      enums.push(parseEnumBlock(lines, b.start, b.ns));
    } else {
      apis.push(parseApiBlock(lines, b.start));
    }
  }

  // populate resolution indexes (enum/message by short + full qualified name)
  for (const e of enums) indexType(enumsIndex, e.namespace, e.name);
  for (const m of messages) indexType(msgsIndex, m.namespace, m.name);

  // Re-resolve every field now that the index is complete, so message/enum refs
// carry qualified keys (disambiguates same-name types in different namespaces).
  for (const m of messages) {
    for (const f of m.fields) {
      if (f.repeated) {
        f.element = resolveType(f.element.csharpType, m.namespace);
        if (!f.element.wire) triage.push(`STILL-UNRESOLVED ${m.name}.${f.name} : ${f.element.csharpType}`);
      } else if (f.map) {
        f.key = resolveType(f.key.csharpType, m.namespace);
        f.value = resolveType(f.value.csharpType, m.namespace);
        if (!f.key.wire || !f.value.wire) triage.push(`STILL-UNRESOLVED-map ${m.name}.${f.name}`);
      } else {
        const r = resolveType(f.csharpType, m.namespace);
        if (r.wire) { delete f.csharpType; Object.assign(f, r); }
        else triage.push(`STILL-UNRESOLVED ${m.name}.${f.name} : ${f.csharpType}`);
      }
    }
  }

  applySchemaOverrides(messages);

  const requestClasses = messages.filter(m => m.name.endsWith('Request')).length;
  const responseClasses = messages.filter(m => m.name.endsWith('Response')).length;
  const endpoints = apis.reduce((a, x) => a + x.methods.length, 0);
  const reqTypes = new Set(), respTypes = new Set();
  // qualify each endpoint request/response type to its namespace key
  function qualify(shortName, kind) {
    if (shortName === 'Empty') return shortName;
    const index = kind === 'req' ? msgsIndex : msgsIndex;
    const cands = index.byShort.get(shortName) || [];
    if (cands.length === 1) return cands[0];
    // preferred: Solis.Common.Proto.Api first (RPC namespace), else exact single
    const api = cands.filter(c => c.startsWith('Solis.Common.Proto.Api.'));
    if (api.length === 1) return api[0];
    return cands[0] || shortName;
  }
  for (const a of apis) for (const me of a.methods) {
    me.request = qualify(me.requestType, 'req');
    me.response = qualify(me.responseType, 'resp');
    delete me.requestType; delete me.responseType;
    reqTypes.add(me.request); respTypes.add(me.response);
  }

  const report = {
    schemaVersion: 'a1.0',
    source: { dump: path.basename(DUMP), sha },
    counts: {
      messageClasses: messages.length,
      requestClasses,
      responseClasses,
      referencedRequestTypes: reqTypes.size,
      referencedResponseTypes: respTypes.size,
      enums: enums.length,
      services: apis.length,
      endpointMethods: endpoints,
      oneofMessages: messages.filter(m => m.oneof).length,
    },
    oneofMessages: messages.filter(m => m.oneof).map(m => m.name),
    nameConflicts: Object.entries(
      messages.reduce((acc, m) => { acc[m.name] = (acc[m.name] || 0) + 1; return acc; }, {})
    ).filter(([, n]) => n > 1).map(([name, n]) => ({ name, n, namespaces: messages.filter(x => x.name === name).map(x => x.namespace) })),
    unresolvedFieldCount: messages.reduce((acc, m) => acc + m.fields.filter(f => {
      if (f.repeated) return !f.element.wire;
      if (f.map) return !f.key.wire || !f.value.wire;
      return !f.wire;
    }).length, 0),
    schemaFields: messages.reduce((acc, m) => acc + m.fields.length, 0),
    enumValues: enums.reduce((acc, e) => acc + e.values.length, 0),
  };

  fs.mkdirSync(OUT, { recursive: true });
  // add qualifiedName for all messages (registry key) while keeping name/namespace
  for (const m of messages) m.qualifiedName = byFqKey(m.namespace, m.name);
  // A1.2 descriptor-dump targets: class shortname -> get_Descriptor() RVA
  const rvas = {};
  for (const m of messages) if (m.descriptorRva) rvas[shortOf(m.name)] = m.descriptorRva;
  const DESC = path.join(ROOT, 'descriptors');
  fs.mkdirSync(DESC, { recursive: true });
  fs.writeFileSync(path.join(DESC, 'class_descriptor_rvas.json'), JSON.stringify(rvas, null, 0));
  // regenerate the embedded A1.2 target table inside descriptors/descriptor_dump.js
  try {
    execFileSync('node', [path.join(DESC, 'gen_targets.mjs')], { stdio: 'inherit' });
  } catch (e) { console.error('[A1.2] gen_targets failed: ' + e.message); }
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'messages.json'), JSON.stringify(messages) + '\n');
  fs.writeFileSync(path.join(OUT, 'enums.json'), JSON.stringify(enums) + '\n');
  fs.writeFileSync(path.join(OUT, 'endpoints.json'), JSON.stringify(apis) + '\n');
  fs.writeFileSync(path.join(OUT, 'triage.json'), JSON.stringify(triage, null, 1) + '\n');

  log(`[A1.0] messages=${messages.length} enums=${enums.length} services=${apis.length} methods=${endpoints}`);
  log(`[A1.0] triage entries=${triage.length}  (see out/schemas/triage.json)`);
}

await main();
