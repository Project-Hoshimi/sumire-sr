import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import '@sumire-sr/protocol/gen/registry.ts';
import './services/all.ts';
import { requireData } from './testing/requireData.ts';

await requireData({ captures: true, db: true });

const { dispatchRpc } = await import('./services/router.ts');
const { db, client } = await import('./db/client.ts');
const { accounts, players, playerEntities } = await import('./db/schema.ts');
const { decodeMessage, encodeMessage, msgRegistry, Reader, Writer } = await import('@sumire-sr/protocol/runtime/proto.ts');
const { endpoints } = await import('@sumire-sr/protocol/gen/endpoints.ts');
const tokens = await import('./auth/firebaseTokens.ts');
const { mintToken } = await import('./auth/jwt.ts');
const { getFreshCapture } = await import('./services/replay/corpus.ts');
const { lessonRatesForArea } = await import('./services/activity.ts');
const { postGifts } = await import('./services/gift.ts');
const { withPlayerTx } = await import('./db/tx.ts');

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS ${label}`);
    return;
  }
  fail++;
  const extra =
    detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.error(`FAIL ${label}${extra}`);
}

// ---------------------------------------------------------------------------
// RPC helpers (handler level, no HTTP)
// ---------------------------------------------------------------------------

function endpoint(name: string) {
  const [service, method] = name.split(':');
  const ep = endpoints[service]?.[method];
  if (!ep) throw new Error(`unknown endpoint ${name}`);
  return ep;
}

function encodeReq(name: string, obj: Record<string, unknown> = {}): Buffer {
  const shapeName = endpoint(name).request;
  if (shapeName === 'Empty') return Buffer.alloc(0);
  const shape = msgRegistry.get(shapeName);
  if (!shape) throw new Error(`no schema registered for ${shapeName}`);
  const w = new Writer();
  encodeMessage(shape, obj, w);
  return Buffer.from(w.toBytes());
}

function decodeResp(name: string, bytes: Buffer): any {
  const shapeName = endpoint(name).response;
  const shape = msgRegistry.get(shapeName);
  if (!shape) throw new Error(`no schema registered for ${shapeName}`);
  return decodeMessage(shape, new Reader(Uint8Array.from(bytes)));
}

const fakeLog = { info() {}, warn() {}, error() {} };
const fakeReq = { headers: {}, log: fakeLog } as any;

async function rpc(name: string, body: Record<string, unknown> = {}, token?: string): Promise<Buffer> {
  const req = token
    ? { headers: { 'x-auth-token': token }, log: fakeLog }
    : fakeReq;
  return dispatchRpc(name, encodeReq(name, body), req as any);
}

async function call(name: string, body: Record<string, unknown> = {}, token?: string): Promise<any> {
  return decodeResp(name, await rpc(name, body, token));
}

/** Name chosen at Tutorial:Init; deliberately different from the capture's "Numbers". */
const TEST_NAME = 'Tester01';

/**
 * The fresh-account captures were recorded from the "Numbers" account. Whenever
 * a response carries a `User`, its `Name` must be the player's own.
 */
function checkResponseUserName(label: string, resp: any): void {
  const user = resp?.CommonResponse?.UpdatedData?.User ?? resp?.User;
  if (user) check(`${label} returns the chosen name`, user.Name === TEST_NAME, user.Name);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function dbReachable(): Promise<boolean> {
  try {
    await withTimeout(db.execute(sql`select 1`), 2500);
    return true;
  } catch (e) {
    console.log(`SKIP fresh-account tests (database unreachable: ${(e as Error).message})`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Corpus regression snapshot (captured with the pre-fresh-player code)
// ---------------------------------------------------------------------------

const CORPUS_ACCOUNT_ID = 'freshaccttest-corpus-account-0000';
const CORPUS_UID = 'freshaccttest-corpus-uid';
const CORPUS_PLAYER_ID = 'freshaccttest-corpus-player-0000';
const CORPUS_PUBLIC_ID = 'FRESHCP1';
const CORPUS_USER_GET_SHA = '70d9e8933893a31a958f8ef54766949c456e0045bdb1990f618369c7c361b02a';
const CORPUS_HOME_ENTER_SHA = 'e2cf5650d41c01fc3a527396a8eb8d795f5c2821ae574a1f5511a466112aafaf';

/** Corpus rows carry no `seed` marker, exactly like accounts that predate it. */
async function seedCorpusPlayer(): Promise<void> {
  await deletePlayerRows(CORPUS_PLAYER_ID);
  await db.delete(players).where(eq(players.id, CORPUS_PLAYER_ID));
  await db.delete(accounts).where(eq(accounts.id, CORPUS_ACCOUNT_ID));
  await db.insert(accounts).values({
    id: CORPUS_ACCOUNT_ID,
    firebaseUid: CORPUS_UID,
    seedId: CORPUS_PUBLIC_ID,
    displayName: 'Player',
  });
  await db.insert(players).values({
    id: CORPUS_PLAYER_ID,
    accountId: CORPUS_ACCOUNT_ID,
    name: 'Player',
    level: 40,
    exp: 1335246,
    gold: 1707717,
    freeJewel: 10670,
    data: { publicUserId: CORPUS_PUBLIC_ID },
  });
}

/**
 * Delete every row that references `playerId`. The schema gains tables (gacha
 * history/state, decks, purchases, …) over time, so discover the `player_id`
 * columns instead of listing them and silently failing on an FK.
 */
async function deletePlayerRows(playerId: string): Promise<void> {
  // Sweeps every table with a player_id column, so per-player state added
  // later — including `player_entities` kinds like `Gifts` and `GiftHistory` —
  // is cleaned up without touching this helper.
  const rows = (await db.execute(sql`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'player_id'
  `)) as unknown as { table_name?: string }[];
  for (const row of rows) {
    const table = String(row.table_name ?? '');
    if (!table) continue;
    await db.execute(sql`delete from ${sql.identifier(table)} where player_id = ${playerId}`);
  }
}

async function deleteAccountByUid(uid: string): Promise<void> {
  const [acct] = await db.select().from(accounts).where(eq(accounts.firebaseUid, uid)).limit(1);
  if (!acct) return;
  const rows = await db.select().from(players).where(eq(players.accountId, acct.id));
  for (const row of rows) await deletePlayerRows(row.id);
  await db.delete(players).where(eq(players.accountId, acct.id));
  await db.delete(accounts).where(eq(accounts.id, acct.id));
}

// ---------------------------------------------------------------------------
// Balance helpers: the `players` columns are the single source of truth
// ---------------------------------------------------------------------------

const USER_BALANCE_MSG = 'Solis.Common.Proto.Transaction.UserBalance';

async function playerBalanceColumns(
  playerId: string,
): Promise<{ FreeBalance: number; PaidBalance: number }> {
  const [row] = await db
    .select({ freeJewel: players.freeJewel, paidJewel: players.paidJewel })
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1);
  return { FreeBalance: Number(row?.freeJewel ?? 0), PaidBalance: Number(row?.paidJewel ?? 0) };
}

/** Decode the stored `Balance` entity (kind='Balance' singleton). */
async function storedBalance(playerId: string): Promise<any> {
  const [row] = await db
    .select()
    .from(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, 'Balance')))
    .limit(1);
  if (!row) return null;
  const shape = msgRegistry.get(USER_BALANCE_MSG);
  if (!shape) throw new Error(`missing proto shape ${USER_BALANCE_MSG}`);
  return decodeMessage(shape, new Reader(Uint8Array.from(Buffer.from(row.blob, 'base64'))));
}

/** The Balance a response serves (top level or `CommonResponse.UpdatedData`). */
function balanceOf(resp: any): { FreeBalance: number; PaidBalance: number } | null {
  const b = resp?.CommonResponse?.UpdatedData?.Balance ?? resp?.Balance;
  if (!b) return null;
  return { FreeBalance: Number(b.FreeBalance ?? 0), PaidBalance: Number(b.PaidBalance ?? 0) };
}

function balanceEq(a: any, b: any): boolean {
  return (
    !!a &&
    !!b &&
    Number(a.FreeBalance ?? 0) === Number(b.FreeBalance ?? 0) &&
    Number(a.PaidBalance ?? 0) === Number(b.PaidBalance ?? 0)
  );
}

/** Assert a response's Balance and the stored Balance entity equal the columns. */
async function checkBalanceSynced(label: string, playerId: string, resp: any): Promise<void> {
  const cols = await playerBalanceColumns(playerId);
  check(`${label} Balance equals the players columns`, balanceEq(balanceOf(resp), cols), {
    served: balanceOf(resp),
    cols,
  });
  const stored = await storedBalance(playerId);
  check(`${label} Balance entity equals the players columns`, balanceEq(stored, cols), { stored, cols });
}

// ---------------------------------------------------------------------------
// Fresh account flow (only with a reachable DB)
// ---------------------------------------------------------------------------

if (await dbReachable()) {
  const createdUids: string[] = [];
  try {
    // --- new account is marked fresh and starts from the fresh template -----
    const uid = tokens.generateFirebaseUid();
    createdUids.push(uid);
    const created = await call('Auth:Create', { FirebaseUID: uid });
    check(
      'Auth:Create returns a custom token for the new uid',
      tokens.verifyCustomToken(created.FirebaseCustomToken)?.uid === uid,
      created,
    );

    const [acct] = await db.select().from(accounts).where(eq(accounts.firebaseUid, uid)).limit(1);
    const [pl] = acct
      ? await db.select().from(players).where(eq(players.accountId, acct.id)).limit(1)
      : [undefined];
    check('Auth:Create created the player row', !!pl);
    check('new player row is marked fresh', (pl?.data as { seed?: string } | null)?.seed === 'fresh', pl?.data);

    const login = await call('Auth:Login', { FirebaseIDToken: tokens.mintIdToken(uid) });
    const token = login.GameAuthToken as string;
    check('Auth:Login issues a game token', typeof token === 'string' && token.length > 0);

    const u = await call('User:Get', {}, token);
    check('fresh User:Get has no Tutorials', !u.Tutorials || u.Tutorials.length === 0, u.Tutorials);
    check('fresh User:Get default name is 牧野航平', u.User?.Name === '牧野航平', u.User?.Name);
    check('fresh User:Get ManagerLevel is 1', Number(u.User?.ManagerLevel) === 1, u.User?.ManagerLevel);
    check('fresh User:Get carries the 17 tutorial cards', (u.Cards?.length ?? 0) === 17, u.Cards?.length);
    check('fresh User:Get has no forced areas', !u.Areas || u.Areas.length === 0, u.Areas);
    check(
      'fresh User:Get identity comes from the player row',
      u.UserPublic?.ServerUserId === pl?.id &&
        u.UserPublic?.PublicUserId === (pl?.data as { publicUserId?: string } | null)?.publicUserId,
      u.UserPublic,
    );

    // --- Balance: served values come from the `players` columns -------------
    await checkBalanceSynced('fresh User:Get', pl!.id, u);

    // --- Tutorial:Init persists the chosen name ----------------------------
    const init = await call('Tutorial:Init', { Name: TEST_NAME }, token);
    check(
      'Tutorial:Init echoes UpdatedData.User with the new name',
      init.CommonResponse?.UpdatedData?.User?.Name === TEST_NAME,
      init,
    );
    const afterInit = await call('User:Get', {}, token);
    check('Tutorial:Init persists User.Name', afterInit.User?.Name === TEST_NAME, afterInit.User?.Name);
    check(
      'Tutorial:Init leaves User:Get without Tutorials',
      !afterInit.Tutorials || afterInit.Tutorials.length === 0,
    );

    const homeLogin = await call('Home:Login', {}, token);
    check(
      'Home:Login keeps the chosen name',
      homeLogin.CommonResponse?.UpdatedData?.User?.Name === TEST_NAME,
      homeLogin.CommonResponse?.UpdatedData?.User?.Name,
    );
    check(
      'Home:Login keeps ManagerLevel 1',
      Number(homeLogin.CommonResponse?.UpdatedData?.User?.ManagerLevel) === 1,
      homeLogin.CommonResponse?.UpdatedData?.User?.ManagerLevel,
    );
    await checkBalanceSynced('Home:Login', pl!.id, homeLogin);

    // The Love menu is gated on Home:Enter's LoveInfo; it stays hidden while
    // the tutorial is in progress.
    const homeDuringTutorial = await call('Home:Enter', { SkipUpdate: false }, token);
    check(
      'fresh Home:Enter during the tutorial does not inject LoveInfo',
      !Number(homeDuringTutorial.LoveInfo?.IsUnlocked),
      homeDuringTutorial.LoveInfo,
    );

    // --- Tutorial:Progress echoes each step -------------------------------
    const progress = (step: number) => call('Tutorial:Progress', { Type: 1, Step: step }, token);
    for (const step of [10, 100]) {
      const resp = await progress(step);
      const tut = resp.CommonResponse?.UpdatedData?.Tutorials?.[0];
      check(
        `Tutorial:Progress step ${step} echoes the tutorial`,
        Number(tut?.TutorialType) === 1 && Number(tut?.Step) === step,
        tut,
      );
    }

    // --- Tutorial:StartQuest serves the matching captured response --------
    const shortBytes = await rpc('Tutorial:StartQuest', { QuestId: 'qt-tutorial-short' }, token);
    const shortCapture = getFreshCapture('00026.resp-plain.Tutorial:StartQuest.bin');
    check(
      'Tutorial:StartQuest qt-tutorial-short returns the captured body',
      !!shortCapture && shortBytes.equals(shortCapture),
      shortBytes.length,
    );
    const fullBytes = await rpc('Tutorial:StartQuest', { QuestId: 'qt-tutorial-full' }, token);
    const fullCapture = getFreshCapture('00028.resp-plain.Tutorial:StartQuest.bin');
    check(
      'Tutorial:StartQuest qt-tutorial-full returns the captured body',
      !!fullCapture && fullBytes.equals(fullCapture),
      fullBytes.length,
    );
    // These captures carry no `User` (only a LiveResult UserInfo), so the name
    // check is a no-op unless the response grows one.
    checkResponseUserName('Tutorial:StartQuest qt-tutorial-short', decodeResp('Tutorial:StartQuest', shortBytes));
    checkResponseUserName('Tutorial:StartQuest qt-tutorial-full', decodeResp('Tutorial:StartQuest', fullBytes));

    // --- Tutorial:ReceiveLessonReward applies its UpdatedData -------------
    const reward = await call('Tutorial:ReceiveLessonReward', {}, token);
    check('Tutorial:ReceiveLessonReward returns the 3 captured rewards', (reward.Rewards?.length ?? 0) === 3, reward.Rewards);
    checkResponseUserName('Tutorial:ReceiveLessonReward', reward);
    const afterReward = await call('User:Get', {}, token);
    check(
      'ReceiveLessonReward does not overwrite the stored User.Name',
      afterReward.User?.Name === TEST_NAME,
      afterReward.User?.Name,
    );
    const enhance = (afterReward.Items ?? []).find((i: any) => i.ItemId === 'item-card_enhance');
    check('ReceiveLessonReward persists Items (card_enhance 1100)', Number(enhance?.Amount) === 1100, enhance);
    const goldPoint = (afterReward.Points ?? []).find((p: any) => p.PointType === 1);
    check('ReceiveLessonReward persists Points (gold 1000)', Number(goldPoint?.Amount) === 1000, goldPoint);
    const step110 = (afterReward.Tutorials ?? []).find((t: any) => Number(t.TutorialType) === 1);
    check('ReceiveLessonReward persists Tutorials step 110', Number(step110?.Step) === 110, step110);
    await checkBalanceSynced('Tutorial:ReceiveLessonReward', pl!.id, reward);

    // --- other endpoints touched by the fresh flow still work --------------
    const freshCard = afterReward.Cards?.[0];
    const enhResp = await call(
      'Card:Enhance',
      { CardId: freshCard?.CardId, Level: Number(freshCard?.Level ?? 1) + 1 },
      token,
    );
    check(
      'Card:Enhance works for a fresh player',
      (enhResp.CommonResponse?.UpdatedData?.Cards?.length ?? 0) === 1,
      enhResp,
    );

    const deckResp = await call(
      'Deck:Save',
      {
        Number: 1,
        Name: 'FRESHDECK',
        DeckEditType: 1,
        UserDeckPositions: [{ Position: 1, CardId: freshCard?.CardId }],
      },
      token,
    );
    check(
      'Deck:Save works for a fresh player',
      deckResp.CommonResponse?.UpdatedData?.Decks?.[0]?.Name === 'FRESHDECK',
      deckResp,
    );
    checkResponseUserName('Deck:Save', deckResp);

    const messageGroups = await call('Message:ListGroup', {}, token);
    check('Message:ListGroup works for a fresh player', !!messageGroups.CommonResponse);
    const timeline = await call('Message:Timeline', { MessageGroupId: 'message_group_skr' }, token);
    check('Message:Timeline works for a fresh player', !!timeline.CommonResponse);
    const finish = await call(
      'Message:Finish',
      {
        MessageGroupId: 'message_group_skr',
        TimelineId: '1792983820090410978',
        SelectMessageDetailIds: ['2'],
      },
      token,
    );
    check(
      'Message:Finish returns the captured tutorial message update',
      finish.CommonResponse?.UpdatedData?.Messages?.[0]?.MessageId === 'message-skr-tutorial-001',
      finish,
    );

    // --- final step 150 clears the tutorial and rewrites User -------------
    for (const step of [120, 130, 140]) {
      const resp = await progress(step);
      const tut = resp.CommonResponse?.UpdatedData?.Tutorials?.[0];
      check(`Tutorial:Progress step ${step} echoes the tutorial`, Number(tut?.Step) === step, tut);
    }
    const p150 = await progress(150);
    const tut150 = p150.CommonResponse?.UpdatedData?.Tutorials?.[0];
    const clearedUser = p150.CommonResponse?.UpdatedData?.User;
    check('Tutorial:Progress step 150 echoes the tutorial', Number(tut150?.Step) === 150, tut150);
    checkResponseUserName('Tutorial:Progress step 150', p150);
    check('step 150 sets TutorialClearedTime', Number(clearedUser?.TutorialClearedTime) > 0, clearedUser?.TutorialClearedTime);
    check('step 150 sets ManagerLevel 2', Number(clearedUser?.ManagerLevel) === 2, clearedUser?.ManagerLevel);
    check('step 150 sets ManagerExp 50', Number(clearedUser?.ManagerExp) === 50, clearedUser?.ManagerExp);
    check(
      'step 150 sets NextPhotoImageIds',
      (clearedUser?.NextPhotoImageIds?.length ?? 0) === 20,
      clearedUser?.NextPhotoImageIds?.length,
    );

    const finalGet = await call('User:Get', {}, token);
    const persisted150 = (finalGet.Tutorials ?? []).find(
      (t: any) => Number(t.TutorialType) === 1 && Number(t.Step) === 150,
    );
    check('User:Get shows the persisted Tutorials step 150', !!persisted150, finalGet.Tutorials);
    check('User:Get shows the persisted TutorialClearedTime', Number(finalGet.User?.TutorialClearedTime) > 0);
    check('User:Get keeps the chosen name after step 150', finalGet.User?.Name === TEST_NAME, finalGet.User?.Name);
    check('User:Get shows ManagerLevel 2 after step 150', Number(finalGet.User?.ManagerLevel) === 2);

    const postClearLogin = await call('Home:Login', {}, token);
    check(
      'Home:Login after step 150 does not roll ManagerLevel back',
      Number(postClearLogin.CommonResponse?.UpdatedData?.User?.ManagerLevel) === 2,
      postClearLogin.CommonResponse?.UpdatedData?.User?.ManagerLevel,
    );

    const home = await call('Home:Enter', { SkipUpdate: false }, token);
    check('fresh Home:Enter returns a body', !!home.LessonProgress, home);
    // Once the tutorial is cleared the server-gated Love menu must be visible.
    check(
      'fresh Home:Enter after the tutorial injects an unlocked LoveInfo',
      Number(home.LoveInfo?.IsViewable) === 1 && Number(home.LoveInfo?.IsUnlocked) === 1,
      home.LoveInfo,
    );
    const gachaIds = ((home.GachaInfos ?? []) as { GachaId?: string }[]).map((g) => String(g.GachaId));
    check(
      'fresh Home:Enter keeps the corpus GachaInfos (no ids missing from our master)',
      !gachaIds.includes('gacha-premium-26-1024'),
      gachaIds,
    );

    // --- starter gifts keep the columns and the served Balance in step -----
    const giftList = await call('Gift:List', {}, token);
    const gifts = (giftList.Gifts ?? []) as {
      GiftId?: string;
      ResourceType?: number;
      Amount?: number;
    }[];
    const stoneGift = gifts.find((g) => Number(g.ResourceType) === 15);
    check('fresh Gift:List posts the 3000-stone starter gift', !!stoneGift, gifts.length);
    const giftIds = gifts.map((g) => String(g.GiftId));
    check('fresh Gift:List posts gift ids', giftIds.every((id) => id.length > 0), giftIds.length);

    const giftRecv = await call('Gift:Receive', { GiftIds: giftIds }, token);
    const stoneResult = ((giftRecv.Results ?? []) as { ResourceType?: number; AmountI64?: number }[]).find(
      (r) => Number(r.ResourceType) === 15,
    );
    check(
      'Gift:Receive grants the 3000-stone starter gift',
      Number(stoneResult?.AmountI64 ?? 0) === 3000,
      stoneResult,
    );
    const giftCols = await playerBalanceColumns(pl!.id);
    check('Gift:Receive moves the stones into the players column', giftCols.FreeBalance === 3000, giftCols);
    await checkBalanceSynced('Gift:Receive', pl!.id, giftRecv);

    // --- Gift:ListHistory serves what Gift:Receive consumed ----------------
    type HistoryRow = {
      GiftId?: string;
      ResourceType?: number;
      ResourceId?: string;
      Amount?: number;
      PostedTime?: number;
      ReceivedTime?: number;
    };
    const giftHistory = await call('Gift:ListHistory', {}, token);
    const history = (giftHistory.Gifts ?? []) as HistoryRow[];
    check(
      'Gift:ListHistory returns one entry per received gift',
      history.length === giftIds.length,
      { history: history.length, received: giftIds.length },
    );
    const historyById = new Map(history.map((h) => [String(h.GiftId), h]));
    check(
      'Gift:ListHistory keeps every received GiftId',
      giftIds.every((id) => historyById.has(id)),
      giftIds.filter((id) => !historyById.has(id)),
    );
    check(
      'Gift:ListHistory matches ResourceType and Amount',
      gifts.every((g) => {
        const h = historyById.get(String(g.GiftId));
        return (
          !!h &&
          Number(h.ResourceType) === Number(g.ResourceType) &&
          Number(h.Amount) === Number(g.Amount)
        );
      }),
      history.map((h) => [h.ResourceType, h.Amount]),
    );
    check(
      'Gift:ListHistory stamps ReceivedTime',
      history.length > 0 && history.every((h) => Number(h.ReceivedTime ?? 0) > 0),
      history.map((h) => h.ReceivedTime),
    );

    // --- a gift posted with postGifts is granted and lands in the history ---
    const postedGiftId = randomUUID();
    const postedAmount = 7;
    await withPlayerTx(pl!.id, (tx) =>
      postGifts(tx, pl!.id, [
        {
          __msg: 'Solis.Common.Proto.Transaction.UserGift',
          GiftId: postedGiftId,
          ResourceType: 15,
          Amount: postedAmount,
          Message: 'history test',
          PostedTime: Date.now(),
        },
      ]),
    );
    const postedList = await call('Gift:List', {}, token);
    check(
      'postGifts appends the gift to Gift:List',
      ((postedList.Gifts ?? []) as { GiftId?: string }[]).some(
        (g) => String(g.GiftId) === postedGiftId,
      ),
      postedList.Gifts?.length,
    );
    const postedRecv = await call('Gift:Receive', { GiftIds: [postedGiftId] }, token);
    check(
      'Gift:Receive grants the gift posted with postGifts',
      ((postedRecv.ReceivedGiftIds ?? []) as string[]).map(String).includes(postedGiftId),
      postedRecv.ReceivedGiftIds,
    );
    const postedHistory = await call('Gift:ListHistory', {}, token);
    const postedRows = (postedHistory.Gifts ?? []) as HistoryRow[];
    const postedRow = postedRows.find((h) => String(h.GiftId) === postedGiftId);
    check(
      'Gift:ListHistory records a gift posted with postGifts',
      !!postedRow &&
        Number(postedRow.ResourceType) === 15 &&
        Number(postedRow.Amount) === postedAmount,
      postedRow,
    );
    check(
      'Gift:ListHistory serves newest first',
      String(postedRows[0]?.GiftId) === postedGiftId,
      postedRows[0]?.GiftId,
    );

    // --- real spends must announce the post-spend Balance -----------------
    // The free-stone draw costs 300 stones (master Consumption ResourceType
    // 15). Spending moves the `players` columns, and the response must carry
    // the new `CommonResponse.UpdatedData.Balance` so the client cannot keep
    // showing (and overspend) the pre-draw amount. The stored entity must
    // track the columns too.
    const freeDrawButton = 'btn-01-gacha-birthday-24-0505';
    const freeDrawBefore = await playerBalanceColumns(pl!.id);
    const freeDraw = await call('Gacha:Draw', { GachaButtonId: freeDrawButton, ExecCount: 1 }, token);
    const stoneSpend = ((freeDraw.ConsumptionResults ?? []) as { ResourceType?: number; Amount?: number }[]).find(
      (r) => Number(r.ResourceType) === 15,
    );
    check(
      'Gacha:Draw free button consumes ResourceType 15 amount 300',
      Number(stoneSpend?.Amount) === 300,
      stoneSpend,
    );
    const freeDrawAfter = await playerBalanceColumns(pl!.id);
    check(
      'Gacha:Draw free button decreases the free_jewel column by 300',
      freeDrawAfter.FreeBalance === freeDrawBefore.FreeBalance - 300,
      { before: freeDrawBefore, after: freeDrawAfter },
    );
    check(
      'Gacha:Draw serves UpdatedData.Balance',
      !!freeDraw.CommonResponse?.UpdatedData?.Balance,
      freeDraw.CommonResponse?.UpdatedData,
    );
    await checkBalanceSynced('Gacha:Draw free button', pl!.id, freeDraw);

    // The daily button is paid-stone only (ResourceType 16). A fresh account
    // has paid_jewel = 0, so the draw must fail and roll back both columns.
    const paidDrawButton = 'btn-01-gacha-birthday-24-0505-daily';
    const paidDrawBefore = await playerBalanceColumns(pl!.id);
    check('fresh account starts the paid-only draw with 0 paid stones', paidDrawBefore.PaidBalance === 0, paidDrawBefore);
    let paidDrawError: Error | null = null;
    try {
      await call('Gacha:Draw', { GachaButtonId: paidDrawButton, ExecCount: 1 }, token);
    } catch (e) {
      paidDrawError = e as Error;
    }
    check('Gacha:Draw paid-only button fails without paid stones', !!paidDrawError, paidDrawError?.message);
    const paidDrawAfter = await playerBalanceColumns(pl!.id);
    check(
      'Gacha:Draw paid-only failure changes no balance column',
      paidDrawAfter.FreeBalance === paidDrawBefore.FreeBalance &&
        paidDrawAfter.PaidBalance === paidDrawBefore.PaidBalance,
      { before: paidDrawBefore, after: paidDrawAfter },
    );

    // --- corpus account stays byte-for-byte unchanged ---------------------
    await seedCorpusPlayer();
    const corpusToken = mintToken({ sub: CORPUS_ACCOUNT_ID, seedId: CORPUS_PUBLIC_ID });
    const corpusUserGet = await rpc('User:Get', {}, corpusToken);
    check('corpus User:Get bytes unchanged', sha256(corpusUserGet) === CORPUS_USER_GET_SHA, sha256(corpusUserGet));
    const corpusHome = await rpc('Home:Enter', {}, corpusToken);
    check('corpus Home:Enter bytes unchanged', sha256(corpusHome) === CORPUS_HOME_ENTER_SHA, sha256(corpusHome));
  } finally {
    for (const createdUid of createdUids) {
      try {
        await deleteAccountByUid(createdUid);
      } catch (e) {
        console.error(`cleanup failed for ${createdUid}: ${(e as Error).message}`);
      }
    }
    try {
      await deletePlayerRows(CORPUS_PLAYER_ID);
      await db.delete(players).where(eq(players.id, CORPUS_PLAYER_ID));
      await db.delete(accounts).where(eq(accounts.id, CORPUS_ACCOUNT_ID));
    } catch (e) {
      console.error(`corpus cleanup failed: ${(e as Error).message}`);
    }
  }
}

try {
  await client.end({ timeout: 5 });
} catch {
  // The DB may never have been contacted (skipped handler tests).
}

console.log(`\nfresh account test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
