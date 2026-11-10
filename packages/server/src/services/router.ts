import { gunzipSync } from 'node:zlib';
import type { FastifyRequest } from 'fastify';
import { endpoints } from '@sumire-sr/protocol/gen/endpoints.ts';
import { decodeMessage, encodeMessage, msgRegistry, Reader, Writer } from '@sumire-sr/protocol/runtime/proto.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { getHandler, handlerOwnsState, hasHandler, type RpcOutput } from './handlers.ts';
import { AppRpcError, ERROR_ACTION, ERROR_CODE, NotImplementedError } from './errors.ts';
import { config } from '../config.ts';
import { isSandbox } from '../profile.ts';
import { SANDBOX_BLOCKED_RPCS } from '../profiles/sandbox/blockedRpcs.ts';
import { authenticate, isGuestAuth } from '../auth/authenticate.ts';
import { db } from '../db/client.ts';
import { withPlayerTx } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { applyCommonResponse } from './playerState.ts';
import { message } from '../messages.ts';

function shapeFor(qname: string) {
  if (qname === 'Empty' || qname.endsWith('.Empty')) return null;
  const s = msgRegistry.get(qname);
  if (!s) throw new Error(`no schema registered for ${qname}`);
  return s;
}

/** Full empty protobuf message. */
const EMPTY = Buffer.alloc(0);

/**
 * RPCs a guest session may call (invite/closed mode). Everything else needs an
 * account and answers with the invite-only dialog; `Auth:*` is always allowed
 * so a new client can still reach `Auth:Create`/`Auth:Login`.
 */
const GUEST_ALLOWED = new Set([
  'System:Check',
  'Master:Get',
  'User:Get',
  'Migration:List',
  'Migration:MigratePassword',
  'Migration:Execute',
]);

/**
 * RPC names absent from the generated endpoint map that the client is known
 * to call during boot. They are answered with an empty protobuf so they cannot
 * wedge the client. Every other unmapped name gets the not-implemented error.
 */
export const TOLERATED_UNMAPPED_RPCS: ReadonlySet<string> = new Set(['Refund:GetTerm', 'User:Title']);

const INVITE_ONLY_MESSAGE = message('inviteOnlyBlocked');

/**
 * Resolve the caller's identity from the request headers and log *why* it was
 * rejected. Without the reason an auth failure is indistinguishable from a
 * handler bug in the logs.
 */
function authenticateRequest(req: FastifyRequest) {
  const tokenHeader = req.headers['x-auth-token'] as string | undefined;
  const authHeader = req.headers.authorization as string | undefined;
  const auth = authenticate(tokenHeader ?? authHeader);
  if (!auth.ok) {
    req.log?.warn?.(
      {
        reason: auth.reason,
        hasToken: Boolean(tokenHeader ?? authHeader),
        header: tokenHeader ? 'x-auth-token' : authHeader ? 'authorization' : null,
      },
      'request unauthenticated',
    );
  }
  return auth;
}

export async function dispatchRpc(name: string, plain: Buffer, req: FastifyRequest): Promise<Buffer> {
  const [service, method] = name.split(':');
  const ep = endpoints[service]?.[method];
  if (ep && isSandbox() && SANDBOX_BLOCKED_RPCS.has(name)) {
    req.log?.warn?.({ name }, 'sandbox-blocked rpc — not implemented');
    throw new NotImplementedError(name);
  }
  if (!ep || !hasHandler(name)) {
    if (config.unhandledRpc === 'empty' || (!ep && TOLERATED_UNMAPPED_RPCS.has(name))) {
      // `SUMIRE_UNHANDLED_RPC=empty` restores the legacy empty reply for every
      // unhandled RPC. A tolerated unmapped name is a known boot RPC answered
      // empty so it cannot wedge the client.
      req.log?.warn?.({ name, known: Boolean(ep) }, 'unhandled rpc — replying empty');
      return EMPTY;
    }
    // Unmapped names get the not-implemented error unless listed in
    // TOLERATED_UNMAPPED_RPCS: an empty success body hides the failure, while
    // gRPC 12 + FUNCTION_LOCKED shows a dialog and returns to the home screen.
    req.log?.warn?.({ name, known: Boolean(ep) }, 'unhandled rpc — not implemented');
    throw new NotImplementedError(name);
  }

  const reqShape = shapeFor(ep.request);
  // The client gzips large request bodies (e.g. Gift:Receive with 61 ids,
  // captures/2026-10-26_lesson_rate_official 00081). A gzip header can never
  // start a protobuf message (0x1f is field 3 with the invalid wire type 7).
  if (plain.length > 2 && plain[0] === 0x1f && plain[1] === 0x8b) plain = gunzipSync(plain);
  const request: Decoded | null = reqShape
    ? decodeMessage(reqShape, new Reader(Uint8Array.from(plain)))
    : null;

  const handler = getHandler(name);
  const auth = authenticateRequest(req);
  if (isGuestAuth(auth) && !name.startsWith('Auth:') && !GUEST_ALLOWED.has(name)) {
    // The token is valid but only marks a guest: no account exists to load or
    // mutate. Answer with `title` so the client returns to the account screen.
    req.log?.warn?.({ name }, 'guest rpc blocked (invite-only)');
    throw new AppRpcError(
      ERROR_CODE.UNAUTHENTICATED,
      ERROR_ACTION.TITLE,
      INVITE_ONLY_MESSAGE,
    );
  }
  const output: RpcOutput = await handler({
    name,
    service,
    method,
    requestShape: ep.request,
    responseShape: ep.response,
    request,
    requestBytes: plain,
    fastifyReq: req,
    auth,
  });

  const respShape = shapeFor(ep.response);

  let bytes: Buffer;
  if (Buffer.isBuffer(output)) {
    // Handler returned final wire bytes already -> use verbatim.
    bytes = output.length === 0 ? EMPTY : output;
  } else if (respShape) {
    // Handler returned a decoded object -> encode against response schema.
    const w = new Writer();
    encodeMessage(respShape, output as Decoded, w);
    bytes = Buffer.from(w.toBytes());
  } else {
    throw new Error(`${name}: handler returned Decoded but schema is ${ep.response}`);
  }

  if (!handlerOwnsState(name)) {
    await materializeState(name, respShape, bytes, req);
  }
  return bytes;
}

/**
 * Persist any `CommonResponse.UpdatedData`/`DeletedData` carried by a response
 * into the authenticated player's state. Best-effort: state materialization must
 * never break the response the client receives.
 */
async function materializeState(
  name: string,
  respShape: ReturnType<typeof shapeFor>,
  bytes: Buffer,
  req: FastifyRequest,
): Promise<void> {
  try {
    if (!respShape) return;
    if (bytes.length === 0) return;
    const hasCommon =
      respShape.name === 'Solis.Common.Proto.Api.CommonResponse' ||
      respShape.fields.some((f) => f.name === 'CommonResponse' && f.message);
    if (!hasCommon) return;
    const auth = authenticateRequest(req);
    if (!auth.ok || !auth.claims?.sub) return;
    // Guests carry sub='guest'; that is not an account id, so nothing to load.
    if (isGuestAuth(auth)) return;
    const [pl] = await db.select().from(players).where(eq(players.accountId, auth.claims.sub)).limit(1);
    if (!pl) return;
    const decoded = decodeMessage(respShape, new Reader(Uint8Array.from(bytes)));
    const applied = await withPlayerTx(pl.id, (tx) =>
      applyCommonResponse(pl.id, respShape, decoded, tx),
    );
    if (applied) req.log?.info?.({ name, playerId: pl.id }, 'player state updated');
  } catch (err) {
    req.log?.warn?.({ name, err: (err as Error).message }, 'player state materialization failed');
  }
}
