import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

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
  await db.delete(playerEntities).where(eq(playerEntities.playerId, CORPUS_PLAYER_ID));
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

async function deleteAccountByUid(uid: string): Promise<void> {
  const [acct] = await db.select().from(accounts).where(eq(accounts.firebaseUid, uid)).limit(1);
  if (!acct) return;
  const rows = await db.select().from(players).where(eq(players.accountId, acct.id));
  for (const row of rows) await db.delete(playerEntities).where(eq(playerEntities.playerId, row.id));
  await db.delete(players).where(eq(players.accountId, acct.id));
  await db.delete(accounts).where(eq(accounts.id, acct.id));
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

    // --- Tutorial:Init persists the chosen name ----------------------------
    const init = await call('Tutorial:Init', { Name: 'Numbers' }, token);
    check(
      'Tutorial:Init echoes UpdatedData.User with the new name',
      init.CommonResponse?.UpdatedData?.User?.Name === 'Numbers',
      init,
    );
    const afterInit = await call('User:Get', {}, token);
    check('Tutorial:Init persists User.Name', afterInit.User?.Name === 'Numbers', afterInit.User?.Name);
    check(
      'Tutorial:Init leaves User:Get without Tutorials',
      !afterInit.Tutorials || afterInit.Tutorials.length === 0,
    );

    const homeLogin = await call('Home:Login', {}, token);
    check(
      'Home:Login keeps the chosen name',
      homeLogin.CommonResponse?.UpdatedData?.User?.Name === 'Numbers',
      homeLogin.CommonResponse?.UpdatedData?.User?.Name,
    );
    check(
      'Home:Login keeps ManagerLevel 1',
      Number(homeLogin.CommonResponse?.UpdatedData?.User?.ManagerLevel) === 1,
      homeLogin.CommonResponse?.UpdatedData?.User?.ManagerLevel,
    );

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

    // --- Tutorial:ReceiveLessonReward applies its UpdatedData -------------
    const reward = await call('Tutorial:ReceiveLessonReward', {}, token);
    check('Tutorial:ReceiveLessonReward returns the 3 captured rewards', (reward.Rewards?.length ?? 0) === 3, reward.Rewards);
    const afterReward = await call('User:Get', {}, token);
    const enhance = (afterReward.Items ?? []).find((i: any) => i.ItemId === 'item-card_enhance');
    check('ReceiveLessonReward persists Items (card_enhance 1100)', Number(enhance?.Amount) === 1100, enhance);
    const goldPoint = (afterReward.Points ?? []).find((p: any) => p.PointType === 1);
    check('ReceiveLessonReward persists Points (gold 1000)', Number(goldPoint?.Amount) === 1000, goldPoint);
    const step110 = (afterReward.Tutorials ?? []).find((t: any) => Number(t.TutorialType) === 1);
    check('ReceiveLessonReward persists Tutorials step 110', Number(step110?.Step) === 110, step110);

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
    check('User:Get keeps the chosen name after step 150', finalGet.User?.Name === 'Numbers', finalGet.User?.Name);
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
      await db.delete(playerEntities).where(eq(playerEntities.playerId, CORPUS_PLAYER_ID));
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
