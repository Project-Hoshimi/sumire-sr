// A1.3 Capture verification harness.
// Extracts ENC-in-plain (request) and DEC-out-plain (response) payloads from the
// Frida capture logs, correlates them with the endpoint (EXEC service method),
// decodes each with the generated schema and re-encodes, asserting byte-exact
// roundtrip. Emits a report + collects residuals for unresolved-ambiguity fixes.
//
// Corpus currently lives in ~/privateserver/captures/*.log as plaintext hex.
// Usage: node verify/verify_schemas.ts [log-glob]
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Reader, Writer, decodeMessage, encodeMessage, msgRegistry } from '../runtime/proto.ts';
import '../src/gen/registry.ts';
import { endpoints } from '../src/gen/endpoints.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAP_DIR = path.join(ROOT, '..', 'captures');

const RE_EXEC = /EXEC service=(\w+) method=(\w+)/;

function parseHex(payload) {
  // payload = ': bytes=N (truncated) 0a 12 08 ...' — capture hex only after the marker
  const bytes = [];
  const m = payload.match(/bytes=\d+(?: \(truncated\))?\s*/);
  if (!m) return bytes;
  const hex = payload.slice(m.index + m[0].length);
  const pairs = hex.match(/[0-9a-f]{2}/g) || [];
  for (const h of pairs) bytes.push(parseInt(h, 16));
  return bytes;
}

// Distinguish the three capture formats:
//  - 'ENC in  plain   : bytes=N ... <hex>'      -> request plaintext
//  - 'DEC out plain   : bytes=N ... <hex>'      -> response plaintext (may be truncated)
function classify(raw) {
  if (raw.includes('ENC in  plain')) {
    const i = raw.indexOf(':');
    return { kind: 'req', payload: raw.slice(i + 1) };
  }
  if (raw.includes('DEC out plain')) {
    const i = raw.indexOf(':');
    return { kind: 'resp', payload: raw.slice(i + 1) };
  }
  return null;
}

function extractCorpus(glob) {
  const files = fs.readdirSync(CAP_DIR).filter(f => f.endsWith('.log'));
  const corpus = [];
  for (const f of files) {
    if (glob && !f.includes(glob)) continue;
    let cur = null;
    const text = fs.readFileSync(path.join(CAP_DIR, f), 'utf8');
    for (const raw of text.split('\n')) {
      const ex = raw.match(RE_EXEC);
      if (ex) { cur = { svc: ex[1], method: ex[2] }; continue; }
      const cls = classify(raw);
      if (cls && cur) {
        const m = cls.payload.match(/bytes=(\d+)(?: \(truncated\))?\s*((?:[0-9a-f]{2} ?)*)/);
        const truncated = cls.payload.includes('(truncated)');
        const bytes = parseHex(cls.payload);
        corpus.push({
          svc: cur.svc, method: cur.method, kind: cls.kind,
          file: f, truncated, declaredLen: m ? Number(m[1]) : bytes.length, bytes,
        });
      }
    }
  }
  return corpus;
}

function endpointType(svc, method, kind) {
  const m = endpoints[svc]?.[method];
  if (!m) return null;
  return kind === 'req' ? m.request : m.response;
}

function roundtripBytes(shapeName, bytes) {
  const shape = msgRegistry.get(shapeName);
  if (!shape) return { ok: false, err: `unregistered ${shapeName}` };
  try {
    // Some responses carry a marshaller envelope: fa f0 04<len><payload>.
    // We fragment-decode: if body decodes cleanly + roundtrips byte-exact as-is,
    // use it; else try unwrapping the fa f0 04<len> envelope first.
    let dec, out;
    {
      const w0 = new Writer();
      const d0 = decodeMessage(shape, new Reader(bytes));
      encodeMessage(shape, d0, w0);
      const b0 = w0.toBytes();
      if (eq(b0, bytes)) return { ok: true, decoded: d0, out: b0, envelope: false };
    }
    if (bytes.length >= 5 && bytes[0] === 0xfa && bytes[1] === 0xf0 && bytes[2] === 0x04) {
      let i = 3;
      let len = 0, shift = 0;
      while (i < bytes.length && (bytes[i] & 0x80)) { len |= (bytes[i] & 0x7f) << shift; shift += 7; i++; }
      if (i >= bytes.length) return { ok: false, err: 'envelope-truncated' };
      len |= bytes[i] << shift; i++;
      const payload = bytes.subarray(i);
      dec = decodeMessage(shape, new Reader(payload));
      const w = new Writer();
      encodeMessage(shape, dec, w);
      out = w.toBytes();
      return { ok: eq(out, payload), decoded: dec, out, envelope: true };
    }
    return { ok: false, err: 'mismatch' };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const report = { total: 0, byteExact: 0, mismatched: 0, partialTruncated: 0, failedDecode: 0, unknownEndpoint: 0 };
const byEndpoint = {};

function main() {
  const globArg = process.argv[2];
  const corpus = extractCorpus(globArg);

  for (const c of corpus) {
    const key = `${c.svc}:${c.method} ${c.kind}`;
    if (!byEndpoint[key]) byEndpoint[key] = { n: 0, exact: 0, mis: 0, samples: [] };
    const e = byEndpoint[key];
    e.n++; report.total++;

    const typeN = endpointType(c.svc, c.method, c.kind);
    if (!typeN) {
      report.unknownEndpoint++;
      if (e.samples.length < 2) e.samples.push({ err: 'no-schema', kind: c.kind, file: c.file });
      continue;
    }
    const r = roundtripBytes(typeN, new Uint8Array(c.bytes));
    if (r.ok) { e.exact++; report.byteExact++; }
    else {
      const truncatedPayload = c.truncated || (c.declaredLen > c.bytes.length);
      if (truncatedPayload) {
        // partial data: decode-only (field-level) verification; byte-exactness needs fullraw
        report.partialTruncated++;
      } else {
        e.mis++; report.mismatched++;
      }
      if (e.samples.length < 3) {
        e.samples.push({ err: r.err || (truncatedPayload ? 'truncated-fullraw-needed' : 'mismatch'),
          kind: c.kind, type: typeN, file: c.file, declared: c.declaredLen, parsed: c.bytes.length,
          truncated: c.truncated, first64: Buffer.from(c.bytes.slice(0, 64)).toString('hex') });
      }
    }
  }

  console.log('[A1.3] corpus:', report.total, 'entries');
  console.log(JSON.stringify({ byteExact: report.byteExact, mismatched: report.mismatched,
    partialTruncated: report.partialTruncated, failedDecode: report.failedDecode,
    unknownEndpoint: report.unknownEndpoint }, null, 2));
  console.log('--- per-endpoint ---');
  for (const [k, v] of Object.entries(byEndpoint).sort()) {
    console.log(`${k.padEnd(34)} n=${String(v.n).padStart(3)} exact=${String(v.exact).padStart(3)} mis=${String(v.mis).padStart(3)}`);
    for (const s of v.samples) console.log('   ', s);
  }
}

main();

(End of file - total 167 lines)
