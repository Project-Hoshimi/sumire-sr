import { and, eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import { decodeMessage, encodeMessage, msgRegistry, Reader, Writer } from '@sumire-sr/protocol/runtime/proto.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { playerEntities } from '../db/schema.ts';
import { withPlayerTx } from '../db/tx.ts';
import {
  applyUpdatedData,
  findPlayerByAccountId,
  getSingleton,
  isFreshPlayer,
  putElements,
  readPlayerBalance,
  withPlayerIdentity,
} from './playerState.ts';
import { getFreshCapture } from './replay/corpus.ts';
import { finishMessage } from './message.ts';

const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';
const USER_TUTORIAL_MSG = 'Solis.Common.Proto.Transaction.UserTutorial';
const USER_MSG = 'Solis.Common.Proto.Transaction.User';
const USER_GET_RESPONSE_MSG = 'Solis.Common.Proto.Api.UserGetResponse';
const PROGRESS_RESPONSE_MSG = 'Solis.Common.Proto.Api.TutorialProgressResponse';
const REWARD_RESPONSE_MSG = 'Solis.Common.Proto.Api.TutorialActivityReceiveLessonRewardResponse';

// Official fresh-account capture files (see captures/2026-10-25_fresh_official).
const FRESH_USER_GET = '00005.resp-plain.User:Get.bin';
const FRESH_FINAL_PROGRESS = '00057.resp-plain.Tutorial:Progress.bin';
const FRESH_LESSON_REWARD = '00034.resp-plain.Tutorial:ReceiveLessonReward.bin';
const FRESH_MESSAGE_FINISH = '00054.resp-plain.Message:Finish.bin';
const FRESH_START_QUESTS: Record<string, string> = {
  'qt-tutorial-short': '00026.resp-plain.Tutorial:StartQuest.bin',
  'qt-tutorial-full': '00028.resp-plain.Tutorial:StartQuest.bin',
};

const FINAL_TUTORIAL_TYPE = 1;
const FINAL_TUTORIAL_STEP = 150;

function commonResponse(updated: Decoded | null = null, deleted: Decoded | null = null): Decoded {
  return {
    __msg: COMMON_RESPONSE_MSG,
    UpdatedData: (updated ?? { __msg: UPDATED_DATA_MSG }) as Decoded,
    DeletedData: (deleted ?? { __msg: DELETED_DATA_MSG }) as Decoded,
  } as Decoded;
}

function commonOnly(updated: Decoded | null = null): Decoded {
  return { __msg: '', CommonResponse: commonResponse(updated) } as Decoded;
}

function decodeCapture(shapeName: string, file: string): Decoded | null {
  const bytes = getFreshCapture(file);
  const shape = bytes ? msgRegistry.get(shapeName) : null;
  if (!bytes || !shape) return null;
  return decodeMessage(shape, new Reader(Uint8Array.from(bytes)));
}

/** The captured User:Get `User` (the state Init responds with, before renaming). */
function freshTemplateUser(): Decoded | null {
  const response = decodeCapture(USER_GET_RESPONSE_MSG, FRESH_USER_GET);
  return (response?.User as Decoded | undefined) ?? null;
}

/** The full `User` snapshot carried by the final Tutorial:Progress response. */
function freshFinalUser(): Decoded | null {
  const response = decodeCapture(PROGRESS_RESPONSE_MSG, FRESH_FINAL_PROGRESS);
  return (response?.CommonResponse?.UpdatedData?.User as Decoded | undefined) ?? null;
}

/**
 * Re-encode a captured response with the player's identity on its `User`
 * (`UpdatedData.User`, or top-level), so the official account's name is never
 * returned to the client or materialized into player state.
 */
async function withFreshUser(playerId: string, shapeName: string, captured: Buffer): Promise<Buffer> {
  const shape = msgRegistry.get(shapeName);
  if (!shape) return captured;
  const decoded = decodeMessage(shape, new Reader(Uint8Array.from(captured)));
  const updated = decoded.CommonResponse?.UpdatedData as Decoded | undefined;
  const capturedUser = (updated?.User ?? decoded.User) as Decoded | undefined;
  if (!capturedUser) return captured;
  const user = withPlayerIdentity(capturedUser, await getSingleton(playerId, 'User'));
  if (updated?.User) updated.User = user;
  else decoded.User = user;
  // Stone balances belong to the players columns (source of truth), not to the
  // captured payload.
  const balance = await readPlayerBalance(playerId);
  if (updated) updated.Balance = balance;
  else decoded.Balance = balance;
  const w = new Writer();
  encodeMessage(shape, decoded, w);
  return Buffer.from(w.toBytes());
}

/**
 * Persist a UserTutorial record so feature-unlock tutorials (e.g. Type 41
 * Company / Type 44 CompanyEnjoy) are not replayed on every login. Corpus-seeded
 * rows carry legacy `#N` entity keys; re-key them by TutorialType first so the
 * upsert can match existing records instead of appending duplicates.
 */
async function persistTutorial(playerId: string, tutorialType: number, step: number): Promise<void> {
  const shape = msgRegistry.get(USER_TUTORIAL_MSG);
  if (!shape) return;
  await withPlayerTx(playerId, async (tx) => {
    const rows = await tx
      .select()
      .from(playerEntities)
      .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, 'Tutorials')));
    for (const r of rows) {
      if (!r.entityKey || !r.entityKey.startsWith('#')) continue;
      const el = decodeMessage(shape, new Reader(Uint8Array.from(r.blob)));
      if (el?.TutorialType == null) continue;
      await tx
        .update(playerEntities)
        .set({ entityKey: String(Number(el.TutorialType)) })
        .where(eq(playerEntities.id, r.id));
    }
    await putElements(
      playerId,
      'Tutorials',
      [{ __msg: USER_TUTORIAL_MSG, TutorialType: tutorialType, Step: step } as Decoded],
      tx,
    );
  });
}

/**
 * Persist the player's chosen name. Fresh players also get it echoed back in
 * `UpdatedData.User`; corpus accounts keep the legacy empty response.
 */
register(
  'Tutorial:Init',
  async (ctx) => {
    const pl = await findPlayerByAccountId(ctx.auth.ok ? ctx.auth.claims?.sub : undefined);
    if (!pl || !isFreshPlayer(pl)) return commonOnly();

    const name = typeof ctx.request?.Name === 'string' ? ctx.request.Name : '';
    const current = (await getSingleton(pl.id, 'User')) ?? freshTemplateUser();
    const user = { ...(current ?? { __msg: USER_MSG }), Name: name } as Decoded;
    const updated = { __msg: UPDATED_DATA_MSG, User: user } as Decoded;
    await withPlayerTx(pl.id, (tx) => applyUpdatedData(pl.id, updated, null, tx));
    return commonOnly(updated);
  },
  { ownsState: true },
);

register(
  'Tutorial:Progress',
  async (ctx) => {
    const tutorialType = ctx.request?.Type == null ? 0 : Number(ctx.request.Type);
    const step = ctx.request?.Step == null ? 0 : Number(ctx.request.Step);
    const pl = await findPlayerByAccountId(ctx.auth.ok ? ctx.auth.claims?.sub : undefined);
    if (pl) await persistTutorial(pl.id, tutorialType, step);

    const userTutorial = {
      __msg: USER_TUTORIAL_MSG,
      TutorialType: tutorialType,
      Step: step,
    } as Decoded;
    const updated = { __msg: UPDATED_DATA_MSG, Tutorials: [userTutorial] } as Decoded;

    // Clearing the opening tutorial updates several User fields in the capture
    // (level 2, exp, buddy, photo ids). Layer those over the player's own User so
    // their name and timestamps stay theirs.
    if (pl && isFreshPlayer(pl) && tutorialType === FINAL_TUTORIAL_TYPE && step === FINAL_TUTORIAL_STEP) {
      const current = await getSingleton(pl.id, 'User');
      const user = withPlayerIdentity(freshFinalUser() ?? { __msg: USER_MSG }, current);
      user.TutorialClearedTime = Date.now();
      updated.User = user;
      await withPlayerTx(pl.id, (tx) =>
        applyUpdatedData(pl.id, { __msg: UPDATED_DATA_MSG, User: user } as Decoded, null, tx),
      );
    }

    ctx.fastifyReq.log.info({ tutorialType, step }, 'tutorial progress');
    return commonOnly(updated);
  },
  { ownsState: true },
);

register('Tutorial:StartQuest', async (ctx) => {
  const pl = await findPlayerByAccountId(ctx.auth.ok ? ctx.auth.claims?.sub : undefined);
  if (!pl || !isFreshPlayer(pl)) return commonOnly();
  const questId = typeof ctx.request?.QuestId === 'string' ? ctx.request.QuestId : '';
  const file = FRESH_START_QUESTS[questId];
  const captured = file ? getFreshCapture(file) : null;
  return captured ?? commonOnly();
});

register('Tutorial:ReceiveLessonReward', async (ctx) => {
  const pl = await findPlayerByAccountId(ctx.auth.ok ? ctx.auth.claims?.sub : undefined);
  if (!pl || !isFreshPlayer(pl)) return commonOnly();
  const captured = getFreshCapture(FRESH_LESSON_REWARD);
  if (!captured) return commonOnly();
  return withFreshUser(pl.id, REWARD_RESPONSE_MSG, captured);
});

/**
 * The opening tutorial's message group finish is absent from the corpus (it
 * used to fall through to the router's empty reply). Fresh players get the
 * captured response, which persists the read message and its schedule deletion.
 * Every other player uses the normal `Message:Finish` implementation.
 */
register('Message:Finish', async (ctx) => {
  const pl = await findPlayerByAccountId(ctx.auth.ok ? ctx.auth.claims?.sub : undefined);
  if (pl && isFreshPlayer(pl)) {
    const captured = getFreshCapture(FRESH_MESSAGE_FINISH);
    return captured ?? Buffer.alloc(0);
  }
  return finishMessage(ctx);
});

for (const name of [
  'Tutorial:StartFanEvent',
  'Tutorial:ReceivePromotionReward',
  'Tutorial:CreateShooting',
  'Tutorial:Skip',
]) {
  register(name, () => commonOnly(), { ownsState: true });
}
