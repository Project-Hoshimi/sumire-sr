import { message } from '../messages.ts';

/**
 * gRPC status codes the local server can emit (canonical values).
 * https://github.com/grpc/grpc/blob/master/doc/statuscodes.md
 */
export const GRPC_STATUS = {
  OK: 0,
  INVALID_ARGUMENT: 3,
  PERMISSION_DENIED: 7,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAUTHENTICATED: 16,
} as const;

/**
 * Application-level error codes (`ErrorCode` enum in the game client, carried
 * in the `x-error-code` response header as a decimal string).
 */
export const ERROR_CODE = {
  /** `s_ErrorCode_InvalidArgument`: the request failed validation. */
  INVALID_ARGUMENT: 2001,
  /** `s_ErrorCode_Unauthenticated`: the session/token is no longer valid. */
  UNAUTHENTICATED: 2004,
  /** `s_ErrorCode_PasswordMigrationFailed`: the given id/password did not match. */
  PASSWORD_MIGRATION_FAILED: 3003,
  /** `s_ErrorCode_PasswordInvalid`: the link password format was rejected. */
  PASSWORD_INVALID: 3004,
  /** `s_ErrorCode_MigrationTargetNotFound`: the one-time token expired/used. */
  MIGRATION_TARGET_NOT_FOUND: 3009,
  /** `s_ErrorCode_FunctionLocked`: the RPC has no server-side handler yet. */
  FUNCTION_LOCKED: 3022,
} as const;

/**
 * Error actions (`x-error-action` header) select the client-side handler:
 * `title` → back to the title screen (i.e. re-login), `store` → update dialog,
 * `retry` → retry dialog, `home` → dialog, then back to the home screen,
 * `continue` → dialog without navigation. Unknown/absent means a generic dialog.
 * Neither `none` (the client forwards it to the retry dialog) nor `continue`
 * works for a failed RPC: the client re-issues the request after every dismiss,
 * for screen loads and button actions alike. Only `home` breaks the loop.
 */
export const ERROR_ACTION = {
  TITLE: 'title',
  RETRY: 'retry',
  HOME: 'home',
  CONTINUE: 'continue',
  NONE: 'none',
} as const;

/**
 * Dialog body for RPCs that have no server-side handler: the client shows it
 * and then returns to the home screen.
 */
export const NOT_IMPLEMENTED_MESSAGE = message('notImplemented');

/**
 * Error sent when Auth:Login meets an unbound UID on an invite/closed server.
 * One place to retune how the client handles it.
 */
export const INVITE_ONLY_LOGIN_ERROR = {
  code: ERROR_CODE.FUNCTION_LOCKED,
  action: ERROR_ACTION.TITLE,
  grpcStatus: GRPC_STATUS.PERMISSION_DENIED,
} as const;

export class RpcError extends Error {
  readonly grpcStatus: number;

  constructor(message: string, grpcStatus: number) {
    super(message);
    this.name = 'RpcError';
    this.grpcStatus = grpcStatus;
  }
}

/**
 * The caller's identity could not be established: the `x-auth-token` header is
 * missing, or the JWT does not verify (bad signature / expired / wrong aud).
 *
 * Handlers signal this condition by throwing an error whose message ends in
 * `unauthenticated` (e.g. `throw new Error('Gacha:Draw: unauthenticated')`);
 * `isUnauthenticatedError()` recognises both those and this class, so the
 * server can answer with gRPC `UNAUTHENTICATED` (16) instead of HTTP 500.
 */
export class UnauthenticatedError extends RpcError {
  constructor(message = 'unauthenticated') {
    super(message, GRPC_STATUS.UNAUTHENTICATED);
    this.name = 'UnauthenticatedError';
  }
}

/**
 * The RPC exists in the generated endpoint map but the server has no handler
 * for it yet. Answer with gRPC `UNIMPLEMENTED` (12) and a dialog that returns
 * to the home screen (`ERROR_CODE.FUNCTION_LOCKED` + `ERROR_ACTION.HOME`)
 * instead of an empty success body, which the client would silently accept.
 */
export class NotImplementedError extends RpcError {
  constructor(name: string) {
    super(`${name}: not implemented`, GRPC_STATUS.UNIMPLEMENTED);
    this.name = 'NotImplementedError';
  }
}

/**
 * An RPC failure that carries the application-level metadata the client reads
 * from the response (`x-error-code` / `x-error-action`) instead of a generic
 * dialog. The server catch maps it onto `sendGrpcError` directly.
 *
 * `grpcStatus` defaults to UNAUTHENTICATED (16); this repo has no
 * FAILED_PRECONDITION constant, and 16 is what the client already routes to its
 * re-login/dialog flow.
 */
export class AppRpcError extends RpcError {
  readonly code: number;
  readonly action: string;

  constructor(
    code: number,
    action: string,
    message: string,
    grpcStatus: number = GRPC_STATUS.UNAUTHENTICATED,
  ) {
    super(message, grpcStatus);
    this.name = 'AppRpcError';
    this.code = code;
    this.action = action;
  }
}

export function isAppRpcError(err: unknown): err is AppRpcError {
  return err instanceof AppRpcError;
}

/**
 * Action used by every migration error. Kept as one constant so switching the
 * client-side handler later is a one-line change.
 */
export const MIGRATION_ERROR_ACTION = ERROR_ACTION.CONTINUE;

const UNAUTHENTICATED_MESSAGE = /unauthenticated\b/i;

export function isUnauthenticatedError(err: unknown): boolean {
  if (err instanceof UnauthenticatedError) return true;
  return err instanceof Error && UNAUTHENTICATED_MESSAGE.test(err.message);
}

export function isNotImplementedError(e: unknown): e is NotImplementedError {
  return e instanceof NotImplementedError;
}

/**
 * Percent-encode a status message for the `grpc-message` trailer: gRPC requires
 * it to be printable ASCII (spaces and `%` included), otherwise .NET rejects
 * the whole response.
 */
export function encodeGrpcMessage(message: string): string {
  return encodeURIComponent(message).replace(/%20/g, ' ');
}

/**
 * Encode a gRPC binary metadata header value: the header is `-bin`-suffixed, so
 * its wire value is the base64 of the raw UTF-8 bytes.
 */
export function encodeBinHeader(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}
