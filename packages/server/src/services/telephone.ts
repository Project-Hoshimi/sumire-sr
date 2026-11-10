// Ported from solis-server (AGPL-3.0), internal/server/rpc/servers/telephone/.
import { register, type RpcContext } from './handlers.ts';
import { withPlayerTx } from '../db/tx.ts';
import { getTelephone } from '../master/index.ts';
import { findPlayerByAccountId, listElements, putElements } from './playerState.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { isSandbox } from '../profile.ts';
import { reconcileNarrative } from './narrative.ts';

/**
 * Phone calls embedded in message detail graphs. Calls are seeded as finished
 * on the sandbox profile; the handlers still implement the scheduled →
 * received → finished transitions so a non-sandbox account can use them.
 */

const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';

const TELEPHONE_STATUS_RECEIVED = 3;
const TELEPHONE_STATUS_FINISHED = 4;

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

function commonResponse(updated: Decoded | null): Decoded {
  return {
    __msg: COMMON_RESPONSE_MSG,
    UpdatedData: (updated ?? { __msg: UPDATED_DATA_MSG }) as Decoded,
    DeletedData: { __msg: 'Solis.Common.Proto.Api.DeletedData' } as Decoded,
  } as Decoded;
}

function telephoneIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** `Telephone:Receive` — turn a due scheduled call into a received one. */
register(
  'Telephone:Receive',
  async (ctx) => {
    const ids = telephoneIds(ctx.request?.TelephoneIds);
    if (ids.length === 0) {
      throw new Error('Telephone:Receive: at least one telephoneId is required');
    }
    const pl = await playerForAccount(accountOf(ctx), ctx.name);

    return withPlayerTx(pl.id, async (tx) => {
      const now = Date.now();
      const telephones = await listElements(pl.id, 'Telephones', tx);
      const byId = new Map(
        telephones.map((telephone) => [String(telephone.TelephoneId ?? ''), telephone]),
      );
      const seen = new Set<string>();
      const changed: Decoded[] = [];

      for (const telephoneId of ids) {
        if (telephoneId === '') {
          throw new Error('Telephone:Receive: telephoneId must not be empty');
        }
        if (seen.has(telephoneId)) continue;
        seen.add(telephoneId);
        if (!(await getTelephone(telephoneId))) {
          throw new Error(`Telephone:Receive: unknown Telephone ${telephoneId}`);
        }
        const telephone = byId.get(telephoneId);
        if (!telephone) throw new Error(`Telephone:Receive: telephone ${telephoneId} is not owned`);
        const status = Number(telephone.TelephoneStatusType ?? 0);
        if (status === TELEPHONE_STATUS_RECEIVED || status === TELEPHONE_STATUS_FINISHED) continue;
        if (status !== 2) {
          throw new Error(`Telephone:Receive: telephone ${telephoneId} is not scheduled`);
        }
        const scheduledTime = Number(telephone.ScheduledTime ?? 0);
        if (scheduledTime <= 0 || scheduledTime > now) {
          throw new Error(`Telephone:Receive: telephone ${telephoneId} has not arrived`);
        }
        telephone.TelephoneStatusType = TELEPHONE_STATUS_RECEIVED;
        changed.push(telephone);
      }

      if (changed.length) await putElements(pl.id, 'Telephones', changed, tx);
      return {
        __msg: '',
        CommonResponse: commonResponse(
          changed.length ? ({ __msg: UPDATED_DATA_MSG, Telephones: changed } as Decoded) : null,
        ),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Telephone:Finishes` — mark received calls finished. */
register(
  'Telephone:Finishes',
  async (ctx) => {
    const ids = telephoneIds(ctx.request?.TelephoneIds);
    if (ids.length === 0) {
      throw new Error('Telephone:Finishes: at least one telephoneId is required');
    }
    const pl = await playerForAccount(accountOf(ctx), ctx.name);

    return withPlayerTx(pl.id, async (tx) => {
      const telephones = await listElements(pl.id, 'Telephones', tx);
      const byId = new Map(
        telephones.map((telephone) => [String(telephone.TelephoneId ?? ''), telephone]),
      );
      const seen = new Set<string>();
      const changed: Decoded[] = [];

      for (const telephoneId of ids) {
        if (telephoneId === '') {
          throw new Error('Telephone:Finishes: telephoneId must not be empty');
        }
        if (seen.has(telephoneId)) continue;
        seen.add(telephoneId);
        if (!(await getTelephone(telephoneId))) {
          throw new Error(`Telephone:Finishes: unknown Telephone ${telephoneId}`);
        }
        const telephone = byId.get(telephoneId);
        if (!telephone) throw new Error(`Telephone:Finishes: telephone ${telephoneId} is not owned`);
        if (Number(telephone.TelephoneStatusType ?? 0) === TELEPHONE_STATUS_FINISHED) continue;
        if (Number(telephone.TelephoneStatusType ?? 0) !== TELEPHONE_STATUS_RECEIVED) {
          throw new Error(`Telephone:Finishes: telephone ${telephoneId} has not been received`);
        }
        telephone.TelephoneStatusType = TELEPHONE_STATUS_FINISHED;
        changed.push(telephone);
      }

      if (changed.length) await putElements(pl.id, 'Telephones', changed, tx);
      // Official profile only: finishing a call can unlock/schedule the next
      // idol message or call. The sandbox keeps its pre-seeded state.
      if (!isSandbox()) {
        const updated = {
          __msg: UPDATED_DATA_MSG,
          ...(changed.length ? { Telephones: changed } : {}),
        } as Decoded;
        await reconcileNarrative(pl.id, Date.now(), updated, 'none', '', tx);
        return {
          __msg: '',
          IsReliabilityUp: false,
          CommonResponse: commonResponse(updated),
        } as Decoded;
      }
      return {
        __msg: '',
        IsReliabilityUp: false,
        CommonResponse: commonResponse(
          changed.length ? ({ __msg: UPDATED_DATA_MSG, Telephones: changed } as Decoded) : null,
        ),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/** `Telephone:CallHistory` — call log is only readable after the call ends. */
register(
  'Telephone:CallHistory',
  async (ctx) => {
    const telephoneId = String(ctx.request?.TelephoneId ?? '');
    if (telephoneId === '') throw new Error('Telephone:CallHistory: telephoneId is required');
    if (!(await getTelephone(telephoneId))) {
      throw new Error(`Telephone:CallHistory: unknown Telephone ${telephoneId}`);
    }
    const pl = await playerForAccount(accountOf(ctx), ctx.name);
    const telephones = await listElements(pl.id, 'Telephones');
    const telephone = telephones.find(
      (entry) => String(entry.TelephoneId ?? '') === telephoneId,
    );
    if (!telephone) {
      throw new Error(`Telephone:CallHistory: telephone ${telephoneId} is not owned`);
    }
    if (Number(telephone.TelephoneStatusType ?? 0) !== TELEPHONE_STATUS_FINISHED) {
      throw new Error('Telephone:CallHistory: telephone history is unavailable before the call is finished');
    }
    return { __msg: '', CommonResponse: commonResponse(null) } as Decoded;
  },
  { ownsState: true },
);
