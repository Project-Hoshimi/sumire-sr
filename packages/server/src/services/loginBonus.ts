import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { players, playerEntities } from '../db/schema.ts';
import { alreadyClaimed, claimOnce } from '../db/claims.ts';
import { getLoginBonus } from '../master/index.ts';
import { applyRewardRefs } from '../master/reward.ts';
import {
  decodeMessage,
  encodeMessage,
  msgRegistry,
  Reader,
  Writer,
  type Decoded,
} from '@sumire-sr/protocol/runtime/proto.ts';

const RESPONSE_MSG = 'Solis.Common.Proto.Api.LoginBonusReceiveResponse';
const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';
const USER_LOGIN_BONUS_MSG = 'Solis.Common.Proto.Transaction.UserLoginBonus';

const STATE_KIND = 'LoginBonusState';

function stateShape() {
  return msgRegistry.get(USER_LOGIN_BONUS_MSG)!;
}

async function loadState(
  exec: Executor,
  playerId: string,
  loginBonusId: string,
): Promise<Decoded | null> {
  const [row] = await exec
    .select()
    .from(playerEntities)
    .where(
      and(
        eq(playerEntities.playerId, playerId),
        eq(playerEntities.kind, STATE_KIND),
        eq(playerEntities.entityKey, loginBonusId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const shape = stateShape();
  return decodeMessage(shape, new Reader(Uint8Array.from(Buffer.from(row.blob, 'base64'))));
}

async function saveState(
  exec: Executor,
  playerId: string,
  state: Decoded,
): Promise<void> {
  const shape = stateShape();
  const w = new Writer();
  encodeMessage(shape, state, w);
  const blob = Buffer.from(w.toBytes()).toString('base64');
  await exec
    .delete(playerEntities)
    .where(
      and(
        eq(playerEntities.playerId, playerId),
        eq(playerEntities.kind, STATE_KIND),
        eq(playerEntities.entityKey, String(state.LoginBonusId)),
      ),
    );
  await exec.insert(playerEntities).values({
    id: randomUUID(),
    playerId,
    kind: STATE_KIND,
    entityKey: String(state.LoginBonusId),
    ordinal: 0,
    blob,
  });
}

/**
 * `LoginBonus:Receive` — server-authoritative, once per UTC day per bonus.
 * The day index is the player's prior `ReceiveCount`; the reward ref is
 * `LoginBonus.RewardIds[ReceiveCount]`. State lives in `player_entities`
 * under kind `LoginBonusState` (not part of the `User:Get` surface).
 */
register(
  'LoginBonus:Receive',
  async (ctx) => {
    const req = ctx.request;
    if (!req) throw new Error('LoginBonus:Receive: missing request');
    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('LoginBonus:Receive: unauthenticated');
    const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
    if (!pl) throw new Error('LoginBonus:Receive: no player for account');

    const loginBonusId = String(req.LoginBonusId ?? '');
    if (!loginBonusId) throw new Error('LoginBonus:Receive: missing LoginBonusId');

    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const claimKey = `${loginBonusId}:${today}`;

    const out = await withPlayerTx(pl.id, async (tx) => {
      const master = await getLoginBonus(loginBonusId);
      if (!master) throw new Error(`LoginBonus:Receive: unknown login bonus ${loginBonusId}`);
      const rewardIds = (master.RewardIds as string[] | null) ?? [];

      let state = await loadState(tx, pl.id, loginBonusId);
      if (!state) {
        state = {
          __msg: USER_LOGIN_BONUS_MSG,
          LoginBonusId: loginBonusId,
          LastLoginTime: now,
          LoginCount: 1,
          ReceiveCount: 0,
        } as Decoded;
      }

      if (await alreadyClaimed(pl.id, 'login_bonus', claimKey, tx)) {
        return {
          state,
          results: [] as Decoded[],
          updated: { __msg: UPDATED_DATA_MSG } as Decoded,
          granted: 0,
        };
      }

      const day = Number(state.ReceiveCount ?? 0);
      const ref = rewardIds[day];
      if (!ref) throw new Error(`LoginBonus:Receive: no reward for day ${day} of ${loginBonusId}`);

      const won = await claimOnce(pl.id, 'login_bonus', claimKey, tx);
      if (!won) {
        return {
          state,
          results: [] as Decoded[],
          updated: { __msg: UPDATED_DATA_MSG } as Decoded,
          granted: 0,
        };
      }

      const applied = await applyRewardRefs(pl.id, [ref], tx);
      const updated: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
      if (applied.updated) {
        if (applied.updated.Items) updated.Items = applied.updated.Items;
        if (applied.updated.Points) updated.Points = applied.updated.Points;
        if (applied.updated.Balance) updated.Balance = applied.updated.Balance;
      }

      state.ReceiveCount = day + 1;
      state.LastLoginTime = now;
      await saveState(tx, pl.id, state);

      return { state, results: applied.results, updated, granted: applied.results.length };
    });

    ctx.fastifyReq.log.info(
      { accountId, serverUserId: pl.id, loginBonusId, granted: out.granted },
      'login bonus receive (server-authoritative)',
    );

    return {
      __msg: RESPONSE_MSG,
      UserLoginBonus: out.state,
      Rewards: out.results,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: out.updated,
        DeletedData: { __msg: DELETED_DATA_MSG } as Decoded,
      },
    } as Decoded;
  },
  { ownsState: true },
);
