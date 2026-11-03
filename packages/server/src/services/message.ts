// Ported from solis-server (AGPL-3.0), internal/server/rpc/servers/message/.
import { register, type RpcContext } from './handlers.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { getMessage, getTelephone, listMessages } from '../master/index.ts';
import {
  findPlayerByAccountId,
  getSingleton,
  listElements,
  putElements,
  putSingleton,
  removeElements,
} from './playerState.ts';
import {
  existingHistoryPath,
  mergeSortedStrings,
  resolveMessageDetails,
  terminalMessageDetailId,
  validateMessageProgressExtension,
  type MessageMaster,
} from './messagePath.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * In-game messages (chat threads) and the telephone calls embedded in their
 * detail graphs.
 *
 * `UserMessage`/`UserTelephone` live in the generic `player_entities` store
 * through `playerState.ts`. Solis keeps a separate server-only
 * `UserMessageProgress` collection; here it is a JSON singleton under the
 * `MessageProgress` kind, keyed by message id, which the client payload builder
 * ignores because the field is not part of `UserGetResponse`.
 */

const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';
const TIMELINE_INFO_MSG = 'Solis.Common.Proto.Api.TimelineInfo';
const MESSAGE_GROUP_INFO_MSG = 'Solis.Common.Proto.Api.MessageGroupInfo';
const USER_MESSAGE_SCHEDULE_MSG = 'Solis.Common.Proto.Transaction.UserMessageSchedule';

const MESSAGE_STATUS_RECEIVED = 3;
const MESSAGE_STATUS_FINISHED = 4;
const TELEPHONE_STATUS_FINISHED = 4;
const MESSAGE_TIMELINE_PAGE_SIZE = 30;

const MESSAGE_PROGRESS_FIELD = 'MessageProgress';

type MessageProgressEntry = {
  LastMessageDetailId?: string;
  LastMessageDetailTime?: number;
};

type MessageProgress = Record<string, MessageProgressEntry>;

type MessageTimelineState = {
  infos: Decoded[];
  usersById: Map<string, Decoded>;
  masters: Map<string, MessageMaster>;
};

function accountOf(ctx: RpcContext): string {
  const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
  if (!accountId) throw new Error(`${ctx.name}: unauthenticated`);
  return accountId;
}

async function playerForAccount(accountId: string, rpc: string) {
  const pl = await findPlayerByAccountId(accountId);
  if (!pl) throw new Error(`${rpc}: no player for account`);
  return pl;
}

function commonResponse(updated: Decoded | null, deleted: Decoded | null = null): Decoded {
  return {
    __msg: COMMON_RESPONSE_MSG,
    UpdatedData: (updated ?? { __msg: UPDATED_DATA_MSG }) as Decoded,
    DeletedData: (deleted ?? { __msg: DELETED_DATA_MSG }) as Decoded,
  } as Decoded;
}

function updatedData(): Decoded {
  return { __msg: UPDATED_DATA_MSG } as Decoded;
}

function messageMaster(row: unknown): MessageMaster {
  return row as unknown as MessageMaster;
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function detailIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

async function loadMessageProgress(
  playerId: string,
  exec: Executor,
): Promise<MessageProgress> {
  const raw = await getSingleton(playerId, MESSAGE_PROGRESS_FIELD, exec);
  const progress: MessageProgress = {};
  if (!raw) return progress;
  for (const [messageId, value] of Object.entries(raw)) {
    if (messageId === '__msg' || messageId === '__unknown') continue;
    if (!value || typeof value !== 'object') continue;
    const entry = value as MessageProgressEntry;
    progress[messageId] = {
      LastMessageDetailId: String(entry.LastMessageDetailId ?? ''),
      LastMessageDetailTime: Number(entry.LastMessageDetailTime ?? 0),
    };
  }
  return progress;
}

async function saveMessageProgress(
  playerId: string,
  progress: MessageProgress,
  exec: Executor,
): Promise<void> {
  await putSingleton(playerId, MESSAGE_PROGRESS_FIELD, progress as Decoded, exec);
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function messageTimelineId(message: Decoded): bigint {
  const base = BigInt(Number(message.ArrivedTime ?? 0)) * 1_000_000n;
  const hash = BigInt(fnv1a32(String(message.MessageId ?? '')) % 1_000_000);
  return base + hash;
}

function uniqueMessageTimelineId(message: Decoded, used: Set<string>): bigint {
  const base = BigInt(Number(message.ArrivedTime ?? 0)) * 1_000_000n;
  let candidate = messageTimelineId(message);
  while (used.has(candidate.toString())) {
    const suffix = (candidate - base + 1n) % 1_000_000n;
    candidate = base + suffix;
  }
  return candidate;
}

/** Build the client timeline view, mirroring Solis `loadMessageTimelineState`. */
async function loadMessageTimelineState(
  playerId: string,
  exec: Executor,
): Promise<MessageTimelineState> {
  const now = Date.now();
  const userMessages = await listElements(playerId, 'Messages', exec);
  const masters = new Map<string, MessageMaster>();
  for (const row of await listMessages()) {
    const master = messageMaster(row);
    const id = String(master.Id ?? '');
    if (id) masters.set(id, master);
  }
  const progressByMessage = await loadMessageProgress(playerId, exec);

  userMessages.sort((left, right) => {
    const a = String(left.MessageId ?? '');
    const b = String(right.MessageId ?? '');
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const infos: Decoded[] = [];
  const usersById = new Map<string, Decoded>();
  const usedTimelineIds = new Set<string>();

  for (const message of userMessages) {
    const messageId = String(message.MessageId ?? '');
    const master = masters.get(messageId);
    const status = Number(message.MessageStatusType ?? 0);
    if (!master || status < MESSAGE_STATUS_RECEIVED) continue;
    const arrivedTime = Number(message.ArrivedTime ?? 0);
    if (arrivedTime > now) continue;

    usersById.set(messageId, message);
    const timelineId = uniqueMessageTimelineId(message, usedTimelineIds);
    usedTimelineIds.add(timelineId.toString());

    const info: Decoded = {
      __msg: TIMELINE_INFO_MSG,
      MessageGroupId: String(master.MessageGroupId ?? ''),
      TimelineId: timelineId,
      MessageId: messageId,
      ArrivedTime: arrivedTime,
      SelectMessageDetailIds: detailIds(message.SelectMessageDetailIds),
      Finished: status === MESSAGE_STATUS_FINISHED,
    };

    const progress = progressByMessage[messageId];
    if (progress) {
      info.LastMessageDetailId = String(progress.LastMessageDetailId ?? '');
      info.LastMessageDetailTime = Number(progress.LastMessageDetailTime ?? 0);
    } else if (info.Finished) {
      info.LastMessageDetailId = terminalMessageDetailId(master);
      info.LastMessageDetailTime = arrivedTime;
    }
    infos.push(info);
  }

  return { infos, usersById, masters };
}

function findTimelineMessage(
  state: MessageTimelineState,
  messageGroupId: string,
  timelineId: bigint,
): { info: Decoded | null; message: Decoded | null; master: MessageMaster | null } {
  for (const info of state.infos) {
    if (String(info.MessageGroupId ?? '') !== messageGroupId) continue;
    if (toBigInt(info.TimelineId) !== timelineId) continue;
    const messageId = String(info.MessageId ?? '');
    return {
      info,
      message: state.usersById.get(messageId) ?? null,
      master: state.masters.get(messageId) ?? null,
    };
  }
  return { info: null, message: null, master: null };
}

/** `Message:ListGroup` — latest timeline per group, groups sorted by id. */
register(
  'Message:ListGroup',
  async (ctx) => {
    const pl = await playerForAccount(accountOf(ctx), ctx.name);
    const state = await withPlayerTx(pl.id, (tx) => loadMessageTimelineState(pl.id, tx));
    const latestByGroup = new Map<string, Decoded>();
    for (const info of state.infos) {
      const groupId = String(info.MessageGroupId ?? '');
      const latest = latestByGroup.get(groupId);
      if (!latest || toBigInt(info.TimelineId) > toBigInt(latest.TimelineId)) {
        latestByGroup.set(groupId, info);
      }
    }
    const infos = [...latestByGroup.keys()]
      .sort()
      .map((groupId) => ({
        __msg: MESSAGE_GROUP_INFO_MSG,
        MessageGroupId: groupId,
        LatestTimelineInfo: latestByGroup.get(groupId),
      }));
    return { __msg: '', Infos: infos, CommonResponse: commonResponse(null) } as Decoded;
  },
  { ownsState: true },
);

/** `Message:Timeline` — newest-first page of a group's timelines. */
register(
  'Message:Timeline',
  async (ctx) => {
    const messageGroupId = String(ctx.request?.MessageGroupId ?? '');
    const timelineId = toBigInt(ctx.request?.TimelineId);
    if (messageGroupId === '' || timelineId < 0n) {
      throw new Error('Message:Timeline: messageGroupId and a non-negative timelineId are required');
    }
    const pl = await playerForAccount(accountOf(ctx), ctx.name);
    const state = await withPlayerTx(pl.id, (tx) => loadMessageTimelineState(pl.id, tx));
    const infos = state.infos
      .filter(
        (info) =>
          String(info.MessageGroupId ?? '') === messageGroupId &&
          (timelineId === 0n || toBigInt(info.TimelineId) < timelineId),
      )
      .sort((left, right) => (toBigInt(left.TimelineId) > toBigInt(right.TimelineId) ? -1 : 1));
    const hasNext = infos.length > MESSAGE_TIMELINE_PAGE_SIZE;
    if (hasNext) infos.length = MESSAGE_TIMELINE_PAGE_SIZE;
    return {
      __msg: '',
      Infos: infos,
      HasNext: hasNext,
      CommonResponse: commonResponse(null),
    } as Decoded;
  },
  { ownsState: true },
);

/** `Message:Receive` — turn a due scheduled message into a received one. */
register(
  'Message:Receive',
  async (ctx) => {
    const messageIds = detailIds(ctx.request?.MessageIds);
    if (messageIds.length === 0) throw new Error('Message:Receive: at least one messageId is required');
    const pl = await playerForAccount(accountOf(ctx), ctx.name);

    return withPlayerTx(pl.id, async (tx) => {
      const now = Date.now();
      const updated = updatedData();
      const messages = await listElements(pl.id, 'Messages', tx);
      const schedules = await listElements(pl.id, 'MessageSchedules', tx);
      const messagesById = new Map(messages.map((m) => [String(m.MessageId ?? ''), m]));
      const schedulesById = new Map(schedules.map((s) => [String(s.MessageId ?? ''), s]));
      const seen = new Set<string>();
      const changed: Decoded[] = [];
      const arrived: Decoded[] = [];

      for (const messageId of messageIds) {
        if (messageId === '') throw new Error('Message:Receive: messageId must not be empty');
        if (seen.has(messageId)) continue;
        seen.add(messageId);
        if (!(await getMessage(messageId))) {
          throw new Error(`Message:Receive: unknown Message ${messageId}`);
        }
        const message = messagesById.get(messageId);
        if (!message) throw new Error(`Message:Receive: message ${messageId} is not owned`);
        const status = Number(message.MessageStatusType ?? 0);
        if (status === MESSAGE_STATUS_RECEIVED || status === MESSAGE_STATUS_FINISHED) continue;
        if (status !== 2) {
          throw new Error(`Message:Receive: message ${messageId} is not scheduled`);
        }
        const schedule = schedulesById.get(messageId);
        if (!schedule) throw new Error(`Message:Receive: message ${messageId} has no schedule`);
        const scheduledTime = Number(schedule.ScheduledTime ?? 0);
        if (scheduledTime <= 0 || scheduledTime > now) {
          throw new Error(`Message:Receive: message ${messageId} has not arrived`);
        }
        message.MessageStatusType = MESSAGE_STATUS_RECEIVED;
        message.ArrivedTime = scheduledTime;
        changed.push(message);
        arrived.push(schedule);
      }

      if (changed.length) await putElements(pl.id, 'Messages', changed, tx);
      if (changed.length) updated.Messages = changed;
      if (arrived.length) updated.MessageSchedules = arrived;
      return { __msg: '', CommonResponse: commonResponse(updated) } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Message:Save` — persist in-progress choices and the current detail. */
register(
  'Message:Save',
  async (ctx) => {
    const messageGroupId = String(ctx.request?.MessageGroupId ?? '');
    const timelineId = toBigInt(ctx.request?.TimelineId);
    const messageDetailId = String(ctx.request?.MessageDetailId ?? '');
    if (messageGroupId === '' || timelineId <= 0n || messageDetailId === '') {
      throw new Error(
        'Message:Save: messageGroupId, a positive timelineId, and messageDetailId are required',
      );
    }
    const pl = await playerForAccount(accountOf(ctx), ctx.name);

    return withPlayerTx(pl.id, async (tx) => {
      const state = await loadMessageTimelineState(pl.id, tx);
      const { info, message, master } = findTimelineMessage(state, messageGroupId, timelineId);
      if (!info || !message || !master) {
        throw new Error('Message:Save: message timeline was not found');
      }
      if (Number(message.MessageStatusType ?? 0) === MESSAGE_STATUS_FINISHED) {
        throw new Error('Message:Save: finished message progress cannot be changed');
      }
      if (Number(message.MessageStatusType ?? 0) !== MESSAGE_STATUS_RECEIVED) {
        throw new Error('Message:Save: message has not been received');
      }

      const resolved = resolveMessageDetails(
        master,
        detailIds(ctx.request?.SelectMessageDetailIds),
        messageDetailId,
      );
      validateMessageProgressExtension(
        master,
        String(info.LastMessageDetailId ?? ''),
        detailIds(message.SelectMessageDetailIds),
        resolved.path,
      );

      message.MessageStatusType = MESSAGE_STATUS_RECEIVED;
      message.SelectMessageDetailIds = resolved.selections;
      await putElements(pl.id, 'Messages', [message], tx);

      const progress = await loadMessageProgress(pl.id, tx);
      progress[String(message.MessageId ?? '')] = {
        LastMessageDetailId: messageDetailId,
        LastMessageDetailTime: Date.now(),
      };
      await saveMessageProgress(pl.id, progress, tx);

      return { __msg: '', CommonResponse: commonResponse(null) } as Decoded;
    });
  },
  { ownsState: true },
);

/**
 * `Message:Finish` — complete a non-tutorial message.
 *
 * Exported for `tutorial.ts`, which keeps the captured fresh-account response
 * for fresh players and delegates every other player here.
 */
export async function finishMessage(ctx: RpcContext): Promise<Decoded> {
  const messageGroupId = String(ctx.request?.MessageGroupId ?? '');
  const timelineId = toBigInt(ctx.request?.TimelineId);
  if (messageGroupId === '' && timelineId === 0n) return { __msg: '' } as Decoded;
  if (messageGroupId === '' || timelineId <= 0n) {
    throw new Error('Message:Finish: messageGroupId and a positive timelineId are required');
  }

  const pl = await playerForAccount(accountOf(ctx), ctx.name);

  return withPlayerTx(pl.id, async (tx) => {
    const finishedTime = Date.now();
    const state = await loadMessageTimelineState(pl.id, tx);
    const { info, message, master } = findTimelineMessage(state, messageGroupId, timelineId);
    if (!info || !message || !master) {
      throw new Error('Message:Finish: message timeline was not found');
    }

    const resolved = resolveMessageDetails(
      master,
      detailIds(ctx.request?.SelectMessageDetailIds),
      '',
    );
    const terminal = resolved.path[resolved.path.length - 1]!;

    if (Number(message.MessageStatusType ?? 0) === MESSAGE_STATUS_FINISHED) {
      return { __msg: '', CommonResponse: commonResponse(null) } as Decoded;
    }
    validateMessageProgressExtension(
      master,
      String(info.LastMessageDetailId ?? ''),
      detailIds(message.SelectMessageDetailIds),
      resolved.path,
    );

    const updated = updatedData();
    message.MessageStatusType = MESSAGE_STATUS_FINISHED;
    message.SelectMessageDetailIds = resolved.selections;
    await putElements(pl.id, 'Messages', [message], tx);
    updated.Messages = [message];

    let isReliabilityUp = false;
    const reliability = Number(terminal.Reliability ?? 0);
    const characterId = String(terminal.CharacterId ?? master.CharacterId ?? '');
    if (reliability < 0 || (reliability > 0 && characterId === '')) {
      throw new Error('Message:Finish: message terminal has invalid reliability data');
    }
    if (reliability > 0 && characterId !== '') {
      const characters = await listElements(pl.id, 'Characters', tx);
      const character = characters.find((c) => String(c.CharacterId ?? '') === characterId);
      if (!character) throw new Error(`Message:Finish: character ${characterId} is not owned`);
      const current = Number(character.Reliability ?? 0);
      if (reliability > 2_147_483_647 - current) {
        throw new Error('Message:Finish: character reliability overflows');
      }
      character.Reliability = current + reliability;
      await putElements(pl.id, 'Characters', [character], tx);
      updated.Characters = [character];
      // TODO: Solis also reaches ReliabilityAchievement missions here; this repo
      // has no mission-progress helper yet.
      isReliabilityUp = true;
    }

    const telephones = await listElements(pl.id, 'Telephones', tx);
    const telephonesById = new Map(
      telephones.map((telephone) => [String(telephone.TelephoneId ?? ''), telephone]),
    );
    const changedTelephones: Decoded[] = [];
    for (const detail of resolved.path) {
      const telephoneId = String(detail.TelephoneId ?? '');
      if (telephoneId === '') continue;
      if (!(await getTelephone(telephoneId))) {
        throw new Error(`Message:Finish: unknown Telephone ${telephoneId}`);
      }
      let telephone = telephonesById.get(telephoneId);
      if (!telephone) {
        telephone = { __msg: 'Solis.Common.Proto.Transaction.UserTelephone', TelephoneId: telephoneId } as Decoded;
        telephonesById.set(telephoneId, telephone);
      }
      if (Number(telephone.TelephoneStatusType ?? 0) === TELEPHONE_STATUS_FINISHED) continue;
      if (Number(telephone.UnlockedTime ?? 0) === 0) telephone.UnlockedTime = finishedTime;
      if (Number(telephone.ScheduledTime ?? 0) === 0) {
        telephone.ScheduledTime = Number(telephone.UnlockedTime);
      }
      telephone.TelephoneStatusType = TELEPHONE_STATUS_FINISHED;
      changedTelephones.push(telephone);
    }
    if (changedTelephones.length) {
      await putElements(pl.id, 'Telephones', changedTelephones, tx);
      updated.Telephones = changedTelephones;
    }

    const progress = await loadMessageProgress(pl.id, tx);
    progress[String(message.MessageId ?? '')] = {
      LastMessageDetailId: String(terminal.MessageDetailId ?? ''),
      LastMessageDetailTime: finishedTime,
    };
    await saveMessageProgress(pl.id, progress, tx);

    const deleted = { __msg: DELETED_DATA_MSG } as Decoded;
    const schedules = await listElements(pl.id, 'MessageSchedules', tx);
    const schedule = schedules.find(
      (entry) => String(entry.MessageId ?? '') === String(message.MessageId ?? ''),
    );
    if (schedule) {
      await removeElements(pl.id, 'MessageSchedules', [schedule], tx);
      deleted.MessageSchedules = [
        { __msg: USER_MESSAGE_SCHEDULE_MSG, MessageId: String(message.MessageId ?? '') },
      ];
    }
    // TODO: Solis reconciles narrative schedules after a message finishes; this
    // repo has no narrative scheduler.

    return {
      __msg: '',
      IsReliabilityUp: isReliabilityUp,
      CommonResponse: commonResponse(updated, deleted),
    } as Decoded;
  });
}

/** `Message:SaveHistory` — merge replayed choices into a finished history. */
register(
  'Message:SaveHistory',
  async (ctx) => {
    const messageId = String(ctx.request?.MessageId ?? '');
    if (messageId === '') throw new Error('Message:SaveHistory: messageId is required');
    const pl = await playerForAccount(accountOf(ctx), ctx.name);

    return withPlayerTx(pl.id, async (tx) => {
      const row = await getMessage(messageId);
      if (!row) throw new Error(`Message:SaveHistory: unknown Message ${messageId}`);
      const master = messageMaster(row);
      const messages = await listElements(pl.id, 'Messages', tx);
      const message = messages.find((entry) => String(entry.MessageId ?? '') === messageId);
      if (!message) throw new Error(`Message:SaveHistory: message ${messageId} is not owned`);
      if (Number(message.MessageStatusType ?? 0) !== MESSAGE_STATUS_FINISHED) {
        throw new Error('Message:SaveHistory: message history is unavailable before the message is finished');
      }
      // Leaving a replay before its next choice sends a partial route, so the
      // request alone need not reach a terminal. existingHistoryPath checks
      // every id is a choice and the merged union still holds a complete route.
      const merged = mergeSortedStrings(
        detailIds(message.SelectMessageDetailIds),
        detailIds(ctx.request?.SelectMessageDetailIds),
      );
      existingHistoryPath(master, merged);
      message.SelectMessageDetailIds = merged;
      await putElements(pl.id, 'Messages', [message], tx);
      return {
        __msg: '',
        CommonResponse: commonResponse({ __msg: UPDATED_DATA_MSG, Messages: [message] } as Decoded),
      } as Decoded;
    });
  },
  { ownsState: true },
);
