// Quest RPC tests (port of the "Quest (top/list/start)" section added to
// `src/dbtest.ts` on the narrative stack, commits 3352454 and 4a31ed3).
//
// Run with `npm run test:quest` against a database with master data seeded and
// the capture corpus available ($DATABASE_URL + $SUMIRE_DATA_DIR/captures).

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
import { listElements, loadOrSeed, removeElements } from './services/playerState.ts';
import { dispatchRpc } from './services/router.ts';
import './services/all.ts';

const { listQuestsByArea } = await import('./master/index.ts');

await requireData({ captures: true, db: true });

// Dedicated test account. Seeded state is wiped deterministically so repeated
// runs start from the same captured corpus.
const TEST_ACCOUNT_ID = 'questtest-account-0000-4000-8000-000000000001';
const TEST_UID = 'questtest-firebase-uid-0001';
const SERVER_USER_ID = 'questtest-user-0000-4000-8000-000000000001';
const TEST_PUBLIC_USER_ID = 'QUESTTEST';

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
check('quest: corpus carries a User:Get template', templateBytes !== null);
const templateShape = msgRegistry.get('Solis.Common.Proto.Api.UserGetResponse');
if (!templateBytes || !templateShape) {
  console.log(`\nquest test: ${pass} passed, ${fail} failed`);
  await (await import('./db/client.ts')).client.end({ timeout: 5 });
  process.exit(fail ? 1 : 0);
}
const seedTemplate = decodeMessage(templateShape, new Reader(Uint8Array.from(templateBytes)));
await loadOrSeed(SERVER_USER_ID, seedTemplate);

const questToken = mintToken({ sub: TEST_ACCOUNT_ID, seedId: TEST_PUBLIC_USER_ID });
const questAuth = {
  headers: { 'x-auth-token': questToken },
  log: { info() {}, warn() {} },
} as any;
const questRpc = async (name: string, body: Record<string, unknown> = {}) => {
  const endpoint = (endpoints['Quest'] as any)[name];
  const requestShape = endpoint.request ? msgRegistry.get(endpoint.request) : null;
  let plain = Buffer.alloc(0);
  if (requestShape) {
    const writer = new Writer();
    encodeMessage(requestShape, body as any, writer);
    plain = Buffer.from(writer.toBytes());
  }
  const bytes = await dispatchRpc(`Quest:${name}`, plain, questAuth);
  return decodeMessage(
    msgRegistry.get(endpoint.response)!,
    new Reader(Uint8Array.from(bytes)),
  ) as any;
};
const questStart = (questId: string) =>
  questRpc('Start', { QuestId: questId, DeckNumber: liveDeckNumber, PlayCount: 1 });

const managerRow = async () =>
  (await db.select().from(players).where(eq(players.id, SERVER_USER_ID)).limit(1))[0];

// The quest RPCs simulate a live with the player's saved deck, so pick the
// lowest complete saved deck instead of assuming deck 1 is playable.
const liveDecks = await listElements(SERVER_USER_ID, 'Decks');
const liveOwnedPhotos = new Set(
  (await listElements(SERVER_USER_ID, 'Photos')).map((row: any) => String(row.PhotoId)),
);
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
check('quest: the account has a complete saved deck', liveDeckRow !== undefined);
const liveDeckNumber = Number(liveDeckRow?.Number ?? 0);

const liveQuest = [...(await listQuestsByArea('area-main-001'))].sort(
  (a, b) => Number(a.Order ?? 0) - Number(b.Order ?? 0),
)[0] as any;
check('quest: area-main-001 exposes a quest', liveQuest !== undefined);

// --- Quest (top/list/start) ---

// Start from a fresh quest state; the seeded corpus already contains clears.
await db
  .delete(playerEntities)
  .where(and(eq(playerEntities.playerId, SERVER_USER_ID), eq(playerEntities.kind, 'Areas')));
await db
  .delete(playerEntities)
  .where(and(eq(playerEntities.playerId, SERVER_USER_ID), eq(playerEntities.kind, 'Quests')));

const questTop = await questRpc('Top');
const questMain = await questRpc('ListMain');
const mainGroups = questMain.AreaGroups ?? [];
const firstMainArea = mainGroups[0]?.Areas?.[0];
const secondMainArea = mainGroups[0]?.Areas?.[1];
check('Quest:Top returns main area groups', (questTop.MainAreaGroups ?? []).length > 0);
check(
  'Quest:ListMain first area is unlocked',
  firstMainArea?.AreaId === 'area-main-001' && Boolean(firstMainArea?.Unlocked),
);
check('Quest:ListMain second area is locked before the first is cleared', !secondMainArea?.Unlocked);
check(
  'Quest:ListMain first quest is playable on fresh state',
  firstMainArea?.Quests?.[0]?.QuestId === 'qt-main-1-001-01' && Boolean(firstMainArea?.Quests?.[0]?.IsPlayable),
);

const managerBeforeQuest = await managerRow();
// The seeded account may already own every quest song; drop this one so the
// unlock path is observable.
await removeElements(SERVER_USER_ID, 'Musics', [{ MusicId: liveQuest.MusicId }]);
const firstQuestStart = await questStart('qt-main-1-001-01');
check('Quest:Start clears the first main quest', Number(firstQuestStart.Result?.Cleared) === 1);
check('Quest:Start returns a positive live score', Number(firstQuestStart.Result?.UserInfos?.[0]?.UserResult?.Score ?? 0) > 0);
check('Quest:Start returns rank patterns', (firstQuestStart.RankPatterns ?? []).length === 3);
check('Quest:Start records the highest score', Number(firstQuestStart.HighestScore ?? 0) > 0);
check('Quest:Start main lives keep rank Unknown (Solis)', Number(firstQuestStart.RankType ?? 0) === 0 && Number(firstQuestStart.HighestRank ?? 0) === 0);
const questUpdated = firstQuestStart.CommonResponse?.UpdatedData ?? {};
// rd-main-quest-001-01: 290 item-card_enhance, gold, manager exp, accessory ac-1-visual-02.
const clearRewards = firstQuestStart.Reward?.ClearRewards ?? [];
check(
  'Quest:Start returns the quest clear reward (Solis grantQuestReward)',
  clearRewards.some((row: any) => row.ResourceId === 'item-card_enhance' && Number(row.AmountI64) === 290),
);
check(
  'Quest:Start clear reward items reach UpdatedData',
  (questUpdated.Items ?? []).some((row: any) => row.ItemId === 'item-card_enhance' && Number(row.Amount) >= 290),
);
check('Quest:Start main lives grant no score-rank rewards', (firstQuestStart.Reward?.ScoreRankRewards ?? []).length === 0);
check(
  'Quest:Start surfaces the cleared quest in UpdatedData',
  (questUpdated.Quests ?? []).some((row: any) => row.QuestId === 'qt-main-1-001-01' && Number(row.LastClearedTime) > 0),
);
const managerAfterQuest = await managerRow();
check('Quest:Start grants manager exp', Number(managerAfterQuest.exp) > Number(managerBeforeQuest.exp));
check(
  'Quest:Start grants card exp to the deck',
  (firstQuestStart.Reward?.RewardCards ?? []).length === 5,
);
check(
  'Quest:Start unlocks the quest music',
  (questUpdated.Musics ?? []).some((row: any) => row.MusicId === liveQuest.MusicId),
);
check(
  'Quest:ListMain re-read shows the first clear',
  Number((await questRpc('ListMain')).AreaGroups?.[0]?.Areas?.[0]?.Quests?.[0]?.Cleared) === 1,
);

// A quest in the second area is still locked until area-main-001 is complete.
let lockedRejected = false;
try {
  await questStart('qt-main-1-003-01');
} catch {
  lockedRejected = true;
}
check('Quest:Start rejects a locked quest', lockedRejected);

// Clear every quest in area-main-001..003 sequentially, as required by the
// cd-clear-area-main-003 condition (Condition.Settings[0].ClearArea.AreaId).
const questOrder: string[] = [];
for (const areaId of ['area-main-001', 'area-main-002', 'area-main-003']) {
  const area = [...(await listQuestsByArea(areaId))].sort(
    (a, b) => Number(a.Order ?? 0) - Number(b.Order ?? 0),
  );
  for (const quest of area) questOrder.push(String(quest.Id));
}
// The seeded deck cannot beat the later main quests; this section verifies
// persistence, so lower the clear threshold instead of asserting difficulty.
const originalQuestClearScores = await db
  .select({ Id: masterQuest.Id, ClearScore: masterQuest.ClearScore })
  .from(masterQuest)
  .where(inArray(masterQuest.Id, questOrder));
await db.update(masterQuest).set({ ClearScore: 1 }).where(inArray(masterQuest.Id, questOrder));
let lastQuestId = '';
for (const questId of questOrder) {
  const list = await questRpc('ListMain');
  const flat = (list.AreaGroups ?? []).flatMap((group: any) => group.Areas ?? []);
  const quest = flat.flatMap((area: any) => area.Quests ?? []).find((row: any) => row.QuestId === questId);
  if (Number(quest?.Cleared) === 1) continue;
  const result = await questStart(questId);
  check(`Quest:Start clears ${questId}`, Number(result.Result?.Cleared) === 1);
  lastQuestId = questId;
}
const afterSequential = await questRpc('ListMain');
const area003 = (afterSequential.AreaGroups ?? [])
  .flatMap((group: any) => group.Areas ?? [])
  .find((area: any) => area.AreaId === 'area-main-003');
check('Quest:ListMain area-main-003 is unlocked after sequential clears', Boolean(area003?.Unlocked));
check(
  'Quest:ListMain every area-main-003 quest is cleared (cd-clear-area-main-003)',
  (area003?.Quests ?? []).length === 3 && (area003?.Quests ?? []).every((row: any) => Number(row.Cleared) === 1),
);

if (lastQuestId !== '') {
  const latestList = await questRpc('ListLatestClear', { QuestId: lastQuestId });
  check('Quest:ListLatestClear returns the last clear', (latestList.Clears ?? []).length === 1);
  const latestLive = await questRpc('GetLatestClearLiveResult', {
    QuestId: lastQuestId,
    UserId: TEST_PUBLIC_USER_ID,
  });
  check(
    'Quest:GetLatestClearLiveResult returns the stored live result',
    Number(latestLive.Result?.UserInfos?.[0]?.UserResult?.Score ?? 0) > 0 &&
      (latestLive.RankPatterns ?? []).length === 3,
  );
}

for (const row of originalQuestClearScores) {
  await db.update(masterQuest).set({ ClearScore: row.ClearScore }).where(eq(masterQuest.Id, row.Id));
}

console.log(`\nquest test: ${pass} passed, ${fail} failed`);
await (await import('./db/client.ts')).client.end({ timeout: 5 });
process.exit(fail ? 1 : 0);
