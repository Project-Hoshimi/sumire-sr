/**
 * Birthday DB integration test.
 *
 * Requires a reachable PostgreSQL with master data (the same DATABASE_URL the
 * server uses) and the recorded captures; it skips cleanly otherwise. It only
 * touches its own `birthdaydb-test-*` accounts.
 */
import { eq } from 'drizzle-orm';
import { buildServer } from './server.ts';
import { requireData } from './testing/requireData.ts';
import { db } from './db/client.ts';
import {
  accounts,
  players,
  playerEntities,
  playerExcursionState,
  playerBirthdayState,
  rewardClaims,
  playerLedger,
  playerPurchases,
  playerLoveProgress,
  playerLessonProgress,
  playerGachaState,
  gachaHistory,
  idolRoster,
  ownedCards,
  deckConfigurations,
  liveStageProgress,
  playerBoxGacha,
  playerMarathonPoint,
} from './db/schema.ts';
import { decodeMessage, encodeMessage, msgRegistry, Reader, Writer } from '@sumire-sr/protocol/runtime/proto.ts';
import { endpoints } from '@sumire-sr/protocol/gen/endpoints.ts';
import '@sumire-sr/protocol/gen/registry.ts';
import { AppRpcError } from './services/errors.ts';
import { mintToken } from './auth/jwt.ts';
import { getSingleton, putSingleton } from './services/playerState.ts';
import { setBirthdayClockForTest } from './services/birthdayLogic.ts';

await requireData({ captures: true, db: true });

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond || detail === undefined ? '' : ` (${String(detail)})`}`);
  cond ? pass++ : fail++;
}

const app = buildServer();
await app.listen({ port: 18099, host: '127.0.0.1' });
await import('./services/all.ts');

const { dispatchRpc } = await import('./services/router.ts');

type TestAccount = {
  accountId: string;
  playerId: string;
  publicUserId: string;
  token: string;
};

const MAIN: TestAccount = {
  accountId: 'birthdaydb-test-account',
  playerId: 'birthdaydb-test-user',
  publicUserId: 'BIRTHDAY01',
  token: '',
};
const INVALID: TestAccount = {
  accountId: 'birthdaydb-test-account-invalid',
  playerId: 'birthdaydb-test-user-invalid',
  publicUserId: 'BIRTHDAY02',
  token: '',
};
const ORDER: TestAccount = {
  accountId: 'birthdaydb-test-account-order',
  playerId: 'birthdaydb-test-user-order',
  publicUserId: 'BIRTHDAY03',
  token: '',
};
const NO_BIRTHDAY: TestAccount = {
  accountId: 'birthdaydb-test-account-nobd',
  playerId: 'birthdaydb-test-user-nobd',
  publicUserId: 'BIRTHDAY04',
  token: '',
};

const ALL_ACCOUNTS = [MAIN, INVALID, ORDER, NO_BIRTHDAY];

async function wipe(account: TestAccount) {
  await db.delete(playerEntities).where(eq(playerEntities.playerId, account.playerId));
  await db.delete(playerExcursionState).where(eq(playerExcursionState.playerId, account.playerId));
  await db.delete(playerBirthdayState).where(eq(playerBirthdayState.playerId, account.playerId));
  await db.delete(rewardClaims).where(eq(rewardClaims.playerId, account.playerId));
  await db.delete(playerLedger).where(eq(playerLedger.playerId, account.playerId));
  await db.delete(playerPurchases).where(eq(playerPurchases.playerId, account.playerId));
  await db.delete(playerLoveProgress).where(eq(playerLoveProgress.playerId, account.playerId));
  await db.delete(playerLessonProgress).where(eq(playerLessonProgress.playerId, account.playerId));
  await db.delete(playerGachaState).where(eq(playerGachaState.playerId, account.playerId));
  await db.delete(gachaHistory).where(eq(gachaHistory.playerId, account.playerId));
  await db.delete(idolRoster).where(eq(idolRoster.playerId, account.playerId));
  await db.delete(ownedCards).where(eq(ownedCards.playerId, account.playerId));
  await db.delete(deckConfigurations).where(eq(deckConfigurations.playerId, account.playerId));
  await db.delete(liveStageProgress).where(eq(liveStageProgress.playerId, account.playerId));
  await db.delete(playerBoxGacha).where(eq(playerBoxGacha.playerId, account.playerId));
  await db.delete(playerMarathonPoint).where(eq(playerMarathonPoint.playerId, account.playerId));
  await db.delete(players).where(eq(players.id, account.playerId));
  await db.delete(accounts).where(eq(accounts.id, account.accountId));
}

function writerFor(name: string, request: Record<string, unknown>) {
  const [service, method] = name.split(':');
  const ep = (endpoints as Record<string, Record<string, { request: string; response: string }>>)[service]?.[method];
  if (!ep) throw new Error(`no endpoint for ${name}`);
  const requestShape = ep.request === 'Empty' ? null : msgRegistry.get(ep.request);
  const writer = new Writer();
  if (requestShape) encodeMessage(requestShape, request as never, writer);
  return { ep, bytes: Buffer.from(writer.toBytes()) };
}

async function callRpc(name: string, token: string, request: Record<string, unknown> = {}) {
  const { ep, bytes } = writerFor(name, request);
  const responseShape = msgRegistry.get(ep.response);
  if (!responseShape) throw new Error(`no response shape for ${name}`);
  const out = await dispatchRpc(name, bytes, {
    headers: { 'x-auth-token': token },
    log: { info() {}, warn() {} },
  } as never);
  return decodeMessage(responseShape, new Reader(Uint8Array.from(out))) as Record<string, any>;
}

async function userGet(token: string) {
  return callRpc('User:Get', token);
}

async function expectFailure(fn: () => Promise<unknown>): Promise<AppRpcError | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof AppRpcError ? err : null;
  }
}

async function seedAccount(account: TestAccount, favorites: string[]): Promise<void> {
  await wipe(account);
  await db.insert(accounts).values({
    id: account.accountId,
    firebaseUid: `${account.accountId}-uid`,
    seedId: account.publicUserId,
    displayName: 'Player',
    lastLoginAt: new Date(),
  });
  await db.insert(players).values({
    id: account.playerId,
    accountId: account.accountId,
    name: 'Player',
    level: 40,
    exp: 1335246,
    gold: 1707717,
    freeJewel: 10670,
    data: { publicUserId: account.publicUserId },
  });
  account.token = mintToken({ sub: account.accountId, seedId: account.publicUserId });
  // User:Get lazily seeds the corpus-backed entity store, including Profile.
  await userGet(account.token);
  const profile = await getSingleton(account.playerId, 'Profile', db);
  await putSingleton(account.playerId, 'Profile', {
    ...(profile ?? { __msg: 'Solis.Common.Proto.Transaction.UserProfile' }),
    FavoriteCharacterIds: favorites,
  }, db);
}

const JST_2026_11_07_0402 = Date.UTC(2026, 10, 6, 19, 2, 0);
const JST_2026_11_14_0000 = Date.UTC(2026, 10, 13, 15, 0, 0);
const JST_2027_11_01_0000 = Date.UTC(2027, 9, 31, 15, 0, 0);
const JST_2027_11_07_0000 = Date.UTC(2027, 10, 6, 15, 0, 0);

const PARTICIPANTS = ['birthday-01-smr-01', 'birthday-01-yu-01', 'birthday-01-rui-01'];

function birthdayBannerPresent(body: Record<string, any>): boolean {
  return (body.BannerInfo?.MenuBanners ?? []).some((b: any) => b.Id === 'banner-user-birthday');
}

function birthdayButtonPresent(body: Record<string, any>): boolean {
  return (body.EventButtonDisplayInfos ?? []).some((b: any) => b.ConditionId === 'cd-user-birthday');
}

for (const account of ALL_ACCOUNTS) await wipe(account);

setBirthdayClockForTest(() => JST_2026_11_07_0402);
await seedAccount(MAIN, ['char-smr', 'char-yu', 'char-rui']);

// ---------------------------------------------------------------------------
// Profile:UpdateBirthday
// ---------------------------------------------------------------------------
const setBirthday = await callRpc('Profile:UpdateBirthday', MAIN.token, { Month: 11, Day: 7 });
check('Profile:UpdateBirthday returns the first participant',
  setBirthday.BirthdayAdvInfo?.BirthdayId === 'birthday-01-smr-01',
  setBirthday.BirthdayAdvInfo?.BirthdayId);
check('Profile:UpdateBirthday returns the first participant asset',
  setBirthday.BirthdayAdvInfo?.AdvAssetId === 'userhbd_01_smr');
check('Profile:UpdateBirthday stores the date',
  Number(setBirthday.CommonResponse?.UpdatedData?.Profile?.BirthMonth) === 11 &&
    Number(setBirthday.CommonResponse?.UpdatedData?.Profile?.BirthDay) === 7);

const secondBirthdayError = await expectFailure(() =>
  callRpc('Profile:UpdateBirthday', MAIN.token, { Month: 11, Day: 7 }));
check('Profile:UpdateBirthday rejects a second set with x-error-action home',
  secondBirthdayError?.action === 'home',
  secondBirthdayError?.action);

await seedAccount(INVALID, []);
const invalidDateError = await expectFailure(() =>
  callRpc('Profile:UpdateBirthday', INVALID.token, { Month: 2, Day: 30 }));
check('Profile:UpdateBirthday rejects February 30', invalidDateError?.action === 'home');

// ---------------------------------------------------------------------------
// Home integration
// ---------------------------------------------------------------------------
const login = await callRpc('Home:Login', MAIN.token);
check('Home:Login carries the first unwatched birthday log',
  login.BirthdayAdvInfo?.BirthdayId === 'birthday-01-smr-01',
  login.BirthdayAdvInfo?.BirthdayId);

const enter = await callRpc('Home:Enter', MAIN.token);
check('Home:Enter carries HomeBirthdayInfo',
  enter.EventInfo?.HomeBirthdayInfo?.BannerAssetId === 'img_banner_l_user-birthday' &&
    Number(enter.EventInfo?.HomeBirthdayInfo?.Order) === 1000);
check('Home:Enter birthday banner is first',
  enter.BannerInfo?.MenuBanners?.[0]?.Id === 'banner-user-birthday',
  enter.BannerInfo?.MenuBanners?.[0]?.Id);
check('Home:Enter birthday banner uses the small asset',
  enter.BannerInfo?.MenuBanners?.[0]?.AssetId === 'img_banner_s_user-birthday');
check('Home:Enter carries the birthday event button',
  (enter.EventButtonDisplayInfos ?? []).some(
    (b: any) => b.ConditionId === 'cd-user-birthday' && Number(b.Priority) === 2000),
  JSON.stringify(enter.EventButtonDisplayInfos));

// ---------------------------------------------------------------------------
// Top + watched sequence
// ---------------------------------------------------------------------------
const top = await callRpc('Birthday:Top', MAIN.token);
check('Birthday:Top lists the three participants in order',
  (top.BirthdayInfos ?? []).map((b: any) => b.BirthdayAdvInfo?.BirthdayId).join(',') === PARTICIPANTS.join(','),
  (top.BirthdayInfos ?? []).map((b: any) => b.BirthdayAdvInfo?.BirthdayId).join(','));
check('Birthday:Top carries the catalogue text',
  top.BirthdayInfos?.[0]?.Text === 'お兄ちゃん\nおめでと～！');
check('Birthday:Top carries the first costume',
  top.BirthdayInfos?.[0]?.CostumeId === 'cos-smr-casl-00',
  top.BirthdayInfos?.[0]?.CostumeId);

const afterSmr = await callRpc('Birthday:SetWatched', MAIN.token, { BirthdayId: PARTICIPANTS[0] });
check('SetWatched(smr) leaves yu and rui unwatched',
  (afterSmr.UnwatchAdvBirthdayIds ?? []).join(',') === PARTICIPANTS.slice(1).join(','),
  (afterSmr.UnwatchAdvBirthdayIds ?? []).join(','));
check('SetWatched(smr) makes smr receivable',
  (afterSmr.ReceivableRewardBirthdayIds ?? []).join(',') === PARTICIPANTS[0]);

const afterYu = await callRpc('Birthday:SetWatched', MAIN.token, { BirthdayId: PARTICIPANTS[1] });
check('SetWatched(yu) leaves rui unwatched',
  (afterYu.UnwatchAdvBirthdayIds ?? []).join(',') === PARTICIPANTS[2]);
check('SetWatched(yu) makes smr and yu receivable',
  (afterYu.ReceivableRewardBirthdayIds ?? []).join(',') === PARTICIPANTS.slice(0, 2).join(','));

const afterRui = await callRpc('Birthday:SetWatched', MAIN.token, { BirthdayId: PARTICIPANTS[2] });
check('SetWatched(rui) leaves nothing unwatched', (afterRui.UnwatchAdvBirthdayIds ?? []).length === 0);
check('SetWatched(rui) makes all three receivable',
  (afterRui.ReceivableRewardBirthdayIds ?? []).join(',') === PARTICIPANTS.join(','));

const nonParticipantError = await expectFailure(() =>
  callRpc('Birthday:SetWatched', MAIN.token, { BirthdayId: 'birthday-01-ai-01' }));
check('SetWatched rejects a non-participant', nonParticipantError?.action === 'home');

const repeatSmr = await callRpc('Birthday:SetWatched', MAIN.token, { BirthdayId: PARTICIPANTS[0] });
check('SetWatched is idempotent',
  (repeatSmr.UnwatchAdvBirthdayIds ?? []).length === 0 &&
    (repeatSmr.ReceivableRewardBirthdayIds ?? []).join(',') === PARTICIPANTS.join(','));

// Out-of-order watching is accepted.
await seedAccount(ORDER, ['char-smr', 'char-yu', 'char-rui']);
await callRpc('Profile:UpdateBirthday', ORDER.token, { Month: 11, Day: 7 });
const orderRui = await callRpc('Birthday:SetWatched', ORDER.token, { BirthdayId: PARTICIPANTS[1] });
check('SetWatched accepts an out-of-order participant',
  (orderRui.UnwatchAdvBirthdayIds ?? []).join(',') === PARTICIPANTS[0] + ',' + PARTICIPANTS[2]);
check('SetWatched out-of-order keeps birthday order for receivable',
  (orderRui.ReceivableRewardBirthdayIds ?? []).join(',') === PARTICIPANTS[1]);

const afterAllWatchedLogin = await callRpc('Home:Login', MAIN.token);
check('Home:Login drops BirthdayAdvInfo once everything is watched',
  afterAllWatchedLogin.BirthdayAdvInfo === undefined,
  afterAllWatchedLogin.BirthdayAdvInfo?.BirthdayId);

// ---------------------------------------------------------------------------
// OutputWatchedLog
// ---------------------------------------------------------------------------
const watchedLog = await callRpc('Birthday:OutputWatchedLog', MAIN.token, {
  BirthdayId: PARTICIPANTS[0],
  IsSkip: 1,
});
check('Birthday:OutputWatchedLog accepts a skipped rewatch', watchedLog.CommonResponse !== undefined);
const emptyLogError = await expectFailure(() =>
  callRpc('Birthday:OutputWatchedLog', MAIN.token, { BirthdayId: '' }));
check('Birthday:OutputWatchedLog rejects an empty id', emptyLogError?.action === 'home');

// ---------------------------------------------------------------------------
// ReceiveReward
// ---------------------------------------------------------------------------
const reward = await callRpc('Birthday:ReceiveReward', MAIN.token);
check('Birthday:ReceiveReward returns three decoration rewards',
  (reward.Rewards ?? []).length === 3 &&
    (reward.Rewards ?? []).every((r: any) => Number(r.ResourceType) === 26 && Boolean(r.IsNew) && Number(r.AfterAmount) === 1 && Number(r.AmountI64) === 1));
check('Birthday:ReceiveReward returns the three decoration ids',
  (reward.Rewards ?? []).map((r: any) => r.ResourceId).join(',') ===
    ['deco-user-birthday-smr-01', 'deco-user-birthday-yu-01', 'deco-user-birthday-rui-01'].join(','),
  (reward.Rewards ?? []).map((r: any) => r.ResourceId).join(','));
check('Birthday:ReceiveReward updates Decorations',
  (reward.CommonResponse?.UpdatedData?.Decorations ?? []).length === 3);

const secondReward = await callRpc('Birthday:ReceiveReward', MAIN.token);
check('Birthday:ReceiveReward is empty once claimed', (secondReward.Rewards ?? []).length === 0);

const topAfterClaim = await callRpc('Birthday:Top', MAIN.token);
check('Birthday:Top keeps the three entries after claiming',
  (topAfterClaim.BirthdayInfos ?? []).length === 3);
check('Birthday:Top lists nothing unwatched after claiming',
  (topAfterClaim.UnwatchedAdvBirthdayIds ?? []).length === 0);
check('Birthday:Top lists nothing receivable after claiming',
  (topAfterClaim.ReceivableRewardBirthdayIds ?? []).length === 0);

// ---------------------------------------------------------------------------
// Window closes
// ---------------------------------------------------------------------------
setBirthdayClockForTest(() => JST_2026_11_14_0000);
const closedEnter = await callRpc('Home:Enter', MAIN.token);
check('Home:Enter drops HomeBirthdayInfo after the window',
  closedEnter.EventInfo?.HomeBirthdayInfo === undefined);
check('Home:Enter drops the birthday banner after the window', !birthdayBannerPresent(closedEnter));
check('Home:Enter drops the birthday button after the window', !birthdayButtonPresent(closedEnter));

const closedTop = await callRpc('Birthday:Top', MAIN.token);
check('Birthday:Top is empty after the window',
  (closedTop.BirthdayInfos ?? []).length === 0 &&
    (closedTop.UnwatchedAdvBirthdayIds ?? []).length === 0 &&
    (closedTop.ReceivableRewardBirthdayIds ?? []).length === 0);

const closedRewardError = await expectFailure(() => callRpc('Birthday:ReceiveReward', MAIN.token));
check('Birthday:ReceiveReward rejects after the window', closedRewardError?.action === 'home');
const closedWatchError = await expectFailure(() =>
  callRpc('Birthday:SetWatched', MAIN.token, { BirthdayId: PARTICIPANTS[0] }));
check('Birthday:SetWatched rejects after the window', closedWatchError?.action === 'home');
const closedLog = await callRpc('Birthday:OutputWatchedLog', MAIN.token, {
  BirthdayId: PARTICIPANTS[0],
});
check('Birthday:OutputWatchedLog still succeeds after the window', closedLog.CommonResponse !== undefined);

// ---------------------------------------------------------------------------
// Reminder week and next year
// ---------------------------------------------------------------------------
setBirthdayClockForTest(() => JST_2027_11_01_0000);
const reminderLogin = await callRpc('Home:Login', MAIN.token);
check('Home:Login carries the birthday reminder in the reminder week',
  reminderLogin.BirthdayRemindInfo?.AssetId === 'user-birthday-advance-notice',
  reminderLogin.BirthdayRemindInfo?.AssetId);
check('Home:Login reminder maps the description',
  reminderLogin.BirthdayRemindInfo?.Description === 'ご案内');

await callRpc('Birthday:SetWatchedRemindInfo', MAIN.token);
const suppressedLogin = await callRpc('Home:Login', MAIN.token);
check('Home:Login drops the reminder after SetWatchedRemindInfo',
  suppressedLogin.BirthdayRemindInfo === undefined,
  suppressedLogin.BirthdayRemindInfo?.AssetId);

setBirthdayClockForTest(() => JST_2027_11_07_0000);
const newYearLogin = await callRpc('Home:Login', MAIN.token);
check('Home:Login starts the new event year',
  newYearLogin.BirthdayAdvInfo?.BirthdayId === PARTICIPANTS[0],
  newYearLogin.BirthdayAdvInfo?.BirthdayId);
const newYearTop = await callRpc('Birthday:Top', MAIN.token);
check('Birthday:Top resets the watched list in the new year',
  (newYearTop.UnwatchedAdvBirthdayIds ?? []).join(',') === PARTICIPANTS.join(','),
  (newYearTop.UnwatchedAdvBirthdayIds ?? []).join(','));

// ---------------------------------------------------------------------------
// Account without a birthday
// ---------------------------------------------------------------------------
await seedAccount(NO_BIRTHDAY, []);
const noBirthdayLogin = await callRpc('Home:Login', NO_BIRTHDAY.token);
check('Home:Login carries no birthday fields without a birth date',
  noBirthdayLogin.BirthdayAdvInfo === undefined && noBirthdayLogin.BirthdayRemindInfo === undefined);
const noBirthdayEnter = await callRpc('Home:Enter', NO_BIRTHDAY.token);
check('Home:Enter carries no birthday data without a birth date',
  noBirthdayEnter.EventInfo?.HomeBirthdayInfo === undefined &&
    !birthdayBannerPresent(noBirthdayEnter) &&
    !birthdayButtonPresent(noBirthdayEnter));

setBirthdayClockForTest(null);

console.log(`\nbirthday db test: ${pass} passed, ${fail} failed`);
await app.close();
await (await import('./db/client.ts')).client.end({ timeout: 5 });
process.exit(fail ? 1 : 0);
