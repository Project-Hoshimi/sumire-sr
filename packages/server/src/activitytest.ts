// Activity RPC tests (port of the Activity lesson / manager-level sections
// added to `src/dbtest.ts` on the narrative stack, commits ba60375, d230b55,
// 3776f64, fc5e797 and dfbeab1).
//
// Run with `npm run test:activity` (official profile) against a database with
// master data seeded and the capture corpus available
// ($DATABASE_URL + $SUMIRE_DATA_DIR/captures).

import { and, eq, inArray } from 'drizzle-orm';
import { requireData } from './testing/requireData.ts';
import { decodeMessage, encodeMessage, msgRegistry, Reader, Writer } from '@sumire-sr/protocol/runtime/proto.ts';
import '@sumire-sr/protocol/gen/registry.ts';
import { endpoints } from '@sumire-sr/protocol/gen/endpoints.ts';
import { db } from './db/client.ts';
import { accounts, players, playerEntities, playerLessonProgress } from './db/schema.ts';
import { masterQuest } from './db/masterSchema.ts';
import { mintToken } from './auth/jwt.ts';
import { getCorpusResponse } from './services/replay/corpus.ts';
import {
  getSingleton,
  listElements,
  loadOrSeed,
  putElements,
  putSingleton,
} from './services/playerState.ts';
import { dispatchRpc } from './services/router.ts';
import './services/all.ts';

const { grantItem, getItemAmount } = await import('./services/inventory.ts');
const { listQuestsByArea } = await import('./master/index.ts');
const { addManagerExp } = await import('./master/reward.ts');
const { applyLessonArea, currentLessonAreaId, lessonRatesForArea } = await import('./services/activity.ts');

await requireData({ captures: true, db: true });

// Dedicated test account. Seeded state is wiped deterministically so repeated
// runs start from the same captured corpus.
const TEST_ACCOUNT_ID = 'activitytest-account-0000-4000-8000-000000000001';
const TEST_UID = 'activitytest-firebase-uid-0001';
const SERVER_USER_ID = 'activitytest-user-0000-4000-8000-000000000001';
const TEST_PUBLIC_USER_ID = 'ACTIVITYTEST';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  cond ? pass++ : fail++;
}

// Deterministic start: wipe ONLY this dedicated test account, recreate the
// account/player rows, then lazily seed the entity store from the captured
// `User:Get` corpus template (the same seeding the real handler performs).
await db.delete(playerEntities).where(eq(playerEntities.playerId, SERVER_USER_ID));
await db.delete(playerLessonProgress).where(eq(playerLessonProgress.playerId, SERVER_USER_ID));
await db.delete(players).where(eq(players.id, SERVER_USER_ID));
await db.delete(accounts).where(eq(accounts.firebaseUid, TEST_UID));
await db.insert(accounts).values({
  id: TEST_ACCOUNT_ID,
  firebaseUid: TEST_UID,
  seedId: TEST_PUBLIC_USER_ID,
  displayName: 'Player',
  lastLoginAt: new Date(),
});
await db.insert(players).values({
  id: SERVER_USER_ID,
  accountId: TEST_ACCOUNT_ID,
  name: 'Player',
  data: { publicUserId: TEST_PUBLIC_USER_ID },
});

const templateBytes = getCorpusResponse('User:Get');
check('activity: corpus carries a User:Get template', templateBytes !== null);
const templateShape = msgRegistry.get('Solis.Common.Proto.Api.UserGetResponse');
if (!templateBytes || !templateShape) {
  console.log(`\nactivity test: ${pass} passed, ${fail} failed`);
  await (await import('./db/client.ts')).client.end({ timeout: 5 });
  process.exit(fail ? 1 : 0);
}
const seedTemplate = decodeMessage(templateShape, new Reader(Uint8Array.from(templateBytes)));
await loadOrSeed(SERVER_USER_ID, seedTemplate);

// Deterministic-start normalisation for the dedicated test account. The
// veteran corpus template was captured while one idol (char-chs) was
// mid-activity, so the seeded Characters row carries InActivity=1. Clear every
// InActivity flag and drop any ActivityPromotion singleton left behind by an
// interrupted run, so the activity tests always start from a clean slate.
const seededCharacters = await listElements(SERVER_USER_ID, 'Characters');
const activeCharacters = seededCharacters.filter((c: any) => Number(c.InActivity ?? 0) !== 0);
if (activeCharacters.length > 0) {
  for (const c of activeCharacters) c.InActivity = false;
  await putElements(SERVER_USER_ID, 'Characters', activeCharacters);
}
await putSingleton(SERVER_USER_ID, 'ActivityPromotion', null);

const token = mintToken({ sub: TEST_ACCOUNT_ID, seedId: TEST_PUBLIC_USER_ID });
const auth = {
  headers: { 'x-auth-token': token },
  log: { info() {}, warn() {} },
} as any;

const callRpc = async (service: string, name: string, body: Record<string, unknown> = {}) => {
  const endpoint = (endpoints as any)[service]?.[name];
  if (!endpoint) throw new Error(`unknown endpoint ${service}:${name}`);
  const requestShape = endpoint.request ? msgRegistry.get(endpoint.request) : null;
  let plain = Buffer.alloc(0);
  if (requestShape) {
    const writer = new Writer();
    encodeMessage(requestShape, body as any, writer);
    plain = Buffer.from(writer.toBytes());
  }
  const bytes = await dispatchRpc(`${service}:${name}`, plain, auth);
  return decodeMessage(msgRegistry.get(endpoint.response)!, new Reader(Uint8Array.from(bytes))) as any;
};

const activityReceive = () => callRpc('Activity', 'ReceiveLessonReward');
const activityPromote = (req: { IsFree?: boolean; UseItemId?: string }) =>
  callRpc('Activity', 'PromoteLesson', req);
const homeEnterRpc = async () => callRpc('Home', 'Enter', { SkipUpdate: false });
const questRpc = (name: string, body: Record<string, unknown> = {}) => callRpc('Quest', name, body);
const activityRewardAmount = (resp: any, resourceType: number) =>
  Number((resp.Rewards ?? []).find((r: any) => Number(r.ResourceType) === resourceType)?.Amount ?? 0);
const lessonRows = () =>
  db.select().from(playerLessonProgress).where(eq(playerLessonProgress.playerId, SERVER_USER_ID));
const playerRow = async () => (await db.select().from(players).where(eq(players.id, SERVER_USER_ID)))[0]!;

// The seeded account is a veteran with Main Live clears, so its lesson area is
// not necessarily area-main-001. All step amounts below follow that area.
const lessonArea = await currentLessonAreaId(SERVER_USER_ID);
const { gold: LG, managerExp: LE, cardEnhanceItem: LI } = lessonRatesForArea(lessonArea);

// Seed the lesson row (grants nothing when no whole steps have elapsed).
await activityReceive();

// --- Manager level (Solis `viber.AddManagerExp` port) ---
const setManager = (exp: number, level: number) =>
  db.update(players).set({ exp, level }).where(eq(players.id, SERVER_USER_ID));

await setManager(0, 1);
await addManagerExp(SERVER_USER_ID, 50);
check('Manager level: crossing one threshold raises the level by 1', Number((await playerRow()).level) === 2);

await setManager(0, 1);
await addManagerExp(SERVER_USER_ID, 310);
const severalLevels = await playerRow();
check('Manager level: crossing several thresholds raises several levels', Number(severalLevels.level) === 5);
check('Manager level: total exp accumulates across the ladder', Number(severalLevels.exp) === 310);
// d230b55: addManagerExp must persist the User singleton too.
const leveledUser = await getSingleton(SERVER_USER_ID, 'User');
check(
  'Manager level: the stored User follows the player row',
  Number(leveledUser?.ManagerLevel) === 5 && Number(leveledUser?.ManagerExp) === 310,
);

// Level 300 needs 51,436,090,374 total exp.
await setManager(51_436_090_373, 299);
await addManagerExp(SERVER_USER_ID, 1);
check('Manager level: crossing the last threshold reaches max level', Number((await playerRow()).level) === 300);
await addManagerExp(SERVER_USER_ID, 1_000);
const capped = await playerRow();
check('Manager level: exp at max level caps the level', Number(capped.level) === 300);
check('Manager level: max level still accumulates exp', Number(capped.exp) === 51_436_091_374);

// Activity lesson rewards route manager exp through the same helper.
await setManager(0, 1);
const managerBackdate = Date.now() - 13 * 60 * 60 * 1000;
await db
  .update(playerLessonProgress)
  .set({
    lastReceiveTime: managerBackdate,
    maxRewardTime: managerBackdate + 12 * 60 * 60 * 1000,
    rewardGold: 0,
    rewardManagerExp: 0,
    rewardCardEnhanceItem: 0,
    bankedRewardGold: 0,
    bankedRewardManagerExp: 0,
    bankedRewardCardEnhanceItem: 0,
    rateAnchorTime: 0,
  })
  .where(eq(playerLessonProgress.playerId, SERVER_USER_ID));
const managerActivity = await activityReceive();
const managerAfterActivity = await playerRow();
check('Activity:ReceiveLessonReward after a long backdate raises the level', Number(managerAfterActivity.level) > 1);
check(
  'Activity:ReceiveLessonReward surfaces the raised ManagerLevel',
  Number(managerActivity.CommonResponse?.UpdatedData?.User?.ManagerLevel ?? 0) === Number(managerAfterActivity.level),
);
check(
  'Activity:ReceiveLessonReward surfaces the new ManagerExp',
  Number(managerActivity.CommonResponse?.UpdatedData?.User?.ManagerExp ?? 0) === Number(managerAfterActivity.exp),
);

// --- Activity:PromoteLesson (free / item / stone lesson promotion) ---
const PROMOTE_ITEM = 'item-act_lesson-boost';
const promoteItemAmount = (itemId: string) => getItemAmount(SERVER_USER_ID, itemId);
const promoteSetLesson = (patch: {
  lastReceiveTime?: number;
  maxRewardTime?: number;
  dailyPromoteCount?: number;
  dailyStateDay?: string;
  rewardGold?: number;
  rewardManagerExp?: number;
  rewardCardEnhanceItem?: number;
  bankedRewardGold?: number;
  bankedRewardManagerExp?: number;
  bankedRewardCardEnhanceItem?: number;
  rateAnchorTime?: number;
}) => db.update(playerLessonProgress).set(patch).where(eq(playerLessonProgress.playerId, SERVER_USER_ID));
// Zero idle time: the promote then pays exactly the EffectHours bonus steps.
const promotePinIdle = (dailyPromoteCount: number) =>
  promoteSetLesson({
    lastReceiveTime: Date.now(),
    maxRewardTime: Date.now() + 12 * 60 * 60 * 1000,
    dailyPromoteCount,
    rewardGold: 0,
    rewardManagerExp: 0,
    rewardCardEnhanceItem: 0,
    bankedRewardGold: 0,
    bankedRewardManagerExp: 0,
    bankedRewardCardEnhanceItem: 0,
    rateAnchorTime: 0,
  });
const promoteSetStones = (freeJewel: number, paidJewel: number) =>
  db.update(players).set({ freeJewel, paidJewel }).where(eq(players.id, SERVER_USER_ID));
const promoteOrigPlayer = await playerRow();
const promoteOrigFree = Number(promoteOrigPlayer.freeJewel);
const promoteOrigPaid = Number(promoteOrigPlayer.paidJewel);

// Case 1: free promote, no idle time -> 720 bonus steps only.
await promotePinIdle(0);
const promoteBefore1 = await playerRow();
const promote1 = await activityPromote({ IsFree: true });
const promoteAfter1 = await playerRow();
const promoteRow1 = (await lessonRows())[0];
check('Activity:PromoteLesson free promote pays 720 bonus gold steps', activityRewardAmount(promote1, 8) === 720 * LG);
check(
  'Activity:PromoteLesson free promote pays 720 bonus manager-exp steps (x2 campaign)',
  activityRewardAmount(promote1, 14) === 720 * LE * 2,
);
check('Activity:PromoteLesson free promote pays 720 bonus card-enhance steps', activityRewardAmount(promote1, 1) === 720 * LI);
check(
  'Activity:PromoteLesson free promote adds gold to players',
  Number(promoteAfter1.gold) - Number(promoteBefore1.gold) === 720 * LG,
);
check(
  'Activity:PromoteLesson free promote adds manager exp to players',
  Number(promoteAfter1.exp) - Number(promoteBefore1.exp) === 720 * LE * 2,
);
check('Activity:PromoteLesson free promote reports DailyPromoteCount 1', Number(promote1.Progress?.DailyPromoteCount ?? 0) === 1);
check('Activity:PromoteLesson free promote persists dailyPromoteCount 1', Number(promoteRow1?.dailyPromoteCount ?? 0) === 1);
check(
  'Activity:PromoteLesson free promote clears pending amounts',
  Number(promote1.Progress?.RewardGoldAmount ?? 0) === 0 &&
    Number(promote1.Progress?.RewardManagerExpAmount ?? 0) === 0 &&
    Number(promote1.Progress?.RewardCardEnhanceItemAmount ?? 0) === 0 &&
    Number(promoteRow1?.rewardGold ?? 0) === 0,
);

// Case 2: free promote with 30 idle steps -> (30 + 720) steps paid, anchor advanced by 30 steps.
const promoteAnchor2 = Date.now() - 300_000;
await promoteSetLesson({
  lastReceiveTime: promoteAnchor2,
  maxRewardTime: promoteAnchor2 + 12 * 60 * 60 * 1000,
  dailyPromoteCount: 0,
});
const promote2 = await activityPromote({ IsFree: true });
check(
  'Activity:PromoteLesson free promote with 30 idle steps pays 750 gold steps',
  activityRewardAmount(promote2, 8) === 750 * LG,
);
check(
  'Activity:PromoteLesson free promote with 30 idle steps advances LastReceiveTime by 300000',
  Number(promote2.Progress?.LastReceiveTime ?? 0) === promoteAnchor2 + 300_000,
);

// Case 3: second free promote the same day is rejected.
const promoteBefore3 = await playerRow();
let promoteThrew3 = false;
try {
  await activityPromote({ IsFree: true });
} catch {
  promoteThrew3 = true;
}
const promoteRow3 = (await lessonRows())[0];
const promoteAfter3 = await playerRow();
check('Activity:PromoteLesson second free promote the same day is rejected', promoteThrew3);
check('Activity:PromoteLesson rejected free promote keeps dailyPromoteCount', Number(promoteRow3?.dailyPromoteCount ?? 0) === 1);
check('Activity:PromoteLesson rejected free promote leaves gold unchanged', Number(promoteAfter3.gold) === Number(promoteBefore3.gold));

// Case 4: stone promote spends 50 free stones first.
await promoteSetStones(100, 0);
await promotePinIdle(1);
const promoteBefore4 = await playerRow();
const promote4 = await activityPromote({ IsFree: false });
const promoteAfter4 = await playerRow();
const promoteRow4 = (await lessonRows())[0];
check(
  'Activity:PromoteLesson stone promote spends 50 free stones first',
  Number(promoteAfter4.freeJewel) === 50 && Number(promoteBefore4.paidJewel) === 0 && Number(promoteAfter4.paidJewel) === 0,
);
check(
  'Activity:PromoteLesson stone promote response reports FreeBalance 50',
  Number(promote4.CommonResponse?.UpdatedData?.Balance?.FreeBalance ?? -1) === 50,
);
check('Activity:PromoteLesson stone promote pays 720 bonus gold steps', activityRewardAmount(promote4, 8) === 720 * LG);
check('Activity:PromoteLesson stone promote increments dailyPromoteCount to 2', Number(promoteRow4?.dailyPromoteCount ?? 0) === 2);

// Case 5: insufficient stones -> rejected, nothing changes.
await promoteSetStones(10, 0);
await promotePinIdle(2);
const promoteBefore5 = await playerRow();
let promoteThrew5 = false;
try {
  await activityPromote({ IsFree: false });
} catch {
  promoteThrew5 = true;
}
const promoteAfter5 = await playerRow();
const promoteRow5 = (await lessonRows())[0];
check('Activity:PromoteLesson stone promote with 10 stones is rejected', promoteThrew5);
check('Activity:PromoteLesson rejected stone promote keeps freeJewel 10', Number(promoteAfter5.freeJewel) === 10);
check('Activity:PromoteLesson rejected stone promote keeps dailyPromoteCount 2', Number(promoteRow5?.dailyPromoteCount ?? 0) === 2);
check('Activity:PromoteLesson rejected stone promote leaves gold unchanged', Number(promoteAfter5.gold) === Number(promoteBefore5.gold));

// Case 6: daily limit (5) blocks stone promotions.
await promoteSetStones(1000, 0);
await promotePinIdle(5);
let promoteThrew6 = false;
try {
  await activityPromote({ IsFree: false });
} catch {
  promoteThrew6 = true;
}
const promoteRow6 = (await lessonRows())[0];
check('Activity:PromoteLesson stone promote is rejected at the daily limit (5)', promoteThrew6);
check('Activity:PromoteLesson daily-limit rejection keeps dailyPromoteCount 5', Number(promoteRow6?.dailyPromoteCount ?? 0) === 5);
check('Activity:PromoteLesson daily-limit rejection keeps freeJewel 1000', Number((await playerRow()).freeJewel) === 1000);

// Case 7: item promote ignores the daily limit and spends 1 boost item.
const promoteItemBefore = await promoteItemAmount(PROMOTE_ITEM);
await grantItem(SERVER_USER_ID, PROMOTE_ITEM, 2);
const promoteItemStart = await promoteItemAmount(PROMOTE_ITEM);
check('Activity:PromoteLesson grants 2 boost items before item promote', promoteItemStart === promoteItemBefore + 2);
await promotePinIdle(5);
const promote7 = await activityPromote({ UseItemId: PROMOTE_ITEM });
const promoteRow7 = (await lessonRows())[0];
const promoteItemAfter7 = await promoteItemAmount(PROMOTE_ITEM);
check('Activity:PromoteLesson item promote spends 1 boost item (start -> start-1)', promoteItemAfter7 === promoteItemStart - 1);
check(
  'Activity:PromoteLesson item promote response reports boost Amount start-1',
  Number(
    (promote7.CommonResponse?.UpdatedData?.Items ?? []).find((i: any) => String(i.ItemId) === PROMOTE_ITEM)?.Amount ?? -1,
  ) === promoteItemStart - 1,
);
check('Activity:PromoteLesson item promote pays 720 bonus gold steps', activityRewardAmount(promote7, 8) === 720 * LG);
check('Activity:PromoteLesson item promote keeps dailyPromoteCount 5', Number(promoteRow7?.dailyPromoteCount ?? 0) === 5);

// Case 8: spend the last boost, then another item promote is rejected.
let promote8: any = null;
for (let i = 0; i < 100 && (await promoteItemAmount(PROMOTE_ITEM)) > 0; i++) {
  await promotePinIdle(5);
  promote8 = await activityPromote({ UseItemId: PROMOTE_ITEM });
}
check(
  'Activity:PromoteLesson item promote spends the remaining boost items down to 0',
  (await promoteItemAmount(PROMOTE_ITEM)) === 0 &&
    promote8 !== null &&
    // proto3 omits a zero Amount on the wire, so the decoded entry has no Amount.
    (() => {
      const entry = (promote8.CommonResponse?.UpdatedData?.Items ?? []).find(
        (i: any) => String(i.ItemId) === PROMOTE_ITEM,
      );
      return entry !== undefined && Number(entry.Amount ?? 0) === 0;
    })(),
);
await promotePinIdle(5);
const promoteBefore8 = await playerRow();
let promoteThrew8 = false;
try {
  await activityPromote({ UseItemId: PROMOTE_ITEM });
} catch {
  promoteThrew8 = true;
}
const promoteAfter8 = await playerRow();
check('Activity:PromoteLesson item promote with 0 boost items is rejected', promoteThrew8);
check('Activity:PromoteLesson rejected item promote leaves gold unchanged', Number(promoteAfter8.gold) === Number(promoteBefore8.gold));

// Case 9: a non-boost item id is rejected.
await promotePinIdle(0);
let promoteThrew9 = false;
try {
  await activityPromote({ UseItemId: 'item-card_enhance' });
} catch {
  promoteThrew9 = true;
}
check("Activity:PromoteLesson item promote with 'item-card_enhance' is rejected", promoteThrew9);

// Case 10: free + item is rejected.
await promotePinIdle(0);
let promoteThrew10 = false;
try {
  await activityPromote({ IsFree: true, UseItemId: PROMOTE_ITEM });
} catch {
  promoteThrew10 = true;
}
check('Activity:PromoteLesson free promote with an item is rejected', promoteThrew10);

// Case 11: a stale dailyStateDay resets dailyPromoteCount at reconcile.
await promotePinIdle(1);
await promoteSetLesson({ dailyStateDay: '2000-01-01' });
const promote11 = await activityPromote({ IsFree: true });
const promoteRow11 = (await lessonRows())[0];
check(
  'Activity:PromoteLesson daily reset lets a free promote succeed after a prior-day count of 1',
  Number(promote11.Progress?.DailyPromoteCount ?? 0) === 1,
);
check(
  'Activity:PromoteLesson daily reset rewrites dailyStateDay to today (JST)',
  promoteRow11?.dailyStateDay === new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10),
);

// Restore state for later blocks.
await promoteSetStones(promoteOrigFree, promoteOrigPaid);
await db
  .update(playerLessonProgress)
  .set({
    dailyPromoteCount: 0,
    rewardGold: 0,
    rewardManagerExp: 0,
    rewardCardEnhanceItem: 0,
    bankedRewardGold: 0,
    bankedRewardManagerExp: 0,
    bankedRewardCardEnhanceItem: 0,
    rateAnchorTime: 0,
  })
  .where(eq(playerLessonProgress.playerId, SERVER_USER_ID));

// --- Activity lesson rates follow Main Live progress ---
const rateOf = (areaId: string) => {
  const r = lessonRatesForArea(areaId);
  return `${r.gold}/${r.managerExp}/${r.cardEnhanceItem}`;
};
check('Activity lesson rate: area-main-001 is 5/8/3', rateOf('area-main-001') === '5/8/3');
check('Activity lesson rate: area-main-002 is 7/9/5', rateOf('area-main-002') === '7/9/5');
check('Activity lesson rate: area-main-003 is 10/10/7', rateOf('area-main-003') === '10/10/7');
check(
  'Activity lesson rate: uncaptured area-main-004/005 use area-main-003',
  rateOf('area-main-004') === '10/10/7' && rateOf('area-main-005') === '10/10/7',
);
check('Activity lesson rate: area-main-006 is 25/20/16', rateOf('area-main-006') === '25/20/16');
check(
  'Activity lesson rate: area-main-007 is 30/24/19 (and 008/009 reuse it)',
  rateOf('area-main-007') === '30/24/19' && rateOf('area-main-009') === '30/24/19',
);
check(
  'Activity lesson rate: area-main-010 and later are 51/35/29',
  rateOf('area-main-010') === '51/35/29' && rateOf('area-main-125') === '51/35/29',
);
check('Activity lesson rate: an unknown area falls back to area-main-001', rateOf('area-unknown') === '5/8/3');

const rateT0 = 1_800_000_000_000;
const rateRow: any = {
  stepRewardGold: 5,
  stepRewardManagerExp: 8,
  stepRewardCardEnhanceItem: 3,
  bankedRewardGold: 0,
  bankedRewardManagerExp: 0,
  bankedRewardCardEnhanceItem: 0,
  rateAnchorTime: 0,
  lastReceiveTime: rateT0,
  maxRewardTime: rateT0 + 12 * 60 * 60 * 1000,
  currentAreaId: 'area-main-001',
};
check(
  'applyLessonArea moves to a new area',
  applyLessonArea(rateRow, 'area-main-002', rateT0 + 305_000, 10_000) && rateRow.currentAreaId === 'area-main-002',
);
check(
  'applyLessonArea banks the elapsed whole steps at the old rate',
  rateRow.bankedRewardGold === 150 && rateRow.bankedRewardManagerExp === 240 && rateRow.bankedRewardCardEnhanceItem === 90,
);
check('applyLessonArea anchors the new rate on the step grid', rateRow.rateAnchorTime === rateT0 + 300_000);
check(
  'applyLessonArea switches to the new area rates',
  rateRow.stepRewardGold === 7 && rateRow.stepRewardManagerExp === 9 && rateRow.stepRewardCardEnhanceItem === 5,
);
check('applyLessonArea is a no-op for the same area', !applyLessonArea(rateRow, 'area-main-002', rateT0 + 400_000, 10_000));
applyLessonArea(rateRow, 'area-main-003', rateT0 + 420_000, 10_000);
check(
  'applyLessonArea banks later steps from the previous anchor',
  rateRow.bankedRewardGold === 150 + 12 * 7 && rateRow.rateAnchorTime === rateT0 + 420_000,
);
applyLessonArea(rateRow, 'area-main-004', rateT0 + 500_000, 10_000);
check(
  'applyLessonArea keeps the bank when the rates do not change',
  rateRow.currentAreaId === 'area-main-004' &&
    rateRow.bankedRewardGold === 150 + 12 * 7 &&
    rateRow.rateAnchorTime === rateT0 + 420_000,
);
applyLessonArea(rateRow, 'area-main-006', rateT0 + 13 * 60 * 60 * 1000, 10_000);
check(
  'applyLessonArea banks no steps past the 12h cap',
  rateRow.bankedRewardGold === 150 + 12 * 7 + (4320 - 42) * 10 &&
    rateRow.rateAnchorTime === rateT0 + 12 * 60 * 60 * 1000,
);

// --- Quest first clears move the lesson to the next uncleared Main area ---
// The quest RPCs simulate a live with the player's saved deck, so pick the
// lowest complete saved deck instead of assuming deck 1 is playable.
const liveDecks = await listElements(SERVER_USER_ID, 'Decks');
const liveOwnedPhotos = new Set((await listElements(SERVER_USER_ID, 'Photos')).map((row: any) => String(row.PhotoId)));
const liveOwnedCards = new Map(
  (await listElements(SERVER_USER_ID, 'Cards')).map((row: any) => [String(row.CardId), row]),
);
const liveAllPositions = await listElements(SERVER_USER_ID, 'DeckPositions');
const liveDeckRow = [...liveDecks]
  .sort((a: any, b: any) => Number(a.Number) - Number(b.Number))
  .find((deck: any) => {
    const rows = liveAllPositions.filter((row: any) => Number(row.Number) === Number(deck.Number));
    if (rows.length !== 5) return false;
    return rows.every((row: any) => {
      const owned = liveOwnedCards.get(String(row.CardId)) as any;
      const photos = Array.isArray(row.PhotoIds) ? row.PhotoIds.map(String) : [];
      if (owned === undefined || Number(owned.PhotoEquipableCount ?? 0) < photos.length) return false;
      return photos.every((id: string) => liveOwnedPhotos.has(id));
    });
  });
check('activity: the account has a complete saved deck', liveDeckRow !== undefined);
const liveDeckNumber = Number(liveDeckRow?.Number ?? 0);
const questStart = (questId: string) =>
  questRpc('Start', { QuestId: questId, DeckNumber: liveDeckNumber, PlayCount: 1 });

// Start from a fresh quest state; the seeded corpus already contains clears.
await db
  .delete(playerEntities)
  .where(and(eq(playerEntities.playerId, SERVER_USER_ID), eq(playerEntities.kind, 'Areas')));
await db
  .delete(playerEntities)
  .where(and(eq(playerEntities.playerId, SERVER_USER_ID), eq(playerEntities.kind, 'Quests')));
// Pin the home lesson to a fresh-state anchor 30 steps in the past.
const freshLesson = await homeEnterRpc();
check(
  'Home:Enter puts a player with no main clears in area-main-001',
  freshLesson.LessonProgress?.CurrentAreaId === 'area-main-001' &&
    Number(freshLesson.LessonProgress?.StepRewardGold ?? 0) === 5,
);
const questLessonAnchor = Date.now() - 300_000;
await db
  .update(playerLessonProgress)
  .set({
    lastReceiveTime: questLessonAnchor,
    maxRewardTime: questLessonAnchor + 12 * 60 * 60 * 1000,
    rewardGold: 0,
    rewardManagerExp: 0,
    rewardCardEnhanceItem: 0,
    bankedRewardGold: 0,
    bankedRewardManagerExp: 0,
    bankedRewardCardEnhanceItem: 0,
    rateAnchorTime: 0,
  })
  .where(eq(playerLessonProgress.playerId, SERVER_USER_ID));

// Clear every quest in area-main-001..003 sequentially, as required by the
// cd-clear-area-main-003 condition (Condition.Settings[0].ClearArea.AreaId).
const questOrder: string[] = [];
for (const areaId of ['area-main-001', 'area-main-002', 'area-main-003']) {
  const area = [...(await listQuestsByArea(areaId))].sort((a: any, b: any) => Number(a.Order ?? 0) - Number(b.Order ?? 0));
  for (const quest of area) questOrder.push(String(quest.Id));
}
// The seeded deck cannot beat the later main quests; this section verifies
// persistence, so lower the clear threshold instead of asserting difficulty.
const originalQuestClearScores = await db
  .select({ Id: masterQuest.Id, ClearScore: masterQuest.ClearScore })
  .from(masterQuest)
  .where(inArray(masterQuest.Id, questOrder));
await db.update(masterQuest).set({ ClearScore: 1 }).where(inArray(masterQuest.Id, questOrder));
let clearedAll = true;
for (const questId of questOrder) {
  const list = await questRpc('ListMain');
  const flat = (list.AreaGroups ?? []).flatMap((group: any) => group.Areas ?? []);
  const quest = flat.flatMap((area: any) => area.Quests ?? []).find((row: any) => row.QuestId === questId);
  if (Number(quest?.Cleared) === 1) continue;
  const result = await questStart(questId);
  if (Number(result.Result?.Cleared) !== 1) clearedAll = false;
}
check('Quest:Start clears every main quest in area-main-001..003', clearedAll);
for (const row of originalQuestClearScores) {
  await db.update(masterQuest).set({ ClearScore: row.ClearScore }).where(eq(masterQuest.Id, row.Id));
}

const questLesson = (await lessonRows())[0];
check(
  'Quest:Start first clears move the home lesson to the next uncleared area',
  questLesson?.currentAreaId === 'area-main-004' &&
    Number(questLesson.stepRewardGold) === 10 &&
    Number(questLesson.stepRewardManagerExp) === 10 &&
    Number(questLesson.stepRewardCardEnhanceItem) === 7,
);
check(
  'Quest:Start settles the idle steps before the first area change at the old rate',
  Number(questLesson?.bankedRewardGold ?? 0) >= 30 * 5 &&
    Number(questLesson?.bankedRewardManagerExp ?? 0) >= 30 * 8 &&
    Number(questLesson?.bankedRewardCardEnhanceItem ?? 0) >= 30 * 3,
);
check(
  'Quest:Start anchors the new rate after the settled steps',
  Number(questLesson?.rateAnchorTime ?? 0) >= questLessonAnchor + 300_000,
);
const questLessonHome = await homeEnterRpc();
check(
  'Home:Enter reports the area after the Main Live clears',
  questLessonHome.LessonProgress?.CurrentAreaId === 'area-main-004' &&
    Number(questLessonHome.LessonProgress?.StepRewardGold ?? 0) === 10,
);
check(
  'Home:Enter pending gold includes the old-rate bank',
  Number(questLessonHome.LessonProgress?.RewardGoldAmount ?? 0) >= Number(questLesson?.bankedRewardGold ?? 0),
);
const questLessonReceive = await activityReceive();
check(
  'Activity:ReceiveLessonReward pays the old-rate bank',
  activityRewardAmount(questLessonReceive, 8) >= Number(questLesson?.bankedRewardGold ?? 0),
);
const questLessonAfter = (await lessonRows())[0];
check(
  'Activity:ReceiveLessonReward clears the old-rate bank',
  Number(questLessonAfter?.bankedRewardGold ?? -1) === 0 &&
    Number(questLessonAfter?.rateAnchorTime ?? -1) === 0 &&
    questLessonAfter?.currentAreaId === 'area-main-004',
);

console.log(`\nactivity test: ${pass} passed, ${fail} failed`);
await (await import('./db/client.ts')).client.end({ timeout: 5 });
process.exit(fail ? 1 : 0);
