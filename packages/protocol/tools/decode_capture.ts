// Decode a capture's raw/<n>.<req|resp>-plain.<Service>:<Method>.bin (or <Service>@<Method>, the NTFS-safe spelling in sumire-sr-data) files to JSON.
// Usage: node fastify-api/... tools/decode_capture.ts <captureDir>  (writes <captureDir>/decoded/)
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { decodeMessage, Reader, msgRegistry } from '../src/runtime/proto.ts';
import '../src/gen/registry.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: decode_capture.ts <captureDir>');
const RE = /^(\d+)\.(req|resp)-plain\.([A-Za-z0-9]+)[:@]([A-Za-z0-9]+)\.bin$/;
const P = 'Solis.Common.Proto.Api.';

function shapeFor(svc: string, method: string, kind: 'req' | 'resp') {
  const suffix = kind === 'req' ? 'Request' : 'Response';
  const exact = msgRegistry.get(`${P}${svc}${method}${suffix}`);
  if (exact) return exact;
  // e.g. Tutorial:ReceiveLessonReward -> TutorialActivityReceiveLessonRewardResponse
  const cands = [...msgRegistry.keys()].filter((k) => k.startsWith(P + svc) && k.endsWith(method + suffix));
  return cands.length === 1 ? msgRegistry.get(cands[0])! : null;
}

// Never write tokens to disk in clear: keep a short prefix only.
function redact(_k: string, v: unknown) {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string' && (v.startsWith('eyJ') || /^[A-Za-z0-9+/_=.-]{120,}$/.test(v))) return `${v.slice(0, 8)}…(redacted ${v.length})`;
  return v;
}

const out = join(dir, 'decoded');
mkdirSync(out, { recursive: true });
const index: string[] = [];
for (const f of readdirSync(join(dir, 'raw')).sort()) {
  const m = f.match(RE);
  if (!m) continue;
  const [, n, kind, svc, method] = m;
  let buf = readFileSync(join(dir, 'raw', f));
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = gunzipSync(buf);
    } catch {
      // Keep the original buffer; the existing decode error path handles it.
    }
  }
  const shape = shapeFor(svc, method, kind as 'req' | 'resp');
  let body: unknown;
  try {
    body = shape ? decodeMessage(shape, new Reader(Uint8Array.from(buf))) : { _undecoded: buf.toString('hex').slice(0, 200) };
  } catch (e) {
    body = { _error: (e as Error).message };
  }
  writeFileSync(join(out, f.replace(/\.bin$/, '.json')), JSON.stringify({ shape: shape?.name ?? null, body }, redact, 2));
  index.push(`${n} ${kind.padEnd(4)} ${svc}:${method} ${buf.length}B ${shape ? '' : '(no shape)'}`);
}
writeFileSync(join(out, 'INDEX.txt'), index.join('\n') + '\n');
console.log(index.join('\n'));
