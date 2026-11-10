import { eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import { alreadyClaimed, claimOnce } from '../db/claims.ts';
import { getMission } from '../master/index.ts';
import { applyRewardRefs } from '../master/reward.ts';
import { listElements, putElements } from './playerState.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

const MISSION_RESPONSE_MSG = 'Solis.Common.Proto.Api.MissionReceiveResponse';
const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';
const USER_MISSION_MSG = 'Solis.Common.Proto.Transaction.UserMission';
const URL_TRANSITION_RESPONSE_MSG = 'Solis.Common.Proto.Api.MissionURLTransitionResponse';

const STATUS_RECEIVED = 4;

/**
 * `Mission:Receive` — server-authoritative. For each requested mission it finds
 * the next unclaimed threshold in the master `Mission.Progresses`, verifies the
 * player has reached it, claims it exactly once, applies the reward, and returns
 * the updated `Missions` plus the granted `Items`/`Points`/`Balance`.
 */
register(
  'Mission:Receive',
  async (ctx) => {
    const req = ctx.request;
    if (!req) throw new Error('Mission:Receive: missing request');
    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('Mission:Receive: unauthenticated');
    const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
    if (!pl) throw new Error('Mission:Receive: no player for account');

    const ids = Array.isArray(req.MissionIds) ? (req.MissionIds as string[]) : [];
    const results: Decoded[] = [];

    const updated = await withPlayerTx(pl.id, async (tx) => {
      const acc: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
      const items: Decoded[] = [];
      const points: Decoded[] = [];
      const missions: Decoded[] = [];
      let balance: Decoded | null = null;

      const current = await listElements(pl.id, 'Missions', tx);
      const byId = new Map(current.map((m) => [String(m.MissionId), m]));

      for (const missionId of ids) {
        const mission = await getMission(missionId);
        const progresses = (mission?.Progresses as Decoded[] | null) ?? [];
        if (!progresses.length) continue;

        const um = byId.get(missionId);
        let chosen: Decoded | null = null;
        for (const p of progresses) {
          const threshold = Number(p.Threshold ?? 0);
          if (!(await alreadyClaimed(pl.id, 'mission', `${missionId}:${threshold}`, tx))) {
            chosen = p;
            break;
          }
        }
        if (!chosen) continue;
        const threshold = Number(chosen.Threshold ?? 0);
        const progress = Number(um?.Progress ?? threshold);
        if (progress < threshold) continue;

        const won = await claimOnce(pl.id, 'mission', `${missionId}:${threshold}`, tx);
        if (!won) continue;

        const rewardSet = chosen.RewardSetId == null ? null : String(chosen.RewardSetId);
        if (rewardSet) {
          const applied = await applyRewardRefs(pl.id, [rewardSet], tx);
          results.push(...applied.results);
          if (applied.updated) {
            items.push(...((applied.updated.Items as Decoded[]) ?? []));
            points.push(...((applied.updated.Points as Decoded[]) ?? []));
            if (applied.updated.Balance) balance = applied.updated.Balance as Decoded;
          }
        }

        const next = progresses.find((p) => Number(p.Threshold ?? 0) > threshold);
        const updatedMission: Decoded = {
          __msg: USER_MISSION_MSG,
          MissionId: missionId,
          CurrentThreshold: next ? Number(next.Threshold) : threshold,
          Progress: progress,
          StatusType: STATUS_RECEIVED,
          LastUpdateTime: Date.now(),
        } as Decoded;
        missions.push(updatedMission);
      }

      if (items.length) acc.Items = items;
      if (points.length) acc.Points = points;
      if (balance) acc.Balance = balance;
      if (missions.length) acc.Missions = missions;
      if (missions.length) await putElements(pl.id, 'Missions', missions, tx);
      return acc;
    });

    ctx.fastifyReq.log.info(
      { accountId, serverUserId: pl.id, requested: ids.length, granted: results.length },
      'mission receive (server-authoritative)',
    );

    return {
      __msg: MISSION_RESPONSE_MSG,
      Results: results,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: updated,
        DeletedData: { __msg: DELETED_DATA_MSG } as Decoded,
      },
    } as Decoded;
  },
  { ownsState: true },
);

/**
 * `Mission:URLTransition` — no-op stub.
 *
 * Solis returns `MissionURLTransitionResponse` with an empty `CommonResponse`
 * (containing an empty `UpdatedData` and an empty `DeletedData`).  Sumire-sr
 * mirrors this exactly: no state change, no URL validation, no mission
 * progress tracking.
 *
 * Solis source: solis-server/internal/server/rpc/servers/mission/url_transition.go:10-14
 */
register(
  'Mission:URLTransition',
  async (ctx) => {
    const req = ctx.request;
    if (!req) throw new Error('Mission:URLTransition: missing request');

    return {
      __msg: URL_TRANSITION_RESPONSE_MSG,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: { __msg: UPDATED_DATA_MSG } as Decoded,
        DeletedData: { __msg: DELETED_DATA_MSG } as Decoded,
      },
    } as Decoded;
  },
  { ownsState: true },
);
