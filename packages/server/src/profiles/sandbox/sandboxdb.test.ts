/**
 * Sandbox DB integration test.
 *
 * Requires a reachable PostgreSQL with master data (the same DATABASE_URL the
 * server uses); it skips cleanly otherwise. It creates throwaway `sbxtest*`
 * accounts only and removes every row it created.
 */
import { spawnSync } from 'node:child_process';
import { and, desc, eq, sql } from 'drizzle-orm';
import { requireData } from '../../testing/requireData.ts';
import { db } from '../../db/client.ts';
import {
  accounts,
  players,
  playerEntities,
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
  playerExcursionState,
} from '../../db/schema.ts';
import { decodeMessage, encodeMessage, msgRegistry, Reader, Writer } from '@sumire-sr/protocol/runtime/proto.ts';
import { endpoints } from '@sumire-sr/protocol/gen/endpoints.ts';
import { isNotImplementedError } from '../../services/errors.ts';
import '@sumire-sr/protocol/gen/registry.ts';

process.env.SUMIRE_PROFILE = 'sandbox';
await requireData({ captures: true, db: true });

await import('../../services/all.ts');

const { findOrCreateIdentityByUid } = await import('../../services/auth.ts');
const { dispatchRpc } = await import('../../services/router.ts');
const { mintToken } = await import('../../auth/jwt.ts');
const { getSingleton, listElements, putElements } = await import('../../services/playerState.ts');
const { getCurrency } = await import('../../services/currency.ts');
const { seedSandboxAccount, isSandboxCharacter, collectRewardIds, COLLECTION_RESOURCE_TYPES, SANDBOX_CURRENCY, SANDBOX_AREA_CLEAR_COUNT } = await import('./seed.ts');
const { SANDBOX_SHOWCASE_CASE_COUNT, SANDBOX_SHOWCASE_TOY_AMOUNT } = await import('./showcase.ts');
const { CLIENT_UNRESOLVABLE, isClientResolvable } = await import('./clientDenylist.ts');
const { cardReleaseFromRows, maxEnhancementLevel } = await import('../../services/cardRelease.ts');
const { applyCardStatsFromParam } = await import('../../services/card.ts');
const { master } = await import('../../master/index.ts');
const { loveRoutes } = await import('../../services/moshikoi/catalog.ts');
const loveStandardEndingCount = loveRoutes('love-23-0514').endings.length;

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond || detail === undefined ? '' : ` (${String(detail)})`}`);
  cond ? pass++ : fail++;
}

const created: { uid: string; accountId: string; serverUserId: string }[] = [];

async function removePlayer(accountId: string, serverUserId: string) {
  await db.delete(playerEntities).where(eq(playerEntities.playerId, serverUserId));
  await db.delete(rewardClaims).where(eq(rewardClaims.playerId, serverUserId));
  await db.delete(playerLedger).where(eq(playerLedger.playerId, serverUserId));
  await db.delete(playerPurchases).where(eq(playerPurchases.playerId, serverUserId));
  await db.delete(playerLoveProgress).where(eq(playerLoveProgress.playerId, serverUserId));
  await db.delete(playerLessonProgress).where(eq(playerLessonProgress.playerId, serverUserId));
  await db.delete(playerGachaState).where(eq(playerGachaState.playerId, serverUserId));
  await db.delete(gachaHistory).where(eq(gachaHistory.playerId, serverUserId));
  await db.delete(idolRoster).where(eq(idolRoster.playerId, serverUserId));
  await db.delete(ownedCards).where(eq(ownedCards.playerId, serverUserId));
  await db.delete(deckConfigurations).where(eq(deckConfigurations.playerId, serverUserId));
  await db.delete(liveStageProgress).where(eq(liveStageProgress.playerId, serverUserId));
  await db.delete(playerBoxGacha).where(eq(playerBoxGacha.playerId, serverUserId));
  await db.delete(playerMarathonPoint).where(eq(playerMarathonPoint.playerId, serverUserId));
  await db.delete(playerExcursionState).where(eq(playerExcursionState.playerId, serverUserId));
  await db.delete(players).where(eq(players.id, serverUserId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
}

async function removeByUid(uid: string) {
  const [account] = await db.select().from(accounts).where(eq(accounts.firebaseUid, uid)).limit(1);
  if (!account) return;
  const [player] = await db.select().from(players).where(eq(players.accountId, account.id)).limit(1);
  if (player) await removePlayer(account.id, player.id);
  else await db.delete(accounts).where(eq(accounts.id, account.id));
}

async function rpc(name: string, token: string, request: Record<string, unknown>) {
  const [service, method] = name.split(':');
  const ep = endpoints[service]?.[method];
  if (!ep) throw new Error(`no endpoint for ${name}`);
  const requestShape = ep.request === 'Empty' ? null : msgRegistry.get(ep.request);
  const responseShape = msgRegistry.get(ep.response);
  if ((ep.request !== 'Empty' && !requestShape) || !responseShape) throw new Error(`no shape for ${name}`);
  const writer = new Writer();
  if (requestShape) encodeMessage(requestShape, request as never, writer);
  const bytes = await dispatchRpc(
    name,
    Buffer.from(writer.toBytes()),
    { headers: { 'x-auth-token': token }, log: { info() {}, warn() {} } } as never,
  );
  return decodeMessage(responseShape, new Reader(Uint8Array.from(bytes))) as Record<string, unknown>;
}

const count = async (playerId: string, field: string) => (await listElements(playerId, field, db)).length;

const uid = 'sbxtest-seed-' + Date.now();
const createdAt = Date.now();
const identity = await findOrCreateIdentityByUid(uid);
const creationMs = Date.now() - createdAt;
created.push({ uid, ...identity });
const playerId = identity.serverUserId;

console.log(`sandbox creation: ${creationMs} ms`);
check('sandbox creation stays under 2 s', creationMs < 2000, `${creationMs} ms`);
const token = mintToken({ sub: identity.accountId, seedId: identity.publicUserId });

// ---------------------------------------------------------------------------
// Collections: every kind must contain every master row.
// ---------------------------------------------------------------------------
const masterCounts = {
  Costumes: (await db.select().from(master.masterCostume)).filter((r) =>
    isClientResolvable('Costumes', String(r.Id)),
  ).length,
  Hairs: (await db.select().from(master.masterHair)).filter((r) =>
    isClientResolvable('Hairs', String(r.Id)),
  ).length,
  Characters: (await db.select().from(master.masterCharacter)).filter(isSandboxCharacter).length,
  PhotoRecipes: (await db.select().from(master.masterPhotoRecipe)).length,
  PhotoPoses: (await db.select().from(master.masterPhotoPose)).length,
  ShowcaseToys: (await db.select().from(master.masterShowcaseToy)).length,
  ShowcaseMusics: (await db.select().from(master.masterShowcaseMusic)).length,
  Musics: (await db.select().from(master.masterMusic)).length,
  Cards: (await db.select().from(master.masterCard)).length,
  HomeTalks: (await db.select().from(master.masterHomeTalk)).length,
} as const;

// Decorations have no master table of their own; the seed grants every id the
// Reward master references. Emblems are master-backed: the seed grants the
// union of every `master_Emblem` id and the reward-referenced ids.
const rewarded = collectRewardIds(await db.select({ Resources: master.masterReward.Resources }).from(master.masterReward));
const rewardedCount = (field: string, type: number) =>
  [...(rewarded.get(type) ?? [])].filter((id) => isClientResolvable(field, id)).length;
const masterEmblemIds = [
  ...new Set([
    ...(await db.select({ Id: master.masterEmblem.Id }).from(master.masterEmblem)).map((row) =>
      String(row.Id),
    ),
    ...(rewarded.get(COLLECTION_RESOURCE_TYPES.emblem) ?? []),
  ]),
].filter((id) => isClientResolvable('Emblems', id));
const expectedCounts: Record<string, number> = {
  ...masterCounts,
  // The sandbox inventory carries no accessories: the screens are blocked.
  Accessories: 0,
  Emblems: masterEmblemIds.length,
  Decorations: rewardedCount('Decorations', COLLECTION_RESOURCE_TYPES.decoration),
  Messages: (await db.select().from(master.masterMessage)).length,
  Telephones: (await db.select().from(master.masterTelephone)).length,
};

// Excursion master rows and the seeded non-default gaze reactions.
const excursionPlaceSettingRows = await db.select().from(master.masterExcursionPlaceSetting);
const excursionGazeReactionRows = await db.select().from(master.masterExcursionGazeReaction);
const expectedExcursionGazeReactions = excursionGazeReactionRows.filter(
  (row) => Number(row.Number) > 0,
).length;
expectedCounts.ExcursionGazeReactions = expectedExcursionGazeReactions;
check(
  'master ExcursionPlaceSetting has 80 rows',
  excursionPlaceSettingRows.length === 80,
  excursionPlaceSettingRows.length,
);
check(
  'master ExcursionGazeReaction has 420 rows',
  excursionGazeReactionRows.length === 420,
  excursionGazeReactionRows.length,
);
check(
  'master excursion gaze reactions have 340 non-default keys',
  expectedExcursionGazeReactions === 340,
  expectedExcursionGazeReactions,
);
for (const [field, expected] of Object.entries(expectedCounts)) {
  const actual = await count(playerId, field);
  check(`${field} count equals master (${expected})`, actual === expected, actual);
}

// Home talks: every master talk is already seen, so the home screen can offer
// all of them and `Home:ReadTalk` has nothing left to unlock.
const masterHomeTalkIds = (
  await db.select({ HomeTalkId: master.masterHomeTalk.HomeTalkId }).from(master.masterHomeTalk)
).map((row) => String(row.HomeTalkId));
const seededHomeTalkIds = new Set(
  (await listElements(playerId, 'HomeTalks', db)).map((row) => String(row.HomeTalkId ?? '')),
);
const missingHomeTalks = masterHomeTalkIds.filter((id) => !seededHomeTalkIds.has(id));
check(
  'every master home talk is unlocked',
  masterHomeTalkIds.length > 0 && missingHomeTalks.length === 0,
  `${masterHomeTalkIds.length} master, missing ${missingHomeTalks.slice(0, 5).join(',')}`,
);

// Excursion gaze reactions: every non-default master reaction is seeded under
// the client key (CharacterId, ExcursionPlaceId, GazeReactionNumber).
const seededGazeReactions = await listElements(playerId, 'ExcursionGazeReactions', db);
const seededGazeReactionKeys = new Set(
  seededGazeReactions.map(
    (row) =>
      `${String(row.CharacterId ?? '')}\u0001${String(row.ExcursionPlaceId ?? '')}\u0001${Number(row.GazeReactionNumber ?? 0)}`,
  ),
);
check(
  'seeded excursion gaze reactions are 340 distinct keys',
  seededGazeReactionKeys.size === 340,
  seededGazeReactionKeys.size,
);

// Messages: every master row is finished, with first-path choices when the
// message has a choice. Telephones: every master call is finished.
const masterMessageRows = await db.select().from(master.masterMessage);
const masterMessageById = new Map(masterMessageRows.map((row) => [String(row.Id), row]));
const masterTelephoneRows = await db.select().from(master.masterTelephone);
const seededMessages = await listElements(playerId, 'Messages', db);
check(
  'every message is finished',
  seededMessages.every((m) => Number(m.MessageStatusType) === 4),
  seededMessages.filter((m) => Number(m.MessageStatusType) !== 4).length,
);
check(
  'every branching message has a non-empty first-path selection',
  seededMessages.every((m) => {
    const masterRow = masterMessageById.get(String(m.MessageId));
    const details = Array.isArray(masterRow?.Details) ? (masterRow.Details as Record<string, unknown>[]) : [];
    const hasChoice = details.some((detail) => String(detail.ChoiceText ?? '') !== '');
    return !hasChoice || (Array.isArray(m.SelectMessageDetailIds) && m.SelectMessageDetailIds.length > 0);
  }),
  seededMessages.filter((m) => {
    const masterRow = masterMessageById.get(String(m.MessageId));
    const details = Array.isArray(masterRow?.Details) ? (masterRow.Details as Record<string, unknown>[]) : [];
    const hasChoice = details.some((detail) => String(detail.ChoiceText ?? '') !== '');
    return hasChoice && (!Array.isArray(m.SelectMessageDetailIds) || m.SelectMessageDetailIds.length === 0);
  }).length,
);
const seededTelephones = await listElements(playerId, 'Telephones', db);
check(
  'every telephone is finished',
  seededTelephones.every((t) => Number(t.TelephoneStatusType) === 4),
  seededTelephones.filter((t) => Number(t.TelephoneStatusType) !== 4).length,
);
check(
  'no message schedules remain',
  (await listElements(playerId, 'MessageSchedules', db)).length === 0,
);

// Seeded narrative dates are deterministic and never in the future.
const hbdMessage = seededMessages.find((m) => String(m.MessageId) === 'message-hbd-ai-22-0209');
check(
  'message-hbd-ai-22-0209 gets its 2022-02-09 release time',
  Number(hbdMessage?.ArrivedTime) === Date.UTC(2022, 1, 9, 3, 0, 0),
  hbdMessage?.ArrivedTime,
);
const nowForSeedCheck = Date.now();
const futureMessages = seededMessages
  .filter((m) => Number(m.ArrivedTime) > nowForSeedCheck)
  .map((m) => String(m.MessageId));
check(
  'no seeded message arrives in the future',
  futureMessages.length === 0,
  futureMessages.slice(0, 5).join(','),
);
const futureTelephones = seededTelephones
  .filter(
    (t) =>
      Number(t.UnlockedTime) > nowForSeedCheck || Number(t.ScheduledTime) > nowForSeedCheck,
  )
  .map((t) => String(t.TelephoneId));
check(
  'no seeded telephone unlocks in the future',
  futureTelephones.length === 0,
  futureTelephones.slice(0, 5).join(','),
);

// RPCs against the seeded account: every group has a finished latest timeline
// and the timeline page is newest-first.
const listGroup = await rpc('Message:ListGroup', token, {});
const groupInfos = (listGroup.Infos ?? []) as Record<string, unknown>[];
const expectedGroupIds = new Set(
  masterMessageRows.map((row) => String(row.MessageGroupId ?? '')).filter(Boolean),
);
check(
  'Message:ListGroup lists every message group',
  groupInfos.length === expectedGroupIds.size,
  `${groupInfos.length}/${expectedGroupIds.size}`,
);
check(
  'Message:ListGroup latest timelines are finished',
  groupInfos.every((info) => Boolean((info.LatestTimelineInfo as Record<string, unknown> | undefined)?.Finished)),
);
const groupMessageCounts = new Map<string, number>();
for (const row of masterMessageRows) {
  const groupId = String(row.MessageGroupId ?? '');
  if (groupId) groupMessageCounts.set(groupId, (groupMessageCounts.get(groupId) ?? 0) + 1);
}
const timelineGroupId =
  [...groupMessageCounts.entries()].find(([, count]) => count > 1)?.[0] ??
  [...groupMessageCounts.keys()][0] ??
  '';
const timelineResponse = await rpc('Message:Timeline', token, {
  MessageGroupId: timelineGroupId,
  TimelineId: 0,
});
const timelineInfos = (timelineResponse.Infos ?? []) as Record<string, unknown>[];
check(
  'Message:Timeline returns only the requested group',
  timelineInfos.length > 0 &&
    timelineInfos.every((info) => String(info.MessageGroupId ?? '') === timelineGroupId),
  timelineInfos.length,
);
check(
  'Message:Timeline marks every timeline finished',
  timelineInfos.every((info) => Boolean(info.Finished)),
);
const timelineIds = timelineInfos.map((info) => BigInt(info.TimelineId as bigint));
check(
  'Message:Timeline is newest-first',
  timelineIds.every((id, index) => index === 0 || timelineIds[index - 1]! > id),
);
const latestInfo = (groupInfos.find((info) => String(info.MessageGroupId) === timelineGroupId)
  ?.LatestTimelineInfo ?? {}) as Record<string, unknown>;
const saveHistory = await rpc('Message:SaveHistory', token, {
  MessageId: latestInfo.MessageId,
  SelectMessageDetailIds: latestInfo.SelectMessageDetailIds ?? [],
});
check(
  'Message:SaveHistory echoes the finished message',
  (((saveHistory.CommonResponse as Record<string, unknown> | undefined)?.UpdatedData as Record<string, unknown> | undefined)?.Messages as unknown[] | undefined)?.length === 1,
);
const partialHistory = await rpc('Message:SaveHistory', token, {
  MessageId: latestInfo.MessageId,
  SelectMessageDetailIds: [],
});
check(
  'Message:SaveHistory accepts a replay left before its next choice',
  (((partialHistory.CommonResponse as Record<string, unknown> | undefined)?.UpdatedData as Record<string, unknown> | undefined)?.Messages as unknown[] | undefined)?.length === 1,
);
const receiveFinished = await rpc('Message:Receive', token, {
  MessageIds: [latestInfo.MessageId],
});
check(
  'Message:Receive ignores an already finished message',
  (((receiveFinished.CommonResponse as Record<string, unknown> | undefined)?.UpdatedData as Record<string, unknown> | undefined)?.Messages as unknown[] | undefined)?.length !== 1,
);
const firstTelephoneId = String(masterTelephoneRows[0]?.Id ?? '');
const callHistory = await rpc('Telephone:CallHistory', token, {
  TelephoneId: firstTelephoneId,
});
check(
  'Telephone:CallHistory answers for a finished call',
  Boolean(callHistory.CommonResponse),
);
const finishesAgain = await rpc('Telephone:Finishes', token, {
  TelephoneIds: [firstTelephoneId],
});
check(
  'Telephone:Finishes ignores an already finished call',
  (((finishesAgain.CommonResponse as Record<string, unknown> | undefined)?.UpdatedData as Record<string, unknown> | undefined)?.Telephones as unknown[] | undefined)?.length !== 1,
);
const narrativeGet = await rpc('User:Get', token, {});
check(
  'User:Get serves every seeded message',
  ((narrativeGet.Messages as unknown[] | undefined) ?? []).length === masterMessageRows.length,
  ((narrativeGet.Messages as unknown[] | undefined) ?? []).length,
);
check(
  'User:Get serves every seeded telephone',
  ((narrativeGet.Telephones as unknown[] | undefined) ?? []).length === masterTelephoneRows.length,
  ((narrativeGet.Telephones as unknown[] | undefined) ?? []).length,
);

// Only idols plus Satomi, Kohei and the Dorikyun duo: NPC rows show up as blank
// or duplicate trust and lobby entries.
const ownedCharacterIds = new Set(
  (await listElements(playerId, 'Characters', db)).map((c) => String(c.CharacterId)),
);
check('Satomi (char-stm) is owned', ownedCharacterIds.has('char-stm'));
check("Satomi's first idol row (char-stm1) is owned", ownedCharacterIds.has('char-stm1'));
check('Kohei (char-koh) is owned', ownedCharacterIds.has('char-koh'));
check('Lemon (char-lmn) is owned', ownedCharacterIds.has('char-lmn'));
check('Lime (char-lim) is owned', ownedCharacterIds.has('char-lim'));

const ownedCostumeIds = new Set(
  (await listElements(playerId, 'Costumes', db)).map((c) => String(c.CostumeId)),
);
check("Lemon's idol costume (cos-lmn-idol-00) is owned", ownedCostumeIds.has('cos-lmn-idol-00'));

const ownedHairIds = new Set(
  (await listElements(playerId, 'Hairs', db)).map((h) => String(h.HairId)),
);
check("Lime's casual hair (hair-lim-casl-00) is owned", ownedHairIds.has('hair-lim-casl-00'));
check(
  'no NPC characters are owned',
  !['char-stm2', 'char-mng', 'char-gyo', 'char-vns', 'char-haruhi'].some((id) => ownedCharacterIds.has(id)),
  [...ownedCharacterIds].filter((id) => /stm\d|mng|gyo|vns|haruhi/.test(id)).join(','),
);

// Every master costume/hair/photo id must be present, not just the count —
// minus the master rows the real client cannot resolve.
const idSets: { field: string; key: string; ids: string[] }[] = [
  { field: 'Costumes', key: 'CostumeId', ids: (await db.select().from(master.masterCostume)).map((r) => String(r.Id)) },
  { field: 'Hairs', key: 'HairId', ids: (await db.select().from(master.masterHair)).map((r) => String(r.Id)) },
  { field: 'PhotoRecipes', key: 'PhotoRecipeId', ids: (await db.select().from(master.masterPhotoRecipe)).map((r) => String(r.Id)) },
  { field: 'PhotoPoses', key: 'PhotoPoseId', ids: (await db.select().from(master.masterPhotoPose)).map((r) => String(r.Id)) },
  { field: 'ShowcaseToys', key: 'ShowcaseToyId', ids: (await db.select().from(master.masterShowcaseToy)).map((r) => String(r.Id)) },
  { field: 'ShowcaseMusics', key: 'ShowcaseMusicId', ids: (await db.select().from(master.masterShowcaseMusic)).map((r) => String(r.MusicId)) },
  { field: 'Musics', key: 'MusicId', ids: (await db.select().from(master.masterMusic)).map((r) => String(r.Id)) },
];
for (const spec of idSets) {
  const existing = new Set((await listElements(playerId, spec.field, db)).map((e) => String(e[spec.key] ?? '')));
  const missing = spec.ids.filter((id) => id && isClientResolvable(spec.field, id) && !existing.has(id));
  check(`${spec.field} contains all resolvable master ids`, missing.length === 0, missing.slice(0, 3).join(','));
}

// Every showcase toy is owned at the sandbox stack size, not just once.
const seededToys = await listElements(playerId, 'ShowcaseToys', db);
const underMaxToys = seededToys.filter(
  (toy) => Number(toy.Amount ?? 0) !== SANDBOX_SHOWCASE_TOY_AMOUNT,
);
check(
  'every seeded showcase toy is owned x99',
  seededToys.length > 0 && underMaxToys.length === 0,
  underMaxToys.slice(0, 3).map((toy) => toy.ShowcaseToyId).join(','),
);

// The showcase home always lists the five cases, even before a first save.
const showcaseTop = await rpc('Showcase:Top', token, {});
const showcaseInfos = (showcaseTop.ShowcaseInfos ?? []) as Record<string, unknown>[];
check(
  'Showcase:Top lists at least five cases',
  showcaseInfos.length >= SANDBOX_SHOWCASE_CASE_COUNT,
  showcaseInfos.length,
);
const showcaseShops = (showcaseTop.Shops ?? []) as Record<string, unknown>[];
// The goods-shop screen indexes Shops[0] and finds its default shop by Type.
check(
  'Showcase:Top lists the default goods shop',
  showcaseShops.some((s) => Number(s.Type) === 1003),
  showcaseShops.map((s) => s.Type),
);

// Rows the client cannot resolve must never be seeded: it throws
// `NullReferenceException` in `<Type>Master.FindByKey` while initialising user
// data and falls back to the title screen (`clientDenylist.ts`).
for (const [field, ids] of Object.entries(CLIENT_UNRESOLVABLE)) {
  const key = field === 'Costumes' ? 'CostumeId' : 'HairId';
  const owned = new Set((await listElements(playerId, field, db)).map((e) => String(e[key] ?? '')));
  const seeded = ids.filter((id) => owned.has(id));
  check(`${field} excludes ${ids.length} client-unresolvable ids`, seeded.length === 0, seeded.slice(0, 3).join(','));
}

// ---------------------------------------------------------------------------
// Cards: level / rarity / rank / evolution / enhancements at the master max.
// ---------------------------------------------------------------------------
const masterCards = await db.select().from(master.masterCard);
const rarityRows = await db.select().from(master.masterCardRarity);
const rankRows = await db.select().from(master.masterCardRank);
const evoRows = await db.select().from(master.masterCardEvolutionLevel);
const levelReleaseRows = await db.select().from(master.masterCardLevelRelease);
const evoReleaseRows = await db.select().from(master.masterCardEvolutionLevelRelease);
const skillRows = await db.select().from(master.masterSkill);
const liveAbilityRows = await db.select().from(master.masterLiveAbility);
const activityAbilityRows = await db.select().from(master.masterActivityAbility);
const parameterRows = await db.select().from(master.masterCardParameter);
const levelRow = (await db.select().from(master.masterCardLevel).where(eq(master.masterCardLevel.Level, 230)).limit(1))[0];

const maxRarity = Math.max(...rarityRows.map((r) => Number(r.Rarity ?? 0)));
const maxRank = Math.max(...rankRows.map((r) => Number(r.Rank ?? 0)));
const rarityAtMax = rarityRows.find((r) => Number(r.Rarity) === maxRarity) ?? null;
const rankAtMax = rankRows.find((r) => Number(r.Rank) === maxRank) ?? null;
const maxLevel = Math.min(230, Number(rarityAtMax?.LevelLimit ?? 200) + Number(rankAtMax?.LevelLimitUpAmount ?? 0));
check('master max-rarity/rank/level resolve to ★10/R15/Lv230', maxRarity === 10 && maxRank === 15 && maxLevel === 230, `${maxRarity}/${maxRank}/${maxLevel}`);

const groupBy = <T,>(rows: readonly T[], key: keyof T) => {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const id = String(row[key] ?? '');
    if (!id) continue;
    const list = map.get(id) ?? [];
    list.push(row);
    map.set(id, list);
  }
  return map;
};
const levelReleases = groupBy(levelReleaseRows, 'Id');
const evoReleases = groupBy(evoReleaseRows, 'GroupId');
const skills = new Map(skillRows.map((r) => [String(r.Id), r as unknown as Record<string, unknown>]));
const liveAbilities = new Map(liveAbilityRows.map((r) => [String(r.Id), r as unknown as Record<string, unknown>]));
const activityAbilities = new Map(activityAbilityRows.map((r) => [String(r.Id), r as unknown as Record<string, unknown>]));
const parameters = new Map<string, Record<string, unknown>>();
for (const row of parameterRows) {
  if (Number(row.Level ?? 0) > maxLevel) continue;
  const id = String(row.Id ?? '');
  if (!id) continue;
  const current = parameters.get(id);
  if (!current || Number(row.Level ?? 0) > Number(current.Level ?? 0)) {
    parameters.set(id, row as unknown as Record<string, unknown>);
  }
}
const evoMax = new Map<string, { level: number; exp: number }>();
for (const row of evoRows) {
  const group = String(row.GroupId ?? '');
  const exp = row.Exp == null ? null : Number(row.Exp);
  if (!group || exp === null) continue;
  const level = Number(row.Level ?? 0);
  const current = evoMax.get(group);
  if (!current || level > current.level) evoMax.set(group, { level, exp });
}

const userCards = new Map((await listElements(playerId, 'Cards', db)).map((c) => [String(c.CardId), c]));
let badCardBasics = 0;
let badSkills = 0;
let badAbilities = 0;
let badStats = 0;
const skillHistogram = new Map<string, number>();

for (const mcRow of masterCards) {
  const cardId = String(mcRow.Id);
  const mc = mcRow as unknown as Record<string, unknown>;
  const card = userCards.get(cardId);
  if (!card) {
    badCardBasics++;
    continue;
  }
  const evo = evoMax.get(String(mc.CardEvolutionLevelGroupId ?? '')) ?? { level: 0, exp: 0 };
  if (
    Number(card.Level) !== maxLevel ||
    Number(card.BaseLevel) !== maxLevel ||
    Number(card.Rarity) !== maxRarity ||
    Number(card.Rank) !== maxRank ||
    // Proto omits zero-valued scalars, so a card with no evolution group stores
    // `EvolutionLevel` absent; treat both absent and 0 as the expected level 0.
    Number(card.EvolutionLevel ?? 0) !== evo.level ||
    Number(card.TotalExp) !== Number(levelRow?.RequiredExp ?? 0) ||
    Number(card.RarityTotalExp) !== Number(rarityAtMax?.RequiredExp ?? 0)
  ) {
    badCardBasics++;
  }

  const release = cardReleaseFromRows(
    mc as never,
    maxLevel,
    evo.level,
    levelReleases.get(String(mc.CardLevelReleaseId ?? '')) ?? [],
    // Evolution *release* rows are keyed by `CardEvolutionLevelReleaseGroupId`
    // (the bond release group), not by `CardEvolutionLevelGroupId` (the exp
    // group). The seeder uses the release group too; matching it here is what
    // makes slot 4 count as unlocked at EvolutionLevel 1.
    evoReleases.get(String(mc.CardEvolutionLevelReleaseGroupId ?? '')) ?? [],
  );
  const unlocked = new Set(release.skillSlots);
  for (let slot = 1; slot <= 4; slot++) {
    const skillId = String(mc[`SkillId${slot}`] ?? '');
    if (unlocked.has(slot) && skillId) {
      const expected = maxEnhancementLevel((skills.get(skillId)?.Levels as Record<string, unknown>[]) ?? [], maxLevel);
      if (String(card[`SkillId${slot}`] ?? '') !== skillId) badSkills++;
      if (Number(card[`SkillLevel${slot}`] ?? 0) !== expected) badSkills++;
      if (Number(card[`BaseSkillLevel${slot}`] ?? 0) !== expected) badSkills++;
      skillHistogram.set(`S${slot}=${expected}`, (skillHistogram.get(`S${slot}=${expected}`) ?? 0) + 1);
    } else if (card[`SkillId${slot}`] != null) {
      badSkills++;
    }
  }

  const liveId = String(mc.LiveAbilityId ?? '');
  if (release.liveAbility && liveId) {
    const expected = maxEnhancementLevel((liveAbilities.get(liveId)?.Levels as Record<string, unknown>[]) ?? [], maxLevel);
    if (String(card.LiveAbilityId ?? '') !== liveId) badAbilities++;
    if (Number(card.LiveAbilityLevel ?? 0) !== expected) badAbilities++;
    if (Number(card.BaseLiveAbilityLevel ?? 0) !== expected) badAbilities++;
    skillHistogram.set(`L=${expected}`, (skillHistogram.get(`L=${expected}`) ?? 0) + 1);
  } else if (card.LiveAbilityId != null) {
    badAbilities++;
  }

  const actId = String(mc.ActivityAbilityId ?? '');
  if (release.activityAbility && actId) {
    const expected = maxEnhancementLevel((activityAbilities.get(actId)?.Levels as Record<string, unknown>[]) ?? [], maxLevel);
    if (String(card.ActivityAbilityId ?? '') !== actId) badAbilities++;
    if (Number(card.ActivityAbilityLevel ?? 0) !== expected) badAbilities++;
    if (Number(card.BaseActivityAbilityLevel ?? 0) !== expected) badAbilities++;
    skillHistogram.set(`A=${expected}`, (skillHistogram.get(`A=${expected}`) ?? 0) + 1);
  } else if (card.ActivityAbilityId != null) {
    badAbilities++;
  }

  const expectedStats = { ...card };
  applyCardStatsFromParam(expectedStats, mc as never, (parameters.get(String(mc.CardParameterId ?? '')) as never) ?? null);
  for (const stat of ['Vocal', 'Dance', 'Visual', 'Stamina']) {
    if (Number(card[stat]) !== Number(expectedStats[stat]) || Number(card[`Base${stat}`]) !== Number(expectedStats[stat])) {
      badStats++;
    }
  }
}
check('every card is at max level/rarity/rank/evolution', badCardBasics === 0, badCardBasics);
check('every card skill slot is at its master max', badSkills === 0, badSkills);
check('every card ability is at its master max', badAbilities === 0, badAbilities);
check('every card stat matches the master parameter table', badStats === 0, badStats);
console.log('skill/ability levels:', [...skillHistogram.entries()].sort().map(([k, n]) => `${k}×${n}`).join(' '));

const storyStatusById = new Map(
  (await listElements(playerId, 'Stories', db)).map((s) => [
    String(s.StoryId ?? ''),
    Number(s.StatusType ?? 0),
  ]),
);
const desiredStoryIds = new Set<string>();
for (const mcRow of masterCards) {
  const mc = mcRow as unknown as Record<string, unknown>;
  const releases = levelReleases.get(String(mc.CardLevelReleaseId ?? '')) ?? [];
  for (const row of releases) {
    if (Number(row.Level) > maxLevel) continue;
    for (const t of (row.Targets as { Type?: unknown; Number?: unknown }[] | null) ?? []) {
      if (Number(t.Type) !== 4) continue;
      const story = ((mc.Stories as { StoryId?: unknown }[] | null) ?? [])[Number(t.Number) - 1];
      if (story?.StoryId) desiredStoryIds.add(String(story.StoryId));
    }
  }
}
const missingStories = [...desiredStoryIds].filter((id) => !storyStatusById.has(id)).length;
check('every card story unlock is present', missingStories === 0, missingStories);
check(
  'every card story is read',
  [...desiredStoryIds].every((id) => storyStatusById.get(id) === 2),
  [...desiredStoryIds].filter((id) => storyStatusById.get(id) !== 2).slice(0, 3).join(','),
);
console.log(`Stories seeded as read: ${storyStatusById.size}`);
expectedCounts.Stories = storyStatusById.size;

// The unified seed marks every master story read, not just card stories.
const storyPartRows = await db.select().from(master.masterStoryPart);
const mainStoryId =
  storyPartRows
    .flatMap(
      (part) =>
        ((part.Chapters as Array<{ Episodes?: Array<{ StoryId?: unknown }> }> | null) ?? []).flatMap(
          (chapter) => chapter.Episodes ?? [],
        ),
    )
    .map((episode) => String(episode.StoryId ?? ''))
    .find(Boolean) ?? '';
check(`main story ${mainStoryId} is read`, !!mainStoryId && storyStatusById.get(mainStoryId) === 2, storyStatusById.get(mainStoryId));

const extraStoryRows = await db.select().from(master.masterExtraStory);
const extraStoryId =
  extraStoryRows
    .flatMap((story) => (story.Episodes as Array<{ StoryId?: unknown }> | null) ?? [])
    .map((episode) => String(episode.StoryId ?? ''))
    .find(Boolean) ?? '';
check(`extra story ${extraStoryId} is read`, !!extraStoryId && storyStatusById.get(extraStoryId) === 2, storyStatusById.get(extraStoryId));

// The sandbox ListExtra builder must expose every extra story part unlocked.
const { sandboxExtraStoryPartInfos } = await import('./story.ts');
const extraPartRows = await db.select().from(master.masterExtraStoryPart);
const extraPartInfos = sandboxExtraStoryPartInfos(extraPartRows, extraStoryRows);
check('sandbox ListExtra returns extra story parts', extraPartInfos.length > 0, extraPartInfos.length);
check(
  'sandbox ListExtra marks every part unlocked',
  extraPartInfos.every((info) => info.Unlocked === true),
);

// ---------------------------------------------------------------------------
// Currency + accessories: the sandbox inventory keeps no accessories and no
// deck position may reference a removed one.
// ---------------------------------------------------------------------------
for (const currency of ['gold', 'freeJewel', 'paidJewel', 'stamina'] as const) {
  const amount = await getCurrency(playerId, currency, db);
  check(`${currency} is ${SANDBOX_CURRENCY}`, amount === SANDBOX_CURRENCY, amount);
}
const [playerRow] = await db.select().from(players).where(eq(players.id, playerId)).limit(1);
check(`staminaMax is ${SANDBOX_CURRENCY}`, Number(playerRow?.staminaMax) === SANDBOX_CURRENCY, playerRow?.staminaMax);
const DECK_ACCESSORY_FIELDS = ['AccessoryId', 'Part1AccessoryId', 'Part2AccessoryId'] as const;
const hasAccessoryRef = (position: Record<string, unknown>) =>
  DECK_ACCESSORY_FIELDS.some((field) => String(position[field] ?? '') !== '');
const allDeckPositions = [
  ...(await listElements(playerId, 'DeckPositions', db)),
  ...(await listElements(playerId, 'LeagueDeckPositions', db)),
];
const accessories = await listElements(playerId, 'Accessories', db);
check('sandbox inventory has no accessories', accessories.length === 0, accessories.length);
check(
  'no deck position references an accessory',
  allDeckPositions.every((position) => !hasAccessoryRef(position)),
  allDeckPositions.filter(hasAccessoryRef).length,
);
// The client throws on the activity idol-select screens below level 1.
const [topActivityLevel] = await db
  .select()
  .from(master.masterCharacterActivityLevel)
  .orderBy(desc(master.masterCharacterActivityLevel.Level))
  .limit(1);
const idols = await listElements(playerId, 'Characters', db);
const lowActivity = idols.filter(
  (c) =>
    Number(c.ActivityLevel ?? 0) !== Number(topActivityLevel?.Level) ||
    Number(c.ActivityStamina ?? 0) !== Number(topActivityLevel?.MaxStamina),
);
check(
  `every idol is at activity Lv${topActivityLevel?.Level} with full stamina`,
  idols.length > 0 && lowActivity.length === 0,
  lowActivity.slice(0, 3).map((c) => c.CharacterId).join(','),
);

// ---------------------------------------------------------------------------
// Post-tutorial state: the opening tutorial is finished, every area / function
// lock is cleared and the balance is visible to the client.
// ---------------------------------------------------------------------------
const maxManagerLevel = Number(
  ((await db.execute(
    sql`select coalesce(max("Level"), 1) as level from "master_ManagerLevel"`,
  )) as unknown as { level: number | string }[])[0]?.level ?? 0,
);
const masterAreaCount = Number(
  ((await db.execute(sql`select count(*) as n from "master_Area"`)) as unknown as {
    n: number | string;
  }[])[0]?.n ?? 0,
);

const tutorials = new Map(
  (await listElements(playerId, 'Tutorials', db)).map((t) => [
    Number(t.TutorialType ?? 0),
    Number(t.Step ?? 0),
  ]),
);
check('opening tutorial is completed (Type 1 Step 150)', (tutorials.get(1) ?? 0) >= 150, tutorials.get(1));
check('photo-shooting intro tutorial is completed', (tutorials.get(2) ?? 0) >= 1, tutorials.get(2));

const userSingleton = await getSingleton(playerId, 'User', db);
check(
  'User.TutorialClearedTime is persisted',
  Number(userSingleton?.TutorialClearedTime ?? 0) > 0,
  userSingleton?.TutorialClearedTime,
);
check(
  `manager level is the master max (${maxManagerLevel})`,
  Number(playerRow?.level) === maxManagerLevel && Number(userSingleton?.ManagerLevel) === maxManagerLevel,
  `${playerRow?.level}/${userSingleton?.ManagerLevel}`,
);

const areaRows = await listElements(playerId, 'Areas', db);
check(`every master area is cleared (${masterAreaCount})`, areaRows.length === masterAreaCount, areaRows.length);
check(
  'every cleared area has the sandbox clear count',
  areaRows.every((a) => Number(a.ClearQuestCount ?? 0) >= SANDBOX_AREA_CLEAR_COUNT),
);

const itemRows = await listElements(playerId, 'Items', db);
check('gacha tickets are stocked', itemRows.some((i) => String(i.ItemId ?? '').includes('gacha')));
check(
  'every seeded item stack is at the sandbox ceiling',
  itemRows.every((i) => Number(i.Amount ?? 0) === SANDBOX_CURRENCY),
  itemRows.filter((i) => Number(i.Amount ?? 0) !== SANDBOX_CURRENCY).slice(0, 3).map((i) => i.ItemId).join(','),
);

// The real handler must deliver the balance the client header renders; the
// fresh `User:Get` template carries an empty balance and no points.
const userGet = await rpc('User:Get', token, {});
const balance = (userGet.Balance ?? {}) as Record<string, unknown>;
check(
  `User:Get shows ${SANDBOX_CURRENCY} free jewels`,
  Number(balance.FreeBalance) === SANDBOX_CURRENCY,
  balance.FreeBalance,
);
check('User:Get shows 0 paid jewels', Number(balance.PaidBalance ?? 0) === 0, balance.PaidBalance);
const points = (userGet.Points ?? []) as Record<string, unknown>[];
const pointAmount = (type: number) =>
  Number(points.find((p) => Number(p.PointType) === type)?.Amount ?? -1);
check(`User:Get shows ${SANDBOX_CURRENCY} gold`, pointAmount(1) === SANDBOX_CURRENCY, pointAmount(1));
check(`User:Get shows ${SANDBOX_CURRENCY} stamina`, pointAmount(4) === SANDBOX_CURRENCY, pointAmount(4));
const outUser = (userGet.User ?? {}) as Record<string, unknown>;
check('User:Get reports the tutorial as cleared', Number(outUser.TutorialClearedTime ?? 0) > 0);
check(
  'User:Get reports the master max manager level',
  Number(outUser.ManagerLevel) === maxManagerLevel,
  outUser.ManagerLevel,
);
const outCompany = (userGet.Company ?? {}) as Record<string, unknown>;
const companyRankPoint =
  Number(outCompany.EnjoyPoint ?? 0) + Number(outCompany.TrustPoint ?? 0) + Number(outCompany.SalaryPoint ?? 0);
check('User:Get reports the top office rank points (S+50)', companyRankPoint >= 360000, outCompany);
const outHierarchy = (userGet.Hierarchy ?? {}) as Record<string, unknown>;
check('User:Get reports the BIG4 Venus rank', outHierarchy.BestDetailGradeId === 'hie-001-001', outHierarchy);
const outTutorials = (userGet.Tutorials ?? []) as Record<string, unknown>[];
check(
  'User:Get includes the completed opening tutorial',
  outTutorials.some((t) => Number(t.TutorialType) === 1 && Number(t.Step) >= 150),
);
const outAreas = (userGet.Areas ?? []) as Record<string, unknown>[];
check(
  'User:Get unlocks the photo/story areas',
  outAreas.some((a) => String(a.AreaId) === 'area-main-002' && Number(a.ClearQuestCount) >= 9999),
);
const initialIdol = ((userGet.HomePositions ?? []) as Record<string, unknown>[]).find(
  (p) => Number(p.HomePositionType) === 4,
);
check(
  'User:Get gives a player with no HomePositions a Satomi idol slot',
  initialIdol?.CharacterId === 'char-stm',
  initialIdol?.CharacterId,
);

// Sandbox opens every story episode to Story Photos: User:Get serves the Shoot
// Unlock Ticket flag on every story and persists it to the store. The proto
// decoder represents a bool as the varint number 1, so compare numerically.
const photoShootingOpen = (story: Record<string, unknown>) =>
  Number(story.IsUseActivatePhotoShootingStoryTicket ?? 0) === 1;
const outStories = (userGet.Stories ?? []) as Record<string, unknown>[];
check(
  'User:Get opens every story to Story Photos',
  outStories.length > 0 && outStories.every(photoShootingOpen),
  outStories.filter((s) => !photoShootingOpen(s)).length,
);
const storedStories = await listElements(playerId, 'Stories', db);
check(
  'every stored story has the photo-shooting flag',
  storedStories.length > 0 && storedStories.every(photoShootingOpen),
  storedStories.filter((s) => !photoShootingOpen(s)).length,
);

// ---------------------------------------------------------------------------
// Idempotence: a second seed writes nothing.
// ---------------------------------------------------------------------------
const before = Object.fromEntries(
  await Promise.all(Object.keys(expectedCounts).map(async (field) => [field, await count(playerId, field)] as const)),
);
const messagesBefore = await listElements(playerId, 'Messages', db);
const telephonesBefore = await listElements(playerId, 'Telephones', db);
const reseed = await seedSandboxAccount(db, playerId);
check('re-seed adds no cards', reseed.cardsAdded === 0);
check('re-seed updates no cards', reseed.cardsUpdated === 0);
check('re-seed writes no stories', reseed.storiesRead === 0, reseed.storiesRead);
check('re-seed writes no messages', reseed.messages === 0, reseed.messages);
check('re-seed writes no telephones', reseed.telephones === 0, reseed.telephones);
check('re-seed writes no home talks', reseed.homeTalks === 0, reseed.homeTalks);
check(
  're-seed writes no excursion gaze reactions',
  reseed.excursionGazeReactions === 0,
  reseed.excursionGazeReactions,
);
const messagesAfter = await listElements(playerId, 'Messages', db);
const changedMessages = messagesAfter
  .filter((message, index) => JSON.stringify(message) !== JSON.stringify(messagesBefore[index]))
  .map((message) => String(message.MessageId));
check(
  're-seed leaves message rows unchanged',
  changedMessages.length === 0,
  changedMessages.slice(0, 5).join(','),
);
check(
  're-seed leaves telephone rows unchanged',
  JSON.stringify(telephonesBefore) === JSON.stringify(await listElements(playerId, 'Telephones', db)),
);
check(
  're-seed adds no collection rows',
  [reseed.costumes, reseed.hairs, reseed.accessories, reseed.characters, reseed.emblems, reseed.decorations, reseed.photoRecipes, reseed.photoPoses, reseed.showcaseToys, reseed.showcaseToyAmounts, reseed.showcaseMusics, reseed.musics].every((n) => n === 0),
  JSON.stringify(reseed),
);
check(
  're-seed writes no tutorial/area/item rows',
  reseed.tutorials === 0 && reseed.areas === 0 && reseed.items === 0,
  JSON.stringify({ tutorials: reseed.tutorials, areas: reseed.areas, items: reseed.items }),
);
for (const [field, expected] of Object.entries(before)) {
  const actual = await count(playerId, field);
  check(`re-seed keeps ${field} count`, actual === expected, `${expected} -> ${actual}`);
}

// A re-seed also migrates an account that still has an accessory and a deck
// position referencing it: both must be gone afterwards.
const injectedAccessoryId = 'accessory-sbxtest-injected';
await putElements(
  playerId,
  'Accessories',
  [
    {
      __msg: 'Solis.Common.Proto.Transaction.UserAccessory',
      AccessoryId: injectedAccessoryId,
      Amount: 3,
    },
  ],
  db,
);
await putElements(
  playerId,
  'DeckPositions',
  [
    {
      __msg: 'Solis.Common.Proto.Api.UserDeckPosition',
      Number: 999,
      Position: 1,
      CardId: 'card-ai-03-schl-00',
      Part1AccessoryId: injectedAccessoryId,
      Part2AccessoryId: injectedAccessoryId,
    },
  ],
  db,
);
const cleanedReseed = await seedSandboxAccount(db, playerId);
const accessoriesAfterCleanup = await listElements(playerId, 'Accessories', db);
check(
  're-seed removes an accessory already in the inventory',
  accessoriesAfterCleanup.every((a) => String(a.AccessoryId ?? '') !== injectedAccessoryId),
  accessoriesAfterCleanup.length,
);
const decksAfterCleanup = [
  ...(await listElements(playerId, 'DeckPositions', db)),
  ...(await listElements(playerId, 'LeagueDeckPositions', db)),
];
check(
  're-seed clears an accessory reference on a deck position',
  decksAfterCleanup.every((position) => !hasAccessoryRef(position)),
  decksAfterCleanup.filter(hasAccessoryRef).length,
);
check('re-seed reports the removed accessories', cleanedReseed.accessories === 1, cleanedReseed.accessories);

// ---------------------------------------------------------------------------
// Heal: an account created before the post-tutorial seed (no User/Balance/
// Tutorials/Areas rows, level 1) is repaired by re-running the seed, the same
// way `node src/profiles/sandbox/seedUser.ts <playerId>` heals a live account.
// ---------------------------------------------------------------------------
const healUid = 'sbxtest-heal-' + Date.now();
const healIdentity = await findOrCreateIdentityByUid(healUid);
created.push({ uid: healUid, ...healIdentity });
const healPlayerId = healIdentity.serverUserId;
for (const kind of ['User', 'Balance', 'Tutorials', 'Points', 'Areas', 'Items']) {
  await db
    .delete(playerEntities)
    .where(and(eq(playerEntities.playerId, healPlayerId), eq(playerEntities.kind, kind)));
}
await db.update(players).set({ level: 1, exp: 0 }).where(eq(players.id, healPlayerId));

const healed = await seedSandboxAccount(db, healPlayerId);
check(
  're-seed heals the tutorial/area/item state',
  healed.tutorials > 0 && healed.areas > 0 && healed.items > 0,
  JSON.stringify({ tutorials: healed.tutorials, areas: healed.areas, items: healed.items }),
);
const healToken = mintToken({ sub: healIdentity.accountId, seedId: healIdentity.publicUserId });
const healedGet = await rpc('User:Get', healToken, {});
const healedBalance = (healedGet.Balance ?? {}) as Record<string, unknown>;
check(
  'healed account shows the sandbox jewels',
  Number(healedBalance.FreeBalance) === SANDBOX_CURRENCY,
  healedBalance.FreeBalance,
);
const healedUser = (healedGet.User ?? {}) as Record<string, unknown>;
check('healed account is past the tutorial', Number(healedUser.TutorialClearedTime ?? 0) > 0);
check(
  'healed account has the master max manager level',
  Number(healedUser.ManagerLevel) === maxManagerLevel,
  healedUser.ManagerLevel,
);

// ---------------------------------------------------------------------------
// Gacha: sandbox pulls are free and draw from the full catalogue.
// ---------------------------------------------------------------------------
const catalogue = new Set(masterCards.map((c) => String(c.Id)));
const freeBefore = await getCurrency(playerId, 'freeJewel', db);
const draw1 = await rpc('Gacha:Draw', token, { GachaButtonId: 'btn-01-gacha-birthday-26-0505', ExecCount: 1 });
const rewards1 = (draw1.Rewards as { ResourceType?: unknown; ResourceId?: unknown }[] | undefined) ?? [];
check('single draw returns one card', rewards1.length === 1, rewards1.length);
check('single draw only yields cards', rewards1.every((r) => Number(r.ResourceType) === 2));
check('single draw card exists in the full catalogue', rewards1.every((r) => catalogue.has(String(r.ResourceId))));
check('single draw consumes no currency', ((draw1.ConsumptionResults as unknown[] | undefined) ?? []).length === 0);
check('single draw leaves jewels unchanged', (await getCurrency(playerId, 'freeJewel', db)) === freeBefore);

const freeTen = await rpc('Gacha:Draw', token, { GachaButtonId: 'btn-10-gacha-excursion-01-26-0918-free', ExecCount: 1 });
const rewards10 = (freeTen.Rewards as { ResourceType?: unknown; ResourceId?: unknown }[] | undefined) ?? [];
check('free 10-pull returns ten cards', rewards10.length === 10, rewards10.length);
check('free 10-pull cards exist in the full catalogue', rewards10.every((r) => catalogue.has(String(r.ResourceId))));
check('free 10-pull leaves jewels unchanged', (await getCurrency(playerId, 'freeJewel', db)) === freeBefore);

// Showcase toy packs (the goods shop's 開封) are refused: their assets are
// missing from the client and the player already owns every toy.
const { listGachas } = await import('../../master/index.ts');
const toyGacha = (await listGachas()).find((g) => Number(g.GachaType) === 6 && ((g.ButtonIds as string[] | null) ?? []).length);
let toyDrawError: unknown = null;
try {
  await rpc('Gacha:Draw', token, { GachaButtonId: String((toyGacha?.ButtonIds as string[])[0]), ExecCount: 1 });
} catch (e) {
  toyDrawError = e;
}
check('a showcase toy gacha exists in master', Boolean(toyGacha));
check('showcase toy gacha draw is not implemented', isNotImplementedError(toyDrawError), String(toyDrawError));
const homeEnter = await rpc('Home:Enter', token, {});
const homeGachaIds = ((homeEnter.GachaInfos ?? []) as Record<string, unknown>[]).map((g) => String(g.Id));
check('Home:Enter still lists gachas', homeGachaIds.length > 0, homeGachaIds.length);
check('Home:Enter lists no showcase toy gacha', !homeGachaIds.includes(String(toyGacha?.Id)), homeGachaIds.filter((id) => id.startsWith('gacha-toy')));

// ---------------------------------------------------------------------------
// Memorial gacha: sandbox-only banners draw ★5s from per-category pools at the
// fes 7% rate, with ★4/★3 split evenly over the whole catalogue.
// ---------------------------------------------------------------------------
const { buildProbabilityModel } = await import('../../services/gacha.ts');
const {
  MEMORIAL_GACHA_CATEGORY,
  MEMORIAL_GACHA_IDS,
  buildMemorialPools,
} = await import('./memorialGacha.ts');
const { listCards, listCharacters } = await import('../../master/index.ts');

const memorialCards = await listCards();
const memorialGachaRows = await listGachas();
const memorialCharacters = await listCharacters();
const memorialPools = buildMemorialPools({
  cards: memorialCards,
  gachas: memorialGachaRows,
  characters: memorialCharacters,
});
const expectedMemorialCounts: Record<string, number> = {
  birthday: 69,
  fes: 51,
  limited1: 74,
  limited2: 56,
  link: 9,
  normal: 97,
  collab: 9,
  excursion: 20,
  premium: 19,
};
for (const [category, count] of Object.entries(expectedMemorialCounts)) {
  const pool = memorialPools.get(category as never) ?? [];
  check(`memorial ${category} pool has ${count} cards`, pool.length === count, pool.length);
  check(`memorial ${category} pool is non-empty`, pool.length > 0, pool.length);
}

const memorialPoolIds = [...memorialPools.values()].flat();
const memorialPoolUnion = new Set(memorialPoolIds);
check(
  'memorial pools are disjoint',
  memorialPoolUnion.size === memorialPoolIds.length,
  `${memorialPoolIds.length} ids, ${memorialPoolUnion.size} unique`,
);
const excursionPoolIds = memorialPools.get('excursion') ?? [];
const caslOutfitIds = memorialCards
  .filter((c) => Number(c.InitialRarity) === 5 && /^card-.+-05-casl-04$/.test(String(c.Id)))
  .map((c) => String(c.Id))
  .sort();
check(
  'excursion pool is exactly the 20 casl-04 outfit cards',
  caslOutfitIds.length === 20 &&
    excursionPoolIds.length === caslOutfitIds.length &&
    excursionPoolIds.every((id, i) => id === caslOutfitIds[i]),
  `${excursionPoolIds.length} pooled, ${caslOutfitIds.length} casl-04 cards`,
);
const premiumPoolIds = memorialPools.get('premium') ?? [];
const premiumCardIds = memorialCards
  .filter((c) => Number(c.InitialRarity) === 5 && /^card-.+-05-prem-\d\d$/.test(String(c.Id)))
  .map((c) => String(c.Id))
  .sort();
check(
  'premium pool is exactly the 19 prem cards',
  premiumCardIds.length === 19 &&
    premiumPoolIds.length === premiumCardIds.length &&
    premiumPoolIds.every((id, i) => id === premiumCardIds[i]),
  `${premiumPoolIds.length} pooled, ${premiumCardIds.length} prem cards`,
);
const rarityFiveIds = memorialCards
  .filter((c) => Number(c.InitialRarity) === 5)
  .map((c) => String(c.Id));
check('master has 404 ★5 cards', rarityFiveIds.length === 404, rarityFiveIds.length);
check(
  'memorial pools cover every ★5 card exactly once',
  memorialPoolUnion.size === rarityFiveIds.length && rarityFiveIds.every((id) => memorialPoolUnion.has(id)),
  `${memorialPoolUnion.size} pooled, ${rarityFiveIds.length} in master`,
);

const closeEnough = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const lowRarityIds = new Set(
  memorialCards.filter((c) => Number(c.InitialRarity) === 1 || Number(c.InitialRarity) === 2).map((c) => String(c.Id)),
);
for (const id of MEMORIAL_GACHA_IDS) {
  const model = await buildProbabilityModel({ Id: id, Name: '' } as never);
  const total = (model.rarityRate.get(5) ?? 0) + (model.rarityRate.get(4) ?? 0) + (model.rarityRate.get(3) ?? 0);
  check(`${id} ★5 rate is 7%`, closeEnough(model.rarityRate.get(5) ?? 0, 7), model.rarityRate.get(5));
  check(`${id} ★4 rate is 15%`, closeEnough(model.rarityRate.get(4) ?? 0, 15), model.rarityRate.get(4));
  check(`${id} ★3 rate is 78%`, closeEnough(model.rarityRate.get(3) ?? 0, 78), model.rarityRate.get(3));
  check(`${id} rarity rates total 100%`, closeEnough(total, 100), total);

  const category = MEMORIAL_GACHA_CATEGORY[id];
  const pool = new Set(memorialPools.get(category) ?? []);
  const fiveWeights = [...model.weights.entries()].filter(
    ([cardId, weight]) => weight > 0 && model.rarityOfCard.get(cardId) === 5,
  );
  const weightedIds = new Set(fiveWeights.map(([cardId]) => cardId));
  check(
    `${id} ★5 weights match the ${category} pool`,
    weightedIds.size === pool.size && [...pool].every((cardId) => weightedIds.has(cardId)),
    `${weightedIds.size} weighted, ${pool.size} pooled`,
  );
  const weights = fiveWeights.map(([, weight]) => weight);
  check(
    `${id} ★5 weights are equal`,
    weights.length > 0 && Math.max(...weights) - Math.min(...weights) < 1e-9,
    weights.length ? `${Math.min(...weights)}..${Math.max(...weights)}` : 'no ★5 weights',
  );
  check(
    `${id} never weights a ★1/★2 card`,
    [...model.weights.keys()].every((cardId) => !lowRarityIds.has(cardId)),
  );
}

// ---------------------------------------------------------------------------
// Trust and bond: maxed so trust-gated voicelines, messages and bond pages open.
// ---------------------------------------------------------------------------
const bondChars = await listElements(playerId, 'Characters', db);
check('every idol has max trust', bondChars.every((c) => Number(c.Reliability ?? 0) >= 900));
check('every idol has max bond points', bondChars.every((c) => Number(c.CompanyEnjoyPoint ?? 0) >= 8325));
const company = await getSingleton(playerId, 'Company', db);
check('company bond is at the top level', Number(company?.EnjoyPoint ?? 0) >= 56800, company?.EnjoyPoint);

// Fan gates: every `ConditionFanAmount` threshold must pass. The seed gives
// Light/Middle/Heavy the same per-character maximum, covering both the
// single-tier and summed interpretations of the client condition.
const fanConditionRows = (await db.execute(
  sql`select "Settings" from "master_Condition"`,
)) as unknown as Array<{ Settings: unknown }>;
const fanCharacters = new Map(bondChars.map((c) => [String(c.CharacterId ?? ''), c]));
const fanFailures: string[] = [];
const FAN_FIELDS = ['LightFanAmount', 'MiddleFanAmount', 'HeavyFanAmount'] as const;
for (const row of fanConditionRows) {
  if (!Array.isArray(row.Settings)) continue;
  for (const rawSetting of row.Settings) {
    const fan = (rawSetting as Record<string, unknown> | null)?.FanAmount as
      | Record<string, unknown>
      | undefined;
    if (!fan) continue;
    const characterId = String(fan.CharacterId ?? '');
    const need = Number(fan.AmountGte ?? 0);
    if (!characterId || !Number.isFinite(need)) continue;
    const character = fanCharacters.get(characterId);
    for (const field of FAN_FIELDS) {
      if (Number(character?.[field] ?? 0) < need) {
        fanFailures.push(`${characterId}.${field}<${need}`);
      }
    }
  }
}
check(
  'fan amounts satisfy every ConditionFanAmount',
  fanConditionRows.length > 0 && fanFailures.length === 0,
  fanFailures.slice(0, 5).join(','),
);

// Love: every route at its top LoveLevel.
const loveTops = await db
  .select({ LoveId: master.masterLoveLevel.LoveId, exp: sql<number>`max(${master.masterLoveLevel.RequiredExp})`.mapWith(Number) })
  .from(master.masterLoveLevel)
  .groupBy(master.masterLoveLevel.LoveId);
const loveRows = await db.select().from(playerLoveProgress).where(eq(playerLoveProgress.playerId, playerId));
const loveExp = new Map(loveRows.map((r) => [r.loveId, Number(r.exp)]));
check('every Love route is at its top level', loveTops.length > 0 && loveTops.every((t) => (loveExp.get(String(t.LoveId)) ?? 0) >= t.exp), loveTops.length);
check('Love protagonist name is left for Love:Register', loveRows.every((r) => r.name == null));
const loveTitleExtra = await rpc('Love:TitleExtra', token, { LoveId: 'love-extra-25-0426' });
check(
  'Love:TitleExtra returns the extra story title asset',
  loveTitleExtra.TitleAssetId === 'love-25-0426',
  loveTitleExtra.TitleAssetId,
);
const loveTitleExtraInfo = (loveTitleExtra.LoveInfo ?? {}) as Record<string, unknown>;
check(
  'Love:TitleExtra sends the extra content asset id for its loading logo',
  loveTitleExtraInfo.AssetId === 'love-25-0426',
  loveTitleExtraInfo.AssetId,
);
check(
  'Love:TitleExtra LoveInfo omits CharacterId and CostumeId',
  !loveTitleExtraInfo.CharacterId && !loveTitleExtraInfo.CostumeId,
  `${loveTitleExtraInfo.CharacterId}/${loveTitleExtraInfo.CostumeId}`,
);

// Sumire deliberately lists every supported event in Love:Title, extras included,
// because it has no Home:Enter LoveEventInfos to surface them. The client keys
// this list by LoveId.
const loveTitle = await rpc('Love:Title', token, {});
const loveTitleInfos = (loveTitle.LoveInfos ?? []) as Record<string, unknown>[];
const loveTitleIds = loveTitleInfos.map((i) => String(i.LoveId ?? ''));
check(
  'Love:Title returns exactly one LoveInfo per LoveId',
  loveTitleIds.length === 6 && loveTitleIds.length === new Set(loveTitleIds).size,
  loveTitleIds.join(','),
);
check(
  'Love:Title includes the extra event exactly once',
  loveTitleIds.filter((id) => id === 'love-extra-25-0426').length === 1,
  loveTitleIds.join(','),
);
const loveTitleOrders = loveTitleInfos.map((i) => Number(i.Order ?? NaN));
check(
  'Love:Title assigns distinct, increasing Order values',
  loveTitleOrders.length > 0 &&
    loveTitleOrders.every((order, i) => i === 0 || order > loveTitleOrders[i - 1]),
  loveTitleOrders.join(','),
);
check(
  'Love:Title LoveInfos omit CharacterId and CostumeId',
  loveTitleInfos.every((i) => !i.CharacterId && !i.CostumeId),
  loveTitleInfos.map((i) => `${i.LoveId}:${i.CharacterId}/${i.CostumeId}`).join(','),
);
const loveStandardTitleInfo =
  loveTitleInfos.find((i) => i.LoveId === 'love-23-0514') ?? {};
check(
  'Love:Title reports normal type and standard base type',
  Number(loveStandardTitleInfo.Type) === 1 && Number(loveStandardTitleInfo.BaseType) === 1,
  `${loveStandardTitleInfo.Type}/${loveStandardTitleInfo.BaseType}`,
);
check(
  'Love:Title carries the catalogued unlock condition',
  loveStandardTitleInfo.UnlockConditionId === 'cd-clear-area-main-002' &&
    Boolean(loveStandardTitleInfo.IsUnlocked),
  loveStandardTitleInfo.UnlockConditionId,
);
check(
  'Love:Title carries event and limited mission ids',
  Array.isArray(loveStandardTitleInfo.EventMissionIds) &&
    (loveStandardTitleInfo.EventMissionIds as unknown[]).length === 2 &&
    Array.isArray(loveStandardTitleInfo.LimitedEventMissionIds) &&
    (loveStandardTitleInfo.LimitedEventMissionIds as unknown[]).length === 1,
  JSON.stringify([
    loveStandardTitleInfo.EventMissionIds,
    loveStandardTitleInfo.LimitedEventMissionIds,
  ]),
);
check(
  'Love:Title lists every catalog ending before the first clear',
  ((loveStandardTitleInfo.StoryEndInfos ?? []) as unknown[]).length === loveStandardEndingCount &&
    ((loveStandardTitleInfo.StoryEndInfos ?? []) as Record<string, unknown>[]).every(
      (e) => !e.Unlocked,
    ),
  JSON.stringify(loveStandardTitleInfo.StoryEndInfos),
);
check(
  'Love:Title does not mark a fresh route lesson-maxed',
  !loveStandardTitleInfo.IsLessonRewardMax,
  loveStandardTitleInfo.IsLessonRewardMax,
);
check(
  'Love:Title reports the stocked present item as obtainable',
  Boolean(loveStandardTitleInfo.HasHiddenFavorabilityObtainItem),
  loveStandardTitleInfo.HasHiddenFavorabilityObtainItem,
);
check(
  'Love:Title leaves the standard manager voice switch visible',
  !loveStandardTitleInfo.IsHideManagerVoiceSwitch,
  loveStandardTitleInfo.IsHideManagerVoiceSwitch,
);

// Legacy rows written before migration 0033 backfilled `active_story_episode_id`
// can carry IsReadingStory=true with no active episode. Any Love state load must
// repair that (and seed the empty route) before the client can call Restart.
const legacyLoveId = 'love-24-0517';
const legacyFirstEpisodeId = 'love-event-story-love-24-0517-001';
await putElements(
  playerId,
  'Loves',
  [
    {
      __msg: 'Solis.Common.Proto.Transaction.UserLove',
      LoveId: legacyLoveId,
      UnlockedLoveStoryEndIDs: [],
      HiddenFavorability: 0,
      IsReadingStory: true,
    },
  ],
  db,
);
await db
  .update(playerLoveProgress)
  .set({ name: 'Legacy', activeStoryEpisodeId: '', storyEpisodeIds: [] })
  .where(
    and(
      eq(playerLoveProgress.playerId, playerId),
      eq(playerLoveProgress.loveId, legacyLoveId),
    ),
  );
await rpc('Love:Top', token, { LoveId: legacyLoveId });
const legacyLoveAfterTop = (await listElements(playerId, 'Loves', db)).find(
  (l) => String(l.LoveId ?? '') === legacyLoveId,
);
check(
  'Love:Top clears a stale legacy reading flag',
  !legacyLoveAfterTop?.IsReadingStory,
  legacyLoveAfterTop?.IsReadingStory,
);
const [legacyRowAfterTop] = await db
  .select()
  .from(playerLoveProgress)
  .where(
    and(
      eq(playerLoveProgress.playerId, playerId),
      eq(playerLoveProgress.loveId, legacyLoveId),
    ),
  )
  .limit(1);
check(
  'Love:Top seeds an empty legacy route',
  JSON.stringify(legacyRowAfterTop?.storyEpisodeIds) === JSON.stringify([legacyFirstEpisodeId]),
  JSON.stringify(legacyRowAfterTop?.storyEpisodeIds),
);
let legacyStartFailed = '';
try {
  await rpc('Love:Start', token, { StoryEpisodeId: legacyFirstEpisodeId });
} catch (err) {
  legacyStartFailed = err instanceof Error ? err.message : String(err);
}
check('Love:Start succeeds after the legacy repair', legacyStartFailed === '', legacyStartFailed);

// Solis `love/get_main_character.go:10-16` + `catalog.go:197-205`.
const loveMainExtra = await rpc('Love:GetMainCharacter', token, {
  LoveId: 'love-extra-25-0426',
});
const loveMainExtraInfo = (loveMainExtra.MainCharacterInfo ?? {}) as Record<string, unknown>;
check(
  'Love:GetMainCharacter returns a catalogued extra heroine',
  ['char-rui', 'char-chs', 'char-smr', 'char-ngs'].includes(
    String(loveMainExtraInfo.CharacterId ?? ''),
  ),
  loveMainExtraInfo.CharacterId,
);
check(
  'Love:GetMainCharacter returns a complete extra portrait',
  String(loveMainExtraInfo.CostumeId ?? '') !== '' &&
    String(loveMainExtraInfo.AssetId ?? '') !== '' &&
    String(loveMainExtraInfo.Color ?? '') !== '',
  JSON.stringify(loveMainExtraInfo),
);
const loveMainStandard = await rpc('Love:GetMainCharacter', token, {
  LoveId: 'love-23-0514',
});
const loveMainStandardInfo = (loveMainStandard.MainCharacterInfo ?? {}) as Record<
  string,
  unknown
>;
check(
  'Love:GetMainCharacter uses the configured standard heroine',
  loveMainStandardInfo.CharacterId === 'char-rei' &&
    loveMainStandardInfo.CostumeId === 'cos-rei-schl-00' &&
    loveMainStandardInfo.AssetId === 'img_chr_mem_rei' &&
    loveMainStandardInfo.Color === '68D2E9',
  JSON.stringify(loveMainStandardInfo),
);

// IsUnplayed follows registration (saved protagonist name), not ending unlocks.
const loveRegisteredInfo = (loveTitleExtra.LoveInfo ?? {}) as Record<string, unknown>;
check(
  'Love:TitleExtra marks an unregistered route as unplayed',
  Boolean(loveRegisteredInfo.IsUnplayed),
  loveRegisteredInfo.IsUnplayed,
);
await rpc('Love:Register', token, { LoveId: 'love-extra-25-0426', Name: 'Tester' });
const loveRegisteredExtra = await rpc('Love:TitleExtra', token, {
  LoveId: 'love-extra-25-0426',
});
const loveRegisteredExtraInfo = (loveRegisteredExtra.LoveInfo ?? {}) as Record<string, unknown>;
check(
  'Love:TitleExtra marks a registered route as played',
  !loveRegisteredExtraInfo.IsUnplayed,
  loveRegisteredExtraInfo.IsUnplayed,
);
check(
  'Love:TitleExtra reports the extra event type and base type',
  Number(loveRegisteredExtraInfo.Type) === 2 && Number(loveRegisteredExtraInfo.BaseType) === 2,
  `${loveRegisteredExtraInfo.Type}/${loveRegisteredExtraInfo.BaseType}`,
);
check(
  'Love:TitleExtra hides the extra manager voice switch',
  Boolean(loveRegisteredExtraInfo.IsHideManagerVoiceSwitch),
  loveRegisteredExtraInfo.IsHideManagerVoiceSwitch,
);
check(
  'Love:TitleExtra has no present item to obtain on the extra event',
  !loveRegisteredExtraInfo.HasHiddenFavorabilityObtainItem,
  loveRegisteredExtraInfo.HasHiddenFavorabilityObtainItem,
);
check(
  'Love:TitleExtra does not mark a freshly registered route lesson-maxed',
  !loveRegisteredExtraInfo.IsLessonRewardMax,
  loveRegisteredExtraInfo.IsLessonRewardMax,
);
check(
  'Love:TitleExtra carries the catalogued start time and unlock condition',
  Number(loveRegisteredExtraInfo.StartTime) === 1745636400000 &&
    loveRegisteredExtraInfo.UnlockConditionId === 'cd-clear-area-main-002',
  `${loveRegisteredExtraInfo.StartTime}/${loveRegisteredExtraInfo.UnlockConditionId}`,
);
const loveRegisteredTop = await rpc('Love:Top', token, { LoveId: 'love-extra-25-0426' });
check(
  'Love:Top returns the saved protagonist name',
  loveRegisteredTop.PlayerName === 'Tester',
  loveRegisteredTop.PlayerName,
);
check(
  'Love:Top sends the extra content banner asset id',
  loveRegisteredTop.BannerAssetId === 'img_banner_l_event-love-25-0426',
  loveRegisteredTop.BannerAssetId,
);
check(
  'Love:Top sends the extra content exp asset id',
  loveRegisteredTop.ExpAssetId === 'exp-love-25-0426',
  loveRegisteredTop.ExpAssetId,
);

// Sandbox Love keys are free: the seed stocks every story key and Love:Start
// never spends them on a paid episode. The story itself is route-driven, so the
// paid episode must first be reached by playing episode 1.
const loveStoryItemId = 'item-love-23-0514-story';
const loveId = 'love-23-0514';
const firstLoveEpisodeId = 'love-event-story-love-23-0514-001';
const paidLoveEpisodeId = 'love-event-story-love-23-0514-002';
const loveRoutePath = [
  [firstLoveEpisodeId, [[1, 2], [2, 1]]],
  [paidLoveEpisodeId, [[1, 1], [2, 2]]],
  ['love-event-story-love-23-0514-003', [[1, 1], [2, 1]]],
  ['love-event-story-love-23-0514-004', [[1, 1], [2, 2]]],
  ['love-event-story-love-23-0514-005', [[1, 1], [2, 2]]],
  ['love-event-story-love-23-0514-006', [[1, 2], [2, 2], [3, 1]]],
  ['love-event-story-love-23-0514-007', [[1, 2], [2, 1]]],
  ['love-event-story-love-23-0514-008-happy', [[1, 2]]],
] as const;
const loveRouteErrorDetails = async () => {
  const [row] = await db
    .select()
    .from(playerLoveProgress)
    .where(and(eq(playerLoveProgress.playerId, playerId), eq(playerLoveProgress.loveId, loveId)))
    .limit(1);
  return row;
};
const finishLoveEpisode = (episode: string, choices: ReadonlyArray<readonly [number, number]>) =>
  rpc('Love:Finish', token, {
    StoryEpisodeId: episode,
    SelectStoryChoiceInfos: choices.map(([GroupIndex, Index]) => ({
      GroupIndex,
      Index,
      IsValid: true,
    })),
  });

const [loveKeyMaster, paidLoveEpisode] = await Promise.all([
  db.select().from(master.masterItem).where(eq(master.masterItem.Id, loveStoryItemId)).limit(1),
  db
    .select()
    .from(master.masterLoveStoryEpisode)
    .where(eq(master.masterLoveStoryEpisode.Id, paidLoveEpisodeId))
    .limit(1),
]);
check(
  'test Love key and paid episode exist in master',
  loveKeyMaster.length === 1 && Number(paidLoveEpisode[0]?.ConsumptionItemAmount ?? 0) > 0,
  `${loveKeyMaster.length}/${paidLoveEpisode[0]?.ConsumptionItemAmount}`,
);

// A route event must be registered before any episode can start.
await rpc('Love:Register', token, { LoveId: loveId, Name: 'Tester' });

// Level roadmap (solis `love/top.go:44-64`): reveal five-level windows and attach
// EpisodeUnlockLevels/HintUnlockLevels to the matching row.
const setLoveExp = (exp: number) =>
  db
    .update(playerLoveProgress)
    .set({ exp })
    .where(and(eq(playerLoveProgress.playerId, playerId), eq(playerLoveProgress.loveId, loveId)));
const loveLevelRows = (top: Record<string, unknown>) =>
  (top.LoveLevelInfos ?? []) as Record<string, unknown>[];

await setLoveExp(0);
const loveTopLevel1 = await rpc('Love:Top', token, { LoveId: loveId });
const loveLevels1 = loveLevelRows(loveTopLevel1);
check(
  'Love:Top reveals the first five roadmap rows at level 1',
  loveLevels1.length === 5 &&
    loveLevels1.map((l) => Number(l.Level ?? 0)).join(',') === '1,2,3,4,5',
  loveLevels1.map((l) => l.Level).join(','),
);
check(
  'Love:Top marks the current and next roadmap rows viewable',
  loveLevels1
    .filter((l) => Boolean(l.IsTextViewable))
    .map((l) => Number(l.Level ?? 0))
    .join(',') === '1,2',
  loveLevels1.map((l) => `${l.Level}:${l.IsTextViewable}`).join(','),
);
check(
  'Love:Top attaches story unlocks to roadmap rows',
  Number(loveLevels1.find((l) => Number(l.Level) === 1)?.UnlockStoryEpisode ?? 0) === 1 &&
    Number(loveLevels1.find((l) => Number(l.Level) === 5)?.UnlockStoryEpisode ?? 0) === 5,
  loveLevels1.map((l) => `${l.Level}:${l.UnlockStoryEpisode}`).join(','),
);
check(
  'Love:Top keeps hint unlocks hidden below their level',
  loveLevels1.every((l) => !l.UnlockLoveHintType),
  loveLevels1.map((l) => `${l.Level}:${l.UnlockLoveHintType}`).join(','),
);
check(
  'Love:Top sends the current route as StoryEpisodeIds',
  JSON.stringify(loveTopLevel1.StoryEpisodeIds) === JSON.stringify([firstLoveEpisodeId]),
  JSON.stringify(loveTopLevel1.StoryEpisodeIds),
);
check(
  'Love:Top lists every catalog ending but unlocks none before the first clear',
  ((loveTopLevel1.StoryEndInfos ?? []) as unknown[]).length === loveStandardEndingCount &&
    ((loveTopLevel1.StoryEndInfos ?? []) as Record<string, unknown>[]).every((e) => !e.Unlocked),
  JSON.stringify(loveTopLevel1.StoryEndInfos),
);
check(
  'Love:Top keeps save slots locked before the first ending',
  !((loveTopLevel1.SaveInfo as Record<string, unknown> | undefined)?.Unlocked),
  JSON.stringify(loveTopLevel1.SaveInfo),
);

await setLoveExp(270000);
const loveTopLevel6 = await rpc('Love:Top', token, { LoveId: loveId });
const loveLevels6 = loveLevelRows(loveTopLevel6);
check(
  'Love:Top reveals ten roadmap rows at level 6',
  loveLevels6.length === 10 &&
    loveLevels6.map((l) => Number(l.Level ?? 0)).join(',') === '1,2,3,4,5,6,7,8,9,10',
  loveLevels6.map((l) => l.Level).join(','),
);
check(
  'Love:Top marks every row through the next level viewable',
  loveLevels6
    .filter((l) => Boolean(l.IsTextViewable))
    .map((l) => Number(l.Level ?? 0))
    .join(',') === '1,2,3,4,5,6,7',
  loveLevels6.map((l) => `${l.Level}:${l.IsTextViewable}`).join(','),
);
check(
  'Love:Top attaches hint unlocks to roadmap rows',
  Number(loveLevels6.find((l) => Number(l.Level) === 9)?.UnlockLoveHintType ?? 0) === 1 &&
    Number(loveLevels6.find((l) => Number(l.Level) === 10)?.UnlockLoveHintType ?? 0) === 2,
  loveLevels6.map((l) => `${l.Level}:${l.UnlockLoveHintType}`).join(','),
);
await setLoveExp(860000);

// Save slots unlock with the first ending (solis common.go:141-157).
let loveSaveBeforeEndingRejected = false;
try {
  await rpc('Love:Save', token, { LoveId: loveId, SlotNumber: 1 });
} catch {
  loveSaveBeforeEndingRejected = true;
}
check('Love:Save is rejected before the first ending', loveSaveBeforeEndingRejected);

let loveOffRouteRejected = false;
try {
  await rpc('Love:Start', token, { StoryEpisodeId: 'love-event-story-love-23-0514-003' });
} catch {
  loveOffRouteRejected = true;
}
check('Love:Start rejects an episode that is not on the current route', loveOffRouteRejected);

const firstLoveStart = await rpc('Love:Start', token, { StoryEpisodeId: firstLoveEpisodeId });
const firstLoveChoices = (firstLoveStart.StoryChoiceGroupInfos ?? []) as Record<string, unknown>[];
check('Love:Start returns non-empty ChoiceInfos', firstLoveChoices.length > 0, firstLoveChoices.length);
const firstLoveBranches = (firstLoveStart.AdvBranchInfos ?? []) as Record<string, unknown>[];
check('Love:Start returns a BranchInfos list', Array.isArray(firstLoveBranches), firstLoveBranches.length);

let loveInvalidChoiceRejected = false;
try {
  await finishLoveEpisode(firstLoveEpisodeId, [[1, 99]]);
} catch {
  loveInvalidChoiceRejected = true;
}
check('Love:Finish rejects an invalid choice', loveInvalidChoiceRejected);

const firstLoveFinish = await finishLoveEpisode(firstLoveEpisodeId, loveRoutePath[0][1]);
check(
  'Love:Finish of episode 1 is not an ending',
  !firstLoveFinish.StoryEndName,
  firstLoveFinish.StoryEndName,
);
const afterFirstLoveFinish = await loveRouteErrorDetails();
check(
  'Love:Finish appends the next episode to the route',
  Array.isArray(afterFirstLoveFinish?.storyEpisodeIds) &&
    afterFirstLoveFinish.storyEpisodeIds.includes(paidLoveEpisodeId),
  JSON.stringify(afterFirstLoveFinish?.storyEpisodeIds),
);
check(
  'Love:Finish stores the chosen selections on the route',
  Array.isArray(afterFirstLoveFinish?.selections) && afterFirstLoveFinish.selections.length === 2,
  JSON.stringify(afterFirstLoveFinish?.selections),
);
check(
  'Love:Finish records past choices for hint lookup',
  Array.isArray(afterFirstLoveFinish?.pastSelections) &&
    afterFirstLoveFinish.pastSelections.length === 2,
  JSON.stringify(afterFirstLoveFinish?.pastSelections),
);

const loveTopAfterFirstFinish = await rpc('Love:Top', token, { LoveId: loveId });
check(
  'Love:Top follows the advanced route',
  Array.isArray(loveTopAfterFirstFinish.StoryEpisodeIds) &&
    (loveTopAfterFirstFinish.StoryEpisodeIds as string[]).includes(paidLoveEpisodeId),
  JSON.stringify(loveTopAfterFirstFinish.StoryEpisodeIds),
);
check(
  'Love:Top keeps every catalog ending listed but locked before a clear',
  ((loveTopAfterFirstFinish.StoryEndInfos ?? []) as unknown[]).length ===
    loveStandardEndingCount &&
    ((loveTopAfterFirstFinish.StoryEndInfos ?? []) as Record<string, unknown>[]).every(
      (e) => !e.Unlocked,
    ),
  JSON.stringify(loveTopAfterFirstFinish.StoryEndInfos),
);

const loveKeyBefore = (await listElements(playerId, 'Items', db)).find(
  (i) => String(i.ItemId ?? '') === loveStoryItemId,
);
check(
  'Love story key is stocked to the sandbox ceiling',
  Number(loveKeyBefore?.Amount ?? -1) === SANDBOX_CURRENCY,
  loveKeyBefore?.Amount,
);
const loveStart = await rpc('Love:Start', token, { StoryEpisodeId: paidLoveEpisodeId });
const loveStartItems = ((loveStart.CommonResponse as any)?.UpdatedData?.Items ?? []) as Record<
  string,
  unknown
>[];
const loveStartItem = loveStartItems.find((i) => String(i.ItemId ?? '') === loveStoryItemId);
check(
  'Love:Start echoes the untouched story key',
  Number(loveStartItem?.Amount ?? -1) === SANDBOX_CURRENCY,
  loveStartItem?.Amount,
);
const loveKeyAfter = (await listElements(playerId, 'Items', db)).find(
  (i) => String(i.ItemId ?? '') === loveStoryItemId,
);
check(
  'Love:Start leaves the story key at the sandbox ceiling',
  Number(loveKeyAfter?.Amount ?? -1) === SANDBOX_CURRENCY,
  loveKeyAfter?.Amount,
);

// Play the rest of the route to the canonical TRUE ending
// (`love-end-love-23-0514-008-happy-002`, end roll `event_2305_02_02`).
let lastLoveFinish: Record<string, unknown> = await finishLoveEpisode(
  paidLoveEpisodeId,
  loveRoutePath[1][1],
);
for (const [episode, choices] of loveRoutePath.slice(2)) {
  const start = await rpc('Love:Start', token, { StoryEpisodeId: episode });
  const choiceInfos = (start.StoryChoiceGroupInfos ?? []) as Record<string, unknown>[];
  check(`Love:Start returns choices for ${episode}`, choiceInfos.length > 0, choiceInfos.length);
  lastLoveFinish = await finishLoveEpisode(episode, choices);
}
check(
  'Love:Finish returns the ending name',
  lastLoveFinish.StoryEndName === 'TRUE エンド',
  lastLoveFinish.StoryEndName,
);
check(
  'Love:Finish returns the ending end-roll asset',
  lastLoveFinish.EndRollAssetId === 'event_2305_02_02',
  lastLoveFinish.EndRollAssetId,
);
check(
  'Love:Finish unlocks the save on the first ending',
  Boolean(lastLoveFinish.UnlockSave),
  lastLoveFinish.UnlockSave,
);
const lovesAfterRoute = await listElements(playerId, 'Loves', db);
const loveAfterRoute = lovesAfterRoute.find((l) => String(l.LoveId ?? '') === loveId);
check(
  'Love:Finish unlocks the canonical ending',
  Array.isArray(loveAfterRoute?.UnlockedLoveStoryEndIDs) &&
    (loveAfterRoute.UnlockedLoveStoryEndIDs as string[]).includes(
      'love-end-love-23-0514-008-happy-002',
    ),
  JSON.stringify(loveAfterRoute?.UnlockedLoveStoryEndIDs),
);
check(
  'Love:Finish adds the ending favorability',
  Number(loveAfterRoute?.HiddenFavorability ?? 0) > 0,
  loveAfterRoute?.HiddenFavorability,
);
const afterEnding = await loveRouteErrorDetails();
check(
  'an ending restarts the route at episode 1',
  JSON.stringify(afterEnding?.storyEpisodeIds) === JSON.stringify([firstLoveEpisodeId]),
  JSON.stringify(afterEnding?.storyEpisodeIds),
);
check(
  'an ending clears the active episode',
  afterEnding?.activeStoryEpisodeId === '',
  afterEnding?.activeStoryEpisodeId,
);

const loveTopAfterClear = await rpc('Love:Top', token, { LoveId: loveId });
const loveTopEnds = (loveTopAfterClear.StoryEndInfos ?? []) as Record<string, unknown>[];
check(
  'Love:Top lists every catalog ending after the first clear',
  loveTopEnds.length === loveStandardEndingCount,
  loveTopEnds.length,
);
check(
  'Love:Top marks exactly the cleared ending unlocked',
  loveTopEnds.filter((e) => Boolean(e.Unlocked)).length === 1 &&
    loveTopEnds.some(
      (e) => e.Id === 'love-end-love-23-0514-008-happy-002' && Boolean(e.Unlocked),
    ),
  JSON.stringify(loveTopEnds.map((e) => `${e.Id}:${e.Unlocked}`)),
);

// Top must derive the save gate from UnlockedLoveStoryEndIDs, not the stored
// save_unlocked column (solis top.go:40).
await db
  .update(playerLoveProgress)
  .set({ saveUnlocked: false })
  .where(and(eq(playerLoveProgress.playerId, playerId), eq(playerLoveProgress.loveId, loveId)));
const loveTopForcedLocked = await rpc('Love:Top', token, { LoveId: loveId });
check(
  'Love:Top derives save unlock from endings, ignoring stored save_unlocked',
  Boolean((loveTopForcedLocked.SaveInfo as Record<string, unknown> | undefined)?.Unlocked),
  JSON.stringify(loveTopForcedLocked.SaveInfo),
);

// Save/Load: a slot snapshots the whole route and Load restores it exactly
// (solis save.go:15-48 / load.go:17-55).
await rpc('Love:Save', token, { LoveId: loveId, SlotNumber: 1 });
const afterSave = await loveRouteErrorDetails();
const savedSlot1 = afterSave?.saveSlots.find((s) => s.slotNumber === 1);
check(
  'Love:Save snapshots the route in the slot',
  Array.isArray(savedSlot1?.storyEpisodeIds) &&
    JSON.stringify(savedSlot1.storyEpisodeIds) === JSON.stringify(afterEnding?.storyEpisodeIds) &&
    Array.isArray(savedSlot1?.selections) &&
    savedSlot1.selections.length === (afterEnding?.selections.length ?? -1),
  JSON.stringify(savedSlot1?.storyEpisodeIds),
);
check(
  'Love:Save stores the current episode',
  savedSlot1?.latestStoryEpisodeId === firstLoveEpisodeId,
  savedSlot1?.latestStoryEpisodeId,
);
const loveAfterEnding = (await listElements(playerId, 'Loves', db)).find(
  (l) => String(l.LoveId ?? '') === loveId,
);
const loveFavorabilityAfterEnding = Number(loveAfterEnding?.HiddenFavorability ?? 0);

// Play episode 1 down a different branch; the saved slot must not change.
await rpc('Love:Start', token, { StoryEpisodeId: firstLoveEpisodeId });
await finishLoveEpisode(firstLoveEpisodeId, [[1, 1], [2, 1]]);
const afterOtherBranch = await loveRouteErrorDetails();
check(
  'a different branch advances the route',
  JSON.stringify(afterOtherBranch?.storyEpisodeIds) ===
    JSON.stringify([firstLoveEpisodeId, paidLoveEpisodeId]),
  JSON.stringify(afterOtherBranch?.storyEpisodeIds),
);

const loveLoad = await rpc('Love:Load', token, { LoveId: loveId, SlotNumber: 1 });
check(
  'Love:Load returns the saved route',
  JSON.stringify(loveLoad.StoryEpisodeIds) === JSON.stringify(savedSlot1?.storyEpisodeIds),
  JSON.stringify(loveLoad.StoryEpisodeIds),
);
const afterLoad = await loveRouteErrorDetails();
check(
  'Love:Load restores the saved route exactly',
  JSON.stringify(afterLoad?.storyEpisodeIds) ===
    JSON.stringify(savedSlot1?.storyEpisodeIds) &&
    JSON.stringify(afterLoad?.selections) === JSON.stringify(savedSlot1?.selections),
  JSON.stringify(afterLoad?.storyEpisodeIds),
);
check(
  'Love:Load clears the active episode',
  afterLoad?.activeStoryEpisodeId === '',
  afterLoad?.activeStoryEpisodeId,
);
const loveAfterLoad = (await listElements(playerId, 'Loves', db)).find(
  (l) => String(l.LoveId ?? '') === loveId,
);
check(
  'Love:Load keeps the unlocked ending',
  Array.isArray(loveAfterLoad?.UnlockedLoveStoryEndIDs) &&
    (loveAfterLoad.UnlockedLoveStoryEndIDs as string[]).includes(
      'love-end-love-23-0514-008-happy-002',
    ),
  JSON.stringify(loveAfterLoad?.UnlockedLoveStoryEndIDs),
);
check(
  'Love:Load restores the saved favorability',
  Number(loveAfterLoad?.HiddenFavorability ?? 0) === loveFavorabilityAfterEnding,
  `${loveAfterLoad?.HiddenFavorability}/${loveFavorabilityAfterEnding}`,
);
check(
  'Love:Load keeps past selections',
  (afterSave?.pastSelections ?? []).every((past) =>
    (afterLoad?.pastSelections ?? []).some(
      (now) =>
        now.storyEpisodeId === past.storyEpisodeId &&
        now.groupIndex === past.groupIndex &&
        now.index === past.index,
    ),
  ),
  JSON.stringify(afterLoad?.pastSelections),
);
check('Love:Load clears the reading flag', !loveAfterLoad?.IsReadingStory);

// Reset rewinds only the current route; saves and endings stay
// (solis reset.go:13-41).
let loveOutOfRangeRejected = 0;
for (const SlotNumber of [0, 6]) {
  try {
    await rpc('Love:Save', token, { LoveId: loveId, SlotNumber });
  } catch {
    loveOutOfRangeRejected += 1;
  }
}
check('Love:Save rejects an out-of-range slot', loveOutOfRangeRejected === 2, loveOutOfRangeRejected);

const loveReset = await rpc('Love:Reset', token, { LoveId: loveId });
check(
  'Love:Reset returns the first episode',
  JSON.stringify(loveReset.StoryEpisodeIds) === JSON.stringify([firstLoveEpisodeId]),
  JSON.stringify(loveReset.StoryEpisodeIds),
);
const afterReset = await loveRouteErrorDetails();
check(
  'Love:Reset rewinds the route to the first episode',
  JSON.stringify(afterReset?.storyEpisodeIds) === JSON.stringify([firstLoveEpisodeId]) &&
    Array.isArray(afterReset?.selections) &&
    afterReset.selections.length === 0,
  JSON.stringify(afterReset?.storyEpisodeIds),
);
check(
  'Love:Reset clears the active episode',
  afterReset?.activeStoryEpisodeId === '',
  afterReset?.activeStoryEpisodeId,
);
check(
  'Love:Reset keeps the save slot',
  afterReset?.saveSlots.length === 1 &&
    afterReset.saveSlots[0].slotNumber === 1 &&
    JSON.stringify(afterReset.saveSlots[0].storyEpisodeIds) ===
      JSON.stringify(savedSlot1?.storyEpisodeIds),
  JSON.stringify(afterReset?.saveSlots),
);
const loveAfterReset = (await listElements(playerId, 'Loves', db)).find(
  (l) => String(l.LoveId ?? '') === loveId,
);
check(
  'Love:Reset keeps the unlocked ending',
  Array.isArray(loveAfterReset?.UnlockedLoveStoryEndIDs) &&
    (loveAfterReset.UnlockedLoveStoryEndIDs as string[]).includes(
      'love-end-love-23-0514-008-happy-002',
    ),
  JSON.stringify(loveAfterReset?.UnlockedLoveStoryEndIDs),
);
check(
  'Love:Reset keeps the favorability',
  Number(loveAfterReset?.HiddenFavorability ?? 0) === loveFavorabilityAfterEnding,
  `${loveAfterReset?.HiddenFavorability}/${loveFavorabilityAfterEnding}`,
);
check('Love:Reset clears the reading flag', !loveAfterReset?.IsReadingStory);

// A second ending must not re-unlock the save (solis finish.go:60-66).
await rpc('Love:Start', token, { StoryEpisodeId: firstLoveEpisodeId });
const secondEndingFinish = await finishLoveEpisode(firstLoveEpisodeId, [
  [1, 2],
  [2, 2],
]);
check(
  'Love:Finish unlocks the save only on the first ending',
  secondEndingFinish.StoryEndName === 'オトクオトクエンド' && !secondEndingFinish.UnlockSave,
  `${secondEndingFinish.StoryEndName}/${secondEndingFinish.UnlockSave}`,
);
const lovesAfterSecondEnding = await listElements(playerId, 'Loves', db);
const loveAfterSecondEnding = lovesAfterSecondEnding.find(
  (l) => String(l.LoveId ?? '') === loveId,
);
check(
  'Love:Finish keeps every unlocked ending',
  Array.isArray(loveAfterSecondEnding?.UnlockedLoveStoryEndIDs) &&
    (loveAfterSecondEnding.UnlockedLoveStoryEndIDs as string[]).includes(
      'love-end-love-23-0514-001-bad',
    ) &&
    (loveAfterSecondEnding.UnlockedLoveStoryEndIDs as string[]).includes(
      'love-end-love-23-0514-008-happy-002',
    ),
  JSON.stringify(loveAfterSecondEnding?.UnlockedLoveStoryEndIDs),
);

// ---------------------------------------------------------------------------
// Lobby idol switch: Home:SetCharacterPosition persists per slot type.
// ---------------------------------------------------------------------------
const lobbyChars = (await listElements(playerId, 'Characters', db)).map((c) => String(c.CharacterId ?? ''));
const lobbyIdol = lobbyChars[0] ?? '';
const setPos = await rpc('Home:SetCharacterPosition', token, {
  Positions: [
    { Type: 1, CharacterId: lobbyIdol, IsCharacterRandom: false, IsCostumeRandom: true },
    { Type: 2, IsCharacterRandom: true, IsCostumeRandom: false },
    { Type: 3, IsCharacterRandom: true, IsCostumeRandom: true },
  ],
});
const echoed = ((setPos.CommonResponse as any)?.UpdatedData?.HomePositions ?? []) as Record<string, unknown>[];
check('lobby switch echoes every slot incl. the idol slot', echoed.length === 4, echoed.length);
check('lobby switch fills every slot with an idol', echoed.every((p) => String(p.CharacterId ?? '') !== ''));
const storedPos = await listElements(playerId, 'HomePositions', db);
const homeSlot = storedPos.filter((p) => Number(p.HomePositionType) === 1);
check('lobby switch stores one row per slot', storedPos.length === new Set(storedPos.map((p) => Number(p.HomePositionType))).size, storedPos.length);
check('lobby switch stores the chosen home idol', homeSlot.length === 1 && homeSlot[0].CharacterId === lobbyIdol);
const storedIdol = storedPos.find((p) => Number(p.HomePositionType) === 4);
check('lobby switch stores a type-4 idol row', storedIdol !== undefined, storedIdol?.CharacterId);
check(
  'stored type-4 row is not random',
  !storedIdol?.IsCharacterRandom && !storedIdol?.IsCostumeRandom,
);
const echoedIdol = echoed.find((p) => Number(p.HomePositionType) === 4);
check('lobby switch echoes the stored type-4 idol', echoedIdol?.CharacterId === storedIdol?.CharacterId, echoedIdol?.CharacterId);
const posGet = await rpc('User:Get', token, {});
const servedHome = ((posGet.HomePositions ?? []) as Record<string, unknown>[]).find((p) => Number(p.HomePositionType) === 1);
check('User:Get serves the chosen home idol', servedHome?.CharacterId === lobbyIdol, servedHome);
const servedIdol = ((posGet.HomePositions ?? []) as Record<string, unknown>[]).find((p) => Number(p.HomePositionType) === 4);
check('User:Get serves a type-4 idol row', servedIdol !== undefined, servedIdol?.CharacterId);
check('User:Get serves the stored type-4 idol', servedIdol?.CharacterId === storedIdol?.CharacterId);

// Satomi in a lobby slot: slot 4 must be another owned idol that is not placed.
const stmSet = await rpc('Home:SetCharacterPosition', token, {
  Positions: [{ Type: 1, CharacterId: 'char-stm', IsCharacterRandom: false, IsCostumeRandom: false }],
});
const stmEchoed = ((stmSet.CommonResponse as any)?.UpdatedData?.HomePositions ?? []) as Record<string, unknown>[];
const stmStored = await listElements(playerId, 'HomePositions', db);
const placedChars = new Set(
  stmStored
    .filter((p) => [1, 2, 3].includes(Number(p.HomePositionType)))
    .map((p) => String(p.CharacterId ?? '')),
);
const stmIdol = stmStored.find((p) => Number(p.HomePositionType) === 4);
check('Home = Satomi moves a different idol into slot 4', stmIdol !== undefined && stmIdol.CharacterId !== 'char-stm', stmIdol?.CharacterId);
check('slot-4 idol is owned', stmIdol !== undefined && ownedCharacterIds.has(String(stmIdol.CharacterId)));
check(
  'slot-4 idol is not already placed in slots 1-3',
  stmIdol !== undefined && !placedChars.has(String(stmIdol.CharacterId)),
  [...placedChars].join(','),
);
const stmEchoedIdol = stmEchoed.find((p) => Number(p.HomePositionType) === 4);
check('SetCharacterPosition echoes the new slot-4 idol', stmEchoedIdol?.CharacterId === stmIdol?.CharacterId, stmEchoedIdol?.CharacterId);
const stmGet = await rpc('User:Get', token, {});
const stmServedIdol = ((stmGet.HomePositions ?? []) as Record<string, unknown>[]).find(
  (p) => Number(p.HomePositionType) === 4,
);
check('User:Get serves the new slot-4 idol', stmServedIdol?.CharacterId === stmIdol?.CharacterId, stmServedIdol?.CharacterId);
const stmGetAgain = await rpc('User:Get', token, {});
const stmServedIdolAgain = ((stmGetAgain.HomePositions ?? []) as Record<string, unknown>[]).find(
  (p) => Number(p.HomePositionType) === 4,
);
check(
  'the random slot-4 idol is stable across User:Get calls',
  stmServedIdolAgain?.CharacterId === stmIdol?.CharacterId,
  stmServedIdolAgain?.CharacterId,
);

// No Satomi in any lobby slot (1-3 are all non-Satomi): slot 4 is Satomi.
const nonSatomiIds = lobbyChars.filter((id) => id !== 'char-stm').slice(0, 3);
const otherSet = await rpc('Home:SetCharacterPosition', token, {
  Positions: nonSatomiIds.map((id, i) => ({
    Type: i + 1,
    CharacterId: id,
    IsCharacterRandom: false,
    IsCostumeRandom: false,
  })),
});
const otherEchoed = ((otherSet.CommonResponse as any)?.UpdatedData?.HomePositions ?? []) as Record<string, unknown>[];
const otherStored = await listElements(playerId, 'HomePositions', db);
const otherIdol = otherStored.find((p) => Number(p.HomePositionType) === 4);
check('no Satomi in slots 1-3 makes slot 4 Satomi', otherIdol?.CharacterId === 'char-stm', otherIdol?.CharacterId);
const otherEchoedIdol = otherEchoed.find((p) => Number(p.HomePositionType) === 4);
check('SetCharacterPosition echoes Satomi in slot 4', otherEchoedIdol?.CharacterId === 'char-stm', otherEchoedIdol?.CharacterId);
const otherGet = await rpc('User:Get', token, {});
const otherServedIdol = ((otherGet.HomePositions ?? []) as Record<string, unknown>[]).find(
  (p) => Number(p.HomePositionType) === 4,
);
check('User:Get serves Satomi in slot 4', otherServedIdol?.CharacterId === 'char-stm', otherServedIdol?.CharacterId);

// ---------------------------------------------------------------------------
// Home talks: reading a seeded talk succeeds and echoes the row; unknown ids
// are rejected instead of silently creating state.
// ---------------------------------------------------------------------------
const readTalkId = masterHomeTalkIds[0] ?? '';
const readTalk = await rpc('Home:ReadTalk', token, { HomeTalkId: readTalkId });
const readUpdated = ((readTalk.CommonResponse as any)?.UpdatedData?.HomeTalks ?? []) as Record<string, unknown>[];
check(
  'Home:ReadTalk echoes the read talk',
  readTalkId !== '' && readUpdated.some((row) => String(row.HomeTalkId ?? '') === readTalkId),
  readUpdated.map((row) => row.HomeTalkId).join(','),
);
check('Home:ReadTalk does not raise trust', readTalk.IsReliabilityUp !== true, readTalk.IsReliabilityUp);
check(
  'Home:ReadTalk leaves the seeded talk count unchanged',
  (await count(playerId, 'HomeTalks')) === masterHomeTalkIds.length,
);
let unknownTalkRejected = false;
try {
  await rpc('Home:ReadTalk', token, { HomeTalkId: 'home-talk-does-not-exist' });
} catch {
  unknownTalkRejected = true;
}
check('Home:ReadTalk rejects an unknown talk id', unknownTalkRejected);

// ---------------------------------------------------------------------------
// Excursion: List -> Start -> SetWatchedGazeReaction -> Finish.
// ---------------------------------------------------------------------------
const excursionCharacterId = String(excursionPlaceSettingRows[0]?.CharacterId ?? '');
const excursionPlaceIds = excursionPlaceSettingRows
  .filter((row) => String(row.CharacterId ?? '') === excursionCharacterId)
  .map((row) => String(row.ExcursionPlaceId ?? ''))
  .filter(Boolean);
check(
  'the excursion test character has places',
  excursionCharacterId !== '' && excursionPlaceIds.length > 0,
  `${excursionCharacterId}:${excursionPlaceIds.length}`,
);
const excursionList = await rpc('Excursion:List', token, { CharacterId: excursionCharacterId });
const offeredPlaces = ((excursionList.ExcursionPlaceIds ?? []) as unknown[]).map(String);
check(
  'Excursion:List offers every sandbox place',
  offeredPlaces.length === excursionPlaceIds.length,
  `${offeredPlaces.length}/${excursionPlaceIds.length}`,
);
check(
  'Excursion:List offers the master place set',
  [...offeredPlaces].sort().join(',') === [...new Set(excursionPlaceIds)].sort().join(','),
  offeredPlaces.join(','),
);

const excursionPlaceId = offeredPlaces[0] ?? '';
const excursionStart = await rpc('Excursion:Start', token, {
  CharacterId: excursionCharacterId,
  ExcursionPlaceId: excursionPlaceId,
});
check(
  'Excursion:Start returns no rewards',
  ((excursionStart.RewardResults ?? []) as unknown[]).length === 0,
  ((excursionStart.RewardResults ?? []) as unknown[]).length,
);

const excursionReactionRow =
  excursionGazeReactionRows.find(
    (row) =>
      String(row.CharacterId ?? '') === excursionCharacterId &&
      String(row.ExcursionPlaceId ?? '') === excursionPlaceId &&
      Number(row.Number) > 0,
  ) ??
  excursionGazeReactionRows.find(
    (row) =>
      String(row.CharacterId ?? '') === excursionCharacterId &&
      String(row.ExcursionPlaceId ?? '') === excursionPlaceId,
  );
const excursionReactionNumber = Number(excursionReactionRow?.Number ?? -1);
check(
  'the excursion place has a master gaze reaction',
  excursionReactionNumber >= 0,
  excursionReactionNumber,
);
const watchedReaction = await rpc('Excursion:SetWatchedGazeReaction', token, {
  CharacterId: excursionCharacterId,
  ExcursionPlaceId: excursionPlaceId,
  Number: excursionReactionNumber,
});
const watchedUpdated = ((watchedReaction.CommonResponse as any)?.UpdatedData
  ?.ExcursionGazeReactions ?? []) as Record<string, unknown>[];
check(
  'Excursion:SetWatchedGazeReaction echoes the reaction',
  watchedUpdated.some(
    (row) =>
      String(row.CharacterId ?? '') === excursionCharacterId &&
      String(row.ExcursionPlaceId ?? '') === excursionPlaceId &&
      Number(row.GazeReactionNumber ?? -1) === excursionReactionNumber,
  ),
  watchedUpdated.length,
);
check(
  'Excursion:SetWatchedGazeReaction persists the reaction',
  (await listElements(playerId, 'ExcursionGazeReactions', db)).some(
    (row) =>
      String(row.CharacterId ?? '') === excursionCharacterId &&
      String(row.ExcursionPlaceId ?? '') === excursionPlaceId &&
      Number(row.GazeReactionNumber ?? -1) === excursionReactionNumber,
  ),
);

const enjoyRows = await db.select().from(master.masterCompanyEnjoyObtainPointItemSetting);
const characterEnjoyRows = enjoyRows
  .filter(
    (row) =>
      String(row.CharacterId ?? '') === excursionCharacterId && Number(row.ObtainPoint ?? 0) > 0,
  )
  .sort(
    (a, b) =>
      Number(b.ObtainPoint ?? 0) - Number(a.ObtainPoint ?? 0) ||
      String(a.ItemId ?? '').localeCompare(String(b.ItemId ?? '')),
  );
const expectedGiftItemId = String(characterEnjoyRows[0]?.ItemId ?? '');

const excursionFinish = await rpc('Excursion:Finish', token, {
  GazeReactionNumbers: [excursionReactionNumber],
  CostumeId: 'sandbox-costume',
  HairId: 'sandbox-hair',
});
const finishRewards = ((excursionFinish.RewardResults ?? []) as Record<string, unknown>[]);
check(
  'Excursion:Finish awards one gift reward',
  finishRewards.length === 1 &&
    Number(finishRewards[0]?.IsGift ?? 0) === 1 &&
    String(finishRewards[0]?.ResourceId ?? '') === expectedGiftItemId,
  JSON.stringify(finishRewards[0] ?? null),
);

const [lastGiftRow] = await db
  .select()
  .from(playerEntities)
  .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, 'Gifts')))
  .orderBy(desc(playerEntities.ordinal))
  .limit(1);
const giftShape = msgRegistry.get('Solis.Common.Proto.Transaction.UserGift');
const lastGift =
  lastGiftRow && giftShape
    ? decodeMessage(
        giftShape,
        new Reader(Uint8Array.from(Buffer.from(lastGiftRow.blob, 'base64'))),
      )
    : null;
check(
  'Excursion:Finish posts the gift with the excursion message',
  lastGift !== null &&
    lastGift.Message === '交流のおでかけ報酬' &&
    String(lastGift.ResourceId ?? '') === expectedGiftItemId,
  lastGift?.Message,
);

const excursionListAgain = await rpc('Excursion:List', token, {
  CharacterId: excursionCharacterId,
});
check(
  'Excursion:List works again after Finish clears the active excursion',
  ((excursionListAgain.ExcursionPlaceIds ?? []) as unknown[]).length === excursionPlaceIds.length,
  ((excursionListAgain.ExcursionPlaceIds ?? []) as unknown[]).length,
);

// ---------------------------------------------------------------------------
// Official profile: no sandbox grants. PROFILE is import-time constant, so the
// official check must run in a child process with SUMIRE_PROFILE=official.
// ---------------------------------------------------------------------------
const officialUid = 'sbxtest-official-' + Date.now();
created.push({ uid: officialUid, accountId: '', serverUserId: '' });
const env = { ...process.env, SUMIRE_PROFILE: 'official' };
const probe = spawnSync(
  process.execPath,
  ['--experimental-strip-types', 'src/profiles/sandbox/official-probe.ts', officialUid],
  { cwd: process.cwd(), env, encoding: 'utf8', timeout: 120_000 },
);
const probeLine = (probe.stdout ?? '')
  .split('\n')
  .reverse()
  .find((line) => line.trim().startsWith('{') && line.includes('"profile"'));
let official: Record<string, unknown> | null = null;
try {
  official = probeLine ? JSON.parse(probeLine) : null;
} catch {
  official = null;
}
check('official child process succeeded', probe.status === 0 && official?.profile === 'official', probe.stderr?.slice(-300));
if (official && typeof official.serverUserId === 'string' && typeof official.accountId === 'string') {
  const row = created[created.length - 1];
  row.accountId = String(official.accountId);
  row.serverUserId = String(official.serverUserId);
  check('official player receives no sandbox cards', official.cards === 0, official.cards);
  check('official player receives no sandbox costumes', official.costumes === 0, official.costumes);
  check('official player receives no sandbox music', official.musics === 0, official.musics);
  check('official player receives no sandbox photo recipes', official.photoRecipes === 0, official.photoRecipes);
  check('official player receives no sandbox home talks', official.homeTalks === 0, official.homeTalks);
  check('official player is not topped up to the sandbox currency', Number(official.freeJewel) !== SANDBOX_CURRENCY, official.freeJewel);
}

// ---------------------------------------------------------------------------
// Cleanup.
// ---------------------------------------------------------------------------
for (const row of created) await removeByUid(row.uid);
const leftovers = await Promise.all(
  created.map(async (row) => {
    const [account] = await db.select().from(accounts).where(eq(accounts.firebaseUid, row.uid)).limit(1);
    return !account;
  }),
);
check('test players cleaned up', leftovers.every(Boolean));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
