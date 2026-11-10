import { randomInt } from 'node:crypto';
import type { Executor } from '../db/tx.ts';
import { listMessages, listTelephones } from '../master/index.ts';
import { ConditionEvaluator } from './conditions.ts';
import { listElements, putElements } from './playerState.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Port of Solis `viber.ReconcileNarrativeSchedules` (narrative_schedule.go).
 *
 * The reconciler is the server-authoritative unlock/schedule pass for idol
 * messages and calls: it walks the message/telephone master in order, unlocks
 * entries whose `UnlockConditionId` is now satisfied, and queues at most one
 * pending entry per (MessageGroupId, CharacterId) conversation. Solis runs it
 * from feature entry points (Home, User:Get, story reads, message/telephone
 * completion); we do the same.
 *
 * Differences from Solis, all intentional:
 * - The "god message feature" override lives on the user god-state document in
 *   Solis. There is no such document here, so it is treated as `""` (a normal
 *   user): conditional entries only, dependency unlocks honored.
 * - `NARRATIVE_DELAY_SCALE` (float, default 1, clamped to >= 0) multiplies every
 *   delay ceiling so local testing does not have to wait hours. `0` delivers
 *   everything immediately.
 * - Telephones are always left Scheduled (at least `TELEPHONE_MIN_LEAD_MS` out)
 *   instead of going straight to Received on a zero delay; see step 5.
 * - Messages whose id contains `-tutorial-` are always delivered immediately;
 *   the official fresh capture has `message-skr-tutorial-001` arrive together
 *   with the first `Home:Enter`.
 */

const STORY_MESSAGE_DELAY_MINUTES = 60;
const INSTANT_MESSAGE_DELAY_MINUTES = 12 * 60;
const TELEPHONE_DELAY_MINUTES = 18 * 60;
const MINUTE_MS = 60_000;
/** Lead time so even a zero delay schedules the call ahead of the client's clock. */
const TELEPHONE_MIN_LEAD_MS = 15_000;

const MESSAGE_UNLOCKED = 1;
const MESSAGE_SCHEDULED = 2;
const MESSAGE_RECEIVED = 3;

const TELEPHONE_UNLOCKED = 1;
const TELEPHONE_SCHEDULED = 2;
const TELEPHONE_RECEIVED = 3;

const USER_MESSAGE_MSG = 'Solis.Common.Proto.Transaction.UserMessage';
const USER_MESSAGE_SCHEDULE_MSG = 'Solis.Common.Proto.Transaction.UserMessageSchedule';
const USER_TELEPHONE_MSG = 'Solis.Common.Proto.Transaction.UserTelephone';

/** What triggered the pass; unlocks only follow the matching dependency. */
export type NarrativeUnlockKind = 'all' | 'readStory' | 'finishedMessage' | 'none';

type Row = Record<string, unknown>;
type Collection = 'Messages' | 'MessageSchedules' | 'Telephones';

/** Master tables are immutable during a process lifetime, so load them once. */
let messageMasters: Row[] | null = null;
let telephoneMasters: Row[] | null = null;

export async function masters(): Promise<{ messages: Row[]; telephones: Row[] }> {
  messageMasters ??= (await listMessages()) as unknown as Row[];
  telephoneMasters ??= (await listTelephones()) as unknown as Row[];
  return { messages: messageMasters, telephones: telephoneMasters };
}

/** Test hook: forget the cached master rows (used by dev scripts). */
export function resetNarrativeMasterCache(): void {
  messageMasters = null;
  telephoneMasters = null;
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

function scale(): number {
  const raw = Number(process.env.NARRATIVE_DELAY_SCALE ?? '1');
  if (!Number.isFinite(raw)) return 1;
  return raw < 0 ? 0 : raw;
}

/** Uniform whole-minute delay in `[0, maxMinutes]`, scaled for local testing. */
function randomNarrativeDelay(maxMinutes: number): number {
  const ceiling = Math.floor(maxMinutes * scale());
  if (ceiling <= 0) return 0;
  return randomInt(0, ceiling + 1) * MINUTE_MS;
}

/** Solis `narrativeQueueKey`: one open conversation per group, else per idol. */
function queueKey(groupId: string, characterId: string): string {
  return groupId !== '' ? `group:${groupId}` : characterId;
}

/** True when the condition (recursing `SatisfyCondition`) reads any story. */
async function conditionReadsStory(
  conditionId: string,
  evaluator: ConditionEvaluator,
  visited: Set<string>,
): Promise<boolean> {
  if (conditionId === '' || visited.has(conditionId)) return false;
  visited.add(conditionId);
  const condition = await evaluator.conditionRow(conditionId);
  if (!condition) return false;
  const settings = Array.isArray(condition.Settings) ? (condition.Settings as Row[]) : [];
  for (const setting of settings) {
    const readStory = setting.ReadStory as Row | undefined;
    if (readStory && str(readStory.StoryId) !== '') return true;
    const dependency = setting.SatisfyCondition as Row | undefined;
    if (dependency && (await conditionReadsStory(str(dependency.ConditionId), evaluator, visited))) return true;
  }
  return false;
}

/** True when the condition references `targetId` through the matching kind. */
async function conditionMatchesNarrativeDependency(
  conditionId: string,
  kind: NarrativeUnlockKind,
  targetId: string,
  evaluator: ConditionEvaluator,
  visited: Set<string>,
): Promise<boolean> {
  if (conditionId === '' || targetId === '' || visited.has(conditionId)) return false;
  visited.add(conditionId);
  const condition = await evaluator.conditionRow(conditionId);
  if (!condition) return false;
  const settings = Array.isArray(condition.Settings) ? (condition.Settings as Row[]) : [];
  for (const setting of settings) {
    if (kind === 'readStory' && str((setting.ReadStory as Row | undefined)?.StoryId) === targetId) return true;
    if (kind === 'finishedMessage' && str((setting.FinishedMessage as Row | undefined)?.MessageId) === targetId) {
      return true;
    }
    const dependency = setting.SatisfyCondition as Row | undefined;
    if (
      dependency &&
      (await conditionMatchesNarrativeDependency(str(dependency.ConditionId), kind, targetId, evaluator, visited))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Solis `narrativeConditionEligible`: whether this pass may unlock the entry.
 * Unconditional entries are introduced by their owning game feature, so they
 * are never unlocked by the dependency-driven reconciler.
 */
async function narrativeConditionEligible(
  kind: NarrativeUnlockKind,
  conditionId: string,
  unlockId: string,
  evaluator: ConditionEvaluator,
): Promise<boolean> {
  if (kind === 'none' || conditionId === '') return false;
  if (kind === 'all') return true;
  return conditionMatchesNarrativeDependency(conditionId, kind, unlockId, evaluator, new Set());
}

/** Replace or append `element` in `updated[collection]`, like Solis `putUpdated*`. */
function putUpdated(
  updated: Decoded,
  collection: Collection,
  idField: string,
  id: string,
  element: Decoded,
): void {
  const list = Array.isArray(updated[collection]) ? (updated[collection] as Decoded[]) : [];
  const index = list.findIndex((entry) => str(entry[idField]) === id);
  if (index >= 0) list[index] = element;
  else list.push(element);
  updated[collection] = list as unknown as Decoded;
}

/**
 * Unlock and schedule every eligible message/telephone for `playerId`, writing
 * the changed entries into `updated` (the caller's `UpdatedData`).
 */
export async function reconcileNarrative(
  playerId: string,
  now: number,
  updated: Decoded,
  kind: NarrativeUnlockKind,
  unlockId: string,
  exec: Executor,
): Promise<void> {
  const { messages, telephones } = await masters();

  const evaluator = new ConditionEvaluator(playerId, now, exec);
  const conditionIds: string[] = [];
  for (const master of messages) conditionIds.push(str(master.UnlockConditionId));
  for (const master of telephones) conditionIds.push(str(master.UnlockConditionId));
  await evaluator.prime(conditionIds);

  const userMessages = await listElements(playerId, 'Messages', exec);
  const schedules = await listElements(playerId, 'MessageSchedules', exec);
  const userTelephones = await listElements(playerId, 'Telephones', exec);

  const messagesById = new Map<string, Decoded>();
  for (const message of userMessages) messagesById.set(str(message.MessageId), message);
  const schedulesById = new Map<string, Decoded>();
  for (const schedule of schedules) schedulesById.set(str(schedule.MessageId), schedule);
  const changedMessages = new Set<string>();
  const changedSchedules = new Set<string>();

  // 1. Unlock newly satisfied messages.
  for (const master of messages) {
    const messageId = str(master.Id);
    if (messagesById.has(messageId)) continue;
    if (!(await narrativeConditionEligible(kind, str(master.UnlockConditionId), unlockId, evaluator))) continue;
    if (!(await evaluator.satisfied(str(master.UnlockConditionId)))) continue;
    const message = { __msg: USER_MESSAGE_MSG, MessageId: messageId, MessageStatusType: MESSAGE_UNLOCKED } as Decoded;
    messagesById.set(messageId, message);
    changedMessages.add(messageId);
  }

  // 2. Every unlocked message owns a schedule row, even before it is queued.
  for (const master of messages) {
    const messageId = str(master.Id);
    const message = messagesById.get(messageId);
    if (!message || num(message.MessageStatusType) !== MESSAGE_UNLOCKED) continue;
    if (!schedulesById.has(messageId)) {
      schedulesById.set(messageId, { __msg: USER_MESSAGE_SCHEDULE_MSG, MessageId: messageId } as Decoded);
      changedSchedules.add(messageId);
    }
  }

  // 3. Queue at most one message per conversation.
  const activeMessageQueues = new Set<string>();
  const messageMasterById = new Map<string, Row>();
  for (const master of messages) messageMasterById.set(str(master.Id), master);
  for (const message of messagesById.values()) {
    const status = num(message.MessageStatusType);
    if (status !== MESSAGE_SCHEDULED && status !== MESSAGE_RECEIVED) continue;
    const master = messageMasterById.get(str(message.MessageId));
    if (master) activeMessageQueues.add(queueKey(str(master.MessageGroupId), str(master.CharacterId)));
  }
  for (const master of messages) {
    const messageId = str(master.Id);
    const message = messagesById.get(messageId);
    if (!message || num(message.MessageStatusType) !== MESSAGE_UNLOCKED) continue;
    const key = queueKey(str(master.MessageGroupId), str(master.CharacterId));
    if (activeMessageQueues.has(key)) continue;
    const limit = (await conditionReadsStory(str(master.UnlockConditionId), evaluator, new Set()))
      ? STORY_MESSAGE_DELAY_MINUTES
      : INSTANT_MESSAGE_DELAY_MINUTES;
    // Tutorial messages must arrive with the opening home screen.
    const delay = messageId.includes('-tutorial-') ? 0 : randomNarrativeDelay(limit);
    const schedule = schedulesById.get(messageId);
    if (!schedule) continue;
    schedule.ScheduledTime = now + delay;
    message.MessageStatusType = MESSAGE_SCHEDULED;
    if (delay === 0) {
      message.MessageStatusType = MESSAGE_RECEIVED;
      message.ArrivedTime = now;
    }
    changedMessages.add(messageId);
    changedSchedules.add(messageId);
    activeMessageQueues.add(key);
  }

  // 4. Persist messages then schedules in master order (deterministic writes).
  const changedMessageRows: Decoded[] = [];
  for (const master of messages) {
    const messageId = str(master.Id);
    if (!changedMessages.has(messageId)) continue;
    const message = messagesById.get(messageId);
    if (!message) continue;
    changedMessageRows.push(message);
    putUpdated(updated, 'Messages', 'MessageId', messageId, message);
  }
  await putElements(playerId, 'Messages', changedMessageRows, exec);

  const changedScheduleRows: Decoded[] = [];
  for (const master of messages) {
    const messageId = str(master.Id);
    if (!changedSchedules.has(messageId)) continue;
    const schedule = schedulesById.get(messageId);
    if (!schedule) continue;
    changedScheduleRows.push(schedule);
    putUpdated(updated, 'MessageSchedules', 'MessageId', messageId, schedule);
  }
  await putElements(playerId, 'MessageSchedules', changedScheduleRows, exec);

  // 5. Standalone telephones (those not embedded in a message path).
  const embeddedTelephoneIds = new Set<string>();
  for (const master of messages) {
    const details = Array.isArray(master.Details) ? (master.Details as Row[]) : [];
    for (const detail of details) {
      const telephoneId = str(detail.TelephoneId);
      if (telephoneId !== '') embeddedTelephoneIds.add(telephoneId);
    }
  }

  const telephonesById = new Map<string, Decoded>();
  for (const telephone of userTelephones) telephonesById.set(str(telephone.TelephoneId), telephone);
  const changedTelephones = new Set<string>();

  for (const master of telephones) {
    const telephoneId = str(master.Id);
    if (telephonesById.has(telephoneId) || embeddedTelephoneIds.has(telephoneId)) continue;
    if (!(await narrativeConditionEligible(kind, str(master.UnlockConditionId), unlockId, evaluator))) continue;
    if (!(await evaluator.satisfied(str(master.UnlockConditionId)))) continue;
    const telephone = {
      __msg: USER_TELEPHONE_MSG,
      TelephoneId: telephoneId,
      UnlockedTime: now,
      TelephoneStatusType: TELEPHONE_UNLOCKED,
    } as Decoded;
    telephonesById.set(telephoneId, telephone);
    changedTelephones.add(telephoneId);
  }

  const telephoneMasterById = new Map<string, Row>();
  for (const master of telephones) telephoneMasterById.set(str(master.Id), master);
  const activeTelephoneQueues = new Set<string>();
  for (const telephone of telephonesById.values()) {
    const status = num(telephone.TelephoneStatusType);
    if (status !== TELEPHONE_SCHEDULED && status !== TELEPHONE_RECEIVED) continue;
    const master = telephoneMasterById.get(str(telephone.TelephoneId));
    if (master) activeTelephoneQueues.add(queueKey(str(master.MessageGroupId), str(master.CharacterId)));
  }
  for (const master of telephones) {
    const telephoneId = str(master.Id);
    const telephone = telephonesById.get(telephoneId);
    if (!telephone || num(telephone.TelephoneStatusType) !== TELEPHONE_UNLOCKED) continue;
    if (embeddedTelephoneIds.has(telephoneId)) continue;
    const key = queueKey(str(master.MessageGroupId), str(master.CharacterId));
    if (activeTelephoneQueues.has(key)) continue;
    // Unlike Solis, a call never jumps straight to Received: the client rings
    // only for a Scheduled call whose time comes while it is open, then sends
    // Telephone:Receive. A Received call shows up as already missed.
    const delay = Math.max(randomNarrativeDelay(TELEPHONE_DELAY_MINUTES), TELEPHONE_MIN_LEAD_MS);
    telephone.ScheduledTime = now + delay;
    telephone.TelephoneStatusType = TELEPHONE_SCHEDULED;
    changedTelephones.add(telephoneId);
    activeTelephoneQueues.add(key);
  }

  const changedTelephoneRows: Decoded[] = [];
  for (const master of telephones) {
    const telephoneId = str(master.Id);
    if (!changedTelephones.has(telephoneId)) continue;
    const telephone = telephonesById.get(telephoneId);
    if (!telephone) continue;
    changedTelephoneRows.push(telephone);
    putUpdated(updated, 'Telephones', 'TelephoneId', telephoneId, telephone);
  }
  await putElements(playerId, 'Telephones', changedTelephoneRows, exec);
}
