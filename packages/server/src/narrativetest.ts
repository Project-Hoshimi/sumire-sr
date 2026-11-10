// Narrative reconciler + pending-notifications tests (port of the "Slice 21:
// idol messages & calls" section of `src/dbtest.ts` on the narrative stack,
// commits 0ae7d9e and 3352454).
//
// Run with `npm run test:narrative` against a database with master data seeded
// and the capture corpus available ($DATABASE_URL + $SUMIRE_DATA_DIR/captures).

import { and, eq, inArray } from 'drizzle-orm';
import { requireData } from './testing/requireData.ts';
import { decodeMessage, encodeMessage, msgRegistry, Reader, Writer } from '@sumire-sr/protocol/runtime/proto.ts';
import '@sumire-sr/protocol/gen/registry.ts';
import { endpoints } from '@sumire-sr/protocol/gen/endpoints.ts';
import { db } from './db/client.ts';
import { accounts, players, playerEntities, playerLessonProgress } from './db/schema.ts';
import { mintToken } from './auth/jwt.ts';
import { getCorpusResponse } from './services/replay/corpus.ts';
import {
  listElements,
  loadOrSeed,
  putElements,
  removeElements,
} from './services/playerState.ts';
import { ConditionEvaluator } from './services/conditions.ts';
import { dispatchRpc } from './services/router.ts';
import { buildServer } from './server.ts';
import './services/all.ts';

const { listPendingNarrative } = await import('./services/narrativePending.ts');
const { masters: narrativeMasters } = await import('./services/narrative.ts');

await requireData({ captures: true, db: true });

// The reconciler runs on every User:Get; scale 0 delivers the whole unlock
// queue immediately so this test can drive the read/finish flow.
process.env.NARRATIVE_DELAY_SCALE = '0';

// Dedicated test account. Seeded state is wiped deterministically so repeated
// runs start from the same captured corpus.
const TEST_ACCOUNT_ID = 'narrativetest-account-0000-4000-8000-0000000001';
const TEST_UID = 'narrativetest-firebase-uid-0001';
const SERVER_USER_ID = 'narrativetest-user-0000-4000-8000-0000000001';
const TEST_PUBLIC_USER_ID = 'NARRATIVETEST';

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
check('narrative: corpus carries a User:Get template', templateBytes !== null);
const templateShape = msgRegistry.get('Solis.Common.Proto.Api.UserGetResponse');
if (!templateBytes || !templateShape) {
  console.log(`\nnarrative test: ${pass} passed, ${fail} failed`);
  await (await import('./db/client.ts')).client.end({ timeout: 5 });
  process.exit(fail ? 1 : 0);
}
const seedTemplate = decodeMessage(templateShape, new Reader(Uint8Array.from(templateBytes)));
await loadOrSeed(SERVER_USER_ID, seedTemplate);

const narrativeToken = mintToken({ sub: TEST_ACCOUNT_ID, seedId: TEST_PUBLIC_USER_ID });
const auth = {
  headers: { 'x-auth-token': narrativeToken },
  log: { info() {}, warn() {} },
} as any;

const rpc = async (name: string, body: Record<string, unknown> | null = null) => {
  const [svc, method] = name.split(':');
  const endpoint = (endpoints as any)[svc]?.[method];
  if (!endpoint) throw new Error(`no endpoint ${name}`);
  const requestShape = endpoint.request ? msgRegistry.get(endpoint.request) : null;
  let plain = Buffer.alloc(0);
  if (requestShape && body !== null) {
    const writer = new Writer();
    encodeMessage(requestShape, body as any, writer);
    plain = Buffer.from(writer.toBytes());
  }
  const bytes = await dispatchRpc(name, plain, auth);
  return decodeMessage(msgRegistry.get(endpoint.response)!, new Reader(Uint8Array.from(bytes))) as any;
};

const userGet = () => rpc('User:Get', null);

// --- Narrative reconciler (User:Get entry point) ---

await db.delete(playerEntities).where(
  and(
    eq(playerEntities.playerId, SERVER_USER_ID),
    inArray(playerEntities.kind, ['Messages', 'MessageSchedules', 'Telephones', 'MessageProgress']),
  ),
);

const levelEvaluator = new ConditionEvaluator(SERVER_USER_ID, Date.now());
check(
  'Message: manager level condition is satisfied at Lv40',
  await levelEvaluator.satisfied('cd-manager_level_gte-1'),
);

await putElements(SERVER_USER_ID, 'Stories', [
  {
    __msg: 'Solis.Common.Proto.Transaction.UserStory',
    StoryId: 'st-card-ai-05-arab-00-03',
    StatusType: 2,
  },
]);
const readEvaluator = new ConditionEvaluator(SERVER_USER_ID, Date.now());
check(
  'Message: read story condition unlocks the message',
  await readEvaluator.satisfied('cd-st-read-st-card-ai-05-arab-00-03'),
);
check(
  'Message: unfinished message condition stays locked',
  !(await readEvaluator.satisfied('cd-ms-read-message-card-ai-05-arab-00')),
);

const mu = await userGet();
const arrived = (mu.Messages ?? []) as any[];
const muSchedules = (mu.MessageSchedules ?? []) as any[];
check('Message: User:Get carries arrived messages', arrived.length > 0);
const scheduledIds = new Set(muSchedules.map((s) => String(s.MessageId)));
check(
  'Message: every arrived message owns a schedule',
  arrived.every(
    (m) => ![2, 3].includes(Number(m.MessageStatusType)) || scheduledIds.has(String(m.MessageId)),
  ),
);

const { messages: masterMessages, telephones: masterTelephones } = await narrativeMasters();
const groupOf = new Map<string, string>(
  masterMessages.map((m: any): [string, string] => [String(m.Id), String(m.MessageGroupId)]),
);
const activePerGroup = new Map<string, number>();
for (const message of arrived) {
  const status = Number(message.MessageStatusType);
  if (status !== 2 && status !== 3) continue;
  const messageGroupId = groupOf.get(String(message.MessageId)) ?? '';
  activePerGroup.set(messageGroupId, (activePerGroup.get(messageGroupId) ?? 0) + 1);
}
check(
  'Message: at most one arrived message per group',
  [...activePerGroup.values()].every((count) => count <= 1),
);

const target = arrived.find((m) => Number(m.MessageStatusType) === 3);
check('Message: an arrived message is available for the read flow', target !== undefined);
if (target) {
  const targetId = String(target.MessageId);
  const targetMaster = masterMessages.find((m: any) => String(m.Id) === targetId) as any;
  const targetGroupId = String(targetMaster?.MessageGroupId ?? '');
  const details = (Array.isArray(targetMaster?.Details) ? targetMaster.Details : []) as any[];
  const detailById = new Map<string, any>(details.map((d) => [String(d.MessageDetailId), d]));
  const pointedTo = new Set<string>();
  for (const detail of details) {
    for (const next of (detail.NextMessageDetailIds ?? []) as any[]) pointedTo.add(String(next));
  }
  const rootId = details.map((d) => String(d.MessageDetailId)).find((id) => !pointedTo.has(id)) ?? '';
  const path: any[] = [];
  for (let currentId = rootId; currentId !== ''; ) {
    const detail = detailById.get(currentId);
    if (!detail) break;
    path.push(detail);
    const nextIds = (detail.NextMessageDetailIds ?? []) as any[];
    currentId = nextIds.length > 0 ? String(nextIds[0]) : '';
  }
  const selections = path
    .slice(1)
    .filter((d) => String(d.ChoiceText ?? '') !== '')
    .map((d) => String(d.MessageDetailId));
  const firstChoiceIndex = path.findIndex((d) => String(d.ChoiceText ?? '') !== '');
  const terminal = path[path.length - 1] as any;
  const terminalReliability = Number(terminal?.Reliability ?? 0);
  const reliabilityCharacterId =
    String(terminal?.CharacterId ?? '') || String(targetMaster?.CharacterId ?? '');
  check('Message: master detail graph walks to a terminal', path.length > 0 && !!terminal);

  const listGroup = await rpc('Message:ListGroup', null);
  check(
    'Message:ListGroup reports the target group',
    ((listGroup.Infos ?? []) as any[]).some((info) => String(info.MessageGroupId) === targetGroupId),
  );

  const timeline = await rpc('Message:Timeline', { MessageGroupId: targetGroupId });
  const timelineInfos = (timeline.Infos ?? []) as any[];
  const targetInfo = timelineInfos.find((info) => String(info.MessageId) === targetId);
  check('Message:Timeline contains the target message', targetInfo !== undefined);
  check('Message:Timeline HasNext is falsy', !timeline.HasNext);
  const timelineIds = timelineInfos.map((info) => BigInt(String(info.TimelineId ?? 0)));
  check(
    'Message:Timeline is ordered newest first',
    timelineIds.every((id, index) => index === 0 || timelineIds[index - 1] >= id),
  );
  check(
    'Message:Timeline encodes ArrivedTime in its TimelineId',
    targetInfo !== undefined &&
      BigInt(String(targetInfo.TimelineId ?? 0)) / 1_000_000n === BigInt(String(targetInfo.ArrivedTime ?? 0)),
  );
  const timelineId = String(targetInfo?.TimelineId ?? 0);

  if (targetInfo) {
    if (firstChoiceIndex >= 0) {
      const choiceId = String(path[firstChoiceIndex].MessageDetailId);
      await rpc('Message:Save', {
        MessageGroupId: targetGroupId,
        TimelineId: timelineId,
        MessageDetailId: choiceId,
        SelectMessageDetailIds: [choiceId],
      });
      const savedTarget = (await listElements(SERVER_USER_ID, 'Messages')).find(
        (m) => String(m.MessageId) === targetId,
      ) as any;
      check(
        'Message:Save records the chosen reply',
        Number(savedTarget?.MessageStatusType) === 3 &&
          ((savedTarget?.SelectMessageDetailIds ?? []) as any[]).map(String).includes(choiceId),
      );
      const advanced = await rpc('Message:Timeline', {
        MessageGroupId: targetGroupId,
        TimelineId: BigInt(timelineId) + 1n,
      });
      const advancedInfo = ((advanced.Infos ?? []) as any[]).find(
        (info) => String(info.MessageId) === targetId,
      );
      check(
        'Message:Save advances the saved detail',
        String(advancedInfo?.LastMessageDetailId ?? '') === choiceId,
      );
      let rewindRejected = false;
      try {
        await rpc('Message:Save', {
          MessageGroupId: targetGroupId,
          TimelineId: timelineId,
          MessageDetailId: rootId,
          SelectMessageDetailIds: [],
        });
      } catch {
        rewindRejected = true;
      }
      check('Message:Save rejects rewinding to the root', rewindRejected);
    }

    const charactersBefore = await listElements(SERVER_USER_ID, 'Characters');
    const reliabilityMember = charactersBefore.find(
      (c) => String(c.CharacterId) === reliabilityCharacterId,
    ) as any;
    const reliabilityBefore = Number(reliabilityMember?.Reliability ?? 0);

    const finishReq = {
      MessageGroupId: targetGroupId,
      TimelineId: timelineId,
      SelectMessageDetailIds: selections,
    };
    const finish = await rpc('Message:Finish', finishReq);
    const finishUpdated = finish.CommonResponse?.UpdatedData ?? {};
    const finishDeleted = finish.CommonResponse?.DeletedData ?? {};
    check(
      'Message:Finish marks the message finished',
      ((finishUpdated.Messages ?? []) as any[]).some(
        (m) => String(m.MessageId) === targetId && Number(m.MessageStatusType) === 4,
      ),
    );
    check(
      'Message:Finish reports the removed schedule',
      ((finishDeleted.MessageSchedules ?? []) as any[]).some((s) => String(s.MessageId) === targetId),
    );
    check(
      'Message:Finish reports reliability from the terminal detail',
      !!finish.IsReliabilityUp === terminalReliability > 0,
    );
    const reliabilityAfter = Number(
      ((await listElements(SERVER_USER_ID, 'Characters')).find(
        (c) => String(c.CharacterId) === reliabilityCharacterId,
      ) as any)?.Reliability ?? 0,
    );
    check(
      'Message:Finish raises reliability by the terminal amount',
      terminalReliability > 0
        ? reliabilityAfter === reliabilityBefore + terminalReliability
        : reliabilityAfter === reliabilityBefore,
    );

    const finishAgain = await rpc('Message:Finish', finishReq);
    check(
      'Message:Finish repeat is idempotent',
      ((finishAgain.CommonResponse?.UpdatedData?.Messages ?? []) as any[]).length === 0,
    );

    let badFinishRejected = false;
    try {
      await rpc('Message:Finish', {
        MessageGroupId: targetGroupId,
        TimelineId: 123,
        SelectMessageDetailIds: selections,
      });
    } catch {
      badFinishRejected = true;
    }
    check('Message:Finish rejects an unknown timeline', badFinishRejected);

    const history = await rpc('Message:SaveHistory', {
      MessageId: targetId,
      SelectMessageDetailIds: selections,
    });
    const historyIds = (
      (history.CommonResponse?.UpdatedData?.Messages?.[0]?.SelectMessageDetailIds ?? []) as any[]
    ).map(String);
    check(
      'Message:SaveHistory keeps the chosen replies sorted',
      historyIds.every((id, index) => index === 0 || historyIds[index - 1] <= id) &&
        selections.every((id) => historyIds.includes(id)),
    );
  }
}

// --- Standalone telephones (not embedded in a message detail graph) ---

const embeddedTelephoneIds = new Set<string>();
for (const messageMaster of masterMessages) {
  for (const detail of (messageMaster.Details ?? []) as any[]) {
    const detailTelephoneId = String(detail.TelephoneId ?? '');
    if (detailTelephoneId !== '') embeddedTelephoneIds.add(detailTelephoneId);
  }
}
const standalone = masterTelephones.find((t: any) => !embeddedTelephoneIds.has(String(t.Id)));
check('Telephone: a standalone master call exists', standalone !== undefined);
const standaloneTelephoneId = String((standalone as any)?.Id ?? '');
const telephoneNow = Date.now();
await putElements(SERVER_USER_ID, 'Telephones', [
  {
    __msg: 'Solis.Common.Proto.Transaction.UserTelephone',
    TelephoneId: standaloneTelephoneId,
    UnlockedTime: telephoneNow - 60_000,
    ScheduledTime: telephoneNow - 1_000,
    TelephoneStatusType: 2,
  },
]);
let callHistoryRejected = false;
try {
  await rpc('Telephone:CallHistory', { TelephoneId: standaloneTelephoneId });
} catch {
  callHistoryRejected = true;
}
check('Telephone:CallHistory hides an unfinished call', callHistoryRejected);
const receive = await rpc('Telephone:Receive', { TelephoneIds: [standaloneTelephoneId] });
check(
  'Telephone:Receive marks the call received',
  ((receive.CommonResponse?.UpdatedData?.Telephones ?? []) as any[]).some(
    (t) => String(t.TelephoneId) === standaloneTelephoneId && Number(t.TelephoneStatusType) === 3,
  ),
);
const telFinishes = await rpc('Telephone:Finishes', { TelephoneIds: [standaloneTelephoneId] });
check(
  'Telephone:Finishes marks the call finished',
  ((telFinishes.CommonResponse?.UpdatedData?.Telephones ?? []) as any[]).some(
    (t) => String(t.TelephoneId) === standaloneTelephoneId && Number(t.TelephoneStatusType) === 4,
  ),
);
check('Telephone:Finishes reports no reliability gain', !telFinishes.IsReliabilityUp);
let callHistoryOk = true;
try {
  await rpc('Telephone:CallHistory', { TelephoneId: standaloneTelephoneId });
} catch {
  callHistoryOk = false;
}
check('Telephone:CallHistory is available after the call', callHistoryOk);
let unknownReceiveRejected = false;
try {
  await rpc('Telephone:Receive', { TelephoneIds: ['tel-does-not-exist'] });
} catch {
  unknownReceiveRejected = true;
}
check('Telephone:Receive rejects an unknown call', unknownReceiveRejected);

const narrativeMessages = await listElements(SERVER_USER_ID, 'Messages');
check(
  'Narrative: tutorial message unlocked by manager level',
  narrativeMessages.some((m) => String(m.MessageId) === 'message-skr-tutorial-001'),
);

// --- /mod/narrative/pending: the mod schedules local notifications from this list ---

const app = buildServer();
await app.listen({ port: 18098, host: '127.0.0.1' });

const pendingMessages = (masterMessages as any[]).filter((m) => m.CharacterId);
const pendingFuture = pendingMessages[0];
const pendingPast = pendingMessages[1];
const pendingIds = [String(pendingFuture.Id), String(pendingPast.Id)];
const savedMessages = (await listElements(SERVER_USER_ID, 'Messages')).filter((m) =>
  pendingIds.includes(String(m.MessageId)),
);
const savedSchedules = (await listElements(SERVER_USER_ID, 'MessageSchedules')).filter((s) =>
  pendingIds.includes(String(s.MessageId)),
);
const pendingNow = Date.now();
await putElements(
  SERVER_USER_ID,
  'Messages',
  pendingIds.map((id) => ({
    __msg: 'Solis.Common.Proto.Transaction.UserMessage',
    MessageId: id,
    MessageStatusType: 2,
  })),
);
await putElements(SERVER_USER_ID, 'MessageSchedules', [
  {
    __msg: 'Solis.Common.Proto.Transaction.UserMessageSchedule',
    MessageId: pendingIds[0],
    ScheduledTime: pendingNow + 600_000,
  },
  {
    __msg: 'Solis.Common.Proto.Transaction.UserMessageSchedule',
    MessageId: pendingIds[1],
    ScheduledTime: pendingNow - 1_000,
  },
]);
await putElements(SERVER_USER_ID, 'Telephones', [
  {
    __msg: 'Solis.Common.Proto.Transaction.UserTelephone',
    TelephoneId: standaloneTelephoneId,
    UnlockedTime: pendingNow - 60_000,
    ScheduledTime: pendingNow + 300_000,
    TelephoneStatusType: 2,
  },
]);
const pendingNoAuth = await fetch('http://127.0.0.1:18098/mod/narrative/pending');
check('Narrative pending: 401 without a token', pendingNoAuth.status === 401);
const pendingResp = await fetch('http://127.0.0.1:18098/mod/narrative/pending', {
  headers: { 'x-auth-token': narrativeToken },
});
check('Narrative pending: 200 with the game token', pendingResp.status === 200);
const pendingBody = (await pendingResp.json()) as { serverTime: number; items: any[] };
const pendingMsgIdx = pendingBody.items.findIndex(
  (i) => i.kind === 'message' && i.id === pendingIds[0],
);
const pendingTelIdx = pendingBody.items.findIndex(
  (i) => i.kind === 'telephone' && i.id === standaloneTelephoneId,
);
check(
  'Narrative pending: future scheduled message listed with a character name',
  pendingMsgIdx >= 0 &&
    pendingBody.items[pendingMsgIdx].characterName !== '' &&
    pendingBody.items[pendingMsgIdx].dueAt === pendingNow + 600_000,
);
check('Narrative pending: scheduled call listed', pendingTelIdx >= 0);
check('Narrative pending: sorted by due time', pendingTelIdx >= 0 && pendingTelIdx < pendingMsgIdx);
check(
  'Narrative pending: overdue message not listed',
  !pendingBody.items.some((i) => i.id === pendingIds[1]),
);
check(
  'Narrative pending: every item is due after serverTime',
  pendingBody.items.every((i) => i.dueAt > pendingBody.serverTime),
);
const pendingDirect = await listPendingNarrative(SERVER_USER_ID, Date.now());
check(
  'Narrative pending: service matches the route',
  pendingDirect.map((i) => i.id).join() === pendingBody.items.map((i) => i.id).join(),
);
await removeElements(
  SERVER_USER_ID,
  'Messages',
  pendingIds.map((id) => ({ MessageId: id })),
);
await removeElements(
  SERVER_USER_ID,
  'MessageSchedules',
  pendingIds.map((id) => ({ MessageId: id })),
);
if (savedMessages.length) await putElements(SERVER_USER_ID, 'Messages', savedMessages);
if (savedSchedules.length) await putElements(SERVER_USER_ID, 'MessageSchedules', savedSchedules);
await putElements(SERVER_USER_ID, 'Telephones', [
  {
    __msg: 'Solis.Common.Proto.Transaction.UserTelephone',
    TelephoneId: standaloneTelephoneId,
    UnlockedTime: pendingNow - 60_000,
    ScheduledTime: pendingNow - 1_000,
    TelephoneStatusType: 4,
  },
]);

delete process.env.NARRATIVE_DELAY_SCALE;

console.log(`\nnarrative test: ${pass} passed, ${fail} failed`);
await app.close();
await (await import('./db/client.ts')).client.end({ timeout: 5 });
process.exit(fail ? 1 : 0);
