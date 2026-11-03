import type { FastifyRequest } from 'fastify';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import type { AuthState } from '../auth/authenticate.ts';

export type RpcContext = {
  name: string;
  service: string;
  method: string;
  requestShape: string;
  responseShape: string;
  request: Decoded | null;
  requestBytes: Buffer;
  fastifyReq: FastifyRequest;
  auth: AuthState;
};

export type RpcOutput = Buffer | Decoded;

export type RpcHandler = (ctx: RpcContext) => Promise<RpcOutput> | RpcOutput;

const handlers = new Map<string, RpcHandler>();
const stateOwners = new Set<string>();

export type RegisterOptions = {
  /**
   * When true the handler is responsible for persisting its own player state
   * (typically inside `withPlayerTx`); the router will not run the generic
   * `CommonResponse` materializer against its response.
   */
  ownsState?: boolean;
};

export function register(name: string, h: RpcHandler, opts?: RegisterOptions) {
  if (handlers.has(name)) throw new Error(`duplicate handler ${name}`);
  handlers.set(name, h);
  if (opts?.ownsState) stateOwners.add(name);
}

export function handlerOwnsState(name: string): boolean {
  return stateOwners.has(name);
}

export function getHandler(name: string): RpcHandler {
  const h = handlers.get(name);
  if (h) return h;
  throw new Error(`no handler registered for ${name}`);
}

export function hasHandler(name: string): boolean {
  return handlers.has(name);
}

export function listNames(): string[] {
  return [...handlers.keys()];
}
