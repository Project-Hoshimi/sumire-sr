import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, extractBearer, type JwtClaims } from './jwt.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { ok: boolean; claims?: JwtClaims; reason?: string };
  }
}

export function authHook(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) {
  const header = (request.headers['x-auth-token'] as string) ?? (request.headers.authorization as string);
  const token = extractBearer(header);
  if (!token) {
    request.auth = { ok: false, reason: 'missing token' };
    return done();
  }
  const result = verifyToken(token);
  if (result.ok) {
    request.auth = { ok: true, claims: result.claims };
  } else {
    request.auth = { ok: false, reason: result.reason };
  }
  done();
}

/** Reject request if auth token missing/invalid; allow guest pass for excluded names. */
export function requireAuth(names: Set<string>) {
  return (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    const name = currentRpcName.get(request) ?? '';
    if (names.has(name)) return done();
    const a = request.auth;
    if (!a?.ok) {
      reply.code(401);
      done(new Error('unauthenticated'));
      return;
    }
    done();
  };
}

// The route determines the rpc name inside the handler; store it for auth prehook.
export const currentRpcName = new WeakMap<FastifyRequest, string>();