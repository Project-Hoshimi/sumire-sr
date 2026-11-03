// A2 master-data tooling — decode Master:Get / MasterTag manifest.
// Reuses the A1 runtime + generated schemas. Reads a hex or binary MasterTag
// (either the full response or the captured truncated prefix) and emits the
// per-partition manifest: type, filename, size, cryptoKey hash, download URL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Reader, decodeMessage, msgRegistry } from '../runtime/proto.ts';
import '../src/gen/registry.ts';
import { endpoints } from '../src/gen/endpoints.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAP = path.join(ROOT, '..', 'captures');

function hexToBytes(s) {
  return Uint8Array.from(s.replace(/\s+/g, '').match(/[0-9a-f]{2}/gi).map(h => parseInt(h, 16)));
}

function hexStr(u8) {
  return Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Extract the raw Master:Get DEC-out-plain hex from a capture log (truncated ok).
function extractMasterHex(logFile) {
  for (const raw of fs.readFileSync(logFile, 'utf8').split('\n')) {
    if (raw.includes('DEC out plain') && raw.includes('bytes=55530')) {
      const m = raw.match(/(?:\(truncated\)\s*|\s)((?:[0-9a-f]{2} ?)+)\s*$/);
      if (m) return m[1].trim();
    }
  }
  return null;
}

function main() {
  const om = msgRegistry.get('Solis.Common.Proto.Api.MasterGetResponse');
  const Sh = msgRegistry.get('Solis.Common.Proto.Transaction.MasterTag');
  if (!om || !Sh) { console.error('schema missing'); process.exit(1); }
  console.log('MasterGetResponse fields:', om.fields.map(f => `${f.number}:${f.name}`).join(', '));
  console.log('MasterTag fields:', Sh.fields.map(f => `${f.number}:${f.name}`).join(', '));

  const hex = extractMasterHex(path.join(CAP, 'cap3f.log'));
  if (!hex) { console.error('no Master:Get capture found'); process.exit(1); }
  const bytes = hexToBytes(hex);
  console.log(`[A2] captured Master:Get prefix: ${bytes.length} bytes (512B cap — untruncated needs fullraw)`);

  // lenient decode: outer MasterGetResponse -> MasterTag (nested msg) etc.
  const dec = decodeMessage(om, new Reader(bytes, 0, /*lenient=*/true));
  console.log('truncated:', dec.__truncated === true);

  // MasterGetResponse field1 = MasterTag message
  const tag = dec.MasterTag;
  console.log('MasterTag.version:', tag?.Version);
  const packs = tag?.MasterTagPacks ?? [];
  console.log(`\n=== ${packs.length} partition(s) visible in 512-byte prefix ===\n`);
  for (const p of packs) {
    console.log(`type=${(p.Type ?? '').toString().padEnd(26)} file=${(p.FileName ?? '').toString().padEnd(24)} size=${p.FileSize ?? '?'} crypto=${(p.CryptoKey ?? '\u00b7').toString().slice(0,16)}`);
    console.log(`    url=${p.DownloadUrl}`);
  }
  // raw fallback when lenient recursion clipped too much
  if (packs.length === 0 && dec.MasterTag) {
    console.log('(packs clipped — partial nested payload; need fullraw to list all partitions)');
  }
}

main();