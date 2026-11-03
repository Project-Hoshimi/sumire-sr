// A1.3 FULLRAW corpus verification.
// Reads the binary FULLRAW captures (~/privateserver/captures/<session>/*.bin)
// named NN.req-plain.Service:Method.bin / NN.resp-plain.Service:Method.bin,
// correlates each with the endpoint (service:method), decodes with the generated
// schema and re-encodes, asserting byte-exact roundtrip. These captures are
// untruncated, so they upgrade the "partial (truncated)" residuals from the
// hex .log corpus to byte-exact proof.
// Usage: node verify/verify_fullraw.ts [session-glob]
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Reader, Writer, decodeMessage, encodeMessage, msgRegistry } from '../runtime/proto.ts';
import '../src/gen/registry.ts';
import { endpoints } from '../src/gen/endpoints.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAP_ROOT = path.join(ROOT, '..', 'captures');

const RE_FN = /^(\d{5})\.(req|resp)-plain\.([A-Za-z0-9]+):([A-Za-z0-9]+)\.bin$/;

function endpointType(svc, method, kind) {
  const m = endpoints[svc]?.[method];
  if (!m) return null;
  return kind === 'req' ? m.request : m.response;
}

function eq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Return candidate cut points at which a `fa f0 04 <len> <payload>` marshaller
// envelope ends (anywhere in the buffer). Some captures duplicate the trailing
// envelope and append garbage after it (see Notice:List resp 00010); the real
// message ends at an envelope boundary. Each candidate is only accepted after a
// byte-exact roundtrip of the prefix, so clean bodies are never misclassified.
function envelopeEndCandidates(bytes) {
  const ends = new Set([bytes.length]);
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (!(bytes[i] === 0xfa && bytes[i + 1] === 0xf0 && bytes[i + 2] === 0x04)) continue;
    let j = i + 3, len = 0, shift = 0;
    while (j < bytes.length && (bytes[j] & 0x80)) { len |= (bytes[j] & 0x7f) << shift; shift += 7; j++; }
    if (j >= bytes.length) continue;
    len |= bytes[j] << shift; j++;
    const end = j + len;
    if (end <= bytes.length) ends.add(end);
  }
  return [...ends].sort((a, b) => b - a);
}

function roundtripBytes(shapeName, bytes) {
  const shape = msgRegistry.get(shapeName);
  if (!shape) return { ok: false, err: `unregistered ${shapeName}` };
  try {
    // Some responses carry a marshaller envelope: fa f0 04<len><payload>.
    // Try decode+encode byte-exact as-is; else unwrap the fa f0 04<len> envelope.
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
      const dec = decodeMessage(shape, new Reader(payload));
      const w = new Writer();
      encodeMessage(shape, dec, w);
      const out = w.toBytes();
      return { ok: eq(out, payload), decoded: dec, out, envelope: true };
    }
    // Duplicated trailing marshaller envelope + appended garbage (capture
    // artifact): cut at envelope boundaries and verify the body byte-exact.
    for (const cut of envelopeEndCandidates(bytes)) {
      if (cut === bytes.length) continue;
      const prefix = bytes.subarray(0, cut);
      try {
        const dec = decodeMessage(shape, new Reader(prefix));
        const w = new Writer();
        encodeMessage(shape, dec, w);
        const out = w.toBytes();
        if (eq(out, prefix)) return { ok: true, decoded: dec, out, envelope: false, trailStripped: bytes.length - prefix.length };
      } catch { /* try next candidate */ }
    }
    return { ok: false, err: 'mismatch' };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
}

const report = { total: 0, byteExact: 0, envelope: 0, trailStripped: 0, mismatched: 0, failedDecode: 0, unknownEndpoint: 0, unparsableFilenames: 0 };
const byEndpoint = {};

function main() {
  const sessionGlob = process.argv[2];
  const sessions = fs.readdirSync(CAP_ROOT).filter(d => {
    if (sessionGlob && !d.includes(sessionGlob)) return false;
    const p = path.join(CAP_ROOT, d);
    return fs.statSync(p).isDirectory();
  });

  for (const ses of sessions) {
    const dir = path.join(CAP_ROOT, ses);
    let bins = [];
    try { bins = fs.readdirSync(dir).filter(f => f.endsWith('.bin')); }
    catch { continue; }
    for (const fn of bins) {
      const m = fn.match(RE_FN);
      if (!m) { report.unparsableFilenames++; continue; }
      const [, idx, kind, svc, method] = m;
      const key = `${svc}:${method} ${kind}`;
      if (!byEndpoint[key]) byEndpoint[key] = { n: 0, exact: 0, env: 0, trail: 0, mis: 0, samples: [] };
      const e = byEndpoint[key];
      e.n++; report.total++;

      const bytes = fs.readFileSync(path.join(dir, fn));
      const typeN = endpointType(svc, method, kind);
      if (!typeN) {
        report.unknownEndpoint++;
        if (e.samples.length < 2) e.samples.push({ err: 'no-schema', kind, file: fn });
        continue;
      }
      const r = roundtripBytes(typeN, bytes);
      if (r.ok) {
        e.exact++; report.byteExact++;
        if (r.envelope) { e.env++; report.envelope++; }
        if (r.trailStripped) { e.trail++; report.trailStripped++; }
      } else {
        e.mis++; report.mismatched++;
        if (e.samples.length < 3) {
          e.samples.push({ err: r.err, kind, type: typeN, file: fn, size: bytes.length,
            first64: Buffer.from(bytes.slice(0, 64)).toString('hex') });
        }
      }
    }
  }

  console.log('[A1.3/FULLRAW] sessions:', sessions.join(', ') || '(none)');
  console.log('[A1.3/FULLRAW] corpus:', report.total, 'entries');
  console.log(JSON.stringify({ byteExact: report.byteExact, envelope: report.envelope,
    trailStripped: report.trailStripped,
    mismatched: report.mismatched, failedDecode: report.failedDecode,
    unknownEndpoint: report.unknownEndpoint, unparsableFilenames: report.unparsableFilenames }, null, 2));
  console.log('--- per-endpoint ---');
  for (const [k, v] of Object.entries(byEndpoint).sort()) {
    console.log(`${k.padEnd(38)} n=${String(v.n).padStart(3)} exact=${String(v.exact).padStart(3)} env=${String(v.env).padStart(2)} trail=${String(v.trail).padStart(2)} mis=${String(v.mis).padStart(3)}`);
    for (const s of v.samples) console.log('   ', s);
  }
}

main();
