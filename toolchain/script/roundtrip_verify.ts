// Phase A2 verification — every harvested master row must roundtrip byte-exact.
// Usage: node script/roundtrip_verify.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Reader, Writer, decodeMessage, encodeMessage, msgRegistry } from '../../fastify-api/runtime/proto.ts';
import '../../fastify-api/src/gen/registry.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..', '..');
const BASE = path.join(process.env.SUMIRE_DATA_DIR ? path.resolve(process.env.SUMIRE_DATA_DIR) : REPO_ROOT, 'phaseA2');
const OUT = path.join(BASE, 'out');
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));

let total = 0, ok = 0, fail = 0;
const failures = [];
for (const p of manifest.partitions) {
  const shape = msgRegistry.get(`Solis.Common.Proto.Master.${p.type}`);
  const f = path.join(OUT, 'rows', `${p.type}.jsonl`);
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)) {
    const rec = JSON.parse(line);
    const orig = Buffer.from(rec.data, 'base64');
    const dec = decodeMessage(shape, new Reader(orig));
    const w = new Writer();
    encodeMessage(shape, dec, w);
    const re = w.toBytes();
    total++;
    if (Buffer.compare(Buffer.from(orig), Buffer.from(re)) === 0) { ok++; }
    else { fail++; if (failures.length < 10) failures.push({ type: p.type, key: rec.key, orig: orig.length, re: re.length }); }
    if (total % 20000 === 0) process.stdout.write(`  ${total} rows...\r`);
  }
}
console.log(`ROUNDTRIP: total=${total} exact=${ok} mismatch=${fail}`);
if (failures.length) console.log(JSON.stringify(failures, null, 1));
process.exit(fail ? 1 : 0);
