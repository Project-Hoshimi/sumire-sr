// Starter gift tests (port of the gift block added to `src/dbtest.ts` on the
// narrative stack, commit 5b1ad6f).
//
// Run with `npm run test:startergifts` against a database with master data
// seeded and the capture corpus available ($DATABASE_URL + $SUMIRE_DATA_DIR /
// captures). The npm script selects the official profile, because starter gifts
// are official-game behaviour: Home:Enter posts them only when `!isSandbox()`.

import { gzipSync } from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import { requireData } from './testing/requireData.ts';
import { decodeMessage, encodeMessage, msgRegistry, Reader, Writer } from '@sumire-sr/protocol/runtime/proto.ts';
import '@sumire-sr/protocol/gen/registry.ts';
import './services/all.ts';
import { mintToken } from './auth/jwt.ts';
import { db } from './db/client.ts';
import { accounts, players, playerEntities, playerLessonProgress } from './db/schema.ts';
import { endpoints } from '@sumire-sr/protocol/gen/endpoints.ts';
import { FRESH_SEED } from './services/playerState.ts';
import { STARTER_GIFTS } from './services/starterGifts.ts';

await requireData({ captures: true, db: true });

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  cond ? pass++ : fail++;
}

const { dispatchRpc } = await import('./services/router.ts');

// Dedicated test account. Seeded state is wiped deterministically so repeated
// runs start from the same captured corpus.
const GIFT_ACCOUNT_ID = 'startergift-account-0000-4000-8000-000000000061';
const GIFT_USER_ID = 'startergift-user-0000-4000-8000-000000000061';
const GIFT_FIREBASE_UID = 'startergift-firebase-uid-0061';
const GIFT_PUBLIC_USER_ID = 'DBGIFT61';

await db.delete(playerEntities).where(eq(playerEntities.playerId, GIFT_USER_ID));
await db.delete(playerLessonProgress).where(eq(playerLessonProgress.playerId, GIFT_USER_ID));
await db.delete(players).where(eq(players.id, GIFT_USER_ID));
await db.delete(accounts).where(eq(accounts.id, GIFT_ACCOUNT_ID));
await db.insert(accounts).values({
  id: GIFT_ACCOUNT_ID,
  firebaseUid: GIFT_FIREBASE_UID,
  seedId: GIFT_PUBLIC_USER_ID,
  displayName: 'Player',
  lastLoginAt: new Date(),
});
await db.insert(players).values({
  id: GIFT_USER_ID,
  accountId: GIFT_ACCOUNT_ID,
  name: 'Player',
  level: 1,
  exp: 0,
  gold: 0,
  freeJewel: 0,
  data: { publicUserId: GIFT_PUBLIC_USER_ID, seed: FRESH_SEED },
});

const token = mintToken({ sub: GIFT_ACCOUNT_ID, seedId: GIFT_PUBLIC_USER_ID });
const authOpts = () =>
  ({ headers: { 'x-auth-token': token }, log: { info() {}, warn() {} } }) as any;

const homeEnter = async () => {
  const w = new Writer();
  encodeMessage(msgRegistry.get(endpoints['Home']['Enter'].request)!, { SkipUpdate: false }, w);
  return dispatchRpc('Home:Enter', Buffer.from(w.toBytes()), authOpts());
};
const listGifts = async () => {
  const bytes = await dispatchRpc('Gift:List', Buffer.alloc(0), authOpts());
  return decodeMessage(
    msgRegistry.get(endpoints['Gift']['List'].response)!,
    new Reader(Uint8Array.from(bytes)),
  ) as any;
};
// The client gzips large request bodies (the 61-id Gift:Receive is one).
const receiveGifts = async (ids: string[], gzip = false) => {
  const w = new Writer();
  encodeMessage(msgRegistry.get(endpoints['Gift']['Receive'].request)!, { GiftIds: ids }, w);
  const body = Buffer.from(w.toBytes());
  const bytes = await dispatchRpc('Gift:Receive', gzip ? gzipSync(body) : body, authOpts());
  return decodeMessage(
    msgRegistry.get(endpoints['Gift']['Receive'].response)!,
    new Reader(Uint8Array.from(bytes)),
  ) as any;
};
const userGet = async () => {
  const bytes = await dispatchRpc('User:Get', Buffer.alloc(0), authOpts());
  return decodeMessage(
    msgRegistry.get(endpoints['User']['Get'].response)!,
    new Reader(Uint8Array.from(bytes)),
  ) as any;
};
const giftEntities = () =>
  db
    .select()
    .from(playerEntities)
    .where(
      and(eq(playerEntities.playerId, GIFT_USER_ID), eq(playerEntities.kind, 'Gifts')),
    );

// A fresh player gets the official new-account gift set on its first
// Home:Enter (captures/2026-10-26_lesson_rate_official 00077 / 00082).
check('fresh player has an empty gift box before Home:Enter', (await giftEntities()).length === 0);
await homeEnter();
await homeEnter();
const giftList = await listGifts();
const gifts: any[] = giftList.Gifts ?? [];
check('Home:Enter posts the 61 starter gifts once', gifts.length === 61 && Number(giftList.Count) === 61);
const giftSig = (g: any) => `${g.ResourceType}|${g.ResourceId ?? ''}|${g.Amount}|${g.Message}`;
check(
  'starter gifts match the official set',
  JSON.stringify(gifts.map(giftSig).sort()) === JSON.stringify(STARTER_GIFTS.map(giftSig).sort()),
);
const giftTypeCount = (t: number) => gifts.filter((g) => Number(g.ResourceType) === t).length;
check(
  'starter gifts: 4 item, 17 costume, 1 photo, 1 stone, 5 emblem, 32 decoration, 1 group story point',
  giftTypeCount(1) === 4 && giftTypeCount(5) === 17 && giftTypeCount(7) === 1 && giftTypeCount(15) === 1 &&
    giftTypeCount(17) === 5 && giftTypeCount(26) === 32 && giftTypeCount(20) === 1,
);
check('starter gifts keep the official message', gifts.some((g) => g.Message === 'チュートリアルクリアの報酬です。'));
check(
  'starter gifts share one PostedTime, carry no expiry and are ordered by GiftId',
  new Set(gifts.map((g) => Number(g.PostedTime))).size === 1 && Number(gifts[0].PostedTime) > 0 &&
    gifts.every((g) => !g.ExpireTime) &&
    gifts.every((g, i) => i === 0 || String(gifts[i - 1].GiftId) < String(g.GiftId)),
);
check('stone and group story point gifts carry no ResourceId', gifts.filter((g) => [15, 20].includes(Number(g.ResourceType))).every((g) => !g.ResourceId));

const giftIds: string[] = gifts.map((g) => String(g.GiftId));
const giftResp = await receiveGifts(giftIds, true);
const giftResults: any[] = giftResp.Results ?? [];
check('Gift:Receive reports all 61 ReceivedGiftIds', (giftResp.ReceivedGiftIds?.length ?? 0) === 61 && !giftResp.HasUnreceivedGift);
check('Gift:Receive returns the 77 captured RewardResults', giftResults.length === 77);
const giftRank = (t: number) => (t === 28 ? 5 : t);
check(
  'Gift:Receive results are grouped by resource type',
  giftResults.every((r, i) => i === 0 || giftRank(Number(giftResults[i - 1].ResourceType)) <= giftRank(Number(r.ResourceType))),
);
const giftResult = (t: number, id?: string) =>
  giftResults.find((r) => Number(r.ResourceType) === t && (id == null || r.ResourceId === id));
check(
  'Gift:Receive merges the gacha tickets (10 + 10 = 20)',
  Number(giftResult(1, 'item-gacha_ticket')?.AmountI64) === 20 && Number(giftResult(1, 'item-gacha_ticket')?.AfterAmount) === 20 &&
    giftResults.filter((r) => r.ResourceId === 'item-gacha_ticket').length === 1,
);
check('Gift:Receive grants the R5 ticket and dream items', Number(giftResult(1, 'item-gacha_ticket-r5')?.AfterAmount) === 1 && Number(giftResult(1, 'item-dream-generate-dream-25-0320')?.AfterAmount) === 5);
check(
  'Gift:Receive grants 3000 stone (no IsNew)',
  Number(giftResult(15)?.AmountI64) === 3000 && Number(giftResult(15)?.AfterAmount) === 3000 && !giftResult(15)?.IsNew,
);
check('Gift:Receive grants 25 group story points (IsNew)', Number(giftResult(20)?.AfterAmount) === 25 && !!giftResult(20)?.IsNew);
check(
  'Gift:Receive grants each costume followed by its default hair',
  giftResults.filter((r) => Number(r.ResourceType) === 5).length === 17 &&
    giftResults.every((r, i) =>
      Number(r.ResourceType) !== 5 ||
      (Number(giftResults[i + 1]?.ResourceType) === 28 && giftResults[i + 1].ResourceId === String(r.ResourceId).replace(/^cos-/, 'hair-'))),
);
check(
  'Gift:Receive collection grants are new with AfterAmount 1',
  giftResults.filter((r) => [5, 7, 17, 26, 28].includes(Number(r.ResourceType))).every((r) => !!r.IsNew && Number(r.AfterAmount) === 1),
);
const giftUpdated = giftResp.CommonResponse?.UpdatedData ?? {};
check(
  'Gift:Receive UpdatedData carries the granted collections',
  giftUpdated.Items?.length === 3 && giftUpdated.Costumes?.length === 17 && giftUpdated.Hairs?.length === 17 &&
    giftUpdated.Emblems?.length === 5 && giftUpdated.Decorations?.length === 32 && giftUpdated.Photos?.length === 1,
);
check('Gift:Receive hairs arrive checked and costumes carry ObtainedTime', giftUpdated.Hairs.every((h: any) => !!h.Checked) && giftUpdated.Costumes.every((c: any) => Number(c.ObtainedTime) > 0));
const giftPhoto = giftUpdated.Photos?.[0];
check(
  'Gift:Receive mints the login photo as captured',
  giftPhoto?.AssetId === 'phot-login-5-0001' && Number(giftPhoto?.ImageType) === 1 && !!giftPhoto?.Locked &&
    Number(giftPhoto?.Level) === 10 && giftPhoto?.Abilities?.length === 5 && giftPhoto.Abilities.every((a: any) => !!a.IsAvailable),
);
check(
  'Gift:Receive UpdatedData carries the balance and group story points',
  Number(giftUpdated.Balance?.FreeBalance) === 3000 &&
    Number(giftUpdated.Points?.find((p: any) => Number(p.PointType) === 4)?.Amount) === 25,
);

const giftAfter = await userGet();
check('User:Get shows the received stone and gacha tickets', Number(giftAfter.Balance?.FreeBalance) === 3000 && Number(giftAfter.Items?.find((i: any) => i.ItemId === 'item-gacha_ticket')?.Amount) === 20);
check('User:Get shows the received group story points', Number(giftAfter.Points?.find((p: any) => Number(p.PointType) === 4)?.Amount) === 25);
check(
  'User:Get shows the received costumes, hairs, emblems and decorations',
  (giftAfter.Costumes ?? []).some((c: any) => c.CostumeId === 'cos-ai-idol-02') &&
    (giftAfter.Hairs ?? []).some((h: any) => h.HairId === 'hair-ai-idol-02') &&
    (giftAfter.Emblems ?? []).some((e: any) => e.EmblemId === 'emb-404') &&
    (giftAfter.Decorations ?? []).some((d: any) => d.DecorationId === 'deco-sp-the-sun-01'),
);

const giftResp2 = await receiveGifts(giftIds);
check('Gift:Receive idempotent: no results on second call', (giftResp2.Results?.length ?? 0) === 0);
check('Gift:Receive reports consumed gifts as unreceived', (giftResp2.UnreceivedGiftIds?.length ?? 0) === 61);
await homeEnter();
const giftList2 = await listGifts();
check('Gift:List stays empty after receiving (no repost on login)', (giftList2.Gifts?.length ?? 0) === 0);

console.log(`\nstarter gift test: ${pass} passed, ${fail} failed`);
await (await import('./db/client.ts')).client.end({ timeout: 5 });
process.exit(fail ? 1 : 0);
