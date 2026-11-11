import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { and, eq, inArray, or } from 'drizzle-orm';
import { buildServer } from './server.ts';
import { encrypt, decrypt } from './gateway/crypto.ts';
import { DATA_DIR } from './config.ts';
import { decodeMessage, encodeMessage, msgRegistry, Reader, Writer } from '@sumire-sr/protocol/runtime/proto.ts';
import { endpoints } from '@sumire-sr/protocol/gen/endpoints.ts';
import '@sumire-sr/protocol/gen/registry.ts';
import { verifyToken } from './auth/jwt.ts';
import { db } from './db/client.ts';
import { accounts, players, playerEntities, playerExcursionState, playerBirthdayState, rewardClaims, playerLedger, playerPurchases, playerLoveProgress, playerLessonProgress, playerGachaState, gachaHistory, idolRoster, ownedCards, deckConfigurations, liveStageProgress, playerBoxGacha, playerMarathonPoint, photoImageMetadata, playerFriendLinks } from './db/schema.ts';
import { masterCondition, masterItem, masterPhotoQuestMusic, masterPhotoQuestStage, masterQuest } from './db/masterSchema.ts';
import { parseFirebaseUid } from './services/auth.ts';
import { applyRewardRefs } from './master/reward.ts';
import { mintIdToken } from './auth/firebaseTokens.ts';
import { photoImagePath } from './firebaseStorage.ts';
import { config as serverConfig } from './config.ts';
import { getSingleton, listElements, putElements, putSingleton } from './services/playerState.ts';
import { insertPending } from './services/friendLinks.ts';
import { getItemAmount, grantItem as grantPromotionItem } from './services/inventory.ts';
import { getActivityPerformance, getCostume, getHair, getHierarchyDetailGrade } from './master/index.ts';
import { requireData } from './testing/requireData.ts';
import { loadPinnedIdentity } from './services/identity.ts';
import { FRESH_SEED } from './services/playerState.ts';
import {
  configureDedicatedAbilities,
  DEDICATED_PHOTO_MISSION_ID,
  decidePhotoKind,
  dedicatedSets,
  genericSets,
  loadPhotoGenerationMaster,
  photoQualityBase,
  photoRarityMinimum,
  qualityForFilmLevel,
  rollFilmPhotoTraits,
  rollPhotoAbilities,
  photoAbilityEffectValue,
  ensureDedicatedPhotoMission,
  unlockManagerLevelPhotoAbilities,
  rollPhotoRarity,
} from './services/photoGen.ts';
import { STARTER_GIFTS } from './services/starterGifts.ts';
import { isSandbox } from './profile.ts';

await requireData({ captures: true, requestCaptures: true, db: true });

// The account the captures were recorded with: the real one privately, the
// placeholder in the published data.
const CAPTURED_UID = loadPinnedIdentity()?.firebaseUid;
const CAP = join(DATA_DIR, 'captures', '2026-09-14_a12r', 'raw');

// Dedicated test account. The suite must NEVER act as the real device account,
// otherwise its deterministic wipe + gacha draws consume the player's one-time
// buttons and replay feature tutorials. The test account is seeded with the same
// corpus stats (Lv40) so the M1 assertions stay meaningful.
const TEST_ACCOUNT_ID = 'dbtest-account-0000-4000-8000-000000000001';
const TEST_UID = 'dbtest-firebase-uid-0001';
const SERVER_USER_ID = 'dbtest-user-0000-4000-8000-000000000001';
const TEST_PUBLIC_USER_ID = 'DBTEST01';
const TEST_SEED = { name: 'Player', level: 40, exp: 1335246, gold: 1707717, freeJewel: 10670 };

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  cond ? pass++ : fail++;
}

const app = buildServer();
await app.listen({ port: 18098, host: '127.0.0.1' });
await import('./services/all.ts');

// Deterministic start: wipe ONLY the dedicated test account, then recreate it so
// its entity store is (re)seeded from the corpus template. The device account is
// left completely untouched.
await db
  .delete(playerFriendLinks)
  .where(or(eq(playerFriendLinks.fromPlayerId, SERVER_USER_ID), eq(playerFriendLinks.toPlayerId, SERVER_USER_ID)));
await db.delete(playerEntities).where(eq(playerEntities.playerId, SERVER_USER_ID));
await db.delete(playerExcursionState).where(eq(playerExcursionState.playerId, SERVER_USER_ID));
await db.delete(playerBirthdayState).where(eq(playerBirthdayState.playerId, SERVER_USER_ID));
await db.delete(rewardClaims).where(eq(rewardClaims.playerId, SERVER_USER_ID));
await db.delete(playerLedger).where(eq(playerLedger.playerId, SERVER_USER_ID));
await db.delete(playerPurchases).where(eq(playerPurchases.playerId, SERVER_USER_ID));
await db.delete(playerLoveProgress).where(eq(playerLoveProgress.playerId, SERVER_USER_ID));
await db.delete(playerLessonProgress).where(eq(playerLessonProgress.playerId, SERVER_USER_ID));
await db.delete(playerGachaState).where(eq(playerGachaState.playerId, SERVER_USER_ID));
await db.delete(gachaHistory).where(eq(gachaHistory.playerId, SERVER_USER_ID));
await db.delete(idolRoster).where(eq(idolRoster.playerId, SERVER_USER_ID));
await db.delete(ownedCards).where(eq(ownedCards.playerId, SERVER_USER_ID));
await db.delete(deckConfigurations).where(eq(deckConfigurations.playerId, SERVER_USER_ID));
await db.delete(liveStageProgress).where(eq(liveStageProgress.playerId, SERVER_USER_ID));
await db.delete(playerBoxGacha).where(eq(playerBoxGacha.playerId, SERVER_USER_ID));
await db.delete(playerMarathonPoint).where(eq(playerMarathonPoint.playerId, SERVER_USER_ID));
await db.delete(photoImageMetadata).where(eq(photoImageMetadata.playerId, SERVER_USER_ID));
rmSync(join(serverConfig.resourceDir, 'Photo', TEST_PUBLIC_USER_ID), { recursive: true, force: true });
await db.delete(players).where(eq(players.id, SERVER_USER_ID));
await db.delete(accounts).where(eq(accounts.firebaseUid, TEST_UID));
await db.insert(accounts).values({
  id: TEST_ACCOUNT_ID,
  firebaseUid: TEST_UID,
  seedId: TEST_PUBLIC_USER_ID,
  displayName: TEST_SEED.name,
  lastLoginAt: new Date(),
});
await db.insert(players).values({
  id: SERVER_USER_ID,
  accountId: TEST_ACCOUNT_ID,
  name: TEST_SEED.name,
  level: TEST_SEED.level,
  exp: TEST_SEED.exp,
  gold: TEST_SEED.gold,
  freeJewel: TEST_SEED.freeJewel,
  data: { publicUserId: TEST_PUBLIC_USER_ID },
});

const reqBytes = readFileSync(join(CAP, '00002.req-plain.Auth:Login.bin'));
const loginReqShape = msgRegistry.get(endpoints['Auth']['Login'].request)!;
const capReq = decodeMessage(loginReqShape, new Reader(Uint8Array.from(reqBytes))) as any;
const capUid = parseFirebaseUid(capReq.FirebaseIDToken);
check('captured request carries seeded firebase uid', capUid === CAPTURED_UID);

// Re-target the captured login at the dedicated test account. parseFirebaseUid
// does not verify the signature, so a synthesised payload is sufficient.
const testPayload = Buffer.from(JSON.stringify({ user_id: TEST_UID })).toString('base64url');
capReq.FirebaseIDToken = `test.${testPayload}.sig`;
const w = new Writer();
encodeMessage(loginReqShape, capReq, w);
const testReqBytes = Buffer.from(w.toBytes());

async function login() {
  const resp = await fetch('http://127.0.0.1:18098/api.Auth/Login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf', 'x-auth-token': 't' },
    body: encrypt(testReqBytes, Buffer.from('0000000000000000')),
  });
  check('Auth:Login status 200', resp.status === 200);
  const body = decrypt(Buffer.from(await resp.arrayBuffer()));
  const shape = msgRegistry.get(endpoints['Auth']['Login'].response)!;
  return decodeMessage(shape, new Reader(Uint8Array.from(body))) as any;
}

const r1 = await login();
check('GameAuthToken is our RS256 JWT', typeof r1.GameAuthToken === 'string' && verifyToken(r1.GameAuthToken).ok === true);
check('UserPublic.ServerUserId preserved', r1.UserPublic?.ServerUserId === SERVER_USER_ID);
check('UserPublic.PublicUserId preserved', r1.UserPublic?.PublicUserId === TEST_PUBLIC_USER_ID);

const r2 = await login();
check('re-login yields same server user', r2.UserPublic?.ServerUserId === r1.UserPublic?.ServerUserId);
check('re-login yields same public user', r2.UserPublic?.PublicUserId === r1.UserPublic?.PublicUserId);

const accts = await db.select().from(accounts).where(eq(accounts.firebaseUid, TEST_UID));
check('exactly one account row for the test uid', accts.length === 1);
if (accts[0]) {
  const pls = await db.select().from(players).where(eq(players.accountId, accts[0].id));
  check('exactly one player row for account', pls.length === 1);
  check('player id == server user id', pls[0]?.id === SERVER_USER_ID);
}

const { dispatchRpc } = await import('./services/router.ts');
const userGet = async () => {
  const bytes = await dispatchRpc('User:Get', Buffer.alloc(0), {
    headers: { 'x-auth-token': r1.GameAuthToken },
    log: { info() {} },
  } as any);
  return decodeMessage(
    msgRegistry.get(endpoints['User']['Get'].response)!,
    new Reader(Uint8Array.from(bytes)),
  ) as any;
};

const u = await userGet();
check('User:Get UserPublic.ServerUserId from DB', u.UserPublic?.ServerUserId === SERVER_USER_ID);
check('User:Get UserPublic.PublicUserId from DB', u.UserPublic?.PublicUserId === TEST_PUBLIC_USER_ID);
check('User:Get User.Name from DB', u.User?.Name === 'Player');
check('User:Get User.ManagerLevel from DB', u.User?.ManagerLevel === 40);
check('User:Get Items intact', u.Items?.length === 29);
check('User:Get Cards intact', u.Cards?.length === 19);
check('User:Get Decks intact', u.Decks?.length === 5);
check('User:Get DeckPositions intact', u.DeckPositions?.length === 25);
check('User:Get card element schema kept', u.Cards?.[0]?.__msg === 'Solis.Common.Proto.Transaction.UserCard');

const ents = await db.select().from(playerEntities).where(eq(playerEntities.playerId, SERVER_USER_ID));
const kinds = new Set(ents.map((e) => e.kind));
check('player_entities seeded full surface (>=150 rows)', ents.length >= 150);
check('player_entities kinds span collections + singletons (>=35)', kinds.size >= 35);
check('player_entities cover core kinds',
  ['Items', 'Cards', 'Decks', 'DeckPositions', 'Characters', 'Costumes', 'Accessories', 'Photos', 'Stories', 'Profile', 'TotalCount']
    .every((k) => kinds.has(k)));

const u2 = await userGet();
check('User:Get Cards served from DB (stable length)', u2.Cards?.length === 19);
check('User:Get Cards served from DB (stable first id)', u2.Cards?.[0]?.CardId === u.Cards?.[0]?.CardId);
check('User:Get Items served from DB (stable length)', u2.Items?.length === 29);
check('User:Get Decks served from DB (stable length)', u2.Decks?.length === 5);
check('User:Get DeckPositions served from DB (stable length)', u2.DeckPositions?.length === 25);
check('User:Get Characters served from DB', u2.Characters?.length === 17);
check('User:Get Costumes served from DB', u2.Costumes?.length === 53);
check('User:Get Accessories served from DB', u2.Accessories?.length === 30);

// --- durable 交流/CompanyEnjoy unlock: prerequisite area force-cleared on every fetch ---
check('User:Get force-clears area-main-013', (u.Areas ?? []).some((a: any) => String(a.AreaId) === 'area-main-013'));
check('User:Get area-main-013 carries a high ClearQuestCount',
  (u.Areas ?? []).some((a: any) => String(a.AreaId) === 'area-main-013' && Number(a.ClearQuestCount) >= 9999));
const areaEnts = await db
  .select()
  .from(playerEntities)
  .where(and(eq(playerEntities.playerId, SERVER_USER_ID), eq(playerEntities.kind, 'Areas')));
check('area-main-013 persisted in player_entities', areaEnts.some((e) => e.entityKey === 'area-main-013'));
await db.delete(playerEntities).where(and(eq(playerEntities.playerId, SERVER_USER_ID), eq(playerEntities.kind, 'Areas')));
const u3 = await userGet();
check('area-main-013 re-added after wipe (durable)', (u3.Areas ?? []).some((a: any) => String(a.AreaId) === 'area-main-013'));

// --- durable 交流/CompanyEnjoy bond progress: CompanyEnjoyPoint forced high ---
check('User:Get Characters carry a high CompanyEnjoyPoint',
  (u.Characters ?? []).length > 0 && (u.Characters ?? []).every((c: any) => Number(c.CompanyEnjoyPoint ?? 0) >= 999999));
check('User:Get Company.EnjoyPoint is high', Number(u.Company?.EnjoyPoint ?? 0) >= 999999);
await db.delete(playerEntities).where(and(eq(playerEntities.playerId, SERVER_USER_ID), eq(playerEntities.kind, 'Characters')));
const ub = await userGet();
check('CompanyEnjoyPoint re-added after Characters wipe (durable)',
  (ub.Characters ?? []).every((c: any) => Number(c.CompanyEnjoyPoint ?? 0) >= 999999));

// --- request encoder ---
const encodeReq = (shape: any, obj: any) => {
  const w = new Writer();
  encodeMessage(shape, obj, w);
  return Buffer.from(w.toBytes());
};

// --- Story:Read is server-authoritative: grants reward once + records read status ---
const storyReqShape = msgRegistry.get(endpoints['Story']['Read'].request)!;
const storyRespShape = msgRegistry.get(endpoints['Story']['Read'].response)!;
const readStory = async (storyId: string) => {
  const bytes = await dispatchRpc(
    'Story:Read',
    encodeReq(storyReqShape, { StoryId: storyId }),
    { headers: { 'x-auth-token': r1.GameAuthToken }, log: { info() {}, warn() {} } } as any,
  );
  return decodeMessage(storyRespShape, new Reader(Uint8Array.from(bytes))) as any;
};

const STORY_ID = 'st-original-cmn-01-01-01';
const storyBalanceBefore = Number((await userGet()).Balance?.FreeBalance ?? 0);
const readResp = await readStory(STORY_ID);
const readUd = readResp.CommonResponse?.UpdatedData;
check(
  'Story:Read marks story read (StatusType=2)',
  readUd?.Stories?.[0]?.StoryId === STORY_ID && Number(readUd?.Stories?.[0]?.StatusType) === 2,
);
check(
  'Story:Read grants master reward (freeJewel +30)',
  Number(readResp.Rewards?.[0]?.ResourceType) === 15 && Number(readResp.Rewards?.[0]?.AmountI64) === 30,
);
check(
  'Story:Read updates balance (+30)',
  Number(readUd?.Balance?.FreeBalance ?? 0) === storyBalanceBefore + 30,
);

const readResp2 = await readStory(STORY_ID);
check('Story:Read is idempotent (no second reward)', (readResp2.Rewards?.length ?? 0) === 0);
check(
  'Story:Read idempotent re-reports read status',
  Number(readResp2.CommonResponse?.UpdatedData?.Stories?.[0]?.StatusType) === 2,
);
check(
  'Story:Read idempotent leaves balance stable',
  Number((await userGet()).Balance?.FreeBalance ?? 0) === storyBalanceBefore + 30,
);

let storyRejected = false;
try {
  await readStory('st-does-not-exist');
} catch {
  storyRejected = true;
}
check('Story:Read rejects unknown StoryId', storyRejected);

const storyEnts = await db
  .select()
  .from(playerEntities)
  .where(
    and(eq(playerEntities.playerId, SERVER_USER_ID), eq(playerEntities.kind, 'Stories')),
  );
check('Story:Read persisted to player_entities (Stories)', storyEnts.length >= 1);

// --- Deck:Save is server-authoritative (custom deck, not the corpus capture) ---
const deckReqShape = msgRegistry.get(endpoints['Deck']['Save'].request)!;
const deckRespShape = msgRegistry.get(endpoints['Deck']['Save'].response)!;
const saveDeck = async (number: number, name: string, positions: any[]) => {
  const bytes = await dispatchRpc(
    'Deck:Save',
    encodeReq(deckReqShape, { Number: number, Name: name, DeckEditType: 1, UserDeckPositions: positions }),
    { headers: { 'x-auth-token': r1.GameAuthToken }, log: { info() {}, warn() {} } } as any,
  );
  return decodeMessage(deckRespShape, new Reader(Uint8Array.from(bytes))) as any;
};

const deckResp = await saveDeck(7, 'TESTDECK', [
  { Position: 1, CardId: 'card-ngs-03-schl-00' },
  { Position: 2, CardId: 'card-rio-05-idol-00' },
]);
check(
  'Deck:Save echoes submitted deck name (not the capture)',
  deckResp.CommonResponse?.UpdatedData?.Decks?.[0]?.Name === 'TESTDECK',
);
check('Deck:Save echoes submitted deck Number', deckResp.CommonResponse?.UpdatedData?.Decks?.[0]?.Number === 7);

const afterDeck = await userGet();
check('Deck:Save persisted deck #7', afterDeck.Decks?.find((d: any) => d.Number === 7)?.Name === 'TESTDECK');
check(
  'Deck:Save persisted 2 positions for deck #7',
  afterDeck.DeckPositions?.filter((p: any) => p.Number === 7).length === 2,
);
check(
  'Deck:Save persisted position CardId',
  afterDeck.DeckPositions?.find((p: any) => p.Number === 7 && p.Position === 2)?.CardId === 'card-rio-05-idol-00',
);
check(
  'Deck:Save left pre-existing decks intact',
  (u.Decks ?? []).every((d: any) => afterDeck.Decks?.some((n: any) => n.Number === d.Number)),
);

await saveDeck(7, 'TESTDECK', [{ Position: 1, CardId: 'card-ngs-03-schl-00' }]);
const afterDeck2 = await userGet();
check(
  'Deck:Save removes positions dropped from the request',
  afterDeck2.DeckPositions?.filter((p: any) => p.Number === 7).length === 1,
);

// --- Deck:Save with Number 0 creates a new deck with the next free number ---
const highestDeck = Math.max(0, ...(afterDeck2.Decks ?? []).map((d: any) => Number(d.Number ?? 0)));
const newDeckResp = await saveDeck(0, 'NEWDECK', [{ Position: 1, CardId: 'card-ngs-03-schl-00' }]);
const newDeckNumber = newDeckResp.CommonResponse?.UpdatedData?.Decks?.[0]?.Number;
check('Deck:Save Number 0 assigns the next free deck number', newDeckNumber === highestDeck + 1);
check(
  'Deck:Save Number 0 echoes positions under the assigned number',
  newDeckResp.CommonResponse?.UpdatedData?.DeckPositions?.[0]?.Number === highestDeck + 1,
);
check('Deck:Save Number 0 stores no deck numbered 0', !(await userGet()).Decks?.some((d: any) => !d.Number));
check(
  'Deck:Save Number 0 returns User with the advanced DeckSequence',
  Number(newDeckResp.CommonResponse?.UpdatedData?.User?.DeckSequence ?? 0) === newDeckNumber,
);
// The sequence is never reused: delete the new deck, create another, and the
// number keeps counting up.
await dispatchRpc(
  'Deck:Delete',
  encodeReq(msgRegistry.get(endpoints['Deck']['Delete'].request)!, { Number: newDeckNumber }),
  { headers: { 'x-auth-token': r1.GameAuthToken }, log: { info() {}, warn() {} } } as any,
);
const nextDeckResp = await saveDeck(0, '', [{ Position: 1, CardId: 'card-ngs-03-schl-00' }]);
check(
  'Deck:Save Number 0 does not reuse a deleted deck number',
  nextDeckResp.CommonResponse?.UpdatedData?.Decks?.[0]?.Number === newDeckNumber + 1,
);
check(
  'Deck:Save Number 0 with an empty name gets the default name',
  nextDeckResp.CommonResponse?.UpdatedData?.Decks?.[0]?.Name === `ユニット${newDeckNumber + 1}`,
);
check('Deck:Save Number 0 persisted DeckSequence', Number((await userGet()).User?.DeckSequence ?? 0) === newDeckNumber + 1);

// --- Deck:Delete removes the deck and its positions ---
const deckDelReqShape = msgRegistry.get(endpoints['Deck']['Delete'].request)!;
const deckDelRespShape = msgRegistry.get(endpoints['Deck']['Delete'].response)!;
const deleteDeckRpc = async (number: number) => {
  const bytes = await dispatchRpc(
    'Deck:Delete',
    encodeReq(deckDelReqShape, { Number: number }),
    { headers: { 'x-auth-token': r1.GameAuthToken }, log: { info() {}, warn() {} } } as any,
  );
  return decodeMessage(deckDelRespShape, new Reader(Uint8Array.from(bytes))) as any;
};

const deckDelResp = await deleteDeckRpc(7);
const afterDeckDel = await userGet();
check(
  'Deck:Delete reports the deck in DeletedData',
  deckDelResp.CommonResponse?.DeletedData?.Decks?.[0]?.Number === 7,
);
check(
  'Deck:Delete reports the removed position in DeletedData',
  deckDelResp.CommonResponse?.DeletedData?.DeckPositions?.length === 1 &&
    deckDelResp.CommonResponse?.DeletedData?.DeckPositions?.[0]?.Number === 7 &&
    deckDelResp.CommonResponse?.DeletedData?.DeckPositions?.[0]?.Position === 1,
);
check('Deck:Delete response carries UpdatedData', deckDelResp.CommonResponse?.UpdatedData != null);
check('Deck:Delete removed deck #7', !afterDeckDel.Decks?.some((d: any) => d.Number === 7));
check('Deck:Delete removed the positions of deck #7', !afterDeckDel.DeckPositions?.some((p: any) => p.Number === 7));
check(
  'Deck:Delete left other decks intact',
  (u.Decks ?? []).every((d: any) => afterDeckDel.Decks?.some((n: any) => n.Number === d.Number)),
);
let deckDelRejected = false;
try {
  await deleteDeckRpc(0);
} catch {
  deckDelRejected = true;
}
check('Deck:Delete rejects a non-positive number', deckDelRejected);

// --- master data loaded into Postgres ---
const {
  getManifestVersion,
  getMission,
  listMissions,
  getLoginBonus,
  getStory,
  getStoryPart,
  getStoryEpisodeConsumption,
  getEventStory,
  getExtraStory,
  getExtraStoryPart,
  getCardEvolution,
  getCardEvolutionLevel,
  getCardEvolutionLevelRelease,
  listCardEvolutionMessages,
  getLoveLevel,
  listLoveLevels,
  getLoveStoryEpisode,
  listLoveStoryEpisodes,
  getLoveColor,
  listLoveHomeActions,
  listLoveIds,
} = await import('./master/index.ts');
const mver = await getManifestVersion();
check('server_meta.master_version set', mver === 'c78feb8cecf685f74930bab9ebff8c0681b397b3933b0320e5ae6d1a75abd4f1');

const MISSION_ID = 'event-backside-21-0831-backside_area_clear_count-1';
const LOGIN_BONUS_ID = 'login_bonus-normal-01';
check('master mission present', (await getMission(MISSION_ID))?.Id === MISSION_ID);
check('master login bonus present', (await getLoginBonus(LOGIN_BONUS_ID))?.Id === LOGIN_BONUS_ID);

// --- Story master data seeded ---
check('master Story present', (await getStory(STORY_ID))?.Id === STORY_ID);
check('master StoryPart present', (await getStoryPart('st-part-group-01'))?.Id === 'st-part-group-01');
check(
  'master StoryEpisodeConsumption present',
  (await getStoryEpisodeConsumption('story-consumption-group-01', 1))?.RequiredStoryPoint === 5,
);
check('master EventStory present', (await getEventStory('st-eve-2107-tour'))?.Id === 'st-eve-2107-tour');
check(
  'master ExtraStory present',
  (await getExtraStory('ex-story-part-special-01-26-0401-april'))?.ExtraStoryPartId === 'ex-story-part-special-01',
);
check('master ExtraStoryPart present', (await getExtraStoryPart('ex-st-part-limited-01'))?.Id === 'ex-st-part-limited-01');

// --- Slice 15: card evolution (bond) master data seeded ---
const CE_CARD_ID = 'card-hrk-05-link-00';
check('master CardEvolution present', (await getCardEvolution(CE_CARD_ID, 1))?.RewardCostumeId === 'cos-mna-link-01');
check(
  'master CardEvolutionLevel present',
  Number((await getCardEvolutionLevel('card_evolution_level_bond', 1))?.Exp) === 100,
);
check(
  'master CardEvolutionLevelRelease present',
  ((await getCardEvolutionLevelRelease('card_evolution_level_release_bond', 1))?.Targets as any[])?.length === 1,
);
check('master CardEvolutionMessage present', (await listCardEvolutionMessages(CE_CARD_ID, 0)).length >= 1);

// --- Slice 16: love / idol bond master data seeded ---
check('master LoveLevel present', (await getLoveLevel('love-23-0514', 1))?.LoveId === 'love-23-0514');
check('master LoveLevels count', (await listLoveLevels('love-23-0514')).length === 10);
check(
  'master LoveStoryEpisode present',
  (await getLoveStoryEpisode('love-event-story-25-0426-001'))?.StoryId === 'st-love-25-0426-001',
);
check('master LoveStoryEpisodes count', (await listLoveStoryEpisodes('love-23-0514')).length === 11);
check('master LoveColor present', (await getLoveColor('love-extra-25-0426'))?.LoveId === 'love-extra-25-0426');
check('master LoveHomeActions count', (await listLoveHomeActions('love-23-0514')).length === 43);
check('master LoveIds count', (await listLoveIds()).length === 6);

// --- Slice 16: Love:Title is server-authoritative ---
const loveTitleRespShape = msgRegistry.get(endpoints['Love']['Title'].response)!;
const loveTitleBytes = await dispatchRpc('Love:Title', Buffer.alloc(0), {
  headers: { 'x-auth-token': r1.GameAuthToken },
  log: { info() {}, warn() {} },
} as any);
const loveTitleResp = decodeMessage(loveTitleRespShape, new Reader(Uint8Array.from(loveTitleBytes))) as any;
check('Love:Title returns LoveInfos', (loveTitleResp.LoveInfos?.length ?? 0) >= 1);
check('Love:Title marks Loves unlocked', loveTitleResp.LoveInfos?.some((l: any) => Number(l.IsUnlocked) === 1) === true);
check('Love:Title returns exactly one LoveInfo per event', (loveTitleResp.LoveInfos?.length ?? 0) === 6);
check(
  'Love:Title LoveIds cover all 6 events',
  new Set(loveTitleResp.LoveInfos?.map((l: any) => l.LoveId)).size === 6,
);
check(
  'Love:Title LoveIds are unique',
  (() => {
    const seen = new Set<string>();
    for (const l of loveTitleResp.LoveInfos ?? []) {
      if (seen.has(l.LoveId)) return false;
      seen.add(l.LoveId);
    }
    return true;
  })(),
);
check(
  'Love:Title omits the card CharacterId (solis parity)',
  loveTitleResp.LoveInfos?.every((l: any) => !l.CharacterId) === true,
);
check(
  'Love:Title populates MainCharacterInfo.CharacterId',
  loveTitleResp.LoveInfos?.every(
    (l: any) =>
      typeof l.MainCharacterInfo?.CharacterId === 'string' &&
      l.MainCharacterInfo.CharacterId.length > 0,
  ) === true,
);
const extraActions = await listLoveHomeActions('love-extra-25-0426');

// --- Slice 18: native Love ADV handlers (uncaptured: schema-built, dbtest-validated) ---
const LOVE_ID = 'love-extra-25-0426';
const LOVE_FIRST_EP = 'love-event-story-25-0426-001';
const LOVE_SECOND_EP = 'love-event-story-25-0426-002';
const LOVE_THIRD_EP = 'love-event-story-25-0426-003-magical';
const LOVE_FOURTH_EP = 'love-event-story-25-0426-004-magical-smr';
const LOVE_END_EP = 'love-event-story-25-0426-005-magical-smr-good';
const LOVE_ENDING_ID = 'love-end-love-25-0426-005-magical-smr-happy';
// The event configures four candidate protagonists; GetMainCharacter picks one.
const LOVE_MAIN_CHARACTERS = ['char-rui', 'char-chs', 'char-smr', 'char-ngs'];
// Route selections that drive `...-005-magical-smr-good` to the happy ending.
const LOVE_FIRST_CHOICES: Array<[number, number]> = [[1, 1], [2, 2], [3, 1], [4, 1], [5, 1]];
const LOVE_SECOND_CHOICES: Array<[number, number]> = [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1]];
const LOVE_THIRD_CHOICES: Array<[number, number]> = [
  [1, 1],
  [2, 1],
  [3, 1],
  [4, 2],
  [5, 2],
  [6, 1],
];
const LOVE_FOURTH_CHOICES: Array<[number, number]> = [
  [1, 1],
  [2, 1],
  [3, 1],
  [4, 1],
  [5, 1],
  [6, 1],
  [7, 1],
  [8, 1],
  [9, 1],
];
const LOVE_FIFTH_CHOICES: Array<[number, number]> = [[1, 1]];

check('master LoveLevel RequiredExp seeded',
  Number((await getLoveLevel('love-extra-25-0426', 2))?.RequiredExp ?? 0) === 4000);
check('master LoveStoryEpisode ConsumptionItemAmount seeded',
  Number((await getLoveStoryEpisode('love-event-story-25-0426-002'))?.ConsumptionItemAmount ?? 0) === 1500);
check('master LoveHomeAction ActionType seeded', (await listLoveHomeActions('love-23-0514')).some((a: any) => a.ActionType != null));
check('master LoveHomeAction UnlockLoveStoryEndIds seeded',
  extraActions.some((a: any) => Array.isArray(a.UnlockLoveStoryEndIds) && a.UnlockLoveStoryEndIds.length > 0));

const loveRpc = async (method: keyof (typeof endpoints)['Love'], obj: any) => {
  const ep = (endpoints['Love'] as any)[method];
  const reqBytes = obj == null ? Buffer.alloc(0) : encodeReq(msgRegistry.get(ep.request)!, obj);
  const bytes = await dispatchRpc(
    `Love:${method}`,
    reqBytes,
    { headers: { 'x-auth-token': r1.GameAuthToken }, log: { info() {}, warn() {} } } as any,
  );
  return decodeMessage(msgRegistry.get(ep.response)!, new Reader(Uint8Array.from(bytes))) as any;
};

const finishLoveWith = async (episodeId: string, choices: Array<[number, number]>) =>
  loveRpc('Finish', {
    StoryEpisodeId: episodeId,
    HintLevel: 0,
    SelectStoryChoiceInfos: choices.map(([GroupIndex, Index]) => ({
      GroupIndex,
      Index,
      IsValid: true,
    })),
  });

const startLoveWith = async (episodeId: string) =>
  loveRpc('Start', { StoryEpisodeId: episodeId, HintLevel: 0 });

const loveTop = await loveRpc('Top', { LoveId: LOVE_ID });
check('Love:Top returns Exp', Number(loveTop.Exp ?? 0) === 0);
check('Love:Top unlocks chapter 1 for a new player',
  (loveTop.StoryEpisodeIds ?? []).length === 1 && (loveTop.StoryEpisodeIds ?? [])[0] === LOVE_FIRST_EP);
check('Love:Top resolves story read item', loveTop.ItemInfo?.StoryReadItemId === 'item-love-25-0426-story');
check('Love:Top resolves lesson promote item', loveTop.ItemInfo?.LessonPromoteItemId === 'item-love-25-0426-lesson-boost');
check('Love:Top omits absent present item', !loveTop.ItemInfo?.HiddenFavorabilityObtainItemId);
check('Love:Top populates MainCharacterInfo', typeof loveTop.MainCharacterInfo?.CharacterId === 'string' && loveTop.MainCharacterInfo.CharacterId.length > 0);
check('Love:Top returns LoveLevelInfos', (loveTop.LoveLevelInfos?.length ?? 0) === 5);
check('Love:Top returns ending infos', (loveTop.StoryEndInfos?.length ?? 0) === 12);
check('Love:Top starts with zero hidden favorability', Number(loveTop.HiddenFavorability ?? 0) === 0);

const loveMc = await loveRpc('GetMainCharacter', { LoveId: LOVE_ID });
check('Love:GetMainCharacter returns a character', (loveMc.MainCharacterInfo?.CharacterId ?? '').length > 0);
check('Love:GetMainCharacter returns an asset', (loveMc.MainCharacterInfo?.AssetId ?? '').length > 0);
check(
  'Love:GetMainCharacter returns a configured event character',
  LOVE_MAIN_CHARACTERS.includes(loveMc.MainCharacterInfo?.CharacterId ?? ''),
);

await loveRpc('Register', { LoveId: LOVE_ID, Name: 'ゆうき' });
const loveProgRow = await db
  .select()
  .from(playerLoveProgress)
  .where(and(eq(playerLoveProgress.playerId, SERVER_USER_ID), eq(playerLoveProgress.loveId, LOVE_ID)));
check('Love:Register persists protagonist name', loveProgRow[0]?.name === 'ゆうき');
await loveRpc('UpdateName', { LoveId: LOVE_ID, Name: 'たくみ' });
const loveProgRow2 = await db
  .select()
  .from(playerLoveProgress)
  .where(and(eq(playerLoveProgress.playerId, SERVER_USER_ID), eq(playerLoveProgress.loveId, LOVE_ID)));
check('Love:UpdateName updates protagonist name', loveProgRow2[0]?.name === 'たくみ');

const loveStart = await startLoveWith(LOVE_FIRST_EP);
check('Love:Start returns server choice groups', (loveStart.StoryChoiceGroupInfos?.length ?? 0) === 5);
check('Love:Start sets IsReadingStory', Number(loveStart.CommonResponse?.UpdatedData?.Loves?.[0]?.IsReadingStory ?? 0) === 1);
const loveAfterStart = await userGet();
check('Love:Start persisted Loves via User:Get',
  (loveAfterStart.Loves ?? []).some((l: any) => l.LoveId === LOVE_ID && Number(l.IsReadingStory) === 1));

const loveFinish = await finishLoveWith(LOVE_FIRST_EP, LOVE_FIRST_CHOICES);
check('Love:Finish clears IsReadingStory', Number(loveFinish.CommonResponse?.UpdatedData?.Loves?.[0]?.IsReadingStory ?? 0) === 0);
check('Love:Finish records the story as read',
  Number(loveFinish.CommonResponse?.UpdatedData?.Stories?.[0]?.StatusType ?? 0) === 2);
check('Love:Finish of a non-ending does not unlock an ending', Number(loveFinish.UnlockSave ?? 0) === 0);
check('Love:Finish of a non-ending returns no end name', (loveFinish.StoryEndName ?? '') === '');
await startLoveWith(LOVE_FIRST_EP);
const loveFinish2 = await finishLoveWith(LOVE_FIRST_EP, LOVE_FIRST_CHOICES);
check('Love:Finish is repeatable (story stays read)',
  Number(loveFinish2.CommonResponse?.UpdatedData?.Stories?.[0]?.StatusType ?? 0) === 2);
const loveTopAfterFinish = await loveRpc('Top', { LoveId: LOVE_ID });
check('Love:Top unlocks chapter 2 after finishing chapter 1',
  (loveTopAfterFinish.StoryEpisodeIds ?? []).includes(LOVE_FIRST_EP) &&
    (loveTopAfterFinish.StoryEpisodeIds ?? []).includes(LOVE_SECOND_EP));

const lovePresent = await loveRpc('Present', { LoveId: LOVE_ID });
check('Love:Present increments hidden favorability', Number(lovePresent.HiddenFavorability ?? 0) === 1);
const loveAfterPresent = await userGet();
check('Love:Present persisted via User:Get',
  (loveAfterPresent.Loves ?? []).some((l: any) => l.LoveId === LOVE_ID && Number(l.HiddenFavorability) === 1));

// Walk the route to the magical-smr happy ending so the save slot unlocks.
// Official gates each episode on the player's love level, so raise the test
// player's exp to the highest master threshold before walking past chapter 1,
// then restore it so the lesson/promote exp checks below start from the same base.
let loveExpBeforeWalk: number | null = null;
if (!isSandbox()) {
  const [loveRow] = await db
    .select({ exp: playerLoveProgress.exp })
    .from(playerLoveProgress)
    .where(and(eq(playerLoveProgress.playerId, SERVER_USER_ID), eq(playerLoveProgress.loveId, LOVE_ID)));
  loveExpBeforeWalk = Number(loveRow?.exp ?? 0);
  const loveLevels = await listLoveLevels(LOVE_ID);
  const maxRequiredExp = loveLevels.reduce(
    (max, l) => Math.max(max, Number(l.RequiredExp ?? 0)),
    0,
  );
  await db
    .update(playerLoveProgress)
    .set({ exp: maxRequiredExp })
    .where(and(eq(playerLoveProgress.playerId, SERVER_USER_ID), eq(playerLoveProgress.loveId, LOVE_ID)));
  // Official also spends the love's story key per new episode; stock enough
  // for the episodes past chapter 1 (master costs 1500/2500/3500 each).
  await grantPromotionItem(SERVER_USER_ID, 'item-love-25-0426-story', 20000);
}
await startLoveWith(LOVE_SECOND_EP);
await finishLoveWith(LOVE_SECOND_EP, LOVE_SECOND_CHOICES);
await startLoveWith(LOVE_THIRD_EP);
await finishLoveWith(LOVE_THIRD_EP, LOVE_THIRD_CHOICES);
await startLoveWith(LOVE_FOURTH_EP);
await finishLoveWith(LOVE_FOURTH_EP, LOVE_FOURTH_CHOICES);
await startLoveWith(LOVE_END_EP);
const loveEndFinish = await finishLoveWith(LOVE_END_EP, LOVE_FIFTH_CHOICES);
check('Love:Finish of an ending unlocks save', Number(loveEndFinish.UnlockSave ?? 0) === 1);
check('Love:Finish returns the ending name', loveEndFinish.StoryEndName === '解けない魔法END');
check('Love:Finish appends the ending id to UserLove',
  (loveEndFinish.CommonResponse?.UpdatedData?.Loves?.[0]?.UnlockedLoveStoryEndIDs ?? []).includes(LOVE_ENDING_ID));
const loveTopAfterEnd = await loveRpc('Top', { LoveId: LOVE_ID });
check('Love:Top reflects the unlocked ending',
  loveTopAfterEnd.StoryEndInfos?.some((e: any) => e.Id === LOVE_ENDING_ID && Number(e.Unlocked ?? 0) === 1) === true);

if (loveExpBeforeWalk !== null) {
  await db
    .update(playerLoveProgress)
    .set({ exp: loveExpBeforeWalk })
    .where(and(eq(playerLoveProgress.playerId, SERVER_USER_ID), eq(playerLoveProgress.loveId, LOVE_ID)));
}

// Backdate the lesson anchor by exactly one 10 s step.
await db
  .update(playerLoveProgress)
  .set({ lastReceiveTime: Date.now() - 10_000 })
  .where(and(eq(playerLoveProgress.playerId, SERVER_USER_ID), eq(playerLoveProgress.loveId, LOVE_ID)));
const loveLesson1 = await loveRpc('ReceiveLessonReward', { LoveId: LOVE_ID });
check('Love:ReceiveLessonReward grants lesson exp', Number(loveLesson1.ObtainExp ?? 0) === 14);
check('Love:ReceiveLessonReward reports total exp', Number(loveLesson1.TotalExp ?? 0) === 14);
check('Love:ReceiveLessonReward grants the story item', (loveLesson1.Rewards?.length ?? 0) >= 1);
check('Love:ReceiveLessonReward sets LastReceiveTime', Number(loveLesson1.LessonProgress?.LastReceiveTime ?? 0) > 0);
const loveLesson2 = await loveRpc('ReceiveLessonReward', { LoveId: LOVE_ID });
check('Love:ReceiveLessonReward is windowed (no double reward)', Number(loveLesson2.ObtainExp ?? 0) === 0);
check('Love:ReceiveLessonReward keeps total exp', Number(loveLesson2.TotalExp ?? 0) === 14);

const lovePromote1 = await loveRpc('PromoteLesson', { LoveId: LOVE_ID });
check('Love:PromoteLesson raises total exp', Number(lovePromote1.TotalExp ?? 0) > 14);
const lovePromote2 = await loveRpc('PromoteLesson', { LoveId: LOVE_ID });
check('Love:PromoteLesson advances one level per call', Number(lovePromote2.TotalExp ?? 0) > Number(lovePromote1.TotalExp ?? 0));
await db
  .update(playerLoveProgress)
  .set({ exp: 1_000_000 })
  .where(and(eq(playerLoveProgress.playerId, SERVER_USER_ID), eq(playerLoveProgress.loveId, LOVE_ID)));
const lovePromoteMax = await loveRpc('PromoteLesson', { LoveId: LOVE_ID });
check('Love:PromoteLesson no-ops at max level', Number(lovePromoteMax.ObtainExp ?? 0) === 0);

// The ending reset the route to chapter 1, and an ending has now unlocked saving.
await loveRpc('Save', { LoveId: LOVE_ID, SlotNumber: 1 });
const loveLoad = await loveRpc('Load', { LoveId: LOVE_ID, SlotNumber: 1 });
check('Love:Load restores the saved route',
  (loveLoad.StoryEpisodeIds ?? []).length === 1 && (loveLoad.StoryEpisodeIds ?? [])[0] === LOVE_FIRST_EP);
const loveReset = await loveRpc('Reset', { LoveId: LOVE_ID, SlotNumber: 1 });
check('Love:Reset returns to chapter 1 only',
  (loveReset.StoryEpisodeIds ?? []).length === 1 && (loveReset.StoryEpisodeIds ?? [])[0] === LOVE_FIRST_EP);
await loveRpc('ResetReadingStoryStatus', { LoveId: LOVE_ID });
await loveRpc('Save', { LoveId: LOVE_ID, SlotNumber: 1 });
await loveRpc('UpdateSaveName', { LoveId: LOVE_ID, SlotNumber: 1, Name: 'スロット1' });
check('Love:Save/UpdateSaveName are accepted', true);

const loveExtra = await loveRpc('TitleExtra', { LoveId: LOVE_ID });
check('Love:TitleExtra returns the requested LoveInfo', loveExtra.LoveInfo?.LoveId === LOVE_ID);
check('Love:TitleExtra LoveInfo carries endings', (loveExtra.LoveInfo?.StoryEndInfos?.length ?? 0) === 12);
check(
  'Love:TitleExtra returns the extra story title asset',
  loveExtra.TitleAssetId === 'love-25-0426',
);

// --- Activity:ReceiveLessonReward (native lesson idle rewards) ---
const activityAuth = {
  headers: { 'x-auth-token': r1.GameAuthToken },
  log: { info() {}, warn() {} },
} as any;
const activityRespShape = msgRegistry.get(endpoints['Activity']['ReceiveLessonReward'].response)!;
const activityReceive = async () => {
  const bytes = await dispatchRpc('Activity:ReceiveLessonReward', Buffer.alloc(0), activityAuth);
  return decodeMessage(activityRespShape, new Reader(Uint8Array.from(bytes))) as any;
};
const homeEnterShape = msgRegistry.get(endpoints['Home']['Enter'].response)!;
const homeEnterRpc = async () => {
  const bytes = await dispatchRpc(
    'Home:Enter',
    encodeReq(msgRegistry.get(endpoints['Home']['Enter'].request)!, { SkipUpdate: false }),
    activityAuth,
  );
  return decodeMessage(homeEnterShape, new Reader(Uint8Array.from(bytes))) as any;
};
const activityRewardAmount = (resp: any, resourceType: number) =>
  Number((resp.Rewards ?? []).find((r: any) => Number(r.ResourceType) === resourceType)?.Amount ?? 0);
const lessonRows = () =>
  db.select().from(playerLessonProgress).where(eq(playerLessonProgress.playerId, SERVER_USER_ID));
const enhanceItemAmount = (u: any) =>
  Number(u.Items?.find((i: any) => i.ItemId === 'item-card_enhance')?.Amount ?? 0);

const activityFirstAt = Date.now();
const activityFirst = await activityReceive();
check('Activity:ReceiveLessonReward first call grants no rewards', (activityFirst.Rewards?.length ?? 0) === 0);
const seededLesson = (await lessonRows())[0];
check('Activity:ReceiveLessonReward lazily seeds one progress row', (await lessonRows()).length === 1 && !!seededLesson);
check('Activity lesson seed mirrors Solis step rates',
  Number(seededLesson?.stepRewardGold ?? 0) === 5 &&
    Number(seededLesson?.stepRewardManagerExp ?? 0) === 8 &&
    Number(seededLesson?.stepRewardCardEnhanceItem ?? 0) === 3);
check('Activity lesson seed starts LastReceiveTime at now',
  Math.abs(Number(seededLesson?.lastReceiveTime ?? 0) - activityFirstAt) < 5000);
check('Activity lesson seed sets the 12h reward cap',
  Number(seededLesson?.maxRewardTime ?? 0) - Number(seededLesson?.lastReceiveTime ?? 0) === 12 * 60 * 60 * 1000);
check('Activity lesson seed uses the Solis main area', seededLesson?.currentAreaId === 'area-main-001');
check('Activity:ReceiveLessonReward first Progress reports the seeded anchor',
  Math.abs(Number(activityFirst.Progress?.LastReceiveTime ?? 0) - activityFirstAt) < 5000);

const beforeActivityPl = (await db.select().from(players).where(eq(players.id, SERVER_USER_ID)))[0]!;
const beforeEnhance = enhanceItemAmount(await userGet());
const backdated = Date.now() - 300_000;
await db
  .update(playerLessonProgress)
  .set({ lastReceiveTime: backdated })
  .where(eq(playerLessonProgress.playerId, SERVER_USER_ID));
const activitySecond = await activityReceive();
check('Activity:ReceiveLessonReward pays 30 gold steps', activityRewardAmount(activitySecond, 8) === 150);
check('Activity:ReceiveLessonReward pays 30 manager-exp steps + campaign bonus',
  activityRewardAmount(activitySecond, 14) === 480);
check('Activity:ReceiveLessonReward pays 30 card-enhance steps', activityRewardAmount(activitySecond, 1) === 90);
check('Activity:ReceiveLessonReward clears the collected pending amounts',
  Number(activitySecond.Progress?.RewardGoldAmount ?? 0) === 0 &&
    Number(activitySecond.Progress?.RewardManagerExpAmount ?? 0) === 0 &&
    Number(activitySecond.Progress?.RewardCardEnhanceItemAmount ?? 0) === 0);
check('Activity:ReceiveLessonReward advances the anchor by the collected steps',
  Number(activitySecond.Progress?.LastReceiveTime ?? 0) === backdated + 300_000);
check('Activity:ReceiveLessonReward resets the 12h window from the new anchor',
  Number(activitySecond.Progress?.MaxRewardTime ?? 0) - Number(activitySecond.Progress?.LastReceiveTime ?? 0) ===
    12 * 60 * 60 * 1000);
const afterActivityPl = (await db.select().from(players).where(eq(players.id, SERVER_USER_ID)))[0]!;
check('Activity:ReceiveLessonReward actually adds gold', Number(afterActivityPl.gold) - Number(beforeActivityPl.gold) === 150);
check('Activity:ReceiveLessonReward actually adds manager exp', Number(afterActivityPl.exp) - Number(beforeActivityPl.exp) === 480);
check('Activity:ReceiveLessonReward actually adds card-enhance items',
  enhanceItemAmount(await userGet()) - beforeEnhance === 90);

const activityThird = await activityReceive();
check('Activity:ReceiveLessonReward immediate second call grants no rewards',
  (activityThird.Rewards?.length ?? 0) === 0);
check('Activity:ReceiveLessonReward immediate second call leaves pending at zero',
  Number(activityThird.Progress?.RewardGoldAmount ?? 0) === 0 &&
    Number(activityThird.Progress?.RewardManagerExpAmount ?? 0) === 0 &&
    Number(activityThird.Progress?.RewardCardEnhanceItemAmount ?? 0) === 0);

const capNow = Date.now();
const capLast = capNow - 13 * 60 * 60 * 1000;
await db
  .update(playerLessonProgress)
  .set({ lastReceiveTime: capLast, maxRewardTime: capLast + 12 * 60 * 60 * 1000 })
  .where(eq(playerLessonProgress.playerId, SERVER_USER_ID));
const activityCap = await activityReceive();
check('Activity:ReceiveLessonReward caps idle rewards at 12h (gold)',
  activityRewardAmount(activityCap, 8) === 4320 * 5);
check('Activity:ReceiveLessonReward caps idle rewards at 12h (manager exp + bonus)',
  activityRewardAmount(activityCap, 14) === 4320 * 8 * 2);
check('Activity:ReceiveLessonReward caps idle rewards at 12h (items)',
  activityRewardAmount(activityCap, 1) === 4320 * 3);
check('Activity:ReceiveLessonReward discards idle time beyond the cap from the anchor',
  Number(activityCap.Progress?.LastReceiveTime ?? 0) >= capNow &&
    Number(activityCap.Progress?.LastReceiveTime ?? 0) < capNow + 10_000);
check('Activity:ReceiveLessonReward leaves a fresh 12h window after the capped receipt',
  Number(activityCap.Progress?.MaxRewardTime ?? 0) - Number(activityCap.Progress?.LastReceiveTime ?? 0) ===
    12 * 60 * 60 * 1000);

await db
  .update(playerLessonProgress)
  .set({ lastReceiveTime: Date.now() - 300_000 })
  .where(eq(playerLessonProgress.playerId, SERVER_USER_ID));
const activityHome = await homeEnterRpc();
check('Home:Enter carries Activity LessonProgress pending gold',
  Number(activityHome.LessonProgress?.RewardGoldAmount ?? 0) === 150);
check('Home:Enter carries Activity LessonProgress pending manager exp',
  Number(activityHome.LessonProgress?.RewardManagerExpAmount ?? 0) === 240);
check('Home:Enter carries Activity LessonProgress pending card-enhance items',
  Number(activityHome.LessonProgress?.RewardCardEnhanceItemAmount ?? 0) === 90);
check('Home:Enter nests the same Activity progress in LessonInfo',
  Number(activityHome.LessonInfo?.LessonProgress?.RewardGoldAmount ?? 0) === 150 &&
    Number(activityHome.LessonInfo?.LessonProgress?.RewardManagerExpAmount ?? 0) === 240);
check('Home:Enter carries live Activity campaign effects',
  (activityHome.LessonInfo?.CampaignEffects ?? []).some((e: any) => Number(e.Type) === 4002) === true);
const pendingLesson = (await lessonRows())[0];
check('Home:Enter persists the reconciled Activity pending amounts',
  Number(pendingLesson?.rewardGold ?? 0) === 150 &&
    Number(pendingLesson?.rewardManagerExp ?? 0) === 240 &&
    Number(pendingLesson?.rewardCardEnhanceItem ?? 0) === 90);
await db
  .update(playerLessonProgress)
  .set({ rewardGold: 0, rewardManagerExp: 0, rewardCardEnhanceItem: 0 })
  .where(eq(playerLessonProgress.playerId, SERVER_USER_ID));

// --- Mission:Receive is server-authoritative + idempotent ---
const missionReqShape = msgRegistry.get(endpoints['Mission']['Receive'].request)!;
const missionRespShape = msgRegistry.get(endpoints['Mission']['Receive'].response)!;
const receiveMission = async (ids: string[]) => {
  const bytes = await dispatchRpc(
    'Mission:Receive',
    encodeReq(missionReqShape, { MissionIds: ids }),
    { headers: { 'x-auth-token': r1.GameAuthToken }, log: { info() {}, warn() {} } } as any,
  );
  return decodeMessage(missionRespShape, new Reader(Uint8Array.from(bytes))) as any;
};

const medalBefore = (await userGet()).Items?.find((i: any) => i.ItemId === 'item-backside_medal')?.Amount ?? 0;
const missionResp = await receiveMission([MISSION_ID]);
check('Mission:Receive returns a reward result', (missionResp.Results?.length ?? 0) >= 1);
check(
  'Mission:Receive marks mission received (StatusType 4)',
  missionResp.CommonResponse?.UpdatedData?.Missions?.some((m: any) => m.MissionId === MISSION_ID && m.StatusType === 4),
);

const afterMission = await userGet();
const medalAfter = afterMission.Items?.find((i: any) => i.ItemId === 'item-backside_medal')?.Amount ?? 0;
check('Mission:Receive granted item-backside_medal +50', medalAfter === medalBefore + 50);
check(
  'Mission:Receive persisted UserMission via User:Get',
  afterMission.Missions?.some((m: any) => m.MissionId === MISSION_ID && m.StatusType === 4),
);

const missionResp2 = await receiveMission([MISSION_ID]);
const medalAfter2 = (await userGet()).Items?.find((i: any) => i.ItemId === 'item-backside_medal')?.Amount ?? 0;
check('Mission:Receive idempotent: no second reward', (missionResp2.Results?.length ?? 0) === 0);
check('Mission:Receive idempotent: item amount stable', medalAfter2 === medalAfter);

// --- LoginBonus:Receive is server-authoritative + once-per-day idempotent ---
const lbReqShape = msgRegistry.get(endpoints['LoginBonus']['Receive'].request)!;
const lbRespShape = msgRegistry.get(endpoints['LoginBonus']['Receive'].response)!;
const receiveLoginBonus = async (id: string) => {
  const bytes = await dispatchRpc(
    'LoginBonus:Receive',
    encodeReq(lbReqShape, { LoginBonusId: id }),
    { headers: { 'x-auth-token': r1.GameAuthToken }, log: { info() {}, warn() {} } } as any,
  );
  return decodeMessage(lbRespShape, new Reader(Uint8Array.from(bytes))) as any;
};

const lbItem = 'item-act_promotion_shorten';
const lbBefore = (await userGet()).Items?.find((i: any) => i.ItemId === lbItem)?.Amount ?? 0;
const lbResp = await receiveLoginBonus(LOGIN_BONUS_ID);
check('LoginBonus:Receive returns UserLoginBonus', lbResp.UserLoginBonus?.LoginBonusId === LOGIN_BONUS_ID);
check('LoginBonus:Receive ReceiveCount=1', Number(lbResp.UserLoginBonus?.ReceiveCount) === 1);
check('LoginBonus:Receive returns a reward result', (lbResp.Rewards?.length ?? 0) >= 1);

const lbAfter = (await userGet()).Items?.find((i: any) => i.ItemId === lbItem)?.Amount ?? 0;
check('LoginBonus:Receive granted item-act_promotion_shorten +1', lbAfter === lbBefore + 1);

const lbResp2 = await receiveLoginBonus(LOGIN_BONUS_ID);
const lbAfter2 = (await userGet()).Items?.find((i: any) => i.ItemId === lbItem)?.Amount ?? 0;
check('LoginBonus:Receive same-day idempotent: no second reward', (lbResp2.Rewards?.length ?? 0) === 0);
check('LoginBonus:Receive same-day idempotent: ReceiveCount stable', Number(lbResp2.UserLoginBonus?.ReceiveCount) === 1);
check('LoginBonus:Receive same-day idempotent: item amount stable', lbAfter2 === lbAfter);

// --- Gacha:List / Gacha:Draw are server-authoritative ---
const gachaListShape = msgRegistry.get(endpoints['Gacha']['List'].response)!;
const gachaDrawShape = msgRegistry.get(endpoints['Gacha']['Draw'].response)!;
const listGacha = async () => {
  const bytes = await dispatchRpc('Gacha:List', Buffer.alloc(0), {
    headers: { 'x-auth-token': r1.GameAuthToken },
    log: { info() {}, warn() {} },
  } as any);
  return decodeMessage(gachaListShape, new Reader(Uint8Array.from(bytes))) as any;
};
const drawGacha = async (buttonId: string, execCount = 1) => {
  const bytes = await dispatchRpc(
    'Gacha:Draw',
    encodeReq(msgRegistry.get(endpoints['Gacha']['Draw'].request)!, { GachaButtonId: buttonId, ExecCount: execCount }),
    { headers: { 'x-auth-token': r1.GameAuthToken }, log: { info() {}, warn() {} } } as any,
  );
  return decodeMessage(gachaDrawShape, new Reader(Uint8Array.from(bytes))) as any;
};

const BUTTON_ID = 'btn-01-gacha-birthday-26-0505';
const list = await listGacha();
check('Gacha:List lists no banners outside the sandbox', (list.Gachas?.length ?? 0) === 0);

const jewelBefore = (await userGet()).Balance?.FreeBalance != null
  ? Number((await userGet()).Balance.FreeBalance)
  : 0;
const cardsBefore = (await userGet()).Cards?.length ?? 0;
const draw1 = await drawGacha(BUTTON_ID, 1);
check('Gacha:Draw returns Button info', draw1.Button?.Id === BUTTON_ID);
check('Gacha:Draw draws DrawCount cards (1)', (draw1.Rewards?.length ?? 0) === 1);
check('Gacha:Draw records consumption', (draw1.ConsumptionResults?.length ?? 0) >= 1);
check('Gacha:Draw result card is granted', draw1.Rewards?.every((r: any) => r.ResourceType === 2));
check('Gacha:Draw returns RewardResults', (draw1.RewardResults?.length ?? 0) >= 1);

const drawnCardId = draw1.Rewards?.[0]?.ResourceId;
const afterDraw = await userGet();
check('Gacha:Draw grants the drawn card (or duplicate) deterministically present', afterDraw.Cards?.some((c: any) => c.CardId === drawnCardId) === true);
check('Gacha:Draw updates GachaButtons TotalCount=1', afterDraw.GachaButtons?.some((g: any) => g.GachaButtonId === BUTTON_ID && Number(g.TotalCount) === 1) === true);
const jewelAfter = Number(afterDraw.Balance?.FreeBalance ?? 0);
check('Gacha:Draw spends 300 free jewels', jewelAfter === jewelBefore - 300);
check('Gacha:Draw does not shrink the collection', (afterDraw.Cards?.length ?? 0) >= cardsBefore);

const draw2 = await drawGacha(BUTTON_ID, 1);
const afterDraw2 = await userGet();
check('Gacha:Draw second pull increments TotalCount=2', afterDraw2.GachaButtons?.some((g: any) => g.GachaButtonId === BUTTON_ID && Number(g.TotalCount) === 2) === true);
check('Gacha:Draw second pull spends another 300', Number(afterDraw2.Balance?.FreeBalance ?? 0) === jewelAfter - 300);

if (!isSandbox()) {
  let threw = false;
  try {
    await drawGacha(BUTTON_ID, 100000);
  } catch {
    threw = true;
  }
  check('Gacha:Draw rejects unaffordable pull', threw);
}
const afterFail = await userGet();
check('Gacha:Draw failed pull did not change jewels', Number(afterFail.Balance?.FreeBalance ?? 0) === Number(afterDraw2.Balance?.FreeBalance ?? 0));

// --- Free excursion 10-pull is zero-cost ---
const freeBefore = Number((await userGet()).Balance?.FreeBalance ?? 0);
const freeCardsBefore = new Set<string>(((await userGet()).Cards ?? []).map((c: any) => String(c.CardId)));
const freeDraw = await drawGacha('btn-10-gacha-excursion-01-26-0918-free', 1);
check('Gacha:Draw free excursion draws 10 cards', (freeDraw.Rewards?.length ?? 0) === 10);
check('Gacha:Draw free excursion costs nothing', (freeDraw.ConsumptionResults?.length ?? 0) === 0);
check('Gacha:Draw free excursion does not spend jewels', Number((await userGet()).Balance?.FreeBalance ?? 0) === freeBefore);
const EXCURSION_PICKUPS = ['card-rui-05-casl-04', 'card-yu-05-casl-04', 'card-smr-05-casl-04'];
check(
  'Gacha:Draw free excursion 10-pull guarantees a pickup card',
  (freeDraw.Rewards ?? []).some((r: any) => EXCURSION_PICKUPS.includes(String(r.ResourceId))),
);

// --- New cards grant their tied costume + hair(s) into UpdatedData ---
// For every card drawn this pull that the player did not already own, the
// response's CommonResponse.UpdatedData must carry the card's RewardCostumeId
// and every RewardHairIds entry (falling back to RewardHairId, then the
// costume's DefaultHairId), mirroring what was persisted to the collection.
const { getCard: getMasterCard, getCostume: getMasterCostume } = await import('./master/index.ts');
const checkCosmeticsGranted = async (draw: any, pre: Set<string>, label: string) => {
  const ud = draw.CommonResponse?.UpdatedData ?? {};
  const cos = new Set((ud.Costumes ?? []).map((c: any) => String(c.CostumeId)));
  const hairs = new Set((ud.Hairs ?? []).map((h: any) => String(h.HairId)));
  let checked = 0;
  let ok = true;
  for (const r of draw.Rewards ?? []) {
    if (Number(r.ResourceType) !== 2) continue;
    const cid = String(r.ResourceId);
    if (pre.has(cid)) continue;
    const mc: any = await getMasterCard(cid);
    if (!mc) continue;
    const expected: string[] = [];
    if (mc.RewardCostumeId) {
      const cosId = String(mc.RewardCostumeId);
      expected.push(`cos:${cosId}`);
      if (!cos.has(cosId)) ok = false;
      const plural = Array.isArray(mc.RewardHairIds) ? (mc.RewardHairIds as unknown[]) : [];
      const hs = new Set<string>();
      for (const h of plural) if (h) hs.add(String(h));
      if (mc.RewardHairId) hs.add(String(mc.RewardHairId));
      if (hs.size === 0) {
        const c = await getMasterCostume(cosId);
        if (c?.DefaultHairId) hs.add(String(c.DefaultHairId));
      }
      for (const h of hs) expected.push(`hair:${h}`);
    } else {
      const plural = Array.isArray(mc.RewardHairIds) ? (mc.RewardHairIds as unknown[]) : [];
      const hs = new Set<string>();
      for (const h of plural) if (h) hs.add(String(h));
      if (mc.RewardHairId) hs.add(String(mc.RewardHairId));
      for (const h of hs) expected.push(`hair:${h}`);
    }
    for (const e of expected) {
      const [kind, id] = e.split(':');
      if (kind === 'cos' && !cos.has(id)) ok = false;
      if (kind === 'hair' && !hairs.has(id)) ok = false;
      checked++;
    }
  }
  check(
    `${label}: ${checked} new-card cosmetic(s) present in UpdatedData`,
    ok && checked > 0,
  );
};
await checkCosmeticsGranted(freeDraw, freeCardsBefore, 'Gacha cosmetics (free excursion)');

// --- Cosmetic grant mapping (deterministic): costume + ALL plural hairs ---
const { cosmeticGrantsForCard } = await import('./services/cardCosmetics.ts');
const hairOnlyCard: any = await getMasterCard('card-smr-05-birt-02');
const hairOnlyGrants = await cosmeticGrantsForCard(hairOnlyCard);
const hairOnlyIds = hairOnlyGrants.filter((g) => g.resourceType === 28).map((g) => g.resourceId).sort();
check('Gacha cosmetics: multi-hair card grants all 4 RewardHairIds', hairOnlyIds.length === 4);
check('Gacha cosmetics: hair-only card grants no costume', !hairOnlyGrants.some((g) => g.resourceType === 5));
const costumeCard: any = await getMasterCard('card-rui-05-casl-04');
const costumeGrants = await cosmeticGrantsForCard(costumeCard);
check(
  'Gacha cosmetics: costume card grants its costume',
  costumeGrants.some((g) => g.resourceType === 5 && g.resourceId === 'cos-rui-casl-04'),
);
check('Gacha cosmetics: costume card also grants a default hair', costumeGrants.some((g) => g.resourceType === 28));

// --- Reconcile cosmetics for already-owned cards via User:Get ---
// Regression for "cards I already owned are missing outfits": strip a tied
// costume from an owned card, then a User:Get must re-grant it.
const reconPs = await import('./services/playerState.ts');
const { missingCardCosmetics } = await import('./services/cardCosmetics.ts');
const ownedForRecon = (await userGet()).Cards ?? [];
let reconCostumeId = '';
for (const c of ownedForRecon) {
  const mc: any = await getMasterCard(String(c.CardId));
  if (mc?.RewardCostumeId) {
    reconCostumeId = String(mc.RewardCostumeId);
    break;
  }
}
check('Reconcile: test account owns a card with a tied costume', !!reconCostumeId);
if (reconCostumeId) {
  await reconPs.removeElements(SERVER_USER_ID, 'Costumes', [
    { __msg: reconPs.collectionElementMsg('Costumes')!, CostumeId: reconCostumeId } as any,
  ]);
  const missing = await missingCardCosmetics(SERVER_USER_ID);
  check(
    'Reconcile: stripped tied costume detected as missing',
    missing.some((g) => g.resourceType === 5 && g.resourceId === reconCostumeId),
  );
  const afterGet = await userGet();
  const cosAfter = new Set((afterGet.Costumes ?? []).map((c: any) => String(c.CostumeId)));
  check('Reconcile: User:Get re-grants the missing tied costume', cosAfter.has(reconCostumeId));
}

// --- Reconcile card skill/ability unlocks via User:Get ---
// A stored card may carry skill ids it has not unlocked (e.g. acquired before
// the level-release model). User:Get must strip the ids locked at its level.
const relReconId = 'card-ai-04-casl-00';
await reconPs.putElements(SERVER_USER_ID, 'Cards', [
  {
    __msg: reconPs.collectionElementMsg('Cards')!,
    CardId: relReconId,
    Level: 1,
    Rarity: 4,
    SkillId1: 'sk-ai-04-casl-00-1',
    SkillId2: 'sk-ai-04-casl-00-2',
    SkillId3: 'sk-ai-04-casl-00-3',
    LiveAbilityId: 'lba-visual_multiply',
  } as any,
]);
const relRecon = (await userGet()).Cards?.find((c: any) => c.CardId === relReconId);
check(
  'Reconcile: User:Get strips skill/ability ids locked at Lv1',
  !!relRecon?.SkillId1 && !relRecon?.SkillId2 && !relRecon?.SkillId3 && !relRecon?.LiveAbilityId,
);
await reconPs.removeElements(SERVER_USER_ID, 'Cards', [
  { __msg: reconPs.collectionElementMsg('Cards')!, CardId: relReconId } as any,
]);

// --- Bloom Pt (ResourceType 25): dedicated 開花Pt on the owned card ---
const { applyCardBloomPt, grantDuplicateMedal } = await import('./services/cardBloom.ts');
const bloomCardId = 'card-smr-05-birt-02';
const bloomBefore = Number(
  (await userGet()).Items?.find((i: any) => i.ItemId === 'item-card_limit_break')?.Amount ?? 0,
);
const ownedBefore = (await userGet()).Cards?.find((c: any) => c.CardId === bloomCardId) ?? null;
const bloomApplied = await applyCardBloomPt(SERVER_USER_ID, bloomCardId, 100);
check('Bloom Pt emits a type-25 result', bloomApplied.results.some((r) => Number(r.ResourceType) === 25));
if (ownedBefore) {
  check(
    'Bloom Pt raises RarityTotalExp on the owned card (auto-bloom included)',
    Number(bloomApplied.afterExp) > Number(ownedBefore.RarityTotalExp ?? 0) || Number(bloomApplied.overflow) > 0,
  );
  const ownedAfter = (await userGet()).Cards?.find((c: any) => c.CardId === bloomCardId);
  check(
    'Bloom Pt persists the raised exp',
    Number(ownedAfter?.RarityTotalExp ?? 0) === Number(bloomApplied.afterExp),
  );
} else {
  const bloomAfter = Number(
    (await userGet()).Items?.find((i: any) => i.ItemId === 'item-card_limit_break')?.Amount ?? 0,
  );
  check('Bloom Pt on an unowned card credits Bloom Pieces', bloomAfter === bloomBefore + 100);
}

// --- Duplicate conversion: medal + dedicated 開花Pt lookups ---
const dupMedal = await grantDuplicateMedal(SERVER_USER_ID, drawnCardId);
check(
  'Duplicate medal scales with the owned card rarity',
  !!dupMedal && Number(dupMedal.amount) >= 1 && Number(dupMedal.result?.ResourceType) === 1,
);
const { getCardDuplicateExp } = await import('./master/index.ts');
check('CardDuplicateExp credits ★5 duplicates 100 bloom Pt', Number((await getCardDuplicateExp(5))?.Exp) === 100);

// --- Gacha card suite: Probability / rates / SelectCard / Exchange / History ---
const gachaRpc = async (method: string, reqObj: Record<string, unknown>) => {
  const ep = (endpoints['Gacha'] as Record<string, { request: string; response: string }>)[method]!;
  const reqBytes =
    ep.request === 'Empty' ? Buffer.alloc(0) : encodeReq(msgRegistry.get(ep.request)!, reqObj);
  const bytes = await dispatchRpc(`Gacha:${method}`, reqBytes, {
    headers: { 'x-auth-token': r1.GameAuthToken },
    log: { info() {}, warn() {} },
  } as any);
  return decodeMessage(msgRegistry.get(ep.response)!, new Reader(Uint8Array.from(bytes))) as any;
};

const prob = await gachaRpc('Probability', { GachaId: 'gacha-birthday-26-0505' });
const probR5 = prob.RarityProbabilityInfos?.find((r: any) => Number(r.Rarity) === 5);
const probR4 = prob.RarityProbabilityInfos?.find((r: any) => Number(r.Rarity) === 4);
check('Gacha:Probability exposes the ★5 rate 3.5%', Number(probR5?.Probability) === 3500);
check('Gacha:Probability exposes the ★4 rate 15%', Number(probR4?.Probability) === 15000);
const featuredCard = prob.ProbabilityInfos?.find((p: any) => p.ResourceId === 'card-smr-05-birt-02');
check('Gacha:Probability marks the featured card rate-up', Number(featuredCard?.IsRatioUp ?? 0) === 1);
check('Gacha:Probability featured card is 1.0%', Number(featuredCard?.Probability) === 1000);
const raritySum = (prob.RarityProbabilityInfos ?? []).reduce((s: number, r: any) => s + Number(r.Probability), 0);
check('Gacha:Probability rarity rates sum to 100%', Math.abs(raritySum - 100000) <= 1);
check('Gacha:Probability sends no slot-10 fix (no guarantee in the real game)', !prob.FixProbabilityInfos);

const probFes = await gachaRpc('Probability', { GachaId: 'gacha-fes-21-0928' });
const fesR5 = probFes.RarityProbabilityInfos?.find((r: any) => Number(r.Rarity) === 5);
check('Gacha:Probability fes ★5 rate is 7%', Number(fesR5?.Probability) === 7000);
const fesFeatured = probFes.ProbabilityInfos?.find((p: any) => p.ResourceId === 'card-mna-05-idol-00');
check('Gacha:Probability fes featured card is 1.5% (doubled rate-up)', Number(fesFeatured?.Probability) === 1500);
check('Gacha:Probability fes featured card is rate-up', Number(fesFeatured?.IsRatioUp ?? 0) === 1);
const fesFeatured2 = probFes.ProbabilityInfos?.find((p: any) => p.ResourceId === 'card-skr-05-fest-00');
check('Gacha:Probability fes second featured card is 1.5% (doubled rate-up)', Number(fesFeatured2?.Probability) === 1500);

// The "選べるアイプラフェス" (The AiLE) fes-select banner is a fes banner
// (`gacha-fs-*` / フェス) even though its id/text omit the latin "fes".
const probFsSelect = await gachaRpc('Probability', { GachaId: 'gacha-fs-select-26-0625' });
const fsSelectR5 = probFsSelect.RarityProbabilityInfos?.find((r: any) => Number(r.Rarity) === 5);
check('Gacha:Probability fes-select ★5 rate is doubled (7%)', Number(fsSelectR5?.Probability) === 7000);
// The probability dialog reads the pool + per-card rates from the per-rarity
// nested list, not the flat top-level list.
const fsNested = fsSelectR5?.ProbabilityInfos ?? [];
check('Gacha:Probability fes-select lists the ★5 pool cards', fsNested.length > 1);
check(
  'Gacha:Probability fes-select nested rate-up card is 1.5%',
  Math.max(...fsNested.map((p: any) => Number(p.Probability) || 0)) === 1500,
);
check(
  'Gacha:Probability groups ★4 cards under the ★4 rarity',
  (probFsSelect.RarityProbabilityInfos?.find((r: any) => Number(r.Rarity) === 4)?.ProbabilityInfos?.length ?? 0) > 0,
);

// --- ★5確定 guarantee banner (bir-fixed): ★5-only table + guaranteed slot ---
const probFixed = await gachaRpc('Probability', { GachaId: 'gacha-bir-fixed-26-0505' });
const fixedR5 = probFixed.RarityProbabilityInfos?.find((r: any) => Number(r.Rarity) === 5);
check('Gacha:Probability guarantee banner ★5 rate is 100%', Number(fixedR5?.Probability) === 100000);
check(
  'Gacha:Probability guarantee banner has no ★4/★3 rows',
  !(probFixed.RarityProbabilityInfos ?? []).some((r: any) => Number(r.Rarity) < 5),
);
const fixedFeatured = probFixed.ProbabilityInfos?.find((p: any) => p.ResourceId === 'card-smr-05-birt-02');
check('Gacha:Probability guarantee featured card is 3.0%', Number(fixedFeatured?.Probability) === 3000);
check('Gacha:Probability guarantee featured card is rate-up', Number(fixedFeatured?.IsRatioUp ?? 0) === 1);
const fixedCardSum = (probFixed.ProbabilityInfos ?? []).reduce(
  (s: number, p: any) => s + (Number(p.Probability) || 0),
  0,
);
check('Gacha:Probability guarantee card rates sum to ~100%', Math.abs(fixedCardSum - 100000) <= 2500);

const { listCards } = await import('./master/index.ts');
const fiveStarIds = new Set(
  (await listCards()).filter((c: any) => Number(c.InitialRarity) === 5).map((c: any) => String(c.Id)),
);
const curGacha = await import('./services/currency.ts');
await curGacha.grantCurrency(SERVER_USER_ID, 'paidJewel', 2700);
const fixedDraw = await drawGacha('btn-10-gacha-bir-fixed-26-0505-total', 1);
check('Gacha:Draw guarantee 10-pull draws 10 cards', (fixedDraw.Rewards?.length ?? 0) === 10);
check(
  'Gacha:Draw guarantee 10-pull consumes the 2700 paid-stone cost',
  (fixedDraw.ConsumptionResults ?? []).some((c: any) => Number(c.Amount) === 2700),
);
check(
  'Gacha:Draw guarantee 10-pull contains a ★5',
  (fixedDraw.Rewards ?? []).some((r: any) => fiveStarIds.has(String(r.ResourceId))),
);

await gachaRpc('SelectCard', {
  GachaId: 'gacha-birthday-26-0505',
  SelectedCardIds: ['card-smr-05-birt-02', 'card-smr-05-birt-01'],
});
// Gacha:List is empty outside the sandbox, so read the stored selection.
const selectedCards = async (gachaId: string) => {
  const [row] = await db
    .select()
    .from(playerGachaState)
    .where(and(eq(playerGachaState.playerId, SERVER_USER_ID), eq(playerGachaState.gachaId, gachaId)))
    .limit(1);
  return Array.isArray(row?.selectedCardIds) ? (row!.selectedCardIds as string[]).map(String) : [];
};
check('Gacha:SelectCard persists the selection', (await selectedCards('gacha-birthday-26-0505')).length === 2);

const STEP2_SELECT = ['card-rui-05-fest-04', 'card-yu-05-fest-04', 'card-smr-05-fest-04'];
await gachaRpc('SelectCard', {
  GachaId: 'gacha-fixed-step2-26-0625',
  SelectedCardIds: STEP2_SELECT,
});
const step2Selected = await selectedCards('gacha-fixed-step2-26-0625');
check(
  'Gacha:SelectCard caps the TRINITYAiLE fest step2 pick to one card',
  step2Selected.length === 1 && step2Selected[0] === STEP2_SELECT[0],
);

const FS_SELECT = ['card-rui-05-fest-03', 'card-smr-05-fest-03', 'card-yu-05-fest-01'];
await gachaRpc('SelectCard', {
  GachaId: 'gacha-fs-select-26-0625',
  SelectedCardIds: FS_SELECT,
});
const fsSelected = await selectedCards('gacha-fs-select-26-0625');
check(
  'Gacha:SelectCard caps the fes-select pick to SelectPickupAmount (2)',
  fsSelected.length === 2 && FS_SELECT.slice(0, 2).every((id) => fsSelected.includes(id)),
);

check(
  'Gacha:Draw grants a spark point for the banner',
  draw1.CommonResponse?.UpdatedData?.Items?.some(
    (i: any) => i.ItemId === 'item-gacha_point-birthday-26-0505',
  ) === true,
);

const { grantItem: grantItemGacha } = await import('./services/inventory.ts');
await grantItemGacha(SERVER_USER_ID, 'item-gacha_point-birthday-26-0505', 500);
const exch = await gachaRpc('Exchange', { GachaExchangeId: 'exc-gacha-gacha-birthday-26-0505-01', Count: 1 });
check('Gacha:Exchange returns the exchange info', !!exch.Exchange?.Id);
check('Gacha:Exchange increments the exchanged count', Number(exch.Exchange?.ExchangedCount ?? 0) === 1);
check('Gacha:Exchange grants the reward', (exch.RewardResults?.length ?? 0) >= 1);
check(
  'Gacha:Exchange reward is the banner card',
  exch.RewardResults?.some(
    (r: any) => Number(r.ResourceType) === 2 && r.ResourceId === 'card-smr-05-birt-02',
  ) === true,
);
check(
  'Gacha:Exchange surfaces the card in UpdatedData.Cards',
  exch.CommonResponse?.UpdatedData?.Cards?.some(
    (c: any) => c.CardId === 'card-smr-05-birt-02',
  ) === true,
);

const hist = await gachaRpc('History', { GachaType: 1 });
check('Gacha:History returns recorded draws', (hist.Histories?.length ?? 0) >= 3);

const freeTicket = await gachaRpc('ReceiveFreePremiumGachaTicket', { GachaId: 'gacha-birthday-26-0505' });
check('Gacha:ReceiveFreePremiumGachaTicket acknowledges', !!freeTicket.CommonResponse);

// --- Card:Enhance is server-authoritative ---
const { grantItem } = await import('./services/inventory.ts');
const { getCardLevel } = await import('./master/index.ts');
const enhanceShape = msgRegistry.get(endpoints['Card']['Enhance'].response)!;
const enhanceReqShape = msgRegistry.get(endpoints['Card']['Enhance'].request)!;
const enhanceCard = async (cardId: string, level: number) => {
  const bytes = await dispatchRpc(
    'Card:Enhance',
    encodeReq(enhanceReqShape, { CardId: cardId, Level: level }),
    { headers: { 'x-auth-token': r1.GameAuthToken }, log: { info() {}, warn() {} } } as any,
  );
  return decodeMessage(enhanceShape, new Reader(Uint8Array.from(bytes))) as any;
};

await grantItem(SERVER_USER_ID, 'item-card_enhance', 2000000);
const beforeEnh = await userGet();
const targetCard = beforeEnh.Cards?.[0];
const enhCardId = targetCard?.CardId as string;
const enhFromLevel = Number(targetCard?.Level ?? 1);
const enhTargetLevel = enhFromLevel + 1;
const enhLevelRow = await getCardLevel(enhTargetLevel);
const enhTargetExp = Number(enhLevelRow?.RequiredExp ?? 0);
const enhItemBefore = Number(beforeEnh.Items?.find((i: any) => i.ItemId === 'item-card_enhance')?.Amount ?? 0);

const enhResp = await enhanceCard(enhCardId, enhTargetLevel);
const afterEnh = await userGet();
const enhCardAfter = afterEnh.Cards?.find((c: any) => c.CardId === enhCardId);
const enhItemAfter = Number(afterEnh.Items?.find((i: any) => i.ItemId === 'item-card_enhance')?.Amount ?? 0);

check('Card:Enhance returns UpdatedData.Cards', (enhResp.CommonResponse?.UpdatedData?.Cards?.length ?? 0) === 1);
check('Card:Enhance levels the card up', Number(enhCardAfter?.Level) === enhTargetLevel);
check('Card:Enhance sets TotalExp to master RequiredExp', Number(enhCardAfter?.TotalExp) === enhTargetExp);
check('Card:Enhance persisted the enhanced card via User:Get', !!enhCardAfter);
check('Card:Enhance spends item-card_enhance', enhItemAfter < enhItemBefore);

let enhThrew = false;
try {
  await enhanceCard(enhCardId, enhTargetLevel);
} catch {
  enhThrew = true;
}
check('Card:Enhance rejects a non-increasing target level', enhThrew);

// --- Card stories unlock by card level (PLANS §1.7) ---
const { grantCard: grantCardStory } = await import('./services/inventory.ts');
const CS_CARD = 'card-smr-05-casl-04';
const CS_EP1 = 'st-card-smr-05-casl-04-01';
const CS_EP2 = 'st-card-smr-05-casl-04-02';
const CS_EP3 = 'st-card-smr-05-casl-04-03';
const csEp = (s: any) => [CS_EP1, CS_EP2, CS_EP3].includes(s.StoryId);

const csOwned = (await userGet()).Cards?.some((c: any) => c.CardId === CS_CARD);
if (!csOwned) await grantCardStory(SERVER_USER_ID, { CardId: CS_CARD });
const csAfterGrant = await userGet();
const csStories1 = (csAfterGrant.Stories ?? []).filter(csEp);
check(
  'Card grant at Lv1 unlocks episode 1 (Unread)',
  csStories1.some((s: any) => s.StoryId === CS_EP1 && Number(s.StatusType) === 1),
);
check('Card grant at Lv1 leaves episode 2 locked', !csStories1.some((s: any) => s.StoryId === CS_EP2));
check('Card grant at Lv1 leaves episode 3 locked', !csStories1.some((s: any) => s.StoryId === CS_EP3));
const csCard1 = csAfterGrant.Cards?.find((c: any) => c.CardId === CS_CARD);
if (Number(csCard1?.Level) === 1) {
  check(
    'Card at Lv1 exposes only SkillId1 (SkillId2 + ActivityAbility locked)',
    !!csCard1?.SkillId1 && !csCard1?.SkillId2 && !csCard1?.ActivityAbilityId,
  );
}

let csLockedThrew = false;
try {
  await readStory(CS_EP2);
} catch {
  csLockedThrew = true;
}
check('Story:Read rejects an episode locked by card level', csLockedThrew);

const csEnh35 = await enhanceCard(CS_CARD, 35);
const csAfter35 = await userGet();
const csStories35 = (csAfter35.Stories ?? []).filter(csEp);
check(
  'Enhance to Lv35 unlocks episode 2 (Unread)',
  csStories35.some((s: any) => s.StoryId === CS_EP2 && Number(s.StatusType) === 1),
);
check(
  'Enhance to Lv35 keeps episode 1 Unread',
  csStories35.some((s: any) => s.StoryId === CS_EP1 && Number(s.StatusType) === 1),
);
check('Enhance to Lv35 leaves episode 3 locked', !csStories35.some((s: any) => s.StoryId === CS_EP3));
check('Enhance to Lv35 unlocks SkillId2', !!csAfter35.Cards?.find((c: any) => c.CardId === CS_CARD)?.SkillId2);
check(
  'Enhance to Lv35 unlocks the ActivityAbilityId (Lv30 release)',
  csAfter35.Cards?.find((c: any) => c.CardId === CS_CARD)?.ActivityAbilityId
    === 'aab-fan_event_manager_exp_up',
);
check(
  'Enhance response surfaces the newly unlocked episode in UpdatedData.Stories',
  (csEnh35.CommonResponse?.UpdatedData?.Stories ?? []).some(
    (s: any) => s.StoryId === CS_EP2 && Number(s.StatusType) === 1,
  ),
);

const csEnh45 = await enhanceCard(CS_CARD, 45);
const csAfter45 = await userGet();
const csStories45 = (csAfter45.Stories ?? []).filter(csEp);
check(
  'Enhance to Lv45 unlocks episode 3 (Unread)',
  csStories45.some((s: any) => s.StoryId === CS_EP3 && Number(s.StatusType) === 1),
);
check(
  'Enhance to Lv45 keeps episodes 1 and 2',
  csStories45.some((s: any) => s.StoryId === CS_EP1) && csStories45.some((s: any) => s.StoryId === CS_EP2),
);
check(
  'Enhance to Lv45 response surfaces episode 3',
  (csEnh45.CommonResponse?.UpdatedData?.Stories ?? []).some(
    (s: any) => s.StoryId === CS_EP3 && Number(s.StatusType) === 1,
  ),
);

const csRead1 = await readStory(CS_EP1);
const csRead2 = await readStory(CS_EP2);
const csRead3 = await readStory(CS_EP3);
check(
  'Story:Read flips unlocked card episodes to Read',
  Number(csRead1.CommonResponse?.UpdatedData?.Stories?.[0]?.StatusType) === 2 &&
    Number(csRead2.CommonResponse?.UpdatedData?.Stories?.[0]?.StatusType) === 2 &&
    Number(csRead3.CommonResponse?.UpdatedData?.Stories?.[0]?.StatusType) === 2,
);
const csRead2Again = await readStory(CS_EP2);
check('Story:Read idempotent for a card episode', (csRead2Again.Rewards?.length ?? 0) === 0);
const csAfterRead = await userGet();
check(
  'Read card episodes persist as StatusType 2',
  (csAfterRead.Stories ?? []).filter(csEp).every((s: any) => Number(s.StatusType) === 2),
);


// --- Gift:List / Gift:Receive are server-authoritative ---
const giftListShape = msgRegistry.get(endpoints['Gift']['List'].response)!;
const giftRecvShape = msgRegistry.get(endpoints['Gift']['Receive'].response)!;
const giftRecvReqShape = msgRegistry.get(endpoints['Gift']['Receive'].request)!;
const listGifts = async () => {
  const bytes = await dispatchRpc('Gift:List', Buffer.alloc(0), {
    headers: { 'x-auth-token': r1.GameAuthToken },
    log: { info() {}, warn() {} },
  } as any);
  return decodeMessage(giftListShape, new Reader(Uint8Array.from(bytes))) as any;
};
const receiveGifts = async (ids: string[]) => {
  const bytes = await dispatchRpc(
    'Gift:Receive',
    encodeReq(giftRecvReqShape, { GiftIds: ids }),
    { headers: { 'x-auth-token': r1.GameAuthToken }, log: { info() {}, warn() {} } } as any,
  );
  return decodeMessage(giftRecvShape, new Reader(Uint8Array.from(bytes))) as any;
};

const giftList = await listGifts();
check('Gift:List seeds the gift box from the capture', (giftList.Gifts?.length ?? 0) === 3);
const giftIds: string[] = (giftList.Gifts ?? []).map((g: any) => String(g.GiftId));

const giftBefore = await userGet();
const giftItemBefore = Number(giftBefore.Items?.find((i: any) => i.ItemId === 'item-dream-generate-dream-25-0320')?.Amount ?? 0);
const giftStoneBefore = Number(giftBefore.Balance?.FreeBalance ?? 0);

const giftResp = await receiveGifts(giftIds);
check('Gift:Receive returns one result per gift', (giftResp.Results?.length ?? 0) === 3);
check('Gift:Receive reports ReceivedGiftIds', (giftResp.ReceivedGiftIds?.length ?? 0) === 3);

const giftAfter = await userGet();
const giftItemAfter = Number(giftAfter.Items?.find((i: any) => i.ItemId === 'item-dream-generate-dream-25-0320')?.Amount ?? 0);
const giftStoneAfter = Number(giftAfter.Balance?.FreeBalance ?? 0);
check('Gift:Receive granted the item gift (+5)', giftItemAfter === giftItemBefore + 5);
check('Gift:Receive granted the stone gift (+10)', giftStoneAfter === giftStoneBefore + 10);
check('Gift:Receive granted the emblem gift', !!giftAfter.Emblems?.some((e: any) => e.EmblemId === 'emb-308'));

const giftResp2 = await receiveGifts(giftIds);
check('Gift:Receive idempotent: no results on second call', (giftResp2.Results?.length ?? 0) === 0);
check('Gift:Receive reports consumed gifts as unreceived', (giftResp2.UnreceivedGiftIds?.length ?? 0) === 3);
const giftList2 = await listGifts();
check('Gift:List reflects the emptied gift box', (giftList2.Gifts?.length ?? 0) === 0);

// --- Shop:List / Shop:ListItem / Shop:Purchase are server-authoritative ---
const shopListShape = msgRegistry.get(endpoints['Shop']['List'].response)!;
const shopItemListShape = msgRegistry.get(endpoints['Shop']['ListItem'].response)!;
const shopItemListReqShape = msgRegistry.get(endpoints['Shop']['ListItem'].request)!;
const shopPurchaseReqShape = msgRegistry.get(endpoints['Shop']['Purchase'].request)!;
const shopPurchaseRespShape = msgRegistry.get(endpoints['Shop']['Purchase'].response)!;
const authOpts = { headers: { 'x-auth-token': r1.GameAuthToken }, log: { info() {}, warn() {} } } as any;

const shopList = decodeMessage(
  shopListShape,
  new Reader(Uint8Array.from(await dispatchRpc('Shop:List', Buffer.alloc(0), authOpts))),
) as any;
check('Shop:List returns the captured shops', (shopList.Shops?.length ?? 0) === 15);

const shopItems = decodeMessage(
  shopItemListShape,
  new Reader(Uint8Array.from(await dispatchRpc('Shop:ListItem', encodeReq(shopItemListReqShape, { ShopId: 'shop_top_shop' }), authOpts))),
) as any;
check('Shop:ListItem returns the captured catalog', (shopItems.ShopItems?.length ?? 0) === 15);

const shopBefore = await userGet();
const shopPieceBefore = Number(shopBefore.Items?.find((i: any) => i.ItemId === 'item-gacha_ticket_piece')?.Amount ?? 0);
const shopPurchase = decodeMessage(
  shopPurchaseRespShape,
  new Reader(Uint8Array.from(await dispatchRpc('Shop:Purchase', encodeReq(shopPurchaseReqShape, { ShopItemId: 'shop_item_gacha_ticket_piece-010' }), authOpts))),
) as any;
check('Shop:Purchase returns reward results', (shopPurchase.Rewards?.length ?? 0) >= 1);
const shopAfter = await userGet();
const shopPieceAfter = Number(shopAfter.Items?.find((i: any) => i.ItemId === 'item-gacha_ticket_piece')?.Amount ?? 0);
check('Shop:Purchase granted item-gacha_ticket_piece +10', shopPieceAfter === shopPieceBefore + 10);
check('Shop:Purchase persisted via User:Get', shopPieceAfter === shopPieceBefore + 10);

let shopThrew = false;
try {
  await dispatchRpc('Shop:Purchase', encodeReq(shopPurchaseReqShape, { ShopItemId: 'shop_item_gacha_ticket_piece-010' }), authOpts);
} catch {
  shopThrew = true;
}
check('Shop:Purchase enforces the purchase limit', shopThrew);

const shopItemsAfter = decodeMessage(
  shopItemListShape,
  new Reader(Uint8Array.from(await dispatchRpc('Shop:ListItem', encodeReq(shopItemListReqShape, { ShopId: 'shop_top_shop' }), authOpts))),
) as any;
const limitItem = shopItemsAfter.ShopItems?.find((s: any) => s.Id === 'shop_item_gacha_ticket_piece-010');
check('Shop:ListItem reflects the reduced LeftCount', Number(limitItem?.LeftCount ?? 0) === 0);

// --- Market:ListItem / Market:Purchase are server-authoritative ---
const marketListShape = msgRegistry.get(endpoints['Market']['ListItem'].response)!;
const marketPurchaseReqShape = msgRegistry.get(endpoints['Market']['Purchase'].request)!;
const marketPurchaseRespShape = msgRegistry.get(endpoints['Market']['Purchase'].response)!;

const marketList = decodeMessage(
  marketListShape,
  new Reader(Uint8Array.from(await dispatchRpc('Market:ListItem', Buffer.alloc(0), authOpts))),
) as any;
check('Market:ListItem returns the captured market', (marketList.MarketItems?.length ?? 0) === 8);

const marketBefore = await userGet();
const marketGoldBefore = Number(marketBefore.Points?.find((p: any) => p.PointType === 1)?.Amount ?? 0);
const marketEnhBefore = Number(marketBefore.Items?.find((i: any) => i.ItemId === 'item-card_enhance')?.Amount ?? 0);
const marketItem = marketList.MarketItems?.find((m: any) => Number(m.Number) === 21);
const marketCost = Number(marketItem?.DiscountAmount ?? marketItem?.BaseAmount ?? 0);

const marketPurchase = decodeMessage(
  marketPurchaseRespShape,
  new Reader(Uint8Array.from(await dispatchRpc('Market:Purchase', encodeReq(marketPurchaseReqShape, { Number: 21 }), authOpts))),
) as any;
check('Market:Purchase returns the updated list', (marketPurchase.MarketItems?.length ?? 0) === 8);
const marketAfter = await userGet();
const marketGoldAfter = Number(marketAfter.Points?.find((p: any) => p.PointType === 1)?.Amount ?? 0);
const marketEnhAfter = Number(marketAfter.Items?.find((i: any) => i.ItemId === 'item-card_enhance')?.Amount ?? 0);
check('Market:Purchase spends the gold cost', marketGoldAfter === marketGoldBefore - marketCost);
check('Market:Purchase granted item-card_enhance +99000', marketEnhAfter === marketEnhBefore + 99000);
check('Market:Purchase marks the item SoldOut', !!marketPurchase.MarketItems?.find((m: any) => Number(m.Number) === 21)?.SoldOut);

let marketThrew = false;
try {
  await dispatchRpc('Market:Purchase', encodeReq(marketPurchaseReqShape, { Number: 21 }), authOpts);
} catch {
  marketThrew = true;
}
check('Market:Purchase rejects an already sold-out item', marketThrew);

// --- Costume / Hair equip + checked (uncaptured: schema-built, dbtest-validated) ---
const callRpc = async (name: string, reqShape: string, req: any) => {
  const [svc, method] = name.split(':');
  const respShape = (endpoints as any)[svc!][method!].response;
  return decodeMessage(
    msgRegistry.get(respShape)!,
    new Reader(Uint8Array.from(await dispatchRpc(name, encodeReq(msgRegistry.get(reqShape)!, req), authOpts))),
  ) as any;
};

const setCostume = (costumeId: string, hairId = '') =>
  callRpc('Costume:SetCostume', 'Solis.Common.Proto.Api.CostumeSetRequest', { CostumeId: costumeId, HairId: hairId });
const setLiveCostume = (costumeId: string, hairId = '') =>
  callRpc('Costume:SetLiveCostume', 'Solis.Common.Proto.Api.CostumeLiveSetRequest', { CostumeId: costumeId, HairId: hairId });
const checkCostume = (costumeId: string) =>
  callRpc('Costume:CheckCostume', 'Solis.Common.Proto.Api.CostumeCheckRequest', { CostumeId: costumeId });
const checkBulk = (costumeIds: string[], hairIds: string[]) =>
  callRpc('Costume:CheckBulk', 'Solis.Common.Proto.Api.CostumeCheckBulkRequest', { CostumeIds: costumeIds, HairIds: hairIds });
const checkHair = (hairId: string) =>
  callRpc('Hair:CheckHair', 'Solis.Common.Proto.Api.HairCheckRequest', { HairId: hairId });

// --- Excursion:Finish posts its gift and Gift:Receive persists the item ---
const excursionList = await callRpc(
  'Excursion:List',
  'Solis.Common.Proto.Api.ExcursionListRequest',
  { CharacterId: 'char-ai' },
);
const excursionPlaceId = String(excursionList.ExcursionPlaceIds?.[0] ?? '');
check('Excursion:List offers a place for char-ai', !!excursionPlaceId);
await callRpc('Excursion:Start', 'Solis.Common.Proto.Api.ExcursionStartRequest', {
  CharacterId: 'char-ai',
  ExcursionPlaceId: excursionPlaceId,
});
const excursionFinish = await callRpc(
  'Excursion:Finish',
  'Solis.Common.Proto.Api.ExcursionFinishRequest',
  { CostumeId: 'cos-ai-idol-02', HairId: 'hair-ai-idol-02', GazeReactionNumbers: [] },
);
const outingReward = (excursionFinish.RewardResults ?? [])[0];
check(
  'Excursion:Finish returns the character gift as a gift reward',
  !!outingReward &&
    Number(outingReward.IsGift) === 1 &&
    outingReward.ResourceId === 'item-enjoy-present-sp-ai' &&
    Number(outingReward.AmountI64) === 1,
);
const finishNotifications = (excursionFinish.CommonResponse?.UpdatedData?.Notifications ?? []) as any[];
const finishGiftNotification = finishNotifications.find(
  (n: any) => Number(n.NotificationType) === 3,
);
check(
  'Excursion:Finish lights the Gift notification in UpdatedData',
  !!finishGiftNotification && !!finishGiftNotification.Valid,
);
const finishStoredGiftNotifications = (await listElements(SERVER_USER_ID, 'Notifications')).filter(
  (n: any) => Number(n.NotificationType) === 3,
);
check(
  'Excursion:Finish stores exactly one valid Gift notification',
  finishStoredGiftNotifications.length === 1 && !!finishStoredGiftNotifications[0]?.Valid,
);
const outingGiftList = await listGifts();
const outingGift = (outingGiftList.Gifts ?? []).find(
  (g: any) => g.ResourceId === outingReward?.ResourceId,
);
check('Gift:List shows the outing gift', !!outingGift && Number(outingGift.Amount) === 1);
const outingHome = await callRpc('Home:Enter', 'Solis.Common.Proto.Api.HomeEnterRequest', { SkipUpdate: false });
check(
  'Home:Enter reports HasReceivableGift while the outing gift waits',
  Number(outingHome.HasReceivableGift ?? 0) === 1,
);

const outingItemBefore = await getItemAmount(SERVER_USER_ID, String(outingReward?.ResourceId ?? ''));
const outingReceive = await receiveGifts([String(outingGift?.GiftId ?? '')]);
const outingUpdatedItem = (outingReceive.CommonResponse?.UpdatedData?.Items ?? []).find(
  (i: any) => i.ItemId === outingReward?.ResourceId,
);
check(
  'Gift:Receive reports the outing gift item',
  Number(outingUpdatedItem?.Amount ?? -1) === outingItemBefore + 1,
);
const outingItems = await listElements(SERVER_USER_ID, 'Items');
const outingItemAfter = Number(
  outingItems.find((i: any) => i.ItemId === outingReward?.ResourceId)?.Amount ?? 0,
);
check('Gift:Receive stores the outing gift in Items', outingItemAfter === outingItemBefore + 1);

// The outing gift was the only one in the box, so receiving it empties the box
// and must clear the present-box badge.
const receiveNotifications = (outingReceive.CommonResponse?.UpdatedData?.Notifications ?? []) as any[];
const receiveGiftNotification = receiveNotifications.find(
  (n: any) => Number(n.NotificationType) === 3,
);
check(
  'Gift:Receive clears the Gift notification in UpdatedData',
  !!receiveGiftNotification && !receiveGiftNotification.Valid,
);
const afterReceiveGiftNotifications = (await listElements(SERVER_USER_ID, 'Notifications')).filter(
  (n: any) => Number(n.NotificationType) === 3,
);
check(
  'Gift:Receive clears the stored Gift notification when the box is empty',
  afterReceiveGiftNotifications.length === 1 && !afterReceiveGiftNotifications[0]?.Valid,
);
const emptiedHome = await callRpc('Home:Enter', 'Solis.Common.Proto.Api.HomeEnterRequest', { SkipUpdate: false });
check(
  'Home:Enter clears HasReceivableGift once the gift box is empty',
  Number(emptiedHome.HasReceivableGift ?? 0) === 0,
);

// --- Company:UseEnjoyObtainPointItem spends a gift for CompanyEnjoyPoint ---
const enjoyBefore = await userGet();
const enjoyCharacterBefore = (enjoyBefore.Characters ?? []).find(
  (c: any) => c.CharacterId === 'char-ai',
);
const enjoyPointBefore = Number(enjoyCharacterBefore?.CompanyEnjoyPoint ?? 0);
const enjoyItemBefore = await getItemAmount(SERVER_USER_ID, 'item-enjoy-present-sp-ai');
const enjoyResp = await callRpc(
  'Company:UseEnjoyObtainPointItem',
  'Solis.Common.Proto.Api.CompanyUseObtainEnjoyPointItemRequest',
  { CharacterId: 'char-ai', ItemId: 'item-enjoy-present-sp-ai', ConsumptionItemAmount: 1 },
);
const enjoyItemAfter = await getItemAmount(SERVER_USER_ID, 'item-enjoy-present-sp-ai');
check(
  'Company:UseEnjoyObtainPointItem consumes one gift item',
  enjoyItemAfter === enjoyItemBefore - 1,
);
const enjoyUpdatedItem = (enjoyResp.CommonResponse?.UpdatedData?.Items ?? []).find(
  (i: any) => i.ItemId === 'item-enjoy-present-sp-ai',
);
const enjoyDeletedItem = (enjoyResp.CommonResponse?.DeletedData?.Items ?? []).find(
  (i: any) => i.ItemId === 'item-enjoy-present-sp-ai',
);
check(
  'Company:UseEnjoyObtainPointItem reports the changed stack',
  enjoyItemAfter === 0
    ? !!enjoyDeletedItem
    : Number(enjoyUpdatedItem?.Amount ?? -1) === enjoyItemAfter,
);
const enjoyCharacter = (enjoyResp.CommonResponse?.UpdatedData?.Characters ?? []).find(
  (c: any) => c.CharacterId === 'char-ai',
);
check(
  'Company:UseEnjoyObtainPointItem adds the master ObtainPoint',
  Number(enjoyCharacter?.CompanyEnjoyPoint ?? 0) === enjoyPointBefore + 150,
);
const enjoyPersisted = await userGet();
const enjoyPersistedPoint = Number(
  (enjoyPersisted.Characters ?? []).find((c: any) => c.CharacterId === 'char-ai')
    ?.CompanyEnjoyPoint ?? 0,
);
check(
  'Company:UseEnjoyObtainPointItem persists CompanyEnjoyPoint',
  enjoyPersistedPoint === enjoyPointBefore + 150,
);

let enjoyInsufficientThrew = false;
try {
  await callRpc(
    'Company:UseEnjoyObtainPointItem',
    'Solis.Common.Proto.Api.CompanyUseObtainEnjoyPointItemRequest',
    {
      CharacterId: 'char-ai',
      ItemId: 'item-enjoy-present-sp-ai',
      ConsumptionItemAmount: enjoyItemAfter + 1,
    },
  );
} catch {
  enjoyInsufficientThrew = true;
}
check('Company:UseEnjoyObtainPointItem rejects insufficient items', enjoyInsufficientThrew);
const enjoyAfterReject = await userGet();
const enjoyRejectPoint = Number(
  (enjoyAfterReject.Characters ?? []).find((c: any) => c.CharacterId === 'char-ai')
    ?.CompanyEnjoyPoint ?? 0,
);
check(
  'Company:UseEnjoyObtainPointItem rejection changes nothing',
  enjoyRejectPoint === enjoyPointBefore + 150 &&
    (await getItemAmount(SERVER_USER_ID, 'item-enjoy-present-sp-ai')) === enjoyItemAfter,
);

// --- Item:Sell sells an owned item stack for gold ---
const sellableItem = (await db.select().from(masterItem)).find((i) => Number(i.SalePrice ?? 0) > 0);
check('Item:Sell test found a sellable master item', !!sellableItem);
if (sellableItem) {
  const sellId = sellableItem.Id;
  const sellPrice = Number(sellableItem.SalePrice);
  const sellItem = (amount: number) =>
    callRpc('Item:Sell', 'Solis.Common.Proto.Api.ItemSellRequest', { ItemId: sellId, Amount: amount });
  const goldOf = async () =>
    Number((await db.select().from(players).where(eq(players.id, SERVER_USER_ID)).limit(1))[0]?.gold ?? 0);

  await grantPromotionItem(SERVER_USER_ID, sellId, 5);
  const sellOwned = await getItemAmount(SERVER_USER_ID, sellId);
  const sellGoldBefore = await goldOf();

  const sellResp = await sellItem(2);
  check('Item:Sell reduces the stack', (await getItemAmount(SERVER_USER_ID, sellId)) === sellOwned - 2);
  check('Item:Sell grants SalePrice per item', (await goldOf()) === sellGoldBefore + 2 * sellPrice);
  check(
    'Item:Sell reports the remaining stack in UpdatedData.Items',
    Number(sellResp.CommonResponse?.UpdatedData?.Items?.[0]?.Amount ?? -1) === sellOwned - 2 &&
      sellResp.CommonResponse?.UpdatedData?.Items?.[0]?.ItemId === sellId,
  );
  check(
    'Item:Sell reports the gold total in UpdatedData.Points',
    Number(
      (sellResp.CommonResponse?.UpdatedData?.Points ?? []).find((p: any) => Number(p.PointType) === 1)?.Amount ?? -1,
    ) === sellGoldBefore + 2 * sellPrice,
  );

  let sellTooManyThrew = false;
  try {
    await sellItem(sellOwned);
  } catch {
    sellTooManyThrew = true;
  }
  check('Item:Sell rejects selling more than owned', sellTooManyThrew);

  let sellZeroThrew = false;
  try {
    await sellItem(0);
  } catch {
    sellZeroThrew = true;
  }
  check('Item:Sell rejects a non-positive amount', sellZeroThrew);

  const sellAllResp = await sellItem(sellOwned - 2);
  check('Item:Sell empties the stack', (await getItemAmount(SERVER_USER_ID, sellId)) === 0);
  check(
    'Item:Sell reports the emptied stack in DeletedData.Items',
    sellAllResp.CommonResponse?.DeletedData?.Items?.[0]?.ItemId === sellId,
  );
}

const costumeResp = await setCostume('cos-ai-idol-02', 'hair-ai-idol-02');
const costumeChar = costumeResp.CommonResponse?.UpdatedData?.Characters?.[0];
check('Costume:SetCostume returns UpdatedData.Characters', (costumeResp.CommonResponse?.UpdatedData?.Characters?.length ?? 0) === 1);
check('Costume:SetCostume sets FavoriteCostumeId', costumeChar?.FavoriteCostumeId === 'cos-ai-idol-02');
check('Costume:SetCostume sets FavoriteHairId', costumeChar?.FavoriteHairId === 'hair-ai-idol-02');

const afterCostume = await userGet();
const aiChar = afterCostume.Characters?.find((c: any) => c.CharacterId === 'char-ai');
check('Costume:SetCostume persisted FavoriteCostumeId via User:Get', aiChar?.FavoriteCostumeId === 'cos-ai-idol-02');
check('Costume:SetCostume persisted FavoriteHairId via User:Get', aiChar?.FavoriteHairId === 'hair-ai-idol-02');

const liveResp = await setLiveCostume('cos-ai-trng-00', 'hair-ai-trng-00');
const liveChar = liveResp.CommonResponse?.UpdatedData?.Characters?.[0];
check('Costume:SetLiveCostume sets LiveCostumeId', liveChar?.LiveCostumeId === 'cos-ai-trng-00');
check('Costume:SetLiveCostume sets LiveHairId', liveChar?.LiveHairId === 'hair-ai-trng-00');
const afterLive = await userGet();
const aiCharLive = afterLive.Characters?.find((c: any) => c.CharacterId === 'char-ai');
check('Costume:SetLiveCostume persisted LiveCostumeId via User:Get', aiCharLive?.LiveCostumeId === 'cos-ai-trng-00');
check('Costume:SetLiveCostume did not disturb FavoriteCostumeId', aiCharLive?.FavoriteCostumeId === 'cos-ai-idol-02');

const checkResp = await checkCostume('cos-ai-idol-02');
check('Costume:CheckCostume marks the costume Checked', Boolean(checkResp.CommonResponse?.UpdatedData?.Costumes?.[0]?.Checked));
const afterCheck = await userGet();
const checkedCos = afterCheck.Costumes?.find((c: any) => c.CostumeId === 'cos-ai-idol-02');
check('Costume:CheckCostume persisted Checked via User:Get', Boolean(checkedCos?.Checked));

const bulkResp = await checkBulk(['cos-aoi-idol-02'], ['hair-ai-idol-02']);
check('Costume:CheckBulk returns UpdatedData.Costumes', (bulkResp.CommonResponse?.UpdatedData?.Costumes?.length ?? 0) === 1);
check('Costume:CheckBulk returns UpdatedData.Hairs', (bulkResp.CommonResponse?.UpdatedData?.Hairs?.length ?? 0) === 1);
check('Costume:CheckBulk marks costume Checked', Boolean(bulkResp.CommonResponse?.UpdatedData?.Costumes?.[0]?.Checked));
check('Costume:CheckBulk marks hair Checked', Boolean(bulkResp.CommonResponse?.UpdatedData?.Hairs?.[0]?.Checked));

const hairResp = await checkHair('hair-ai-trng-00');
check('Hair:CheckHair returns UpdatedData.Hairs', (hairResp.CommonResponse?.UpdatedData?.Hairs?.length ?? 0) === 1);
check('Hair:CheckHair marks the hair Checked', Boolean(hairResp.CommonResponse?.UpdatedData?.Hairs?.[0]?.Checked));

let costumeThrew = false;
try {
  await setCostume('cos-does-not-exist');
} catch {
  costumeThrew = true;
}
check('Costume:SetCostume rejects an unknown costume', costumeThrew);

let hairMismatchThrew = false;
try {
  await setCostume('cos-ai-idol-02', 'hair-aoi-idol-02');
} catch {
  hairMismatchThrew = true;
}
check('Costume:SetCostume rejects a hair owned by another character', hairMismatchThrew);

// --- Accessory:Sell (uncaptured: schema-built, dbtest-validated) ---
const sellAccessory = (accessoryId: string, count: number) =>
  callRpc('Accessory:Sell', 'Solis.Common.Proto.Api.AccessorySellRequest', { AccessoryId: accessoryId, Count: count });

const accBefore = await userGet();
const accGoldBefore = Number(accBefore.Points?.find((p: any) => p.PointType === 1)?.Amount ?? 0);
const accOwnedBefore = Number(accBefore.Accessories?.find((a: any) => a.AccessoryId === 'ac-1-dance-01')?.Amount ?? 0);

const sellResp = await sellAccessory('ac-1-dance-01', 1);
check('Accessory:Sell returns UpdatedData.Accessories', (sellResp.CommonResponse?.UpdatedData?.Accessories?.length ?? 0) === 1);
check('Accessory:Sell decrements the owned amount', Number(sellResp.CommonResponse?.UpdatedData?.Accessories?.[0]?.Amount) === accOwnedBefore - 1);
check('Accessory:Sell credits Points (gold) at SalePrice', Number(sellResp.CommonResponse?.UpdatedData?.Points?.[0]?.Amount) === accGoldBefore + 10);

const accAfter = await userGet();
check('Accessory:Sell persisted the reduced amount via User:Get',
  Number(accAfter.Accessories?.find((a: any) => a.AccessoryId === 'ac-1-dance-01')?.Amount ?? -1) === accOwnedBefore - 1);
check('Accessory:Sell persisted gold via User:Get',
  Number(accAfter.Points?.find((p: any) => p.PointType === 1)?.Amount ?? 0) === accGoldBefore + 10);

const goldBeforeFull = Number((await userGet()).Points?.find((p: any) => p.PointType === 1)?.Amount ?? 0);
const soldOutId = 'ac-1-visual-01';
const soldOutAmount = Number(accAfter.Accessories?.find((a: any) => a.AccessoryId === soldOutId)?.Amount ?? 0);
const sellAllResp = await sellAccessory(soldOutId, soldOutAmount);
check('Accessory:Sell reports the emptied stack in DeletedData', (sellAllResp.CommonResponse?.DeletedData?.Accessories?.length ?? 0) === 1);
check('Accessory:Sell credits gold for the full stack', Number(sellAllResp.CommonResponse?.UpdatedData?.Points?.[0]?.Amount) === goldBeforeFull + 10 * soldOutAmount);
const accAfterAll = await userGet();
check('Accessory:Sell removes an emptied stack from the collection',
  !accAfterAll.Accessories?.some((a: any) => a.AccessoryId === soldOutId));

let sellThrew = false;
const goldBeforeOversell = Number((await userGet()).Points?.find((p: any) => p.PointType === 1)?.Amount ?? 0);
try {
  await sellAccessory('ac-1-dance-01', 99999);
} catch {
  sellThrew = true;
}
const goldAfterOversell = Number((await userGet()).Points?.find((p: any) => p.PointType === 1)?.Amount ?? 0);
check('Accessory:Sell rejects selling more than owned', sellThrew);
check('Accessory:Sell failed sale does not change gold', goldAfterOversell === goldBeforeOversell);

// --- Profile customization / equip (uncaptured: schema-built, dbtest-validated) ---
const updateProfile = (name: string, req: any) =>
  callRpc(name, `Solis.Common.Proto.Api.Profile${name.split(':')[1]}Request`, req);

const profBefore = await userGet();
const ownedPhotoId = String(profBefore.Photos?.[0]?.PhotoId ?? '');
const ownedDecorationId = String(profBefore.Decorations?.[0]?.DecorationId ?? '');
const ownedEmblemId = String(profBefore.Emblems?.[0]?.EmblemId ?? '');
const ownedCharacterId = String(profBefore.Characters?.[0]?.CharacterId ?? '');
const ownedCardIds: string[] = (profBefore.Cards ?? []).map((c: any) => String(c.CardId));
const buddyCardId = ownedCardIds.find((c) => c !== String(profBefore.User?.BuddyCardId)) ?? ownedCardIds[0];

const msgResp = await updateProfile('Profile:UpdateMessage', { Message: 'hello from dbtest' });
check('Profile:UpdateMessage returns UpdatedData.Profile', !!msgResp.CommonResponse?.UpdatedData?.Profile);
check('Profile:UpdateMessage sets the message', msgResp.CommonResponse?.UpdatedData?.Profile?.Message === 'hello from dbtest');
const afterMsg = await userGet();
check('Profile:UpdateMessage persisted via User:Get', afterMsg.Profile?.Message === 'hello from dbtest');

const bgResp = await updateProfile('Profile:UpdateBackground', {
  BackgroundType: 2,
  FavoriteCardId: buddyCardId,
  FavoritePhotoId: ownedPhotoId,
  FavoriteCardDisplayType: 2,
});
const bgProfile = bgResp.CommonResponse?.UpdatedData?.Profile;
check('Profile:UpdateBackground sets BackgroundType', Number(bgProfile?.BackgroundType) === 2);
check('Profile:UpdateBackground sets FavoritePhotoId', bgProfile?.FavoritePhotoId === ownedPhotoId);
check('Profile:UpdateBackground sets FavoriteCardId', bgProfile?.FavoriteCardId === buddyCardId);
check('Profile:UpdateBackground sets FavoriteCardDisplayType', Number(bgProfile?.FavoriteCardDisplayType) === 2);
const afterBg = await userGet();
check('Profile:UpdateBackground persisted FavoritePhotoId via User:Get', afterBg.Profile?.FavoritePhotoId === ownedPhotoId);
check('Profile:UpdateBackground persisted FavoriteCardId via User:Get', afterBg.Profile?.FavoriteCardId === buddyCardId);

const decoResp = await updateProfile('Profile:UpdateDecoration', { DecorationId: ownedDecorationId });
check('Profile:UpdateDecoration sets DecorationId', decoResp.CommonResponse?.UpdatedData?.Profile?.DecorationId === ownedDecorationId);
const afterDeco = await userGet();
check('Profile:UpdateDecoration persisted via User:Get', afterDeco.Profile?.DecorationId === ownedDecorationId);

const favResp = await updateProfile('Profile:UpdateFavoriteCharacters', { FavoriteCharacterIds: [ownedCharacterId] });
check('Profile:UpdateFavoriteCharacters sets FavoriteCharacterIds',
  String(favResp.CommonResponse?.UpdatedData?.Profile?.FavoriteCharacterIds?.[0]) === ownedCharacterId);
const afterFav = await userGet();
check('Profile:UpdateFavoriteCharacters persisted via User:Get',
  String(afterFav.Profile?.FavoriteCharacterIds?.[0]) === ownedCharacterId);

const emblemResp = await updateProfile('Profile:UpdateEmblem', { EmblemId: ownedEmblemId });
check('Profile:UpdateEmblem returns UpdatedData.User', !!emblemResp.CommonResponse?.UpdatedData?.User);
check('Profile:UpdateEmblem sets EmblemId', emblemResp.CommonResponse?.UpdatedData?.User?.EmblemId === ownedEmblemId);
const afterEmblem = await userGet();
check('Profile:UpdateEmblem persisted via User:Get', afterEmblem.User?.EmblemId === ownedEmblemId);

const buddyResp = await updateProfile('Profile:UpdateBuddyCard', { CardId: buddyCardId });
check('Profile:UpdateBuddyCard sets BuddyCardId', buddyResp.CommonResponse?.UpdatedData?.User?.BuddyCardId === buddyCardId);
const afterBuddy = await userGet();
check('Profile:UpdateBuddyCard persisted via User:Get', afterBuddy.User?.BuddyCardId === buddyCardId);

const layoutResp = await updateProfile('Profile:UpdateLayout', { LayoutType: 3, InformationType: 2, ColorType: 4 });
const layoutProfile = layoutResp.CommonResponse?.UpdatedData?.Profile;
check('Profile:UpdateLayout sets LayoutType', Number(layoutProfile?.LayoutType) === 3);
check('Profile:UpdateLayout sets InformationType', Number(layoutProfile?.InformationType) === 2);
check('Profile:UpdateLayout sets ColorType', Number(layoutProfile?.ColorType) === 4);
const afterLayout = await userGet();
check('Profile:UpdateLayout persisted via User:Get',
  Number(afterLayout.Profile?.LayoutType) === 3 && Number(afterLayout.Profile?.ColorType) === 4);

const bdayResp = await updateProfile('Profile:UpdateBirthday', { Month: 7, Day: 23 });
const bdayProfile = bdayResp.CommonResponse?.UpdatedData?.Profile;
check('Profile:UpdateBirthday sets BirthMonth', Number(bdayProfile?.BirthMonth) === 7);
check('Profile:UpdateBirthday sets BirthDay', Number(bdayProfile?.BirthDay) === 23);
const afterBday = await userGet();
check('Profile:UpdateBirthday persisted via User:Get',
  Number(afterBday.Profile?.BirthMonth) === 7 && Number(afterBday.Profile?.BirthDay) === 23);

// --- Profile:FindUser finds only the caller's own profile ---
const findUser = (userId: string) =>
  callRpc('Profile:FindUser', 'Solis.Common.Proto.Api.ProfileFindUserRequest', { UserId: userId });
const findSelfBefore = await userGet();
const foundByPublicId = await findUser(TEST_PUBLIC_USER_ID);
check('Profile:FindUser finds the caller by public user id', foundByPublicId.UserId === SERVER_USER_ID);
check('Profile:FindUser returns the caller name', foundByPublicId.Name === String(findSelfBefore.User?.Name ?? ''));
check(
  'Profile:FindUser returns the profile message',
  foundByPublicId.Message === String(findSelfBefore.Profile?.Message ?? ''),
);
check('Profile:FindUser returns a hierarchy grade', !!foundByPublicId.HierarchyCurrentDetailGradeId);
check('Profile:FindUser carries a CommonResponse', foundByPublicId.CommonResponse != null);
check(
  'Profile:FindUser returns the favourite photo set on the profile',
  String(foundByPublicId.FavoritePhoto?.PhotoId ?? '') === String(findSelfBefore.Profile?.FavoritePhotoId ?? ''),
);
check(
  'Profile:FindUser returns the favourite card set on the profile',
  String(foundByPublicId.FavoriteCard?.CardId ?? '') === String(findSelfBefore.Profile?.FavoriteCardId ?? ''),
);
const foundByServerId = await findUser(SERVER_USER_ID);
check('Profile:FindUser finds the caller by server user id', foundByServerId.UserId === SERVER_USER_ID);
// A second player on the same server can be found by either id.
const OTHER_ACCOUNT_ID = 'dbtest-account-0000-4000-8000-000000000002';
const OTHER_USER_ID = 'dbtest-user-0000-4000-8000-000000000002';
const OTHER_PUBLIC_USER_ID = 'DBTEST02';
await db.delete(players).where(eq(players.id, OTHER_USER_ID));
await db.delete(accounts).where(eq(accounts.id, OTHER_ACCOUNT_ID));
await db.insert(accounts).values({
  id: OTHER_ACCOUNT_ID,
  firebaseUid: 'dbtest-firebase-uid-0002',
  seedId: OTHER_PUBLIC_USER_ID,
  displayName: 'OtherPlayer',
  lastLoginAt: new Date(),
});
await db.insert(players).values({
  id: OTHER_USER_ID,
  accountId: OTHER_ACCOUNT_ID,
  name: 'OtherPlayer',
  level: 7,
  data: { publicUserId: OTHER_PUBLIC_USER_ID },
});
const foundOther = await findUser(OTHER_PUBLIC_USER_ID);
check(
  'Profile:FindUser finds another player by public user id',
  foundOther.UserId === OTHER_USER_ID && foundOther.Name === 'OtherPlayer' && Number(foundOther.ManagerLevel) === 7,
);
check('Profile:FindUser finds another player by server user id', (await findUser(OTHER_USER_ID)).UserId === OTHER_USER_ID);
await db.delete(players).where(eq(players.id, OTHER_USER_ID));
await db.delete(accounts).where(eq(accounts.id, OTHER_ACCOUNT_ID));
const foundNobody = await findUser('NOSUCHUSER');
check(
  'Profile:FindUser returns an empty profile for an unknown id',
  !foundNobody.UserId && !foundNobody.Name && foundNobody.CommonResponse != null,
);
let findUserEmptyThrew = false;
try {
  await findUser('');
} catch {
  findUserEmptyThrew = true;
}
check('Profile:FindUser rejects an empty user id', findUserEmptyThrew);

const newName = `dbname-${Date.now().toString(36)}`;
const nameResp = await updateProfile('Profile:UpdateName', { Name: newName });
check('Profile:UpdateName returns UpdatedData.User', nameResp.CommonResponse?.UpdatedData?.User?.Name === newName);
const afterName = await userGet();
check('Profile:UpdateName persisted to the player row via User:Get', afterName.User?.Name === newName);
// Restore the captured name so the suite stays idempotent across runs.
await updateProfile('Profile:UpdateName', { Name: 'Player' });

let decoThrew = false;
try {
  await updateProfile('Profile:UpdateDecoration', { DecorationId: 'deco-does-not-exist' });
} catch {
  decoThrew = true;
}
check('Profile:UpdateDecoration rejects an unowned decoration', decoThrew);

let photoThrew = false;
try {
  await updateProfile('Profile:UpdateBackground', { FavoritePhotoId: 'photo-does-not-exist' });
} catch {
  photoThrew = true;
}
check('Profile:UpdateBackground rejects an unowned photo', photoThrew);

let emblemThrew = false;
try {
  await updateProfile('Profile:UpdateEmblem', { EmblemId: 'emb-nope' });
} catch {
  emblemThrew = true;
}
check('Profile:UpdateEmblem rejects an unowned emblem', emblemThrew);

let favThrew = false;
try {
  await updateProfile('Profile:UpdateFavoriteCharacters', { FavoriteCharacterIds: ['char-nope'] });
} catch {
  favThrew = true;
}
check('Profile:UpdateFavoriteCharacters rejects an unowned character', favThrew);

// --- Profile:Top / friend lists (sandbox: no other players) ---
const profileTopShape = msgRegistry.get(endpoints['Profile']['Top'].response)!;
const profileTop = decodeMessage(
  profileTopShape,
  new Reader(Uint8Array.from(await dispatchRpc('Profile:Top', Buffer.alloc(0), authOpts))),
) as any;
check('Profile:Top returns an empty friend profile list', (profileTop.FriendProfiles?.length ?? 0) === 0);
const hierarchyGradeId = String(profileTop.HierarchyCurrentDetailGradeId ?? '');
check('Profile:Top returns a hierarchy detail grade', hierarchyGradeId.length > 0);
check('Profile:Top hierarchy grade exists in master data', (await getHierarchyDetailGrade(hierarchyGradeId)) !== null);

const friendListShape = msgRegistry.get(endpoints['Friend']['List'].response)!;
const friendListResponse = decodeMessage(
  friendListShape,
  new Reader(Uint8Array.from(await dispatchRpc('Friend:List', Buffer.alloc(0), authOpts))),
) as any;
check('Friend:List returns an empty profile list', (friendListResponse.Profiles?.length ?? 0) === 0);
const friendSearch = decodeMessage(
  msgRegistry.get(endpoints['Friend']['Search'].response)!,
  new Reader(Uint8Array.from(await dispatchRpc('Friend:Search', Buffer.alloc(0), authOpts))),
) as any;
check('Friend:Search returns an empty suggested-user list', (friendSearch.Profiles?.length ?? 0) === 0);

// --- Friend requests between two players ---
// The second player cannot authenticate in this test, so its side is driven
// through insertPending / direct table access.
const FRIEND_ACCOUNT_ID = 'dbtest-account-0000-4000-8000-000000000003';
const FRIEND_USER_ID = 'dbtest-user-0000-4000-8000-000000000003';
const FRIEND_PUBLIC_ID = 'DBTEST03';

const clearFriendLinks = () =>
  db.delete(playerFriendLinks).where(
    or(
      inArray(playerFriendLinks.fromPlayerId, [FRIEND_USER_ID, SERVER_USER_ID]),
      inArray(playerFriendLinks.toPlayerId, [FRIEND_USER_ID, SERVER_USER_ID]),
    ),
  );
await clearFriendLinks();
await db.delete(players).where(eq(players.id, FRIEND_USER_ID));
await db.delete(accounts).where(eq(accounts.id, FRIEND_ACCOUNT_ID));
await db.insert(accounts).values({
  id: FRIEND_ACCOUNT_ID,
  firebaseUid: 'dbtest-firebase-uid-0003',
  seedId: FRIEND_PUBLIC_ID,
  displayName: 'FriendPlayer',
  lastLoginAt: new Date(),
});
await db.insert(players).values({
  id: FRIEND_USER_ID,
  accountId: FRIEND_ACCOUNT_ID,
  name: 'FriendPlayer',
  level: 9,
  data: { publicUserId: FRIEND_PUBLIC_ID },
});

const friendRpc = (method: string, req: any) =>
  callRpc(`Friend:${method}`, `Solis.Common.Proto.Api.Friend${method}Request`, req);
const friendList = async (method: string) =>
  decodeMessage(
    msgRegistry.get((endpoints as any)['Friend'][method].response)!,
    new Reader(Uint8Array.from(await dispatchRpc(`Friend:${method}`, Buffer.alloc(0), authOpts))),
  ) as any;

const friendApply = await friendRpc('Apply', { UserId: FRIEND_PUBLIC_ID });
check('Friend:Apply creates a pending request', !!friendApply.Applied);
const friendApplying = await friendList('ListApplying');
check(
  'Friend:ListApplying lists the target profile',
  friendApplying.Profiles?.length === 1 &&
    friendApplying.Profiles[0].UserId === FRIEND_PUBLIC_ID &&
    friendApplying.Profiles[0].Name === 'FriendPlayer' &&
    Number(friendApplying.Profiles[0].ManagerLevel) === 9,
);

const friendApplyAgain = await friendRpc('Apply', { UserId: FRIEND_PUBLIC_ID });
check(
  'Friend:Apply reports an existing outgoing request',
  !!friendApplyAgain.IsAlreadyOffering && !friendApplyAgain.Applied,
);

const friendApplyMissing = await friendRpc('Apply', { UserId: 'NOSUCHUSER' });
check('Friend:Apply reports an unknown user as deleted', !!friendApplyMissing.IsAccountDeleted);
const friendApplySelf = await friendRpc('Apply', { UserId: TEST_PUBLIC_USER_ID });
check('Friend:Apply reports the caller as deleted', !!friendApplySelf.IsAccountDeleted);

await friendRpc('Cancel', { UserId: FRIEND_PUBLIC_ID });
check(
  'Friend:Cancel removes the outgoing request',
  ((await friendList('ListApplying')).Profiles?.length ?? 0) === 0,
);

await insertPending(FRIEND_USER_ID, SERVER_USER_ID);
const friendApplied = await friendList('ListApplied');
check(
  'Friend:ListApplied lists the incoming request',
  friendApplied.Profiles?.length === 1 && friendApplied.Profiles[0].UserId === FRIEND_PUBLIC_ID,
);
const friendApplyIncoming = await friendRpc('Apply', { UserId: FRIEND_PUBLIC_ID });
check(
  'Friend:Apply reports an existing incoming request',
  !!friendApplyIncoming.IsAlreadyOffered,
);

const friendReject = await friendRpc('Reject', { UserId: FRIEND_PUBLIC_ID });
check('Friend:Reject removes the incoming request', !friendReject.IsOfferDeleted);
check(
  'Friend:ListApplied is empty after rejecting',
  ((await friendList('ListApplied')).Profiles?.length ?? 0) === 0,
);
const friendRejectAgain = await friendRpc('Reject', { UserId: FRIEND_PUBLIC_ID });
check('Friend:Reject reports a missing offer', !!friendRejectAgain.IsOfferDeleted);

await insertPending(FRIEND_USER_ID, SERVER_USER_ID);
const friendApprove = await friendRpc('Approve', { UserId: FRIEND_PUBLIC_ID });
check('Friend:Approve accepts the request', !!friendApprove.Approved);
const friendFriends = await friendList('List');
check(
  'Friend:List lists the new friend',
  friendFriends.Profiles?.length === 1 && friendFriends.Profiles[0].UserId === FRIEND_PUBLIC_ID,
);
const profileTopWithFriend = decodeMessage(
  msgRegistry.get(endpoints['Profile']['Top'].response)!,
  new Reader(Uint8Array.from(await dispatchRpc('Profile:Top', Buffer.alloc(0), authOpts))),
) as any;
check(
  'Profile:Top lists the new friend in FriendProfiles',
  profileTopWithFriend.FriendProfiles?.length === 1 &&
    profileTopWithFriend.FriendProfiles?.[0]?.UserId === FRIEND_PUBLIC_ID,
);
check(
  'Friend:ListApplied is empty after approving',
  ((await friendList('ListApplied')).Profiles?.length ?? 0) === 0,
);
const friendApproveAgain = await friendRpc('Approve', { UserId: FRIEND_PUBLIC_ID });
check('Friend:Approve reports a missing offer', !!friendApproveAgain.IsOfferDeleted);
const friendApplyFriend = await friendRpc('Apply', { UserId: FRIEND_PUBLIC_ID });
check('Friend:Apply reports an existing friend', !!friendApplyFriend.IsAlreadyFriend);

await friendRpc('Delete', { UserIds: [FRIEND_PUBLIC_ID] });
check('Friend:Delete removes the friendship', ((await friendList('List')).Profiles?.length ?? 0) === 0);

await friendRpc('Apply', { UserId: FRIEND_PUBLIC_ID });
await friendList('CancelAll');
check(
  'Friend:CancelAll removes the outgoing requests',
  ((await friendList('ListApplying')).Profiles?.length ?? 0) === 0,
);

await clearFriendLinks();
await db.delete(players).where(eq(players.id, FRIEND_USER_ID));
await db.delete(accounts).where(eq(accounts.id, FRIEND_ACCOUNT_ID));


// --- Slice 13: card progression (uncaptured: schema-built, dbtest-validated) ---
const inv = await import('./services/inventory.ts');
const cur = await import('./services/currency.ts');
const ps = await import('./services/playerState.ts');
const callCard = (method: string, req: any) =>
  callRpc(`Card:${method}`, `Solis.Common.Proto.Api.Card${method}Request`, req);
const itemAmt = (u: any, id: string) => Number(u.Items?.find((i: any) => i.ItemId === id)?.Amount ?? 0);
const goldAmt = (u: any) => Number(u.Points?.find((p: any) => p.PointType === 1)?.Amount ?? 0);
const cardOf = (u: any, id: string) => u.Cards?.find((c: any) => c.CardId === id);
const photoOf = (u: any, id: string) => u.Photos?.find((p: any) => p.PhotoId === id);
const accAmt = (u: any, id: string) => Number(u.Accessories?.find((a: any) => a.AccessoryId === id)?.Amount ?? 0);

await inv.grantItem(SERVER_USER_ID, 'item-card_limit_break', 100);
await inv.grantItem(SERVER_USER_ID, 'item-card_rank', 100);
await inv.grantItem(SERVER_USER_ID, 'item-card_skill', 5000);
await inv.grantItem(SERVER_USER_ID, 'item-card_support_release', 200);
await cur.grantCurrency(SERVER_USER_ID, 'freeJewel', 100000);

const lbId = 'card-ai-03-schl-00';
const lbcBefore = await userGet();
const lbRarityBefore = Number(cardOf(lbcBefore, lbId)?.Rarity ?? 0);
const lbItemBefore = itemAmt(lbcBefore, 'item-card_limit_break');
const lbcResp = await callCard('LimitBreak', { CardId: lbId, Rarity: lbRarityBefore + 1 });
const lbcAfter = await userGet();
check('Card:LimitBreak returns UpdatedData.Cards', (lbcResp.CommonResponse?.UpdatedData?.Cards?.length ?? 0) >= 1);
check('Card:LimitBreak raises the card rarity', Number(cardOf(lbcAfter, lbId)?.Rarity) === lbRarityBefore + 1);
check('Card:LimitBreak spends Bloom Pieces', itemAmt(lbcAfter, 'item-card_limit_break') === lbItemBefore - 25);
let lbThrew = false;
try {
  await callCard('LimitBreak', { CardId: lbId, Rarity: lbRarityBefore });
} catch {
  lbThrew = true;
}
check('Card:LimitBreak rejects a non-increasing rarity', lbThrew);

const ruId = 'card-hrk-03-schl-00';
const ruBefore = await userGet();
const ruRankBefore = Number(cardOf(ruBefore, ruId)?.Rank ?? 0);
const ruItemBefore = itemAmt(ruBefore, 'item-card_rank');
await callCard('RankUp', { CardId: ruId, Rank: ruRankBefore + 1 });
const ruAfter = await userGet();
check('Card:RankUp raises the card rank', Number(cardOf(ruAfter, ruId)?.Rank) === ruRankBefore + 1);
check('Card:RankUp spends Potential Pieces', itemAmt(ruAfter, 'item-card_rank') === ruItemBefore - 5);

const skId = 'card-hrk-05-casl-04';
const skBefore = await userGet();
const skItemBefore = itemAmt(skBefore, 'item-card_skill');
const skSkillId = String(cardOf(skBefore, skId)?.SkillId1 ?? '');
await callCard('SkillEnhance', { CardId: skId, SkillId: skSkillId });
const skAfter = await userGet();
check('Card:SkillEnhance raises SkillLevel1', Number(cardOf(skAfter, skId)?.SkillLevel1 ?? 0) === 2);
check('Card:SkillEnhance spends Skill Powder', itemAmt(skAfter, 'item-card_skill') === skItemBefore - 500);

let laThrew = false;
try {
  await callCard('LiveAbilityEnhance', { CardId: skId, AbilityId: 'lba-beat_score_multiply' });
} catch {
  laThrew = true;
}
check('Card:LiveAbilityEnhance rejects when the card level is below the requirement', laThrew);
let laBadThrew = false;
try {
  await callCard('LiveAbilityEnhance', { CardId: skId, AbilityId: 'lba-nope' });
} catch {
  laBadThrew = true;
}
check('Card:LiveAbilityEnhance rejects an unknown ability id', laBadThrew);
let aaThrew = false;
try {
  await callCard('ActivityAbilityEnhance', { CardId: skId, AbilityId: 'aba-nope' });
} catch {
  aaThrew = true;
}
check('Card:ActivityAbilityEnhance rejects when the card has no activity ability', aaThrew);

// --- Card skill/ability unlock (CardLevelRelease / CardEvolutionLevelRelease) ---
const { buildUserCard } = await import('./services/inventory.ts');
const { cardReleaseForCard, applyCardRelease } = await import('./services/cardRelease.ts');
const relCardId = 'card-ai-04-casl-00'; // skills 1-3 + LiveAbilityId, no SkillId4
const relMaster: any = await getMasterCard(relCardId);

const freshLv1: any = await buildUserCard(relCardId);
check('buildUserCard Lv1 emits SkillId1 only',
  !!freshLv1?.SkillId1 && !freshLv1?.SkillId2 && !freshLv1?.SkillId3 && !freshLv1?.LiveAbilityId);
check('buildUserCard Lv1 defaults skill/ability levels to 1',
  Number(freshLv1?.SkillLevel1) === 1 && Number(freshLv1?.SkillLevel2) === 1
  && Number(freshLv1?.LiveAbilityLevel) === 1 && Number(freshLv1?.ActivityAbilityLevel) === 1);
check('buildUserCard Lv1 sets PhotoEquipableCount to 2', Number(freshLv1?.PhotoEquipableCount) === 2);

const rel1 = await cardReleaseForCard(relMaster, 1, 0);
const rel20 = await cardReleaseForCard(relMaster, 20, 0);
const rel30 = await cardReleaseForCard(relMaster, 30, 0);
const rel80 = await cardReleaseForCard(relMaster, 80, 0);
check('release Lv1 unlocks skill slot 1 only',
  rel1.skillSlots.join(',') === '1' && !rel1.liveAbility && !rel1.activityAbility);
check('release Lv20 unlocks skill slots 1,2 (no ability yet)',
  rel20.skillSlots.join(',') === '1,2' && !rel20.liveAbility && !rel20.activityAbility);
check('release Lv30 unlocks live + activity abilities',
  rel30.liveAbility && rel30.activityAbility && rel30.skillSlots.join(',') === '1,2');
check('release Lv80 additionally unlocks skill slot 3',
  rel80.skillSlots.join(',') === '1,2,3');

const synthCard: any = {
  __msg: 'Solis.Common.Proto.Transaction.UserCard',
  CardId: relCardId, Level: 1, SkillId1: 'x', SkillId2: 'y', SkillId3: 'z', ActivityAbilityId: 'a',
};
applyCardRelease(synthCard, relMaster, await cardReleaseForCard(relMaster, 1, 0));
check('applyCardRelease clears ids of locked skills/abilities',
  synthCard.SkillId1 === 'sk-ai-04-casl-00-1' && synthCard.SkillId2 === undefined
  && synthCard.SkillId3 === undefined && synthCard.ActivityAbilityId === undefined);
check('applyCardRelease mirrors Base ids for unlocked entries',
  synthCard.BaseSkillId1 === 'sk-ai-04-casl-00-1' && synthCard.BaseSkillId2 === undefined);

check('buildUserCard Lv1 carries BaseLevel (client Lv badge)',
  Number(freshLv1?.BaseLevel) === 1 && Number(freshLv1?.Level) === 1);
check('buildUserCard Lv1 carries base stat mirrors + Mental/Technique + ObtainedTime',
  Number(freshLv1?.BaseVocal) === Number(freshLv1?.Vocal)
  && Number(freshLv1?.BaseStamina) === Number(freshLv1?.Stamina)
  && Number(freshLv1?.Mental) === 100 && Number(freshLv1?.Technique) === 100
  && !!freshLv1?.ObtainedTime);

const legacyCard: any = { __msg: 'Solis.Common.Proto.Transaction.UserCard', CardId: relCardId, Level: 1 };
applyCardRelease(legacyCard, relMaster, await cardReleaseForCard(relMaster, 1, 0));
check('applyCardRelease backfills BaseLevel for legacy cards without it',
  Number(legacyCard.BaseLevel) === 1 && Number(legacyCard.Mental) === 100 && !!legacyCard.ObtainedTime);

const linkMaster: any = await getMasterCard('card-hrk-05-link-00');
const linkEvo0 = await cardReleaseForCard(linkMaster, 80, 0);
const linkEvo1 = await cardReleaseForCard(linkMaster, 80, 1);
check('bond evolution unlocks skill slot 4',
  !linkEvo0.skillSlots.includes(4) && linkEvo1.skillSlots.includes(4));

const supNumber = 3;
const supCard = 'card-aoi-03-schl-00';
await callCard('SetSupport', { Number: supNumber, CardId: supCard });
const supAfter = await userGet();
check('Card:SetSupport registers the support slot',
  String((supAfter.CardSupports ?? []).find((s: any) => Number(s.Number) === supNumber)?.CardId ?? '') === supCard);
check('Card:SetSupport marks the card Supported', Boolean(cardOf(supAfter, supCard)?.Supported));
const remResp = await callCard('RemoveSupport', { Number: supNumber });
check('Card:RemoveSupport returns Rewards', (remResp.Rewards?.length ?? 0) >= 1);
const supRemoved = await userGet();
check('Card:RemoveSupport frees the support slot',
  !(supRemoved.CardSupports ?? []).some((s: any) => Number(s.Number) === supNumber));

const relBefore = await userGet();
const relCountBefore = Number(relBefore.User?.CardSupportReleaseCount ?? 0);
const relItemBefore = itemAmt(relBefore, 'item-card_support_release');
await callCard('ReleaseSupport', { UseStone: false });
const relAfter = await userGet();
check('Card:ReleaseSupport increments CardSupportReleaseCount',
  Number(relAfter.User?.CardSupportReleaseCount ?? 0) === relCountBefore + 1);
check('Card:ReleaseSupport consumes the release item',
  itemAmt(relAfter, 'item-card_support_release') === relItemBefore - 100);

const resetBefore = await userGet();
const resetJewelBefore = Number(resetBefore.Balance?.FreeBalance ?? 0);
const resetResp = await callCard('Reset', { CardId: lbId });
const resetAfter = await userGet();
check('Card:Reset returns Rewards', (resetResp.Rewards?.length ?? 0) >= 1);
check('Card:Reset returns the card to level 1', Number(cardOf(resetAfter, lbId)?.Level ?? 0) === 1);
check('Card:Reset spends CardResetStoneAmount',
  Number(resetAfter.Balance?.FreeBalance ?? 0) === resetJewelBefore - 50);

const dtId = 'card-aoi-03-schl-00';
const dtBefore = await userGet();
const dtNext = Number(cardOf(dtBefore, dtId)?.DisplayType ?? 0) === 2 ? 1 : 2;
await callCard('UpdateDisplayType', { CardId: dtId, DisplayType: dtNext });
const dtAfter = await userGet();
check('Card:UpdateDisplayType persists the display type', Number(cardOf(dtAfter, dtId)?.DisplayType) === dtNext);

// --- Slice 13: photo management (uncaptured: schema-built, dbtest-validated) ---
const callPhoto = (method: string, req: any) =>
  callRpc(`Photo:${method}`, `Solis.Common.Proto.Api.Photo${method}Request`, req);
const callPhotoEmpty = async (method: string) => {
  const respShape = (endpoints as any)['Photo'][method].response;
  return decodeMessage(
    msgRegistry.get(respShape)!,
    new Reader(Uint8Array.from(await dispatchRpc(`Photo:${method}`, Buffer.alloc(0), authOpts))),
  ) as any;
};

await inv.grantItem(SERVER_USER_ID, 'item-photo_enhance', 5000);
await inv.grantItem(SERVER_USER_ID, 'item-photo_reroll', 100);
await inv.grantItem(SERVER_USER_ID, 'item-photo_ink-basic-01', 500);
await cur.grantCurrency(SERVER_USER_ID, 'freeJewel', 100000);
await ps.putElements(SERVER_USER_ID, 'PhotoRecipes', [
  { __msg: 'Solis.Common.Proto.Transaction.UserPhotoRecipe', PhotoRecipeId: 'photo-recipe-3-1-0001' } as any,
]);

const peId = '146f46c9-7a0c-466f-b4bc-6341fcbe3f79';
const peBefore = await userGet();
const peItemBefore = itemAmt(peBefore, 'item-photo_enhance');
await callPhoto('Enhance', { PhotoId: peId, Level: 20 });
const peAfter = await userGet();
check('Photo:Enhance raises the photo level', Number(photoOf(peAfter, peId)?.Level ?? 0) === 20);
check('Photo:Enhance spends Advance Film', itemAmt(peAfter, 'item-photo_enhance') === peItemBefore - 1);
let peThrew = false;
try {
  await callPhoto('Enhance', { PhotoId: peId, Level: 15 });
} catch {
  peThrew = true;
}
check('Photo:Enhance rejects a non-increasing level', peThrew);

const extBefore = await userGet();
const extCountBefore = Number(extBefore.User?.PhotoLimitExtendedCount ?? 0);
const extJewelBefore = Number(extBefore.Balance?.FreeBalance ?? 0);
await callPhotoEmpty('ExtendLimit');
const extAfter = await userGet();
check('Photo:ExtendLimit increments PhotoLimitExtendedCount',
  Number(extAfter.User?.PhotoLimitExtendedCount ?? 0) === extCountBefore + 1);
check('Photo:ExtendLimit spends PhotoLimitExtendStone',
  Number(extAfter.Balance?.FreeBalance ?? 0) === extJewelBefore - 100);

const prId = 'a175715b-91b6-4a8a-944f-c33839a3a793';
const prBefore = await userGet();
const prItemBefore = itemAmt(prBefore, 'item-photo_reroll');
await callPhoto('Reroll', { PhotoId: prId });
const prAfter = await userGet();
check('Photo:Reroll spends Recycle Film', itemAmt(prAfter, 'item-photo_reroll') === prItemBefore - 5);

const puId = '7378d72b-8017-4000-816d-db6019bb953e';
const puName = `photo-${Date.now().toString(36)}`;
await callPhoto('Update', { PhotoId: puId, Name: puName });
const puAfter = await userGet();
check('Photo:Update sets the photo name', photoOf(puAfter, puId)?.Name === puName);

const slBefore = await userGet();
const slLockedBefore = Boolean(photoOf(slBefore, puId)?.Locked);
await callPhoto('SwitchLock', { PhotoIds: [puId] });
const slAfter = await userGet();
check('Photo:SwitchLock toggles the lock', Boolean(photoOf(slAfter, puId)?.Locked) === !slLockedBefore);

const pdId = 'a8a4fb1c-7ab2-4101-aeac-d524bba551d8';
const pdResp = await callPhoto('Delete', { PhotoIds: [pdId] });
check('Photo:Delete returns DeletedData.Photos', (pdResp.CommonResponse?.DeletedData?.Photos?.length ?? 0) === 1);
check('Photo:Delete returns RewardResults', (pdResp.RewardResults?.length ?? 0) >= 1);
const pdAfter = await userGet();
check('Photo:Delete removes the photo', !photoOf(pdAfter, pdId));

const rtId = '07e101c8-cd02-4b6a-862d-a1509a31717d';
await callPhoto('Retouch', { PhotoRecipeId: 'photo-recipe-3-1-0001', PhotoId: rtId });
const rtAfter = await userGet();
check('Photo:Retouch assigns the recipe', photoOf(rtAfter, rtId)?.PhotoRecipeId === 'photo-recipe-3-1-0001');

const srResp = await callPhoto('SaleRecipe', { PhotoRecipeIds: ['photo-recipe-3-1-0001'] });
check('Photo:SaleRecipe returns DeletedData.PhotoRecipes',
  (srResp.CommonResponse?.DeletedData?.PhotoRecipes?.length ?? 0) === 1);
check('Photo:SaleRecipe returns RewardResults', (srResp.RewardResults?.length ?? 0) >= 1);
const srAfter = await userGet();
check('Photo:SaleRecipe removes the recipe',
  !(srAfter.PhotoRecipes ?? []).some((r: any) => r.PhotoRecipeId === 'photo-recipe-3-1-0001'));

const repResp = await callPhotoEmpty('Report');
check('Photo:Report responds with IsGift=false', !!repResp && !repResp.IsGift);

// --- Photo shooting pipeline (captured on-device 2026-10-09; byte-exact shapes, server-built values) ---
await inv.grantItem(SERVER_USER_ID, 'item-photo_shooting-02', 100);
const filmBefore = itemAmt(await userGet(), 'item-photo_shooting-02');

const listShooting = async () =>
  decodeMessage(
    msgRegistry.get(endpoints['Photo']['ListShooting'].response)!,
    new Reader(Uint8Array.from(await dispatchRpc('Photo:ListShooting', Buffer.alloc(0), authOpts))),
  ) as any;

const listResp = await listShooting();
// The catalogue is condition-filtered, so the counts depend on the corpus
// player's progress; only the shape is asserted unconditionally here.
check('Photo:ListShooting returns Activities', (listResp.Activities ?? []).every((a: any) => typeof a.PhotoActivityId === 'string'));
check('Photo:ListShooting returns Musics', (listResp.Musics ?? []).every((m: any) => typeof m.MusicId === 'string'));
check('Photo:ListShooting returns Stages', (listResp.Stages ?? []).every((s: any) => typeof s.StageId === 'string'));
check('Photo:ListShooting returns Expressions', (listResp.Expressions ?? []).every((e: any) => typeof e.PhotoExpressionId === 'string'));
check('Photo:ListShooting IsUnlocked is a bool or omitted (false)',
  [...(listResp.Activities ?? []), ...(listResp.Musics ?? []), ...(listResp.Stages ?? []), ...(listResp.Expressions ?? [])]
    .every((entry: any) => entry.IsUnlocked == null || entry.IsUnlocked === 1 || entry.IsUnlocked === true));
check('Photo:ListShooting returns the pose-tutorial DokanInfo',
  (listResp.DokanInfo?.Expressions ?? []).some((d: any) => d.Id === 'dokan_photo-expression-tutorial'));

// Drive the view/unlock filtering deterministically instead of relying on the
// corpus player's progress: patch one known stage/music row through all three
// states (hidden -> visible+locked -> visible+unlocked) and restore it below.
const SHOOT_STAGE = 'stage-live-hall-00-00';
const SHOOT_MUSIC = 'music-tri-007';
const hiddenConditionId = 'cd-dbtest-photo-hidden';
await db.delete(masterCondition).where(eq(masterCondition.Id, hiddenConditionId));
await db.insert(masterCondition).values([{ Id: hiddenConditionId, Settings: [{ Term: { NowAfter: 1, NowBefore: 2 } }] }]);
const [stageBefore] = await db
  .select({ ViewConditionId: masterPhotoQuestStage.ViewConditionId, UnlockConditionId: masterPhotoQuestStage.UnlockConditionId })
  .from(masterPhotoQuestStage)
  .where(eq(masterPhotoQuestStage.Id, SHOOT_STAGE));
const [musicBefore] = await db
  .select({ ViewConditionId: masterPhotoQuestMusic.ViewConditionId, UnlockConditionId: masterPhotoQuestMusic.UnlockConditionId })
  .from(masterPhotoQuestMusic)
  .where(eq(masterPhotoQuestMusic.Id, SHOOT_MUSIC));
const patchStage = (view: string, unlock: string) =>
  db.update(masterPhotoQuestStage).set({ ViewConditionId: view, UnlockConditionId: unlock }).where(eq(masterPhotoQuestStage.Id, SHOOT_STAGE));
const patchMusic = (view: string, unlock: string) =>
  db.update(masterPhotoQuestMusic).set({ ViewConditionId: view, UnlockConditionId: unlock }).where(eq(masterPhotoQuestMusic.Id, SHOOT_MUSIC));

await patchStage(hiddenConditionId, '');
const hiddenList = await listShooting();
check('Photo:ListShooting omits an entry whose view condition fails',
  !(hiddenList.Stages ?? []).some((s: any) => s.StageId === SHOOT_STAGE));
await patchStage('', hiddenConditionId);
const lockedList = await listShooting();
const lockedStage = (lockedList.Stages ?? []).find((s: any) => s.StageId === SHOOT_STAGE);
check('Photo:ListShooting keeps a visible-but-locked stage with IsUnlocked=false',
  lockedStage !== undefined && !lockedStage.IsUnlocked);
await patchStage('', '');
await patchMusic('', '');
const openList = await listShooting();
const openStage = (openList.Stages ?? []).find((s: any) => s.StageId === SHOOT_STAGE);
const openMusic = (openList.Musics ?? []).find((m: any) => m.MusicId === SHOOT_MUSIC);
check('Photo:ListShooting unlocks a stage whose conditions are satisfied', Boolean(openStage?.IsUnlocked));
check('Photo:ListShooting unlocks a music whose conditions are satisfied', Boolean(openMusic?.IsUnlocked));

const chkShoot = await callRpc('Photo:CheckShooting', 'Solis.Common.Proto.Api.PhotoCheckShootingRequest', {
  ActionType: 3,
  PhotoMusicId: SHOOT_MUSIC,
  PhotoStageId: SHOOT_STAGE,
  CharacterIds: ['char-smr'],
  CostumeIds: ['cos-smr-schl-00'],
  HairIds: ['hair-smr-schl-00'],
});
check('Photo:CheckShooting returns CommonResponse', !!chkShoot.CommonResponse);

// Shootings must use one of the user's reserved image IDs (Solis NextPhotoImageIds).
const reservedImageId = async (): Promise<string> =>
  String(((await getSingleton(SERVER_USER_ID, 'User'))?.NextPhotoImageIds as string[] | undefined)?.[0] ?? '');
let rejectedUnknownStage = false;
try {
  await callRpc('Photo:CheckShooting', 'Solis.Common.Proto.Api.PhotoCheckShootingRequest', {
    PhotoStageId: 'stage-does-not-exist',
  });
} catch {
  rejectedUnknownStage = true;
}
check('Photo:CheckShooting rejects a non-viewable stage', rejectedUnknownStage);

const shootingReq = {
  ActionType: 3,
  PhotoMusicId: SHOOT_MUSIC,
  PhotoStageId: SHOOT_STAGE,
  CharacterIds: ['char-smr'],
  CostumeIds: ['cos-smr-schl-00'],
  HairIds: ['hair-smr-schl-00'],
  CreateShootingParams: [{
    PhotoImageId: await reservedImageId(),
    ItemId: 'item-photo_shooting-02',
    MainCharacterId: 'char-smr',
  }],
  ManualCount: 6,
};
let rejectedCreateStage = false;
try {
  await callRpc('Photo:CreateShootings', 'Solis.Common.Proto.Api.PhotoCreateShootingsRequest', {
    ...shootingReq,
    PhotoStageId: 'stage-does-not-exist',
  });
} catch {
  rejectedCreateStage = true;
}
check('Photo:CreateShootings rejects a non-viewable stage', rejectedCreateStage);

const shootResp = await callRpc('Photo:CreateShootings', 'Solis.Common.Proto.Api.PhotoCreateShootingsRequest', shootingReq);
const created = shootResp.Photos?.[0];
check('Photo:CreateShootings returns a photo', !!created?.PhotoId);
check('Photo:CreateShootings echoes PhotoImageId as AssetId', created?.AssetId === shootingReq.CreateShootingParams[0].PhotoImageId);
check('Photo:CreateShootings sets Rarity 1..5', Number(created?.Rarity) >= 1 && Number(created?.Rarity) <= 5);
check('Photo:CreateShootings sets ImageType 2 (User)', Number(created?.ImageType) === 2);
check('Photo:CreateShootings sets PlaceName from the stage master', (created?.PlaceName ?? '') !== '');
check('Photo:CreateShootings sets EventName ライブ', created?.EventName === 'ライブ');
check('Photo:CreateShootings assigns abilities', (created?.Abilities?.length ?? 0) >= 1);
check('Photo:CreateShootings returns IsGift=false', !shootResp?.IsGift);
const shootAfter = await userGet();
{
  const ids = ((await getSingleton(SERVER_USER_ID, 'User'))?.NextPhotoImageIds as string[] | undefined) ?? [];
  const usedId = shootingReq.CreateShootingParams[0].PhotoImageId;
  check('Photo:CreateShootings keeps 20 reserved image IDs', ids.length === 20);
  check('Photo:CreateShootings rotates out the used image ID', !ids.includes(usedId));
  let reuseRejected = false;
  try {
    await callRpc('Photo:CreateShootings', 'Solis.Common.Proto.Api.PhotoCreateShootingsRequest', shootingReq);
  } catch {
    reuseRejected = true;
  }
  check('Photo:CreateShootings rejects a consumed image ID', reuseRejected);
}
check('Photo:CreateShootings spends the film item', itemAmt(shootAfter, 'item-photo_shooting-02') === filmBefore - 1);
check('Photo:CreateShootings persists the photo', photoOf(shootAfter, created?.PhotoId)?.AssetId === shootingReq.CreateShootingParams[0].PhotoImageId);

// --- General vs dedicated photos (Solis viber/photo.go) ---
check(
  'Photo:CreateShootings omits CharacterIds on a general photo',
  ((created?.CharacterIds as unknown[] | undefined) ?? []).length === 0,
);
check('Photo:CreateShootings keeps FocusCharacterId on a general photo', created?.FocusCharacterId === 'char-smr');

// Solis's photo rarity + quality model (src/services/photoGen.ts). Master data
// is static, so load it once for the whole section.
const photoMaster = await loadPhotoGenerationMaster();
const createdLevel = Number(created?.Level ?? 0);
check('Photo:CreateShootings Level is a multiple of 5', createdLevel > 0 && createdLevel % 5 === 0);
check(
  'Photo:CreateShootings Level is within the PhotoRarityLevel range',
  photoMaster.minLevel > 0 && createdLevel >= photoMaster.minLevel && createdLevel <= photoMaster.maxLevel,
);

const genericRarity5 = await genericSets(5);
check('photoGen genericSets(5) returns sets', genericRarity5.length > 0);
check(
  'photoGen genericSets(5) excludes idol-specific (Limited) sets',
  genericRarity5.every((s) => s.Id.startsWith('pab-set-5-') && !s.Id.includes('-idol-')),
);
check('photoGen genericSets(5) excludes recipe sets', genericRarity5.every((s) => !s.Id.includes('recipe')));

const smrDedicated = await dedicatedSets('char-smr');
check('photoGen dedicatedSets(char-smr) returns the four idol sets', smrDedicated.length === 4);
check(
  'photoGen dedicatedSets(char-smr) only returns -smr-idol- sets',
  smrDedicated.every((s) => s.Id.includes('-smr-idol-')),
);

check(
  'photoGen decides the character-only film is dedicated',
  (await decidePhotoKind({ characterOnlyFilm: true, filmLevel: 1, rarity: 1, characterId: 'char-smr' })) === 'dedicated',
);
check(
  'photoGen decides film level 9 + rarity 5 + sub-1% roll is dedicated',
  (await decidePhotoKind({ characterOnlyFilm: false, filmLevel: 9, rarity: 5, characterId: 'char-smr', rng: () => 0.005 })) ===
    'dedicated',
);
check(
  'photoGen keeps film level 8 + rarity 5 general',
  (await decidePhotoKind({ characterOnlyFilm: false, filmLevel: 8, rarity: 5, characterId: 'char-smr', rng: () => 0.005 })) ===
    'general',
);
check(
  'photoGen keeps film level 9 + rarity 4 general',
  (await decidePhotoKind({ characterOnlyFilm: false, filmLevel: 9, rarity: 4, characterId: 'char-smr', rng: () => 0.005 })) ===
    'general',
);

// Photo rarity floor (Solis randomRarity). Setting.PhotoShootingItemThresholds
// is not in the curated master_Setting schema, so [1,4,7] is the fallback.
check('photoGen thresholds are 1,4,7', photoMaster.thresholds.join(',') === '1,4,7');
check('photoGen film level 1 has minimum rarity 1', photoRarityMinimum(1, photoMaster.thresholds) === 1);
check('photoGen film level 3 has minimum rarity 1', photoRarityMinimum(3, photoMaster.thresholds) === 1);
check('photoGen film level 4 has minimum rarity 2', photoRarityMinimum(4, photoMaster.thresholds) === 2);
check('photoGen film level 6 has minimum rarity 2', photoRarityMinimum(6, photoMaster.thresholds) === 2);
check('photoGen film level 7 has minimum rarity 3', photoRarityMinimum(7, photoMaster.thresholds) === 3);
check('photoGen film level 9 has minimum rarity 3', photoRarityMinimum(9, photoMaster.thresholds) === 3);
check(
  'photoGen film level 9 never rolls below rarity 3',
  [0, 0.5, 0.999].every((r) => rollPhotoRarity(9, photoMaster.thresholds, () => r) >= 3),
);

// Rarity weights (minimum 3 -> [70,25,5]).
check('photoGen minimum 3 rng 0 rolls rarity 3', rollPhotoRarity(7, photoMaster.thresholds, () => 0) === 3);
check('photoGen minimum 3 rng 0.71 rolls rarity 4', rollPhotoRarity(7, photoMaster.thresholds, () => 0.71) === 4);
check('photoGen minimum 3 rng 0.96 rolls rarity 5', rollPhotoRarity(7, photoMaster.thresholds, () => 0.96) === 5);

// Quality anchors from the PhotoShooting item descriptions (Solis
// qualityForFilmLevel, before jitter/rounding).
const anchorQuality = (level: number) =>
  qualityForFilmLevel(level, photoMaster.qualityAnchors, photoMaster.minLevel);
for (const [level, expected] of [
  [3, 60],
  [4, 100],
  [5, 120],
  [7, 140],
  [8, 150],
  [9, 160],
  [6, 130],
  [1, 20],
  [2, 40],
] as const) {
  check(`photoGen quality anchor film level ${level} = ${expected}`, anchorQuality(level) === expected);
}

// Guaranteed ★5 films: rarity 5 at a fixed quality, whatever the rng.
const { getItem: getMasterItem } = await import('./master/index.ts');
const guaranteedFilm = await getMasterItem('item-photo_shooting-09-25-0318');
const guaranteedTraits = [0, 0.999].map((r) =>
  rollFilmPhotoTraits({
    film: guaranteedFilm,
    filmLevel: 9,
    managerLevel: 40,
    master: photoMaster,
    rng: () => r,
  }),
);
check('photoGen ★5確定 film renders fixed', guaranteedTraits.every((t) => t.fixed));
check('photoGen ★5確定 film always rolls rarity 5', guaranteedTraits.every((t) => t.rarity === 5));
check('photoGen ★5確定 film always rolls quality 160', guaranteedTraits.every((t) => t.level === 160));

const quality60Film = await getMasterItem('item-photo_shooting-03-21-0721');
const quality60Traits = rollFilmPhotoTraits({
  film: quality60Film,
  filmLevel: 3,
  managerLevel: 40,
  master: photoMaster,
  // 0.4 -> jitter index 2 -> 0, so the anchor survives unchanged.
  rng: () => 0.4,
});
check('photoGen film item-photo_shooting-03-21-0721 rolls quality 60', quality60Traits.level === 60);

// The manager-level film: quality is the manager level, capped by 最大品質.
const levelChangeFilm = await getMasterItem('item-photo_shooting_level_change-01');
const levelChangeBase = (manager: number) =>
  photoQualityBase(levelChangeFilm, 1, manager, photoMaster.qualityAnchors, photoMaster.minLevel);
check('photoGen level-change film with manager 50 has base 50', levelChangeBase(50) === 50);
check('photoGen level-change film with manager 200 has base 165', levelChangeBase(200) === 165);

const passiveFirstSet = smrDedicated.find((s) =>
  String((s.PhotoAbilityIds as string[] | undefined)?.[0] ?? '').startsWith('pab-passive-skill_'),
);
const dedicatedAbilities = passiveFirstSet ? await rollPhotoAbilities(passiveFirstSet, 10, () => 0.5) : [];
configureDedicatedAbilities(dedicatedAbilities, 40);
check(
  'photoGen dedicated passive carries mission ms-photo-manager_level_achievement-80',
  dedicatedAbilities[0]?.MissionId === DEDICATED_PHOTO_MISSION_ID,
);
check(
  'photoGen dedicated passive is unavailable below manager level 80',
  Boolean(dedicatedAbilities[0]?.IsAvailable) === false,
);

// The photo detail screen needs the gate mission's UserMission (it throws without one).
{
  const before = (await listElements(SERVER_USER_ID, 'Missions')).filter((m) => m.MissionId === DEDICATED_PHOTO_MISSION_ID);
  const first = await ensureDedicatedPhotoMission(SERVER_USER_ID);
  const second = await ensureDedicatedPhotoMission(SERVER_USER_ID);
  const after = (await listElements(SERVER_USER_ID, 'Missions')).filter((m) => m.MissionId === DEDICATED_PHOTO_MISSION_ID);
  check('ensureDedicatedPhotoMission creates the gate mission once', (before.length > 0 || first != null) && second == null && after.length === 1);
  check('gate mission row is in progress', Number(after[0]?.StatusType) === 1);
}

// Manager level 80 unlocks gated dedicated abilities (Solis UnlockManagerLevelPhotoAbilities).
{
  const photoId = 'dbtest-gated-photo-0001';
  await putElements(SERVER_USER_ID, 'Photos', [{
    __msg: 'Solis.Common.Proto.Transaction.UserPhoto',
    PhotoId: photoId,
    Abilities: [{ __msg: 'Solis.Common.Proto.Transaction.UserPhotoAbility', PhotoAbilityId: 'pab-passive-skill_sk-phot-smr-idol-01', EffectValue: 3, Grade: 1, MissionId: DEDICATED_PHOTO_MISSION_ID, IsAvailable: false }],
  } as never]);
  check('unlockManagerLevelPhotoAbilities does nothing below level 80', (await unlockManagerLevelPhotoAbilities(SERVER_USER_ID, 79)).length === 0);
  const unlocked = await unlockManagerLevelPhotoAbilities(SERVER_USER_ID, 80);
  const stored = (await listElements(SERVER_USER_ID, 'Photos')).find((p) => p.PhotoId === photoId);
  check('unlockManagerLevelPhotoAbilities unlocks the gated ability at level 80',
    unlocked.some((p) => p.PhotoId === photoId) && Boolean((stored?.Abilities as Array<{ IsAvailable?: unknown }> | undefined)?.[0]?.IsAvailable));
  check('unlockManagerLevelPhotoAbilities is a no-op once unlocked', (await unlockManagerLevelPhotoAbilities(SERVER_USER_ID, 80)).length === 0);
}

// Ability effect value follows Solis: level value × grade BonusPermil/1000 + BonusValue.
{
  const levels = [{ Level: 1, Value: 100 }, { Level: 150, Value: 2000 }, { Level: 160, Value: 2200 }];
  const grades = [{ Grade: 1, BonusPermil: 1000 }, { Grade: 10, BonusPermil: 1400, BonusValue: 5 }];
  check('photoAbilityEffectValue grade 1 at quality 155 = 2000', photoAbilityEffectValue(levels, grades, 155, 1) === 2000);
  check('photoAbilityEffectValue grade 10 at quality 160 = 3085', photoAbilityEffectValue(levels, grades, 160, 10) === 3085);
  const top = await rollPhotoAbilities({ PhotoAbilityIds: ['pab-active-skill-score-up_multiply-3'] } as never, 160, () => 0.999);
  check('rollPhotoAbilities picks a grade from the master list and applies its bonus', Number(top[0]?.Grade) > 1 &&
    Number(top[0]?.EffectValue) > Number((await rollPhotoAbilities({ PhotoAbilityIds: ['pab-active-skill-score-up_multiply-3'] } as never, 160, () => 0))[0]?.EffectValue));
  const single = await rollPhotoAbilities({ PhotoAbilityIds: ['pab-received_strength_effect_count_increase-vocal_up_recipe_distribution-5'] } as never, 160, () => 0.999);
  check('rollPhotoAbilities keeps single-grade abilities at grade 1', Number(single[0]?.Grade) === 1);
}

const urlResp = await callRpc('Photo:GetImageURL', 'Solis.Common.Proto.Api.PhotoGetImageUrlRequest', {
  Type: 3,
  AssetIds: [created?.AssetId ?? 'x'],
});
check('Photo:GetImageURL returns OrigUrl for Type=3', (urlResp.UrlList?.[0]?.OrigUrl ?? '') !== '');
check('Photo:GetImageURL returns TmbUrl for Type=3', (urlResp.UrlList?.[0]?.TmbUrl ?? '') !== '');

// --- Firebase Storage photo upload (Solis firebasestorage.googleapis.com port) ---
{
  const STORAGE = 'http://127.0.0.1:18098/v0/b/udc-idolypride/o';
  const fbToken = mintIdToken(TEST_UID, undefined, TEST_PUBLIC_USER_ID);
  // Minimal JPEG: SOI + baseline SOF0 (640x360, 3 components) + EOI.
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x68, 0x02, 0x80, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const jpeg = Buffer.from([0xff, 0xd8, ...sof, 0xff, 0xd9]);
  const thumb = Buffer.from([0xff, 0xd8, ...sof.slice(0, 5), 0x00, 0x5a, 0x00, 0xa0, ...sof.slice(9), 0xff, 0xd9]);

  const startUpload = (objectName: string, token: string | null = fbToken) =>
    fetch(`${STORAGE}?name=${encodeURIComponent(objectName)}&uploadType=resumable`, {
      method: 'POST',
      headers: {
        ...(token ? { authorization: `Firebase ${token}` } : {}),
        'content-type': 'application/json; charset=UTF-8',
        'x-goog-upload-protocol': 'resumable',
        'x-goog-upload-command': 'start',
        'x-goog-upload-header-content-type': 'image/jpeg',
      },
      body: JSON.stringify({ contentType: 'image/jpeg' }),
    });
  const finalizeUpload = (uploadUrl: string, bytes: Buffer, contentType?: string) =>
    fetch(uploadUrl.replace('https://firebasestorage.googleapis.com', 'http://127.0.0.1:18098'), {
      method: 'POST',
      headers: {
        authorization: `Firebase ${fbToken}`,
        ...(contentType ? { 'content-type': contentType } : {}),
        'x-goog-upload-protocol': 'resumable',
        'x-goog-upload-command': 'upload, finalize',
        'x-goog-upload-offset': '0',
      },
      body: bytes,
    });
  const uploadImage = async (objectName: string, bytes: Buffer, contentType?: string) => {
    const started = await startUpload(objectName);
    const uploadUrl = started.headers.get('x-goog-upload-url') ?? '';
    const fin = await finalizeUpload(uploadUrl, bytes, contentType);
    return { started, uploadUrl, fin, meta: fin.status === 200 ? ((await fin.json()) as any) : null };
  };

  check('firebase ID tokens carry the puid claim', JSON.parse(Buffer.from(fbToken.split('.')[1], 'base64url').toString()).puid === TEST_PUBLIC_USER_ID);

  const assetId = String(created?.AssetId ?? '');
  const objectName = `Photo/${TEST_PUBLIC_USER_ID}/${assetId}`;
  const noAuth = await startUpload(objectName, null);
  check('storage upload without Firebase auth → 401', noAuth.status === 401);
  const foreign = await startUpload(`Photo/ZZZZ9999/${assetId}`);
  check('storage upload into another public user id is refused', foreign.status === 401 || foreign.status === 403);

  const orig = await uploadImage(objectName, jpeg);
  check('storage upload start → 200 active', orig.started.status === 200 && orig.started.headers.get('x-goog-upload-status') === 'active');
  check('storage upload start returns a resumable upload URL', orig.uploadUrl.includes('upload_id=AJjja9') && orig.uploadUrl.includes('upload_protocol=resumable'));
  check('storage upload finalize → 200 final', orig.fin.status === 200 && orig.fin.headers.get('x-goog-upload-status') === 'final');
  check('storage finalize returns Firebase metadata', orig.meta?.name === objectName && orig.meta?.bucket === 'udc-idolypride' && orig.meta?.size === String(jpeg.length));
  check('storage metadata has generation + download token', /^\d+$/.test(orig.meta?.generation ?? '') && (orig.meta?.downloadTokens ?? '') !== '');
  check('storage metadata hides session bookkeeping', orig.meta && !('uploadId' in orig.meta) && !('uploadState' in orig.meta));
  check('storage stores the JPEG on disk', readFileSync(photoImagePath(TEST_PUBLIC_USER_ID, assetId)).equals(jpeg));

  const retry = await finalizeUpload(orig.uploadUrl, jpeg);
  check('storage finalize retry returns the published metadata', retry.status === 200 && ((await retry.json()) as any).generation === orig.meta?.generation);

  const notJpeg = await uploadImage(`Photo/${TEST_PUBLIC_USER_ID}/${assetId}-bad`, Buffer.from('not a jpeg'));
  check('storage rejects a non-JPEG body → 400', notJpeg.fin.status === 400);

  const thumbUp = await uploadImage(`${objectName}_t`, thumb, 'application/octet-stream');
  check('storage thumbnail upload → 200', thumbUp.fin.status === 200);

  // Another player may read a photo only while it is the owner's profile
  // favourite (business cards are visible to other players).
  {
    const VIEWER_ACCOUNT_ID = 'dbtest-account-0000-4000-8000-000000000004';
    const VIEWER_USER_ID = 'dbtest-user-0000-4000-8000-000000000004';
    const VIEWER_UID = 'dbtest-firebase-uid-0004';
    const VIEWER_PUBLIC_ID = 'DBTEST04';
    await db.delete(players).where(eq(players.id, VIEWER_USER_ID));
    await db.delete(accounts).where(eq(accounts.id, VIEWER_ACCOUNT_ID));
    await db.insert(accounts).values({
      id: VIEWER_ACCOUNT_ID,
      firebaseUid: VIEWER_UID,
      seedId: VIEWER_PUBLIC_ID,
      displayName: 'Viewer',
      lastLoginAt: new Date(),
    });
    await db.insert(players).values({
      id: VIEWER_USER_ID,
      accountId: VIEWER_ACCOUNT_ID,
      name: 'Viewer',
      data: { publicUserId: VIEWER_PUBLIC_ID },
    });
    const viewerToken = mintIdToken(VIEWER_UID, undefined, VIEWER_PUBLIC_ID);
    const viewerGet = (name: string) =>
      fetch(`${STORAGE}/${encodeURIComponent(name)}`, { headers: { authorization: `Firebase ${viewerToken}` } });
    const profileBefore = await getSingleton(SERVER_USER_ID, 'Profile');
    const setFavoritePhoto = (photoId: string) =>
      putSingleton(SERVER_USER_ID, 'Profile', {
        ...(profileBefore ?? { __msg: 'Solis.Common.Proto.Transaction.UserProfile' }),
        FavoritePhotoId: photoId,
      } as any);

    await setFavoritePhoto('');
    check('storage refuses another player reading a non-profile photo', (await viewerGet(objectName)).status === 403);
    await setFavoritePhoto(String(created?.PhotoId ?? ''));
    const shared = await viewerGet(objectName);
    check(
      'storage lets another player read the profile favourite photo',
      shared.status === 200 && ((await shared.json()) as any).downloadTokens === orig.meta?.downloadTokens,
    );
    check('storage lets another player read its thumbnail', (await viewerGet(`${objectName}_t`)).status === 200);
    check(
      'storage still refuses another player uploading over it',
      [401, 403].includes((await startUpload(objectName, viewerToken)).status),
    );
    await setFavoritePhoto('');
    check('storage refuses again once the favourite changes', (await viewerGet(objectName)).status === 403);
    if (profileBefore) await putSingleton(SERVER_USER_ID, 'Profile', profileBefore);
    await db.delete(players).where(eq(players.id, VIEWER_USER_ID));
    await db.delete(accounts).where(eq(accounts.id, VIEWER_ACCOUNT_ID));
  }

  const urls = await callRpc('Photo:GetImageURL', 'Solis.Common.Proto.Api.PhotoGetImageUrlRequest', { Type: 3, AssetIds: [assetId] });
  const entry = urls.UrlList?.[0] ?? {};
  check(
    'Photo:GetImageURL OrigUrl points at the published object with its token',
    entry.OrigUrl === `https://firebasestorage.googleapis.com/v0/b/udc-idolypride/o/${encodeURIComponent(objectName)}?alt=media&token=${orig.meta?.downloadTokens}&v=${orig.meta?.generation}`,
  );
  check('Photo:GetImageURL TmbUrl points at the _t thumbnail', String(entry.TmbUrl ?? '').includes(encodeURIComponent(`${objectName}_t`)) && String(entry.TmbUrl).includes(`token=${thumbUp.meta?.downloadTokens}`));
  const origOnly = await callRpc('Photo:GetImageURL', 'Solis.Common.Proto.Api.PhotoGetImageUrlRequest', { Type: 1, AssetIds: [assetId] });
  check('Photo:GetImageURL Type=1 returns only OrigUrl', !!origOnly.UrlList?.[0]?.OrigUrl && !origOnly.UrlList?.[0]?.TmbUrl);

  const media = await fetch(String(entry.OrigUrl).replace('https://firebasestorage.googleapis.com', 'http://127.0.0.1:18098'));
  check('storage media download → 200 image/jpeg with the bytes', media.status === 200 && media.headers.get('content-type') === 'image/jpeg' && Buffer.from(await media.arrayBuffer()).equals(jpeg));
  const etag = media.headers.get('etag') ?? '';
  // fetch() would add `cache-control: no-cache` alongside If-None-Match, so use node:http.
  const notModifiedStatus = await new Promise<number>((resolve, reject) => {
    const u = new URL(String(entry.OrigUrl).replace('https://firebasestorage.googleapis.com', 'http://127.0.0.1:18098'));
    httpRequest(u, { headers: { 'if-none-match': etag } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject).end();
  });
  check('storage media honours If-None-Match → 304', notModifiedStatus === 304);
  const badToken = await fetch(`${STORAGE}/${encodeURIComponent(objectName)}?alt=media&token=nope`);
  check('storage media with a wrong token → 403', badToken.status === 403);
  const metaGet = await fetch(`${STORAGE}/${encodeURIComponent(objectName)}`, { headers: { authorization: `Firebase ${fbToken}` } });
  check('storage metadata GET → 200 Firebase metadata', metaGet.status === 200 && ((await metaGet.json()) as any).downloadTokens === orig.meta?.downloadTokens);
  const missing = await fetch(`${STORAGE}/${encodeURIComponent(`Photo/${TEST_PUBLIC_USER_ID}/never-uploaded`)}?alt=media&token=x`);
  check('storage media for an unknown object → 404', missing.status === 404);

  // Photo:Delete removes the uploaded image objects (Solis removeUserPhotoImageObjects).
  const delShoot = await callRpc('Photo:CreateShootings', 'Solis.Common.Proto.Api.PhotoCreateShootingsRequest', {
    ...shootingReq,
    CreateShootingParams: [{ ...shootingReq.CreateShootingParams[0], PhotoImageId: await reservedImageId() }],
  });
  const delPhoto = delShoot.Photos?.[0];
  const delName = `Photo/${TEST_PUBLIC_USER_ID}/${delPhoto?.AssetId}`;
  await uploadImage(delName, jpeg);
  await uploadImage(`${delName}_t`, thumb);
  check('upload for the photo to delete is stored', existsSync(photoImagePath(TEST_PUBLIC_USER_ID, String(delPhoto?.AssetId))));
  await callRpc('Photo:Delete', 'Solis.Common.Proto.Api.PhotoDeleteRequest', { PhotoIds: [delPhoto?.PhotoId] });
  check('Photo:Delete removes the uploaded image file', !existsSync(photoImagePath(TEST_PUBLIC_USER_ID, String(delPhoto?.AssetId))));
  const delRows = await db.select().from(photoImageMetadata).where(eq(photoImageMetadata.id, delName));
  check('Photo:Delete removes the image metadata', delRows.length === 0);
}

// Restore the master rows patched for the deterministic ListShooting checks.
await patchStage(stageBefore?.ViewConditionId ?? '', stageBefore?.UnlockConditionId ?? '');
await patchMusic(musicBefore?.ViewConditionId ?? '', musicBefore?.UnlockConditionId ?? '');
await db.delete(masterCondition).where(eq(masterCondition.Id, hiddenConditionId));

// Photo catalogue condition kinds: TutorialStep, ItemAmount and
// SatisfyConditions. Temporary master rows + a throwaway tutorial row keep the
// checks independent of corpus progress; both are removed below.
const photoConditionIds = [
  'cd-dbtest-tutorial-step-ok',
  'cd-dbtest-tutorial-step-low',
  'cd-dbtest-tutorial-step-range',
  'cd-dbtest-tutorial-step-missing',
  'cd-dbtest-item-amount-ok',
  'cd-dbtest-item-amount-short',
  'cd-dbtest-item-amount-noid',
  'cd-dbtest-satisfy-all',
  'cd-dbtest-satisfy-one',
  'cd-dbtest-satisfy-empty',
];
await db.delete(masterCondition).where(inArray(masterCondition.Id, photoConditionIds));
const tutorialFixture = {
  __msg: 'Solis.Common.Proto.Transaction.UserTutorial',
  TutorialType: 999,
  Step: 5,
};
await putElements(SERVER_USER_ID, 'Tutorials', [tutorialFixture]);
const { ConditionEvaluator } = await import('./services/conditions.ts');
const { removeElements } = await import('./services/playerState.ts');
const photoFilmAmount = await getItemAmount(SERVER_USER_ID, 'item-photo_shooting-02');
await db.insert(masterCondition).values([
  { Id: 'cd-dbtest-tutorial-step-ok', Settings: [{ TutorialStep: { TutorialType: 999, StepGte: 5 } }] },
  { Id: 'cd-dbtest-tutorial-step-low', Settings: [{ TutorialStep: { TutorialType: 999, StepGte: 6 } }] },
  { Id: 'cd-dbtest-tutorial-step-range', Settings: [{ TutorialStep: { TutorialType: 999, StepGte: 1, StepLte: 4 } }] },
  { Id: 'cd-dbtest-tutorial-step-missing', Settings: [{ TutorialStep: { TutorialType: 998, StepGte: 0, StepLte: 0 } }] },
  { Id: 'cd-dbtest-item-amount-ok', Settings: [{ ItemAmount: { ItemId: 'item-photo_shooting-02', AmountGte: photoFilmAmount } }] },
  { Id: 'cd-dbtest-item-amount-short', Settings: [{ ItemAmount: { ItemId: 'item-photo_shooting-02', AmountGte: photoFilmAmount + 1 } }] },
  { Id: 'cd-dbtest-item-amount-noid', Settings: [{ ItemAmount: { AmountGte: 1 } }] },
  { Id: 'cd-dbtest-satisfy-all', Settings: [{ SatisfyConditions: { Conditions: [
    { ConditionId: 'cd-manager_level_gte-1' },
    { ConditionId: 'cd-dbtest-tutorial-step-ok' },
  ] } }] },
  { Id: 'cd-dbtest-satisfy-one', Settings: [{ SatisfyConditions: { Conditions: [
    { ConditionId: 'cd-manager_level_gte-1' },
    { ConditionId: 'cd-dbtest-tutorial-step-low' },
  ] } }] },
  { Id: 'cd-dbtest-satisfy-empty', Settings: [{ SatisfyConditions: { Conditions: [] } }] },
]);
const photoConditionEvaluator = new ConditionEvaluator(SERVER_USER_ID, Date.now());
check('Condition: TutorialStep range is satisfied', await photoConditionEvaluator.satisfied('cd-dbtest-tutorial-step-ok'));
check('Condition: TutorialStep below StepGte is unsatisfied', !(await photoConditionEvaluator.satisfied('cd-dbtest-tutorial-step-low')));
check('Condition: TutorialStep above StepLte is unsatisfied', !(await photoConditionEvaluator.satisfied('cd-dbtest-tutorial-step-range')));
check('Condition: TutorialStep without a matching type is unsatisfied', !(await photoConditionEvaluator.satisfied('cd-dbtest-tutorial-step-missing')));
check('Condition: ItemAmount at the held amount is satisfied', await photoConditionEvaluator.satisfied('cd-dbtest-item-amount-ok'));
check('Condition: ItemAmount above the held amount is unsatisfied', !(await photoConditionEvaluator.satisfied('cd-dbtest-item-amount-short')));
check('Condition: ItemAmount without ItemId is indeterminate', !(await photoConditionEvaluator.satisfied('cd-dbtest-item-amount-noid')));
check('Condition: SatisfyConditions requires every listed id', await photoConditionEvaluator.satisfied('cd-dbtest-satisfy-all'));
check('Condition: SatisfyConditions fails when one listed id fails', !(await photoConditionEvaluator.satisfied('cd-dbtest-satisfy-one')));
check('Condition: SatisfyConditions with an empty list is indeterminate', !(await photoConditionEvaluator.satisfied('cd-dbtest-satisfy-empty')));
await db.delete(masterCondition).where(inArray(masterCondition.Id, photoConditionIds));
await removeElements(SERVER_USER_ID, 'Tutorials', [tutorialFixture]);

const chkExpr = await callRpc('Photo:CheckExpressionShooting', 'Solis.Common.Proto.Api.PhotoCheckExpressionShootingRequest', {
  PhotoExpressionId: 'photo_expression-hillpark_02',
  CharacterIds: ['char-smr'],
  CostumeIds: ['cos-smr-schl-00'],
  HairIds: ['hair-smr-schl-00'],
});
check('Photo:CheckExpressionShooting returns CommonResponse', !!chkExpr.CommonResponse);

const exprReq = {
  PhotoExpressionId: 'photo_expression-hillpark_02',
  CreateExpressionShootingParams: [{
    PhotoImageId: await reservedImageId(),
    ItemId: 'item-photo_shooting-02',
    StagePositionNumber: 1,
    PhotoPoseId: 'photo-pose-standing-default',
    PhotoFacialId: 'photo-facial-smile',
    PhotoLookingType: 3,
    MainCharacterId: 'char-smr',
  }],
  ManualCount: 7,
  CharacterIds: ['char-smr'],
  CostumeIds: ['cos-smr-schl-00'],
  HairIds: ['hair-smr-schl-00'],
};
const exprResp = await callRpc('Photo:CreateExpressionShootings', 'Solis.Common.Proto.Api.PhotoCreateExpressionShootingsRequest', exprReq);
const exprPhoto = exprResp.Photos?.[0];
check('Photo:CreateExpressionShootings returns a photo', !!exprPhoto?.PhotoId);
check('Photo:CreateExpressionShootings sets PlaceName to the base expression', exprPhoto?.PlaceName === '星見市高台');
check('Photo:CreateExpressionShootings sets EventName to the expression name', exprPhoto?.EventName === '星見市高台②');

const chkCard = await callRpc('Photo:CheckCardStoryShooting', 'Solis.Common.Proto.Api.PhotoCheckCardStoryShootingRequest', {
  CardId: 'card-hrk-05-casl-04',
  Number: 1,
});
check('Photo:CheckCardStoryShooting returns CommonResponse', !!chkCard.CommonResponse);

const csResp = await callRpc('Photo:CreateCardStoryShootings', 'Solis.Common.Proto.Api.PhotoCreateCardStoryShootingsRequest', {
  CardId: 'card-hrk-05-casl-04',
  Number: 1,
  CreateShootingParams: [{
    PhotoImageId: await reservedImageId(),
    ItemId: 'item-photo_shooting-02',
    MainCharacterId: 'char-hrk',
  }],
  ManualCount: 9,
});
check('Photo:CreateCardStoryShootings returns a photo', !!csResp.Photos?.[0]?.PhotoId);

const panList = decodeMessage(
  msgRegistry.get(endpoints['PhotoPanorama']['List'].response)!,
  new Reader(Uint8Array.from(await dispatchRpc('PhotoPanorama:List', Buffer.alloc(0), authOpts))),
) as any;
check('PhotoPanorama:List returns music entries', (panList.Musics?.length ?? 0) >= 1);
check('PhotoPanorama:List matches the official catalog (15 songs)', panList.Musics?.length === 15);
check('PhotoPanorama:List includes MELODIES', (panList.Musics ?? []).some((m: any) => m.MusicId === 'music-hsm-017'));
check('PhotoPanorama:List includes Gratitude', (panList.Musics ?? []).some((m: any) => m.MusicId === 'music-tri-010'));
check('PhotoPanorama:List marks entries IsUnlocked', (panList.Musics ?? []).some((m: any) => Boolean(m.IsUnlocked)));

const chkPan = await callRpc('PhotoPanorama:CheckShooting', 'Solis.Common.Proto.Api.PhotoPanoramaCheckShootingRequest', {
  PhotoMusicId: 'music-clb-011',
  CharacterIds: ['char-smr'],
  CostumeIds: ['cos-smr-schl-00'],
  HairIds: ['hair-smr-schl-00'],
});
check('PhotoPanorama:CheckShooting returns CommonResponse', !!chkPan.CommonResponse);

const panResp = await callRpc('PhotoPanorama:CreateShootings', 'Solis.Common.Proto.Api.PhotoPanoramaCreateShootingsRequest', {
  PhotoMusicId: 'music-clb-011',
  CharacterIds: ['char-smr'],
  CostumeIds: ['cos-smr-schl-00'],
  HairIds: ['hair-smr-schl-00'],
  CreateShootingParams: [{
    PhotoImageId: await reservedImageId(),
    ItemId: 'item-photo_shooting-02',
    MainCharacterId: 'char-smr',
  }],
  ManualCount: 9,
  CameraTypes: [2],
});
check('PhotoPanorama:CreateShootings returns a photo', !!panResp.Photos?.[0]?.PhotoId);

const shelfTop = decodeMessage(
  msgRegistry.get(endpoints['Shelf']['Top'].response)!,
  new Reader(Uint8Array.from(await dispatchRpc('Shelf:Top', Buffer.alloc(0), authOpts))),
) as any;
check('Shelf:Top returns ShelfInfo', !!shelfTop.ShelfInfo?.Name);
check('Shelf:Top returns album infos', (shelfTop.ShelfInfo?.AlbumInfos?.length ?? 0) >= 1);

const albumTop = await callRpc('Shelf:AlbumTop', 'Solis.Common.Proto.Api.ShelfAlbumTopRequest', {
  ShelfAlbumId: 'shelf-album_shelf-26-1002-001',
});
check('Shelf:AlbumTop returns TemplateInfos', (albumTop.TemplateInfos?.length ?? 0) >= 1);
check('Shelf:AlbumTop returns EpisodeInfos', (albumTop.EpisodeInfos?.length ?? 0) >= 1);
check('Shelf:AlbumTop selects a template', (albumTop.SelectedTemplateId ?? '') !== '');

await callRpc('Shelf:CheckShooting', 'Solis.Common.Proto.Api.ShelfCheckShootingRequest', {
  ShelfAlbumId: 'shelf-album_shelf-26-1002-001',
  Episode: 1,
});

const saveResp = await callRpc('Shelf:SavePhoto', 'Solis.Common.Proto.Api.ShelfSavePhotoRequest', {
  ShelfAlbumId: 'shelf-album_shelf-26-1002-001',
  Episode: 1,
  SavePhotoParams: [{ AssetId: created?.AssetId, MainCharacterId: 'char-smr' }],
});
check('Shelf:SavePhoto returns UpdatedData.User', !!saveResp.CommonResponse?.UpdatedData?.User);

await callRpc('Shelf:SetPhoto', 'Solis.Common.Proto.Api.ShelfSetPhotoRequest', {
  ShelfAlbumId: 'shelf-album_shelf-26-1002-001',
  SlotNumber: 1,
  AssetId: created?.AssetId,
});

const albResp = await callRpc('Shelf:CreateAlbumPhoto', 'Solis.Common.Proto.Api.ShelfCreateAlbumPhotoRequest', {
  ShelfAlbumId: 'shelf-album_shelf-26-1002-001',
  AssetId: await reservedImageId(),
});
check('Shelf:CreateAlbumPhoto returns a ★3 photo', Number(albResp.Photo?.Rarity) === 3);
check('Shelf:CreateAlbumPhoto sets EventName フォトアルバム', albResp.Photo?.EventName === 'フォトアルバム');

// --- PhotoContest (schema-built: no on-device capture; master tables seeded) ---
await inv.grantItem(SERVER_USER_ID, 'item-contest_submitting-25-0826', 100);
await inv.grantItem(SERVER_USER_ID, 'item-photo_contest_create-25-0826', 100);
const CONTEST_ID = 'contest-25-0826';
const callContest = (method: string, req: any) =>
  callRpc(`PhotoContest:${method}`, `Solis.Common.Proto.Api.PhotoContest${method}Request`, req);

const cTop = await callContest('Top', { PhotoContestId: CONTEST_ID });
check('PhotoContest:Top returns PhotoContestInfo', !!cTop.PhotoContestInfo?.Id);
check('PhotoContest:Top lists contest sections', (cTop.PhotoContestInfo?.SectionInfos?.length ?? 0) >= 1);
check('PhotoContest:Top lists contest activities', (cTop.PhotoContestInfo?.Activities?.length ?? 0) >= 1);
check('PhotoContest:Top lists contest musics', (cTop.PhotoContestInfo?.Musics?.length ?? 0) >= 1);
check('PhotoContest:Top lists contest stages', (cTop.PhotoContestInfo?.Stages?.length ?? 0) >= 1);
check('PhotoContest:Top exposes submitting item', cTop.PhotoContestInfo?.SubmittingItemId === 'item-contest_submitting-25-0826');

const cCheck = await callContest('CheckShooting', { PhotoContestId: CONTEST_ID, SectionId: 'contest_section_a-25-0826' });
check('PhotoContest:CheckShooting returns CommonResponse', !!cCheck.CommonResponse);

const cCreate = await callContest('CreateShooting', {
  PhotoContestId: CONTEST_ID,
  AssetId: await reservedImageId(),
  ItemId: 'item-photo_contest_create-25-0826',
});
check('PhotoContest:CreateShooting returns a photo', !!cCreate.Photo?.PhotoId);
check('PhotoContest:CreateShooting marks EventName フォトコンテスト', cCreate.Photo?.EventName === 'フォトコンテスト');

const cSubmit = await callContest('SubmitShooting', {
  PhotoContestId: CONTEST_ID,
  SectionId: 'contest_section_a-25-0826',
  ItemId: 'item-contest_submitting-25-0826',
  ActionType: 3,
  MainCharacterId: 'char-smr',
  CharacterIds: ['char-smr'],
  CostumeIds: ['cos-smr-schl-00'],
  HairIds: ['hair-smr-schl-00'],
  ElapsedMilliSeconds: 3000,
  SizeFullPermil: 1000,
  SizeUpperPermil: 900,
  DirectionFrontPermil: 1000,
  DirectionSidePermil: 800,
  PositionPermil: 1000,
});
check('PhotoContest:SubmitShooting returns an evaluation point', Number(cSubmit.EvaluationPoint ?? 0) > 0);
check('PhotoContest:SubmitShooting unlocks a section reward', (cSubmit.NewCanReceiveSectionRewardIds?.length ?? 0) >= 1);
check('PhotoContest:SubmitShooting returns a rank type 1..5', Number(cSubmit.EvaluationRankType ?? 0) >= 1 && Number(cSubmit.EvaluationRankType ?? 0) <= 5);
const cSubmitAfter = await userGet();
check('PhotoContest:SubmitShooting persists a contest photo',
  (cSubmitAfter.Photos ?? []).some((p: any) => p.EventName === 'フォトコンテスト'));

const cList = await callContest('ListPhoto', { PhotoContestId: CONTEST_ID });
check('PhotoContest:ListPhoto returns the submitted photos', (cList.PhotoInfos?.length ?? 0) >= 1);

const cRank = await callContest('Ranking', { PhotoContestId: CONTEST_ID });
check('PhotoContest:Ranking returns self rank 1', Number(cRank.SelfRank ?? 0) === 1);
check('PhotoContest:Ranking returns a ranking entry', (cRank.RankingInfos?.length ?? 0) >= 1);

const cReward = await callContest('ReceiveSectionRewards', {
  PhotoContestId: CONTEST_ID,
  SectionId: 'contest_section_a-25-0826',
  SectionRewardIds: ['section_reward-a-25-0826-1'],
});
 check('PhotoContest:ReceiveSectionRewards returns results', (cReward.Results?.length ?? 0) >= 1);

 // --- Showcase (schema-built: no on-device capture; 8 master tables seeded) ---
 const callShowcase = async (method: string, req: any) => {
   const ep = (endpoints as any)['Showcase'][method];
   const reqBytes =
     ep.request === 'Empty' ? Buffer.alloc(0) : encodeReq(msgRegistry.get(ep.request)!, req);
   const bytes = await dispatchRpc(`Showcase:${method}`, reqBytes, authOpts);
   return decodeMessage(msgRegistry.get(ep.response)!, new Reader(Uint8Array.from(bytes))) as any;
 };

 const scTop = await callShowcase('Top', {});
 check('Showcase:Top lists master frames', (scTop.FrameInfos?.length ?? 0) >= 1);
 check('Showcase:Top lists master music ids', (scTop.ShowcaseMusicIds?.length ?? 0) >= 1);
 check('Showcase:Top returns TotalLikedCount', typeof (scTop.TotalLikedCount ?? 0) === 'number');

 const scSave = await callShowcase('Save', { Number: 1, FrameId: 'frame-002', AssetId: 'img_ui_showcase_case_thumb_default' });
 check('Showcase:Save returns CommonResponse', !!scSave.CommonResponse);

 const scDetail = await callShowcase('SaveDetail', { Number: 1, Name: 'テスト', Comment: 'コメント', MusicId: 'music-clb-001', IsOpen: true });
 check('Showcase:SaveDetail returns CommonResponse', !!scDetail.CommonResponse);

 const scMyset = await callShowcase('SaveMyset', { Number: 1, FrameId: 'frame-002' });
 check('Showcase:SaveMyset returns CommonResponse', !!scMyset.CommonResponse);
 const scRename = await callShowcase('RenameMyset', { Number: 1, Name: 'マイセットA' });
 check('Showcase:RenameMyset returns CommonResponse', !!scRename.CommonResponse);
 const scApply = await callShowcase('ApplyMyset', { Number: 1 });
 check('Showcase:ApplyMyset returns the saved FrameId', scApply.FrameId === 'frame-002');
 const scDelMyset = await callShowcase('DeleteMyset', { Number: 1 });
 check('Showcase:DeleteMyset returns CommonResponse', !!scDelMyset.CommonResponse);

 const scCheck = await callShowcase('CheckShooting', { Number: 1 });
 check('Showcase:CheckShooting returns CommonResponse', !!scCheck.CommonResponse);
 const scCheckThumb = await callShowcase('CheckThumbnailShooting', { Number: 1 });
 check('Showcase:CheckThumbnailShooting returns CommonResponse', !!scCheckThumb.CommonResponse);

 const scLike = await callShowcase('Like', { UserId: 'some-other-user', Number: 1 });
 check('Showcase:Like returns IsAlreadyLike', typeof (scLike.IsAlreadyLike ?? false) === 'boolean');

 const scGet = await callShowcase('Get', { UserId: SERVER_USER_ID });
 check('Showcase:Get returns the saved showcase', (scGet.ShowcaseInfos?.length ?? 0) >= 1);
 const scGallery = await callShowcase('GalleryTop', {});
 check('Showcase:GalleryTop returns TermInfo', !!scGallery.TermInfo?.Month);
 const scSearch = await callShowcase('SearchHashtagList', { HashtagId: 'hashtag-char-ai', IsHead: true });
 check('Showcase:SearchHashtagList returns IsEndHashtagSearchList', Number(scSearch.IsEndHashtagSearchList) === 1);
 const scDisp = await callShowcase('Display', { UserId: SERVER_USER_ID, Number: 1 });
 check('Showcase:Display is viewable', Number(scDisp.IsViewable) === 1);
 check('Showcase:Display returns the saved LayoutInfo', !!scDisp.LayoutInfo);

 await inv.grantItem(SERVER_USER_ID, 'item-photo_shooting-02', 10);
 const scCreate = await callShowcase('CreatePhoto', {
   Number: 1,
   CreatePhotoParams: [{ AssetId: await reservedImageId(), ItemId: 'item-photo_shooting-02', MainCharacterId: 'char-smr' }],
   ManualCount: 1,
 });
 check('Showcase:CreatePhoto returns a photo', !!scCreate.Photos?.[0]?.PhotoId);
 check('Showcase:CreatePhoto marks EventName グッズケース', scCreate.Photos?.[0]?.EventName === 'グッズケース');

 // --- Photo Dream (uncaptured: schema-built, static sample data, dbtest-validated) ---
const callDream = async (method: string, req: any) => {
  const ep = (endpoints as any)['Dream'][method];
  const reqBytes = ep.request === 'Empty' ? Buffer.alloc(0) : encodeReq(msgRegistry.get(ep.request)!, req);
  const bytes = await dispatchRpc(`Dream:${method}`, reqBytes, authOpts);
  return decodeMessage(msgRegistry.get(ep.response)!, new Reader(Uint8Array.from(bytes))) as any;
};
const dreamTop = await callDream('Top', {});
check('Dream:Top returns a SeasonInfo', !!dreamTop.SeasonInfo?.Id);
check('Dream:Top lists rank infos', (dreamTop.SeasonInfo?.RankInfos?.length ?? 0) >= 1);
check('Dream:Top returns DreamUserPhotos list', Array.isArray(dreamTop.DreamUserPhotos ?? []));
const dMat = await callDream('ListMaterialPhoto', {});
check('Dream:ListMaterialPhoto returns UserMaterialPhotos list', Array.isArray(dMat.UserMaterialPhotos ?? []));
const dQuest = await callDream('ListQuest', { BasePhotoId: 'dream-sample' });
check('Dream:ListQuest returns QuestInfos list', Array.isArray(dQuest.QuestInfos ?? []));
const dGen = await callDream('GenerateArea', { BasePhotoId: 'dream-sample', MaterialPhotoId: 'mat-sample' });
check('Dream:GenerateArea returns a DreamUserPhoto', !!dGen.DreamUserPhoto?.PhotoId);
const dStart = await callDream('StartQuest', { BasePhotoId: 'dream-sample', DeckNumber: 1, IsSkip: false });
check('Dream:StartQuest returns a cleared Result', Number(dStart.Result?.Cleared) === 1);
check('Dream:StartQuest returns ClearedQuestNumber', Number(dStart.ClearedQuestNumber) === 1);
const dSkip = await callDream('SkipQuest', { BasePhotoId: 'dream-sample', DeckNumber: 1, QuestNumber: 1 });
check('Dream:SkipQuest returns ClearedQuestNumber', Number(dSkip.ClearedQuestNumber) === 1);
const dReset = await callDream('ResetArea', { BasePhotoId: 'dream-sample' });
check('Dream:ResetArea returns CommonResponse', !!dReset.CommonResponse);
const dLevels = await callRpc('Photo:GetDreamBasePhotoEnhanceLevelInfos', 'Solis.Common.Proto.Api.GetDreamBasePhotoEnhanceLevelInfosRequest', {
  BasePhotoId: 'dream-sample',
});
check('Photo:GetDreamBasePhotoEnhanceLevelInfos returns LevelInfos', (dLevels.LevelInfos?.length ?? 0) >= 1);
check('Photo:GetDreamBasePhotoEnhanceLevelInfos has effect values',
  (dLevels.LevelInfos?.[0]?.EffectValueInfos?.length ?? 0) >= 1);

// --- Photo Special / StoryEpisode / Excursion shooting variants (schema-built, dbtest-validated) ---
const callPhotoVariant = (method: string, reqShape: string, req: any) =>
  callRpc(`Photo:${method}`, reqShape, req);
const spList = await callPhotoVariant('ListSpecialShooting', 'Solis.Common.Proto.Api.PhotoListSpecialShootingRequest', {
  SpecialPhotoShootingId: 'photo-promotion-010',
});
check('Photo:ListSpecialShooting lists special activities', (spList.Activities?.length ?? 0) >= 1);
check('Photo:ListSpecialShooting lists musics', (spList.Musics?.length ?? 0) >= 1);
const spCheck = await callPhotoVariant('CheckSpecialShooting', 'Solis.Common.Proto.Api.PhotoCheckSpecialShootingRequest', {
  SpecialPhotoShootingId: 'photo-promotion-010',
});
check('Photo:CheckSpecialShooting returns CommonResponse', !!spCheck.CommonResponse);
await inv.grantItem(SERVER_USER_ID, 'item-photo_shooting-02', 10);
const spCreate = await callPhotoVariant('CreateSpecialShootings', 'Solis.Common.Proto.Api.PhotoCreateSpecialShootingsRequest', {
  SpecialPhotoShootingId: 'photo-promotion-010',
  CreateShootingParams: [
    { PhotoImageId: await reservedImageId(), ItemId: 'item-photo_shooting-02', MainCharacterId: 'char-smr' },
  ],
  ManualCount: 1,
});
check('Photo:CreateSpecialShootings returns a photo', !!spCreate.Photos?.[0]?.PhotoId);
check('Photo:CreateSpecialShootings marks EventName スペシャル撮影', spCreate.Photos?.[0]?.EventName === 'スペシャル撮影');
await ps.putElements(SERVER_USER_ID, 'Stories', [
  { __msg: 'Solis.Common.Proto.Transaction.UserStory', StoryId: 'st-group-tri-01-01-01', StatusType: 2 } as any,
]);
const seCheck = await callPhotoVariant('CheckStoryEpisodeShooting', 'Solis.Common.Proto.Api.PhotoCheckStoryEpisodeShootingRequest', {
  StoryPartId: 'st-part-group-01',
  Chapter: 1,
  Route: 1,
  Episode: 1,
});
check('Photo:CheckStoryEpisodeShooting returns CommonResponse', !!seCheck.CommonResponse);
const seCreate = await callPhotoVariant('CreateStoryEpisodeShootings', 'Solis.Common.Proto.Api.PhotoCreateStoryEpisodeShootingsRequest', {
  StoryPartId: 'st-part-group-01',
  Chapter: 1,
  Route: 1,
  Episode: 1,
  CreateShootingParams: [
    { PhotoImageId: await reservedImageId(), ItemId: 'item-photo_shooting-02', MainCharacterId: 'char-smr' },
  ],
  ManualCount: 1,
});
check('Photo:CreateStoryEpisodeShootings returns a photo', !!seCreate.Photos?.[0]?.PhotoId);
check('Photo:CreateStoryEpisodeShootings names the event after the story part', String(seCreate.Photos?.[0]?.EventName ?? '').endsWith('編'));
const seAct = await callPhotoVariant('ActivateStoryEpisodeShooting', 'Solis.Common.Proto.Api.PhotoActivateStoryEpisodeShootingRequest', {
  StoryPartId: 'st-part-group-01',
  Chapter: 1,
  Route: 1,
  Episode: 1,
});
check('Photo:ActivateStoryEpisodeShooting returns CommonResponse', !!seAct.CommonResponse);
const exCheck = await callPhotoVariant('CheckExcursionShooting', 'Solis.Common.Proto.Api.PhotoCheckExcursionShootingRequest', {
  ExcursionPlaceId: 'ex-pool',
  CharacterId: 'char-smr',
  CostumeId: 'cos-smr-schl-00',
  HairId: 'hair-smr-schl-00',
});
check('Photo:CheckExcursionShooting returns CommonResponse', !!exCheck.CommonResponse);
const exCreate = await callPhotoVariant('CreateExcursionShootings', 'Solis.Common.Proto.Api.PhotoCreateExcursionShootingsRequest', {
  ExcursionPlaceId: 'ex-pool',
  CharacterId: 'char-smr',
  CostumeId: 'cos-smr-schl-00',
  HairId: 'hair-smr-schl-00',
  CreateExcursionShootingParams: [{ PhotoImageId: await reservedImageId(), ItemId: 'item-photo_shooting-02' }],
  ManualCount: 1,
});
check('Photo:CreateExcursionShootings returns a photo', !!exCreate.Photos?.[0]?.PhotoId);
check('Photo:CreateExcursionShootings marks EventName おでかけ撮影', exCreate.Photos?.[0]?.EventName === 'おでかけ撮影');
check('Photo:CreateExcursionShootings uses place name プール', exCreate.Photos?.[0]?.PlaceName === 'プール');

// --- Photo reward integration (Phase 4): PhotoAllInOne / PhotoSituation / PhotoGift / story ticket ---
const photoGrant = await applyRewardRefs(SERVER_USER_ID, ['rd_auto;photo_all_in_one;phot-aniv-23-0624-1;1']);
check('Reward PhotoAllInOne resolves a grant', (photoGrant.grants?.length ?? 0) >= 1);
check('Reward PhotoAllInOne returns a RewardResult', (photoGrant.results?.length ?? 0) >= 1);
check('Reward PhotoAllInOne is marked new', Number(photoGrant.results?.[0]?.IsNew) === 1);
check('Reward PhotoAllInOne surfaces the photo in UpdatedData', (photoGrant.updated?.Photos?.length ?? 0) >= 1);
const photoGrantPhoto = photoGrant.updated?.Photos?.[0];
check('Reward PhotoAllInOne photo keeps the template AssetId', photoGrantPhoto?.AssetId === 'phot-aniv-23-0624-1');
check('Reward PhotoAllInOne photo carries abilities', (photoGrantPhoto?.Abilities?.length ?? 0) >= 1);
const photoGrantUser = await userGet();
check('Reward PhotoAllInOne persists the photo', (photoGrantUser.Photos ?? []).some((p: any) => p.PhotoId === photoGrantPhoto?.PhotoId));

const photoGap = await applyRewardRefs(SERVER_USER_ID, ['rd_auto;photo_situation;some-situation;1', 'rd_auto;photo_gift;some-gift;1', 'rd_auto;activate_photo_shooting_story_ticket;;1']);
check('Reward PhotoSituation/PhotoGift/story-ticket emit RewardResults', (photoGap.results?.length ?? 0) >= 3);

 // --- Slice 13: accessory enhance / limit break (uncaptured: schema-built, dbtest-validated) ---
const callAcc = (method: string, req: any) =>
  callRpc(`Accessory:${method}`, `Solis.Common.Proto.Api.Accessory${method}Request`, req);

const aeId = 'ac-1-dance-01';
const aeBefore = await userGet();
const aeGoldBefore = goldAmt(aeBefore);
const aeBaseBefore = accAmt(aeBefore, aeId);
const aeFodderBefore = accAmt(aeBefore, 'ac-1-dance-02');
const aeResp = await callAcc('Enhance', { AccessoryId: aeId, Count: 1, MaterialType: 3 });
const aeAfter = await userGet();
check('Accessory:Enhance returns UpdatedData.Accessories', (aeResp.CommonResponse?.UpdatedData?.Accessories?.length ?? 0) >= 1);
check('Accessory:Enhance advances the accessory to the next rarity',
  accAmt(aeAfter, 'ac-1-dance-02') === aeFodderBefore - 3 + 1 && accAmt(aeAfter, aeId) === aeBaseBefore - 1);
check('Accessory:Enhance spends RequiredGold', goldAmt(aeAfter) === aeGoldBefore - 1000);

await cur.grantCurrency(SERVER_USER_ID, 'gold', 30000000);
await inv.grantItem(SERVER_USER_ID, 'item-accessory_limit_break-01', 10);
await inv.grantAccessory(SERVER_USER_ID, 'ac-1-dance-21', 1);
const albBefore = await userGet();
const albGoldBefore = goldAmt(albBefore);
const albRiserBefore = itemAmt(albBefore, 'item-accessory_limit_break-01');
await callAcc('LimitBreak', { AccessoryId: 'ac-1-dance-21', IsInUse: false, IsInUseLeague: false });
const albAfter = await userGet();
check('Accessory:LimitBreak advances to the enhanced accessory', accAmt(albAfter, 'ac-1-dance-22') >= 1);
check('Accessory:LimitBreak spends gold', goldAmt(albAfter) === albGoldBefore - 15000000);
check('Accessory:LimitBreak spends a Spirit Riser',
  itemAmt(albAfter, 'item-accessory_limit_break-01') === albRiserBefore - 1);

// --- Slice 15: card bond evolution on duplicate obtain (uncaptured: schema-built, dbtest-validated) ---
await ps.putElements(SERVER_USER_ID, 'Cards', [
  {
    __msg: 'Solis.Common.Proto.Transaction.UserCard',
    CardId: CE_CARD_ID,
    Level: 1,
    EvolutionLevel: 0,
    EvolutionLevelTotalExp: 0,
  } as any,
]);
await inv.grantCard(SERVER_USER_ID, { CardId: CE_CARD_ID } as any);
const ceAfter = await userGet();
const ceCard = (ceAfter.Cards ?? []).find((c: any) => c.CardId === CE_CARD_ID);
check('Card bond: duplicate grants DuplicateObtainExp', Number(ceCard?.EvolutionLevelTotalExp ?? 0) === 100);
check('Card bond: duplicate raises EvolutionLevel', Number(ceCard?.EvolutionLevel ?? 0) === 1);
check('Card bond: level-up unlocks RewardCostumeId',
  (ceAfter.Costumes ?? []).some((c: any) => c.CostumeId === 'cos-mna-link-01'));

// --- Card grant spawns the card's idol when the player lacks it ---
// A card whose idol is not owned (e.g. a story/quest card outside the gacha
// pools) must spawn the UserCharacter + default cosmetics, or a later
// Quest:ListAsset fails with "not enough owned idols for the live appearance".
const masterIndex = await import('./master/index.ts');
const spawnCardId = 'card-kor-05-idol-00';
const spawnCardMaster = await masterIndex.getCard(spawnCardId);
const spawnCharacterId = String(spawnCardMaster?.CharacterId ?? '');
const spawnMasterCharacter = spawnCharacterId ? await masterIndex.getCharacter(spawnCharacterId) : null;
const spawnActivityLevel = await masterIndex.getCharacterActivityLevel(1);
check('Card spawn: master card references an idol', spawnCharacterId === 'char-kor');
check('Card spawn: master idol row present', !!spawnMasterCharacter);

// Deterministic start: drop the card and the idol so the grant takes the
// new-card path even on a re-run.
await ps.removeElements(SERVER_USER_ID, 'Cards', [
  { __msg: 'Solis.Common.Proto.Transaction.UserCard', CardId: spawnCardId } as any,
]);
await ps.removeElements(SERVER_USER_ID, 'Characters', [
  { __msg: 'Solis.Common.Proto.Transaction.UserCharacter', CharacterId: spawnCharacterId } as any,
]);
const spawnBefore = await ps.listElements(SERVER_USER_ID, 'Characters');
check('Card spawn: test idol starts unowned',
  !spawnBefore.some((c: any) => String(c.CharacterId) === spawnCharacterId));

const spawnGrant = await applyRewardRefs(SERVER_USER_ID, [`rd_auto;card;${spawnCardId};1`]);
const spawnAfter = await userGet();
const spawnedCharacter = (spawnAfter.Characters ?? []).find((c: any) => String(c.CharacterId) === spawnCharacterId);
check('Card grant spawns the card idol', !!spawnedCharacter);
check('Card grant spawns the idol at ActivityLevel 1', Number(spawnedCharacter?.ActivityLevel ?? 0) === 1);
check('Card grant idol FavoriteCostumeId is the master default',
  String(spawnedCharacter?.FavoriteCostumeId ?? '') === String(spawnMasterCharacter?.DefaultCostumeId ?? ''));
check('Card grant idol LiveCostumeId is the master live default',
  String(spawnedCharacter?.LiveCostumeId ?? '') === String(spawnMasterCharacter?.DefaultLiveCostumeId ?? ''));
check('Card grant idol ActivityStamina is the level-1 max',
  Number(spawnedCharacter?.ActivityStamina ?? 0) === Number(spawnActivityLevel?.MaxStamina ?? 0));
check('Card grant surfaces the idol in UpdatedData.Characters',
  (spawnGrant.updated?.Characters ?? []).some((c: any) => String(c.CharacterId) === spawnCharacterId));
check('Card grant returns a Character RewardResult',
  (spawnGrant.results ?? []).some((r: any) =>
    Number(r.ResourceType) === 4 && String(r.ResourceId) === spawnCharacterId && Number(r.AfterAmount) === 1));

const spawnDup = await inv.grantCard(SERVER_USER_ID, { CardId: spawnCardId } as any);
const spawnDupCharacters = await ps.listElements(SERVER_USER_ID, 'Characters');
check('Card spawn: duplicate grant does not add a second idol',
  spawnDupCharacters.filter((c: any) => String(c.CharacterId) === spawnCharacterId).length === 1);
check('Card spawn: duplicate grant returns no spawned elements',
  (spawnDup.characters ?? []).length === 0 && (spawnDup.costumes ?? []).length === 0 && (spawnDup.hairs ?? []).length === 0);

// --- Tutorial:Progress persists UserTutorial records (no feature-tutorial replay) ---
const tutorialProgress = async (type: number, step: number) => {
  const bytes = await dispatchRpc(
    'Tutorial:Progress',
    encodeReq(msgRegistry.get(endpoints['Tutorial']['Progress'].request)!, { Type: type, Step: step }),
    { headers: { 'x-auth-token': r1.GameAuthToken }, log: { info() {}, warn() {} } } as any,
  );
  return decodeMessage(
    msgRegistry.get(endpoints['Tutorial']['Progress'].response)!,
    new Reader(Uint8Array.from(bytes)),
  ) as any;
};
await tutorialProgress(41, 1);
const uTut = await userGet();
const tut41 = uTut.Tutorials?.find((t: any) => Number(t.TutorialType) === 41);
check('Tutorial:Progress persists UserTutorial Type 41 (served in User:Get)', !!tut41 && Number(tut41.Step) === 1);
await tutorialProgress(41, 2);
const uTut2 = await userGet();
const tut41Rows = uTut2.Tutorials?.filter((t: any) => Number(t.TutorialType) === 41) ?? [];
check('Tutorial:Progress upserts by TutorialType (single row, step advanced)',
  tut41Rows.length === 1 && Number(tut41Rows[0]?.Step) === 2);

// --- Full-suite handler coverage (uncaptured: schema-built, permissive/stub responses) ---
// Fills dbtest gaps for implemented RPCs that had no direct coverage (Story/Love/
// Company/Tutorial/Notice/Dokan/System/Master/Home + the one missing Showcase RPC).
const callEmptyReq = async (name: string) => {
  const [svc, method] = name.split(':');
  const respShape = (endpoints as any)[svc!][method!].response;
  const bytes = await dispatchRpc(name, Buffer.alloc(0), authOpts);
  return decodeMessage(msgRegistry.get(respShape)!, new Reader(Uint8Array.from(bytes))) as any;
};

// Story: event/extra lists, event/extra reads, release + stub read handlers.
const stListEvent = await callEmptyReq('Story:ListEvent');
check('Story:ListEvent returns an empty Infos list', (stListEvent.Infos?.length ?? 0) === 0);
check('Story:ListEvent returns CommonResponse', !!stListEvent.CommonResponse);

const stReadEvent = await callRpc('Story:ReadEvent', 'Solis.Common.Proto.Api.StoryReadEventRequest', {
  EventStoryId: 'st-eve-2107-tour',
  Episode: 1,
});
const stReadEventStory = stReadEvent.CommonResponse?.UpdatedData?.Stories?.[0];
check(
  'Story:ReadEvent resolves the episode StoryId and marks it read',
  stReadEventStory?.StoryId === 'st-eve-2107-tour-001' && Number(stReadEventStory?.StatusType) === 2,
);
let stReadEventThrew = false;
try {
  await callRpc('Story:ReadEvent', 'Solis.Common.Proto.Api.StoryReadEventRequest', {
    EventStoryId: 'st-eve-does-not-exist',
    Episode: 1,
  });
} catch {
  stReadEventThrew = true;
}
check('Story:ReadEvent rejects an unknown EventStory', stReadEventThrew);

const stListExtra = await callEmptyReq('Story:ListExtra');
check('Story:ListExtra returns an empty Infos list', (stListExtra.Infos?.length ?? 0) === 0);

const stReadExtra = await callRpc('Story:ReadExtra', 'Solis.Common.Proto.Api.StoryReadExtraRequest', {
  ExtraStoryId: 'ex-story-part-special-01-26-0401-april',
  Episode: 1,
});
check(
  'Story:ReadExtra resolves the episode StoryId and marks it read',
  stReadExtra.CommonResponse?.UpdatedData?.Stories?.[0]?.StoryId ===
      'st-ex-story-part-special-01-26-0401-april-01' &&
    Number(stReadExtra.CommonResponse?.UpdatedData?.Stories?.[0]?.StatusType) === 2,
);
let stReadExtraThrew = false;
try {
  await callRpc('Story:ReadExtra', 'Solis.Common.Proto.Api.StoryReadExtraRequest', {
    ExtraStoryId: 'ex-does-not-exist',
    Episode: 1,
  });
} catch {
  stReadExtraThrew = true;
}
check('Story:ReadExtra rejects an unknown ExtraStory', stReadExtraThrew);

const stRelease = await callRpc('Story:ReleaseEpisode', 'Solis.Common.Proto.Api.StoryReleaseEpisodeRequest', {
  StoryPartId: 'st-part-group-01',
  Chapter: 1,
  Route: 1,
  Episode: 1,
});
check('Story:ReleaseEpisode is a permissive no-op', !!stRelease.CommonResponse);

const stAnniversary = await callRpc(
  'Story:ReadAnniversaryStory',
  'Solis.Common.Proto.Api.StoryReadAnniversaryStoryRequest',
  { AnniversaryId: 'anniv-1', Episode: 1 },
);
check('Story:ReadAnniversaryStory returns an empty read envelope',
  !!stAnniversary.CommonResponse && (stAnniversary.Rewards?.length ?? 0) === 0);

const stCompanyEnjoy = await callRpc(
  'Story:ReadCharacterCompanyEnjoyStory',
  'Solis.Common.Proto.Api.StoryReadCharacterCompanyEnjoyStoryRequest',
  { CharacterId: 'char-smr', Number: 1, IsLast: true },
);
check('Story:ReadCharacterCompanyEnjoyStory is a stub envelope', !!stCompanyEnjoy.CommonResponse);

// Love: restart (alias of Start), save-name + reading-status reset.
// Start the episode first: the ported route engine only allows Restart while
// that episode is actively being read.
await startLoveWith(LOVE_FIRST_EP);
const loveRestart = await loveRpc('Restart', { StoryEpisodeId: LOVE_FIRST_EP });
check('Love:Restart sets IsReadingStory',
  Number(loveRestart.CommonResponse?.UpdatedData?.Loves?.[0]?.IsReadingStory ?? 0) === 1);
check('Love:Restart returns the episode choice groups', (loveRestart.StoryChoiceGroupInfos?.length ?? 0) === 5);

const loveResetReading = await loveRpc('ResetReadingStoryStatus', { LoveId: LOVE_ID });
check('Love:ResetReadingStoryStatus clears IsReadingStory',
  Number(loveResetReading.CommonResponse?.UpdatedData?.Loves?.[0]?.IsReadingStory ?? 0) === 0);

await loveRpc('Save', { LoveId: LOVE_ID, SlotNumber: 1 });
const loveRename = await loveRpc('UpdateSaveName', { LoveId: LOVE_ID, SlotNumber: 1, Name: 'SAVE-A' });
check('Love:UpdateSaveName returns CommonResponse', !!loveRename.CommonResponse);

// Company: top/ranking + enjoy-character reads + the permissive reward handlers.
// Company missions are synthesized from master data, so pick the ids to probe
// by scanning master instead of hardcoding them.
const companyMasters = await listMissions();
const trustMissionMasters = companyMasters.filter(
  (m) => String(m.Id ?? '') !== '' && Number(m.CompanyTrustMissionCategoryType ?? 0) !== 0,
);
const enjoyMissionMasters = companyMasters.filter(
  (m) =>
    String(m.Id ?? '') !== '' &&
    String(m.CompanyEnjoyCharacterId ?? '') !== '' &&
    Number(m.CompanyEnjoyCharacterMissionCategoryType ?? 0) !== 0,
);
const enjoyMissionCharacterId = String(enjoyMissionMasters[0]?.CompanyEnjoyCharacterId ?? '');

const companyTop = await callRpc('Company:Top', 'Solis.Common.Proto.Api.CompanyTopRequest', {
  IsSkipReportMissions: false,
});
check('Company:Top returns CommonResponse', !!companyTop.CommonResponse);
check(
  'Company:Top returns TrustMissionInfos when master has trust missions',
  trustMissionMasters.length === 0
    ? (companyTop.TrustMissionInfos?.length ?? 0) === 0
    : (companyTop.TrustMissionInfos?.length ?? 0) > 0,
);
check(
  'Company:Top TrustMissionInfos carry one completed mission per category',
  (companyTop.TrustMissionInfos ?? []).every(
    (g: any) =>
      Number(g.CategoryType ?? 0) !== 0 &&
      g.UserMissions?.length === 1 &&
      g.UserMissions.every(
        (um: any) =>
          Number(um.StatusType) === 4 && Number(um.Progress) === Number(um.CurrentThreshold),
      ),
  ),
);

const companyEnjoy = await callRpc('Company:EnjoyCharacterTop', 'Solis.Common.Proto.Api.CompanyEnjoyCharacterTopRequest', {
  CharacterId: 'char-smr',
});
check('Company:EnjoyCharacterTop resolves the requested character',
  companyEnjoy.EnjoyLevelInfos?.[0]?.CharacterId === 'char-smr');
const companyEnjoyEmpty = await callRpc('Company:EnjoyCharacterTop', 'Solis.Common.Proto.Api.CompanyEnjoyCharacterTopRequest', {
  CharacterId: '',
});
check('Company:EnjoyCharacterTop returns no levels without a CharacterId',
  (companyEnjoyEmpty.EnjoyLevelInfos?.length ?? 0) === 0);

check('master data has enjoy-character missions', enjoyMissionCharacterId !== '');
if (enjoyMissionCharacterId !== '') {
  const companyEnjoyMissions = await callRpc(
    'Company:EnjoyCharacterTop',
    'Solis.Common.Proto.Api.CompanyEnjoyCharacterTopRequest',
    { CharacterId: enjoyMissionCharacterId },
  );
  const enjoyMissionInfos = companyEnjoyMissions.MissionInfos ?? [];
  check(
    'Company:EnjoyCharacterTop returns MissionInfos for a character with enjoy missions',
    enjoyMissionInfos.length > 0,
  );
  check(
    'Company:EnjoyCharacterTop MissionInfos carry one completed mission per category',
    enjoyMissionInfos.length > 0 &&
      enjoyMissionInfos.every(
        (g: any) =>
          Number(g.CategoryType ?? 0) !== 0 &&
          g.UserMissions?.length === 1 &&
          g.UserMissions.every(
            (um: any) =>
              typeof um.MissionId === 'string' &&
              um.MissionId.length > 0 &&
              Number(um.StatusType) === 4 &&
              Number(um.Progress) === Number(um.CurrentThreshold),
          ),
      ),
  );
}

const companyRpcOk = async (name: string, reqShape: string, req: any) => {
  const resp = await callRpc(`Company:${name}`, reqShape, req);
  check(`Company:${name} returns CommonResponse`, !!resp.CommonResponse);
};
const companyEmptyOk = async (name: string) => {
  const resp = await callEmptyReq(`Company:${name}`);
  check(`Company:${name} returns CommonResponse`, !!resp.CommonResponse);
};
await companyEmptyOk('ListRanking');
await companyRpcOk('ReceiveGradeRewards', 'Solis.Common.Proto.Api.CompanyReceiveGradeRewardsRequest', { GradeIds: ['grade-1'] });
await companyRpcOk('BulkReceiveMission', 'Solis.Common.Proto.Api.CompanyBulkReceiveMissionRequest', { MissionIds: ['mission-1'] });
await companyRpcOk('ListEnjoyCharacterRanking', 'Solis.Common.Proto.Api.CompanyListEnjoyCharacterRankingRequest', { CharacterId: 'char-smr' });
await companyRpcOk('ReceiveEnjoyCharacterLevelRewards', 'Solis.Common.Proto.Api.CompanyReceiveEnjoyCharacterLevelRewardsRequest', { CharacterId: 'char-smr', LevelKeys: [1] });
let companyUseUnknownThrew = false;
try {
  await callRpc('Company:UseEnjoyObtainPointItem', 'Solis.Common.Proto.Api.CompanyUseObtainEnjoyPointItemRequest', {
    CharacterId: 'char-smr',
    ItemId: 'item-x',
    ConsumptionItemAmount: 1,
  });
} catch {
  companyUseUnknownThrew = true;
}
check('Company:UseEnjoyObtainPointItem rejects an unknown item', companyUseUnknownThrew);
await companyRpcOk('BulkReceiveEnjoy', 'Solis.Common.Proto.Api.CompanyBulkReceiveEnjoyRequest', { MissionIds: ['mission-1'] });
await companyEmptyOk('BulkReceiveEnjoyCharacterLevelRewards');
await companyRpcOk('ReceiveTrustLevelRewards', 'Solis.Common.Proto.Api.CompanyReceiveTrustLevelRewardsRequest', { LevelKeys: [1] });

// Tutorial: init/start + permissive reward/skip handlers.
const tutorialInit = await callRpc('Tutorial:Init', 'Solis.Common.Proto.Api.TutorialInitRequest', { Name: 'test' });
check('Tutorial:Init returns CommonResponse', !!tutorialInit.CommonResponse);
const tutorialStartQuest = await callRpc('Tutorial:StartQuest', 'Solis.Common.Proto.Api.TutorialStartQuestRequest', { QuestId: 'quest-1' });
check('Tutorial:StartQuest returns CommonResponse', !!tutorialStartQuest.CommonResponse);
const tutorialCreateShooting = await callRpc('Tutorial:CreateShooting', 'Solis.Common.Proto.Api.TutorialPhotoCreateShootingRequest', {
  MainCharacterId: 'char-smr',
  PhotoImageId: await reservedImageId(),
});
check('Tutorial:CreateShooting returns CommonResponse', !!tutorialCreateShooting.CommonResponse);
for (const name of ['StartFanEvent', 'ReceivePromotionReward', 'ReceiveLessonReward', 'Skip']) {
  const resp = await callEmptyReq(`Tutorial:${name}`);
  check(`Tutorial:${name} returns CommonResponse`, !!resp.CommonResponse);
}

// Notice: list/fetch/get (private server returns empty/permissive payloads).
const noticeList = await callEmptyReq('Notice:List');
check('Notice:List returns an empty Notices list', (noticeList.Notices?.length ?? 0) === 0);
check('Notice:List returns CommonResponse', !!noticeList.CommonResponse);
const noticeFetch = await callRpc('Notice:FetchList', 'Solis.Common.Proto.Api.NoticeFetchRequest', { NoticeCategoryType: 1, Offset: 0 });
check('Notice:FetchList returns an empty Notices list', (noticeFetch.Notices?.length ?? 0) === 0);
const noticeGet = await callRpc('Notice:Get', 'Solis.Common.Proto.Api.NoticeGetRequest', { NoticeId: 'notice-test-01' });
check('Notice:Get echoes the requested NoticeId', noticeGet.Notice?.Id === 'notice-test-01');

// Dokan: watched-log ack (permissive).
const dokanSetWatched = await callRpc('Dokan:SetWatched', 'Solis.Common.Proto.Api.DokanSetWatchedRequest', { DokanIds: ['dokan-photo-expression-tutorial'] });
check('Dokan:SetWatched returns CommonResponse', !!dokanSetWatched.CommonResponse);
const dokanOutput = await callRpc('Dokan:OutputWatchedLog', 'Solis.Common.Proto.Api.DokanOutputWatchedLogRequest', { DokanIds: ['dokan-photo-expression-tutorial'] });
check('Dokan:OutputWatchedLog returns CommonResponse', !!dokanOutput.CommonResponse);

// System: check payload + empty metadata.
const systemCheck = await callRpc('System:Check', 'Solis.Common.Proto.Api.SystemCheckRequest', { FirebaseIDToken: 'x' });
check('System:Check returns KeepAliveTimeMilliseconds', Number(systemCheck.KeepAliveTimeMilliseconds) === 60000);
const systemMetadataBytes = await dispatchRpc('System:GetMetadata', Buffer.alloc(0), authOpts);
check('System:GetMetadata returns an empty body', systemMetadataBytes.length === 0);
const systemCheckAppBytes = await dispatchRpc('System:CheckApp', Buffer.alloc(0), authOpts);
check('System:CheckApp returns an empty body', systemCheckAppBytes.length === 0);

// Master:Get serves the harvested manifest with rewritten download URLs.
const masterGet = await callEmptyReq('Master:Get');
check('Master:Get returns the master version', typeof masterGet.MasterTag?.Version === 'string' && masterGet.MasterTag.Version.length > 0);
check('Master:Get returns master tag packs', (masterGet.MasterTag?.MasterTagPacks?.length ?? 0) >= 1);

// Home:Enter injects the server-gated unlocked LoveInfo.
const homeEnter = await callRpc('Home:Enter', 'Solis.Common.Proto.Api.HomeEnterRequest', { SkipUpdate: false });
check('Home:Enter injects an unlocked LoveInfo', Number(homeEnter.LoveInfo?.IsUnlocked ?? 0) === 1);
// The captured account's Promotion/Refresh slots must not leak into ours.
check('Home:Enter has no active promotion without a run', !homeEnter.PromotionInfo?.ActivePromotion);
check('Home:Enter has no active refresh', !homeEnter.RefreshInfo?.ActiveRefresh);

// Showcase: the one implemented RPC without prior coverage.
const showcaseRecommend = await callEmptyReq('Showcase:SearchFriendRecommendList');
check('Showcase:SearchFriendRecommendList returns ShowcaseInfos', (showcaseRecommend.ShowcaseInfos?.length ?? 0) >= 1);
check('Showcase:SearchFriendRecommendList returns TermInfo', !!showcaseRecommend.TermInfo?.Month);

// --- Activity promotion (Solis load/fetch/start/finish/receive/use promotion) ---
const PROMOTION_ID = 'act-pro-01';
const promotionAmount = (resp: any, resourceType: number) =>
  Number((resp.Rewards ?? []).find((r: any) => Number(r.ResourceType) === resourceType)?.Amount ?? 0);
const promotionState = () => getSingleton(SERVER_USER_ID, 'ActivityPromotion');

// Fresh player: Solis rejects promotion loads while no run exists.
let promoFreshLoadThrew = false;
try {
  await callEmptyReq('Activity:LoadPromotion');
} catch {
  promoFreshLoadThrew = true;
}
check('Activity:LoadPromotion rejects a player with no active run', promoFreshLoadThrew);
check('Activity:LoadPromotion rejection leaves no promotion state', (await promotionState()) === null);

// Finish without a start is rejected as well.
let promoFinishWithoutStartThrew = false;
try {
  await callEmptyReq('Activity:FinishPromotion');
} catch {
  promoFinishWithoutStartThrew = true;
}
check('Activity:FinishPromotion rejects without an active run', promoFinishWithoutStartThrew);

// Pick a Solis-valid lineup from the seeded roster: three owned characters with
// matching owned costume/hair pairs that satisfy the performance costume types.
const popupPerformance = await getActivityPerformance('popup');
check('Activity promotion master carries the popup performance', !!popupPerformance);
const allowedCostumeTypes = new Set((popupPerformance?.CostumeTypeIds as string[] | null) ?? []);
const promoUser = await userGet();
const ownedCostumeIds = new Set<string>((promoUser.Costumes ?? []).map((c: any) => String(c.CostumeId)));
const ownedHairIds = new Set<string>((promoUser.Hairs ?? []).map((h: any) => String(h.HairId)));
const promoLineup: { characterId: string; costumeId: string; hairId: string }[] = [];
for (const character of promoUser.Characters ?? []) {
  const characterId = String(character.CharacterId);
  let chosen: { characterId: string; costumeId: string; hairId: string } | null = null;
  for (const costumeId of ownedCostumeIds) {
    const costume = await getCostume(costumeId);
    if (!costume || String(costume.CharacterId) !== characterId) continue;
    if (!allowedCostumeTypes.has(String(costume.CostumeTypeId ?? ''))) continue;
    for (const hairId of ownedHairIds) {
      const hair = await getHair(hairId);
      if (!hair || String(hair.CharacterId) !== characterId) continue;
      const notWearable = (hair.NotWearableCostumeIds as string[] | null) ?? [];
      const wearable = (hair.WearableCostumeIds as string[] | null) ?? [];
      if (notWearable.includes(costumeId) || (wearable.length > 0 && !wearable.includes(costumeId))) continue;
      chosen = { characterId, costumeId, hairId };
      break;
    }
    if (chosen) break;
  }
  if (chosen) {
    promoLineup.push(chosen);
    if (promoLineup.length === 3) break;
  }
}
check('Activity promotion finds a valid three-character lineup', promoLineup.length === 3);

const startPromotion = (stamina: number) =>
  callRpc('Activity:StartPromotion', 'Solis.Common.Proto.Api.ActivityStartPromotionRequest', {
    ActivityPromotionId: PROMOTION_ID,
    CharacterIds: promoLineup.map((l) => l.characterId),
    CostumeIds: promoLineup.map((l) => l.costumeId),
    HairIds: promoLineup.map((l) => l.hairId),
  });

const setLineupStamina = async (stamina: number) => {
  const characters = await listElements(SERVER_USER_ID, 'Characters');
  const selected = new Set(promoLineup.map((l) => l.characterId));
  const touched = characters.filter((c) => selected.has(String(c.CharacterId)));
  for (const character of touched) {
    character.InActivity = false;
    character.ActivityStamina = stamina;
    character.StaminaUpdatedTime = Date.now();
  }
  await putElements(SERVER_USER_ID, 'Characters', touched);
};

await setLineupStamina(0);
let promoStartNoStaminaThrew = false;
try {
  await startPromotion(0);
} catch {
  promoStartNoStaminaThrew = true;
}
check('Activity:StartPromotion rejects characters without activity stamina', promoStartNoStaminaThrew);
check('Activity:StartPromotion rejection leaves no promotion state', (await promotionState()) === null);

await setLineupStamina(6);
const promoStart = await startPromotion(6);
check('Activity:StartPromotion returns the new progress', promoStart.Progress?.ActivityPromotionId === PROMOTION_ID);
check('Activity:StartPromotion puts three characters on the run', (promoStart.Progress?.Characters?.length ?? 0) === 3);
const homeEnterPromo = await callRpc('Home:Enter', 'Solis.Common.Proto.Api.HomeEnterRequest', { SkipUpdate: false });
check('Home:Enter shows the running promotion lineup',
  JSON.stringify(homeEnterPromo.PromotionInfo?.ActivePromotion?.CharacterIds ?? [])
    === JSON.stringify((promoStart.Progress?.Characters ?? []).map((c: any) => c.CharacterId)));
check('Activity:StartPromotion starts at zero completed steps', Number(promoStart.Progress?.CompletedStep) === 0);
check('Activity:StartPromotion schedules a finish time', Number(promoStart.Progress?.FinishTime) > Number(promoStart.Progress?.StartTime));
check('Activity:StartPromotion writes the Solis step gold', Number(promoStart.Progress?.StepRewardGold) === 470);
check('Activity:StartPromotion derives manager exp from step gold', Number(promoStart.Progress?.StepRewardManagerExp) === 91);
check('Activity:StartPromotion derives activity exp from step gold', Number(promoStart.Progress?.StepRewardActivityExp) === 52);
check('Activity:StartPromotion derives character exp from step gold', Number(promoStart.Progress?.StepRewardCharacterActivityExp) === 57);
check('Activity:StartPromotion marks the characters InActivity',
  (await userGet()).Characters?.filter((c: any) => promoLineup.some((l) => l.characterId === c.CharacterId))
    .every((c: any) => Boolean(c.InActivity)) === true);

const promoSteps = await callRpc('Activity:FetchPromotionSteps', 'Solis.Common.Proto.Api.ActivityFetchPromotionStepsRequest', { Step: 0 });
check('Activity:FetchPromotionSteps returns an empty step list', (promoSteps.Steps?.length ?? 0) === 0);

let promoNegativeStepThrew = false;
try {
  await callRpc('Activity:FetchPromotionSteps', 'Solis.Common.Proto.Api.ActivityFetchPromotionStepsRequest', { Step: -1 });
} catch {
  promoNegativeStepThrew = true;
}
check('Activity:FetchPromotionSteps rejects a negative step', promoNegativeStepThrew);

// Backdate the run by four steps, then settle them through ReceivePromotionReward.
const backdatePromotion = async (elapsedMs: number) => {
  const state: any = await promotionState();
  state.Run.StartTime = Date.now() - elapsedMs;
  await putSingleton(SERVER_USER_ID, 'ActivityPromotion', state);
};
await backdatePromotion(40_000);
const promoReceive = await callEmptyReq('Activity:ReceivePromotionReward');
check('Activity:ReceivePromotionReward advances four completed steps', Number(promoReceive.CompletedStep) === 4);
check('Activity:ReceivePromotionReward pays 4 x 470 gold', promotionAmount(promoReceive, 8) === 1880);
check('Activity:ReceivePromotionReward pays 4 x 91 manager exp', promotionAmount(promoReceive, 14) === 364);
check('Activity:ReceivePromotionReward pays 4 x 531 card-enhance items', promotionAmount(promoReceive, 1) === 2124);
check('Activity:ReceivePromotionReward clears the pending gold', Number(promoReceive.Progress?.RewardGoldAmount) === 0);

const promoReceiveAgain = await callEmptyReq('Activity:ReceivePromotionReward');
check('Activity:ReceivePromotionReward pays nothing without new steps', (promoReceiveAgain.Rewards?.length ?? 0) === 0);

// UsePromotionItem: shortening consumes the stack and moves both timestamps.
let promoShortenMissingThrew = false;
try {
  await callRpc('Activity:UsePromotionItem', 'Solis.Common.Proto.Api.ActivityUsePromotionItemRequest', {
    ItemId: 'item-act_promotion_shorten',
    Amount: 1,
  });
} catch {
  promoShortenMissingThrew = true;
}
check('Activity:UsePromotionItem rejects an insufficient item stack', promoShortenMissingThrew);

await grantPromotionItem(SERVER_USER_ID, 'item-act_promotion_shorten', 2);
const promoFinishBefore = Number((await promotionState())?.Run?.FinishTime);
const promoShorten = await callRpc('Activity:UsePromotionItem', 'Solis.Common.Proto.Api.ActivityUsePromotionItemRequest', {
  ItemId: 'item-act_promotion_shorten',
  Amount: 1,
});
check('Activity:UsePromotionItem consumes one shortening item',
  (await getItemAmount(SERVER_USER_ID, 'item-act_promotion_shorten')) === 1);
check('Activity:UsePromotionItem shortens the finish time by 2 hours',
  Number(promoShorten.Progress?.FinishTime) === promoFinishBefore - 2 * 60 * 60 * 1000);
check('Activity:UsePromotionItem returns the shortened progress',
  promoShorten.Progress?.ActivityPromotionId === PROMOTION_ID);

// Finish settles the remaining steps and clears the run.
const promoFinish = await callEmptyReq('Activity:FinishPromotion');
check('Activity:FinishPromotion settles the remaining step gold', promotionAmount(promoFinish, 8) === 14 * 470);
check('Activity:FinishPromotion reports the total completed steps', Number(promoFinish.TotalSteps) === 18);
check('Activity:FinishPromotion returns the three characters', (promoFinish.Characters?.length ?? 0) === 3);
check('Activity:FinishPromotion clears the run', (await promotionState())?.Run === null);
check('Activity:FinishPromotion releases the characters',
  (await userGet()).Characters?.filter((c: any) => promoLineup.some((l) => l.characterId === c.CharacterId))
    .every((c: any) => !c.InActivity) === true);

let promoDoubleReceiveThrew = false;
try {
  await callEmptyReq('Activity:ReceivePromotionReward');
} catch {
  promoDoubleReceiveThrew = true;
}
check('Activity:ReceivePromotionReward rejects after the run finished', promoDoubleReceiveThrew);
let promoDoubleFinishThrew = false;
try {
  await callEmptyReq('Activity:FinishPromotion');
} catch {
  promoDoubleFinishThrew = true;
}
check('Activity:FinishPromotion rejects a second finish', promoDoubleFinishThrew);

console.log(`\ndb auth test: ${pass} passed, ${fail} failed`);
await app.close();
await (await import('./db/client.ts')).client.end({ timeout: 5 });
process.exit(fail ? 1 : 0);
