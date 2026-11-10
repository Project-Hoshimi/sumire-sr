// Live input preparation tests (port of the "live input preparation" section
// added to `src/dbtest.ts` on the narrative stack, commit eb608fa).
//
// Run with `npm run test:live` against a database with master data seeded and
// the capture corpus available ($DATABASE_URL + $SUMIRE_DATA_DIR/captures).

import { eq } from 'drizzle-orm';
import { requireData } from './testing/requireData.ts';
import { decodeMessage, msgRegistry, Reader } from '@sumire-sr/protocol/runtime/proto.ts';
import '@sumire-sr/protocol/gen/registry.ts';
import { db } from './db/client.ts';
import { accounts, players, playerEntities, playerLessonProgress } from './db/schema.ts';
import { getCorpusResponse, loadCorpus } from './services/replay/corpus.ts';
import { listElements, loadOrSeed } from './services/playerState.ts';

const { newLiveInput, prepareLiveInput, loadLiveFormation, liveClearRankPatterns } =
  await import('./services/liveInput.ts');
const { simulate } = await import('./live/index.ts');
const { listQuestsByArea } = await import('./master/index.ts');

await requireData({ captures: true, db: true });

// Dedicated test account. Seeded state is wiped deterministically so repeated
// runs start from the same captured corpus.
const TEST_ACCOUNT_ID = 'livetest-account-0000-4000-8000-000000000001';
const TEST_UID = 'livetest-firebase-uid-0001';
const SERVER_USER_ID = 'livetest-user-0000-4000-8000-000000000001';
const TEST_PUBLIC_USER_ID = 'LIVETEST';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  cond ? pass++ : fail++;
}

const listSetupElements = listElements;

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

loadCorpus();
const templateBytes = getCorpusResponse('User:Get');
check('live: corpus carries a User:Get template', templateBytes !== null);
const templateShape = msgRegistry.get('Solis.Common.Proto.Api.UserGetResponse');
if (!templateBytes || !templateShape) {
  console.log(`\nlive test: ${pass} passed, ${fail} failed`);
  await (await import('./db/client.ts')).client.end({ timeout: 5 });
  process.exit(fail ? 1 : 0);
}
const seedTemplate = decodeMessage(templateShape, new Reader(Uint8Array.from(templateBytes)));
await loadOrSeed(SERVER_USER_ID, seedTemplate);

// --- Live input preparation (Solis `viber.PrepareLiveInput` port) ---
const liveQuests = [...(await listQuestsByArea('area-main-001'))].sort(
  (a, b) => Number(a.Order ?? 0) - Number(b.Order ?? 0),
);
const liveQuest = liveQuests[0] as any;
check('live: area-main-001 exposes a quest', liveQuest !== undefined);

const liveSeed = 0x5eed_1234n;
const { input: bareLiveInput } = await newLiveInput(liveQuest, liveSeed);
check('live: newLiveInput loads the song chart', (bareLiveInput.Chart ?? []).length > 0);

const liveDecks = await listSetupElements(SERVER_USER_ID, 'Decks');
// The captured deck #1 references a photo the seeded account no longer owns, so
// pick the lowest complete saved deck instead of assuming deck 1 is playable.
const liveOwnedPhotos = new Set(
  (await listSetupElements(SERVER_USER_ID, 'Photos')).map((row: any) => String(row.PhotoId)),
);
const liveOwnedCards = new Map(
  (await listSetupElements(SERVER_USER_ID, 'Cards')).map((row: any) => [String(row.CardId), row]),
);
const liveAllPositions = await listSetupElements(SERVER_USER_ID, 'DeckPositions');
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
check('live: the account has a complete saved deck', liveDeckRow !== undefined);
const liveDeckNumber = Number(liveDeckRow?.Number ?? 0);
const liveFormation = await loadLiveFormation(SERVER_USER_ID, liveDeckNumber);
check('live: saved formation has five positions', liveFormation.Positions.length === 5);

const liveInput = await prepareLiveInput(
  SERVER_USER_ID,
  { DeckNumber: liveDeckNumber },
  liveQuest,
  liveSeed,
  liveFormation,
);
const liveCards = liveInput.Users[0]?.UserDeck?.Cards ?? [];
check(
  'live: user deck carries the saved formation cards',
  liveCards.length === 5 &&
    liveCards.every((card, i) => String(card.CardId) === String(liveFormation.Positions[i]?.CardId)),
);
const ownedLiveCards = new Set(
  (await listSetupElements(SERVER_USER_ID, 'Cards')).map((row: any) => String(row.CardId)),
);
check('live: every deck card is owned by the account', liveCards.every((card) => ownedLiveCards.has(String(card.CardId))));

let liveSkillsResolved = true;
let liveEfficaciesResolved = true;
for (const card of liveCards) {
  for (const skill of card.Skills ?? []) {
    const definition = liveInput.Skills.get(String(skill.SkillId));
    if (definition === undefined) {
      liveSkillsResolved = false;
      continue;
    }
    const level = (definition.Levels ?? []).find((row: any) => Number(row.Level) === Number(skill.SkillLevel));
    if (level === undefined) {
      liveSkillsResolved = false;
      continue;
    }
    for (const detail of level.SkillDetails ?? []) {
      if (!liveInput.Efficacies.has(String(detail.EfficacyId))) liveEfficaciesResolved = false;
    }
  }
}
check('live: every deck card skill resolves in the input Skills map', liveSkillsResolved);
check('live: every skill efficacy resolves in the input Efficacies map', liveEfficaciesResolved);
check('live: the prepared unit resolves at least one skill', liveInput.Skills.size > 0);

const npcExpected = Number(liveQuest.ClearScore ?? 0) === 0;
check(
  'live: NPC lanes fill the opposing side where Solis fills them',
  npcExpected
    ? liveInput.Users.length === 2 && [6, 7, 8, 9, 10].every((index) => liveInput.Cards.has(index))
    : liveInput.Users.length === 1,
);

const liveResult = simulate(liveInput);
const liveScore = Number(liveResult.UserInfos?.[0]?.UserResult?.Score ?? 0);
check('live: prepared input produces a positive score', liveScore > 0);

const liveInputAgain = await prepareLiveInput(
  SERVER_USER_ID,
  { DeckNumber: liveDeckNumber },
  liveQuest,
  liveSeed,
  liveFormation,
);
const liveResultAgain = simulate(liveInputAgain);
check(
  'live: same seed reproduces the same simulation result',
  JSON.stringify(liveResult) === JSON.stringify(liveResultAgain),
);

const liveRanks = liveClearRankPatterns(1000);
check(
  'live: clear rank patterns mirror live.go:226 (B 1200 / C 1000 / D 0)',
  liveRanks.length === 3 &&
    Number(liveRanks[0]?.ThresholdScore) === 1200 &&
    Number(liveRanks[1]?.ThresholdScore) === 1000 &&
    Number(liveRanks[2]?.ThresholdScore ?? 0) === 0,
);

console.log(`\nlive test: ${pass} passed, ${fail} failed`);
await (await import('./db/client.ts')).client.end({ timeout: 5 });
process.exit(fail ? 1 : 0);
