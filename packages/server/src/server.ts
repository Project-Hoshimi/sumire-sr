import Fastify, { type FastifyRequest, type FastifyReply, type FastifyInstance } from 'fastify';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { decrypt, encrypt } from './gateway/crypto.ts';
import { config, publicTlsConfig } from './config.ts';
import { logCaFingerprint, registerCaBootstrap } from './caBootstrap.ts';
import { dispatchRpc } from './services/router.ts';
import { GRPC_STATUS, ERROR_CODE, ERROR_ACTION, NOT_IMPLEMENTED_MESSAGE, encodeBinHeader, encodeGrpcMessage, isAppRpcError, isNotImplementedError, isUnauthenticatedError } from './services/errors.ts';
import { publicKeyFingerprint } from './auth/jwt.ts';
import { ensureTlsCert } from './tls.ts';
import { registerFirebaseEmu } from './firebaseEmu.ts';
import { registerFirebaseStorage } from './firebaseStorage.ts';
import { registerInviteRoutes } from './routes/invites.ts';
import { MASTER_BLOBS_DIR } from './services/master.ts';
import { isSandbox } from './profile.ts';
import { isMainModule } from './mainModule.ts';
import { titleVariantBlobPath } from './profiles/sandbox/titleBackground.ts';
import './services/all.ts';
import '@sumire-sr/protocol/gen/registry.ts';

const UPSTREAM_HOST = '130.211.5.37';
const UPSTREAM_SNI = 'api.octo-cloud.com';
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', ':authority', ':method',
  ':path', ':scheme', ':status', 'content-length', 'accept-encoding',
]);

async function proxyHandler(req: FastifyRequest, reply: FastifyReply) {
  req.log.info({ proxyUrl: req.url }, 'proxy handler entered');
  const url = (req.url ?? '').split('?')[0];
  const qIdx = (req.url ?? '').indexOf('?');
  const q = qIdx >= 0 ? (req.url ?? '').slice(qIdx + 1) : '';
  const path = q ? `${url}?${q}` : url;

  const headers: Record<string, string> = { host: UPSTREAM_SNI };
  const rh = req.headers;
  for (const [k, v] of Object.entries(rh)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }

  const body = req.body ? Buffer.from(req.body as any) : undefined;
  headers['content-length'] = String(body?.length ?? 0);

  const opts: RequestOptions = {
    host: UPSTREAM_HOST,
    port: 443,
    servername: UPSTREAM_SNI,
    method: (req.method ?? 'GET').toUpperCase(),
    path,
    headers,
    rejectUnauthorized: false,
  };

  const outcome = await new Promise<{
    ok: boolean; status?: number; headers?: Record<string, string | string[] | undefined>;
    data?: Buffer; error?: { message?: string; code?: string; errno?: string };
  }>((resolve) => {
    const upstream = httpsRequest(opts, (up) => {
      const chunks: Buffer[] = [];
      up.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
      up.on('error', (e: any) => resolve({ ok: false, error: { message: e?.message, code: e?.code, errno: e?.errno } }));
      up.on('end', () => resolve({ ok: true, status: up.statusCode, headers: up.headers, data: Buffer.concat(chunks) }));
    });
    upstream.on('error', (e: any) => resolve({ ok: false, error: { message: e?.message, code: e?.code, errno: e?.errno } }));
    if (body) upstream.write(body);
    upstream.end();
  });

  if (!outcome.ok || outcome.status === undefined) {
    req.log.error({ err: outcome.error?.message, code: outcome.error?.code, errno: outcome.error?.errno, url }, 'proxy upstream failed');
    return reply.code(502).header('content-type', 'text/plain').send(`proxy failed: ${outcome.error?.message}`);
  }

  req.log.info({ url, status: outcome.status, bytes: outcome.data?.length ?? 0 }, 'proxy upstream response');
  const clean: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(outcome.headers ?? {})) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === 'alt-svc') continue;
    if (v !== undefined) clean[k] = v;
  }
  return reply
    .code(outcome.status)
    .headers(clean)
    .header('content-length', String(outcome.data?.length ?? 0))
    .send(outcome.data ?? Buffer.alloc(0));
}

/**
 * Answer a call with a gRPC error status as a "trailers-only" response:
 * HTTP 200, `content-type: application/grpc`, and the status carried in the
 * response headers. This is what the canonical gRPC servers (and the official
 * backend) return; the client maps `grpc-status` onto `IApiError.Code`.
 *
 * `appError` additionally sets the application-level error metadata the client
 * reads from the response (`x-error-code` → `ErrorCode`, `x-error-action` →
 * the handler that runs, e.g. `title` → back to the title/re-login screen,
 * `message` → the dialog body as a binary gRPC metadata header).
 */
function sendGrpcError(
  reply: FastifyReply,
  status: number,
  message: string,
  appError?: { code: number; action: string; message?: string },
) {
  const headers = {
    'content-type': 'application/grpc',
    'grpc-status': String(status),
    'grpc-message': encodeGrpcMessage(message),
    'x-server-time': String(Date.now()),
    'cache-control': 'no-store',
    ...(appError
      ? { 'x-error-code': String(appError.code), 'x-error-action': appError.action }
      : {}),
    ...(appError?.message
      ? { 'x-error-message-bin': encodeBinHeader(appError.message) }
      : {}),
  };
  if (config.http2 && config.tls) {
    reply.hijack();
    reply.raw.writeHead(200, headers);
    reply.raw.end();
    return reply;
  }
  return reply.code(200).headers(headers).send(Buffer.alloc(0));
}

async function handler(req: FastifyRequest, reply: FastifyReply) {
  // gRPC empty-message requests arrive with no body at all (req.body undefined),
  // not even the 5-byte frame. Treat a missing body as a zero-length message
  // rather than throwing ERR_INVALID_ARG_TYPE.
  const raw = req.body == null ? Buffer.alloc(0) : Buffer.from(req.body as any);
  if (raw.length !== 0 && raw.length < 4) {
    return reply.code(400).header('content-type', 'text/plain').send('bad frame');
  }

  // YAHA/gRPC wraps the AES envelope in a 5-byte gRPC message frame:
  //   [compressed:1][length:4 BE][envelope]
  // An empty request protobuf produces a zero-length message (no envelope).
  let inner = raw;
  let framed = false;
  if (raw.length >= 5 && raw[0] === 0 && raw.readUInt32BE(1) === raw.length - 5) {
    framed = true;
    inner = raw.subarray(5);
  }

  let plain: Buffer;
  if (raw.length === 0 || (framed && inner.length === 0)) {
    plain = Buffer.alloc(0);
  } else {
    try {
      plain = decrypt(inner);
    } catch (e: any) {
      req.log.error({ err: e?.message, framed }, 'frame decrypt failed');
      return reply.code(400).header('content-type', 'text/plain').send('frame decrypt failed');
    }
  }

  // path shape: /api.<Service>/<Method>  (also tolerate /<Service>/<Method>)
  const url = (req.url ?? '').split('?')[0];
  const mm = url.match(/^\/(?:api\.)?([^/]+)\/([^/]+)$/);
  if (!mm) {
    return reply.code(404).header('content-type', 'text/plain').send(`no route ${url}`);
  }
  const name = `${mm[1]}:${mm[2]}`;
  if (config.debugRpc) req.log.info({ name }, 'rpc');

  let resp: Buffer;
  try {
    resp = await dispatchRpc(name, plain, req);
  } catch (e: any) {
    if (isAppRpcError(e)) {
      // RPCs that carry their own app error code/action (migration, invite-only
      // guard): the client renders these as a titled dialog.
      req.log.warn({ name, err: e.message, code: e.code, action: e.action }, 'dispatch failed: app error');
      return sendGrpcError(reply, e.grpcStatus, e.message, {
        code: e.code,
        action: e.action,
        message: e.message,
      });
    }
    if (isUnauthenticatedError(e)) {
      // An invalid/expired GameAuthToken is not a server fault: answer with a
      // real gRPC UNAUTHENTICATED status so the client can route it to its
      // re-login flow. An HTTP 500 turns into gRPC "Unknown" on the client,
      // which it renders as the generic "communication failed" dialog with no
      // way to recover.
      req.log.warn({ name, err: e?.message }, 'dispatch failed: unauthenticated');
      return sendGrpcError(reply, GRPC_STATUS.UNAUTHENTICATED, 'unauthenticated', {
        code: ERROR_CODE.UNAUTHENTICATED,
        action: ERROR_ACTION.TITLE,
      });
    }
    if (isNotImplementedError(e)) {
      // No handler for this RPC: show the dialog, then return the player to the
      // home screen. Non-navigating actions make the client re-issue the RPC.
      req.log.warn({ name, err: e.message }, 'dispatch failed: not implemented');
      return sendGrpcError(reply, GRPC_STATUS.UNIMPLEMENTED, e.message, {
        code: ERROR_CODE.FUNCTION_LOCKED,
        action: ERROR_ACTION.HOME,
        message: NOT_IMPLEMENTED_MESSAGE,
      });
    }
    req.log.error({ name, err: e?.message }, 'dispatch failed');
    return reply.code(500).header('content-type', 'text/plain').send(`dispatch failed: ${e?.message}`);
  }

  let out = encrypt(resp, Buffer.from('cb'));
  if (framed) {
    const h = Buffer.alloc(5);
    h[0] = 0;
    h.writeUInt32BE(out.length, 1);
    out = Buffer.concat([h, out]);
  }

  if (config.http2 && config.tls) {
    reply.hijack();
    const raw = reply.raw;
    const headers = {
      'content-type': framed ? 'application/grpc' : 'application/x-protobuf',
      'x-server-time': String(Date.now()),
      'cache-control': 'no-store',
    };
    raw.writeHead(200, headers);
    const w = raw.write(out);
    if (w && typeof (w as any).then === 'function') {
      (w as unknown as Promise<unknown>).then(() => {
        try {
          raw.addTrailers({ 'grpc-status': '0', 'grpc-message': '' });
        } catch (e: any) {
          req.log.error({ err: e?.message }, 'addTrailers failed');
        }
        raw.end();
      }).catch((e: unknown) => {
        req.log.error({ err: String(e) }, 'h2 body write failed');
        raw.end();
      });
    } else {
      try {
        raw.addTrailers({ 'grpc-status': '0', 'grpc-message': '' });
      } catch (e: any) {
        req.log.error({ err: e?.message }, 'addTrailers failed');
      }
      raw.end();
    }
    return reply;
  }

  return reply
    .header('content-type', 'application/x-protobuf')
    .header('x-server-time', String(Date.now()))
    .header('cache-control', 'no-store')
    .trailer('grpc-status', (_r, _p, cb) => cb(null, '0'))
    .trailer('grpc-message', (_r, _p, cb) => cb(null, ''))
    .send(out);
}

/**
 * Build the SNI callback that serves the public (Let's Encrypt) certificate
 * for exactly one hostname; every other servername falls back to the default
 * private-CA leaf. Exported so the hostname match can be unit-tested without a
 * listener.
 */
export function buildSniCallback(publicTls: { hostname: string; certPath: string; keyPath: string }) {
  let publicContext: ReturnType<typeof createSecureContext>;
  try {
    publicContext = createSecureContext({
      cert: readFileSync(publicTls.certPath),
      key: readFileSync(publicTls.keyPath),
    });
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `failed to load TLS public certificate: TLS_PUBLIC_CERT (${publicTls.certPath}) / ` +
        `TLS_PUBLIC_KEY (${publicTls.keyPath}) for TLS_PUBLIC_HOSTNAME (${publicTls.hostname}): ${reason}`,
    );
  }
  const publicHostname = publicTls.hostname.toLowerCase();
  return (servername: string, cb: (err: Error | null, ctx?: unknown) => void) => {
    if (servername?.toLowerCase() === publicHostname) cb(null, publicContext);
    else cb(null, undefined); // falsy ctx → Node falls back to the default context
  };
}

export function buildServer(): FastifyInstance {
  const opts: Record<string, unknown> = {
    logger: {
      serializers: {
        // Invite tokens live in the path: keep them out of the request log.
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          url: req.url.replace(/^\/invite\/[^/?#]+/, '/invite/<redacted>'),
        }),
      },
    },
    bodyLimit: 64 * 1024 * 1024,
    requestTimeout: 60_000,
  };
  if (config.http2) opts.http2 = true;
  if (config.tls) {
    const tlsOpts: Record<string, unknown> = ensureTlsCert();
    // Optional public certificate for one SNI name (a real domain with a
    // Let's Encrypt cert). Any other servername — including the game's
    // hostnames — keeps the default private-CA leaf context.
    const publicTls = publicTlsConfig();
    if (publicTls) {
      tlsOpts.SNICallback = buildSniCallback(publicTls);
    }
    opts.https = tlsOpts;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = Fastify(opts as any) as unknown as FastifyInstance;

  app.addContentTypeParser(
    /^.*$/,
    { parseAs: 'buffer' },
    (_req: any, body: Buffer, done: (e: Error | null, b?: Buffer) => void) => {
      done(null, body);
    },
  );

  // The game sends `application/x-protobuf,x-octo-app/…` (comma-joined,
  // invalid per RFC 9110). Fastify rejects that as an invalid media type
  // before our catch-all parser runs → normalize to the first media type.
  app.addHook('onRequest', (req, _reply, done) => {
    const ct = req.headers['content-type'];
    if (ct && ct.includes(',')) {
      req.headers['content-type'] = ct.slice(0, ct.indexOf(',')).trim();
    }
    done();
  });

  const tlsSrv: any = app.server;
  tlsSrv.on('tlsClientError', (err: any, socket: any) => {
    app.log.warn(
      { err: err?.message, code: err?.code, remote: `${socket?.remoteAddress}:${socket?.remotePort}` },
      'TLS client error',
    );
  });
  const onSecure = (socket: any, proto?: string) => {
    app.log.info(
      { remote: `${socket?.remoteAddress}:${socket?.remotePort}`, servername: socket?.servername, alpn: proto ?? socket?.alpnProtocol },
      'TLS secure connection established',
    );
  };
  tlsSrv.on('secureConnection', (s: any) => onSecure(s));
  tlsSrv.on('session', (s: any) => onSecure(s, s?.alpnProtocol));

  // Bootstrap endpoints must precede the Firebase emulation and the gRPC
  // catch-alls so no auth/decryption handler can intercept them. Static routes
  // win in Fastify's router regardless, but registration order documents it.
  registerCaBootstrap(app);
  // Firebase Auth REST emulation must be registered before the parametric
  // gRPC fallback; static routes win anyway, but this keeps `/v1/token`
  // unambiguous and documents the intent.
  registerFirebaseEmu(app);
  // Firebase Storage emulation for photo image upload/download (Solis port).
  registerFirebaseStorage(app);
  // Invite pages and the token-guarded admin API (docs/LOGIN_FLOW.md).
  registerInviteRoutes(app);

  app.all('/api/*', handler);
  app.all('/:service/:method', handler);
  app.all('/v2/*', proxyHandler);
  app.get('/master/:type/:file', (req, reply) => {
    const { type, file } = req.params as { type: string; file: string };
    if (!/^[A-Za-z0-9_]+$/.test(type) || !/^[0-9a-f]+$/.test(file)) {
      return reply.code(400).header('content-type', 'text/plain').send('bad master path');
    }
    const variant = isSandbox() ? titleVariantBlobPath(type, file) : null;
    if (variant && existsSync(variant)) {
      return reply.header('content-type', 'application/octet-stream').send(readFileSync(variant));
    }
    const p = join(MASTER_BLOBS_DIR, type);
    if (!existsSync(p)) {
      req.log.warn({ type }, 'master blob missing');
      return reply.code(404).header('content-type', 'text/plain').send('not found');
    }
    return reply.header('content-type', 'application/octet-stream').send(readFileSync(p));
  });
  app.get('/health', (_req, reply) => reply.send({ ok: true }));

  return app;
}

export function start() {
  // Load the signing key at boot, not on the first request: the "[jwt] key
  // pair from …" line (or the loud WARNING when a new key is generated) must be
  // visible in the server log next to "Server listening".
  publicKeyFingerprint();
  const app = buildServer();
  logCaFingerprint(app.log);
  app
    .listen({ port: config.port, host: config.host })
    .then((addr) => console.log(`fastify-api listening on ${addr}`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

if (isMainModule(import.meta.url, process.argv[1])) start();
