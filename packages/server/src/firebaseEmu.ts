import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  FIREBASE_PROJECT_ID,
  mintIdToken,
  mintRefreshToken,
  TOKEN_TTL_SECONDS,
  verifyCustomToken,
  verifyIdToken,
  verifyRefreshToken,
} from './auth/firebaseTokens.ts';
import { findPhotoOwnerByFirebaseUid } from './firebaseStorage.ts';

/**
 * Firebase Auth REST emulation (docs/AUTH_CREATE.md §3 option A).
 *
 * The game client is redirected here for identitytoolkit / securetoken, so the
 * routes answer the exact JSON shapes the Firebase SDK expects. Bodies arrive
 * as raw Buffers (the server installs a catch-all buffer content-type parser);
 * each route accepts both JSON and form-urlencoded input.
 */

const CUSTOM_TOKEN_ERROR = {
  error: {
    code: 400,
    message: 'INVALID_CUSTOM_TOKEN',
    errors: [{ message: 'INVALID_CUSTOM_TOKEN', domain: 'global', reason: 'invalid' }],
  },
};

const REFRESH_TOKEN_ERROR = {
  error: { code: 400, message: 'INVALID_REFRESH_TOKEN', status: 'INVALID_ARGUMENT' },
};

const ID_TOKEN_ERROR = {
  error: {
    code: 400,
    message: 'INVALID_ID_TOKEN',
    errors: [{ message: 'INVALID_ID_TOKEN', domain: 'global', reason: 'invalid' }],
  },
};

function parseText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON — fall through to form parsing below.
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(trimmed)) out[k] = v;
  return out;
}

/** Accept JSON or application/x-www-form-urlencoded regardless of content-type. */
function readBody(body: unknown): Record<string, unknown> {
  if (body == null) return {};
  if (Buffer.isBuffer(body)) return parseText(body.toString('utf8'));
  if (typeof body === 'string') return parseText(body);
  if (typeof body === 'object') return body as Record<string, unknown>;
  return {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function logRequest(req: FastifyRequest, route: string, uid?: string): void {
  req.log.info({ route, path: (req.url ?? '').split('?')[0], uid }, 'firebase emu request');
}

export function registerFirebaseEmu(app: FastifyInstance): void {
  const signInWithCustomToken = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = readBody(req.body);
    const verified = verifyCustomToken(str(body.token));
    logRequest(req, 'signInWithCustomToken', verified?.uid);
    if (!verified) return reply.code(400).send(CUSTOM_TOKEN_ERROR);
    const owner = await findPhotoOwnerByFirebaseUid(verified.uid);
    return reply.send({
      kind: 'identitytoolkit#VerifyCustomTokenResponse',
      idToken: mintIdToken(verified.uid, undefined, owner?.publicUserId),
      refreshToken: mintRefreshToken(verified.uid),
      expiresIn: String(TOKEN_TTL_SECONDS),
      isNewUser: false,
    });
  };

  const secureToken = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = readBody(req.body);
    // The REST API documents snake_case; the Android SDK (FirebaseCore 23.x) sends camelCase JSON.
    const grantType = str(body.grant_type ?? body.grantType);
    const granted = grantType === '' || grantType === 'refresh_token';
    const verified = granted ? verifyRefreshToken(str(body.refresh_token ?? body.refreshToken)) : null;
    logRequest(req, 'securetoken', verified?.uid);
    if (!verified) return reply.code(400).send(REFRESH_TOKEN_ERROR);
    const owner = await findPhotoOwnerByFirebaseUid(verified.uid);
    const idToken = mintIdToken(verified.uid, undefined, owner?.publicUserId);
    return reply.send({
      access_token: idToken,
      expires_in: String(TOKEN_TTL_SECONDS),
      token_type: 'Bearer',
      refresh_token: str(body.refresh_token ?? body.refreshToken),
      id_token: idToken,
      user_id: verified.uid,
      project_id: FIREBASE_PROJECT_ID,
    });
  };

  const lookup = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = readBody(req.body);
    const verified = verifyIdToken(str(body.idToken) || str(body.id_token));
    logRequest(req, 'lookup', verified?.uid);
    if (!verified) return reply.code(400).send(ID_TOKEN_ERROR);
    const authTime =
      typeof verified.claims.auth_time === 'number'
        ? verified.claims.auth_time
        : Math.floor(Date.now() / 1000);
    const nowMs = Date.now();
    return reply.send({
      kind: 'identitytoolkit#GetAccountInfoResponse',
      users: [
        {
          localId: verified.uid,
          lastLoginAt: String(nowMs),
          createdAt: String(Math.floor(authTime * 1000)),
          customAuth: true,
          providerUserInfo: [],
        },
      ],
    });
  };

  // Literal `:` must be escaped as `::` in find-my-way route paths.
  app.post('/v1/accounts::signInWithCustomToken', signInWithCustomToken);
  app.post('/identitytoolkit/v3/relyingparty/verifyCustomToken', signInWithCustomToken);
  app.post('/v1/token', secureToken);
  app.post('/v1/accounts::lookup', lookup);
  app.post('/identitytoolkit/v3/relyingparty/getAccountInfo', lookup);
}
