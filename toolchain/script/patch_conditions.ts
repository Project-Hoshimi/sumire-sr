// Phase A2 — patch selected Condition master rows so listed gacha banners are
// always viewable. Reads [{Id, data}] (base64 proto rows), re-encodes each
// `Solis.Common.Proto.Master.Condition` with every Setting's Term bounded only
// by a far-future NowBefore, and clears the per-setting gate conditions.
// Rows named in the optional 3rd argument ({ [conditionId]: NowAfter }) instead
// get the official permanent form — a real start and an open-ended end
// (`{ NowAfter, NowBefore: 0 }`) — so the client shows no remaining time.
// Usage: npx tsx script/patch_conditions.ts <in.json> <out.json> [perm.json]
import fs from 'node:fs';
import { Reader, Writer, decodeMessage, encodeMessage, msgRegistry } from '../../fastify-api/runtime/proto.ts';
import '../../fastify-api/src/gen/registry.ts';

// 2^42 - 1: comfortably beyond any NowBefore the client will ever evaluate.
const NOW_BEFORE_MAX = 4398046511103;

const shape = msgRegistry.get('Solis.Common.Proto.Master.Condition');
if (!shape) throw new Error('Solis.Common.Proto.Master.Condition not registered');

type Row = { Id: string; data: string };
const rows: Row[] = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const permanent: Record<string, number> = process.argv[4]
  ? JSON.parse(fs.readFileSync(process.argv[4], 'utf8'))
  : {};
const out: Row[] = [];

for (const r of rows) {
  const dec = decodeMessage(shape, new Reader(Buffer.from(r.data, 'base64'))) as any;
  for (const s of dec.Settings ?? []) {
    // Drop EVERY gate sub-condition (ItemAmount, DrawGacha, OpenGacha,
    // PurchaseShop, story/level gates, Satisfy/NotSatisfyCondition, ...) so the
    // banner is visible regardless of the player's held tickets / draw history.
    // Only the always-on Term remains.
    for (const k of Object.keys(s)) {
      if (k === 'Term' || k === '__unknown' || k === '__msg') continue;
      delete s[k];
    }
    s.Term =
      r.Id in permanent
        ? { NowAfter: permanent[r.Id], NowBefore: 0 }
        : { NowAfter: 0, NowBefore: NOW_BEFORE_MAX };
  }
  const w = new Writer();
  encodeMessage(shape, dec, w);
  out.push({ Id: r.Id, data: Buffer.from(w.toBytes()).toString('base64') });
}

fs.writeFileSync(process.argv[3], JSON.stringify(out));
console.log(`patched ${out.length} conditions`);
