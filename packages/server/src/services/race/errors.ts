// User-facing race rejections.
//
// A plain `throw new Error(...)` reaches `server.ts`'s catch-all and answers
// HTTP 500, which the client renders as "Bad gRPC response. HTTP status code:
// 500" and retries forever. Racing actions the player cannot afford or is not
// allowed to take right now must instead carry an `ErrorCode` so the client
// shows a titled dialog (same mechanism as `marathon/staminaItem.ts`).
import { AppRpcError, ERROR_ACTION, ERROR_CODE, GRPC_STATUS } from '../errors.ts';

/**
 * Reject a race request the player cannot perform right now. `ERROR_ACTION.HOME`
 * matters: any other action makes the client re-issue the failed RPC after the
 * dialog is dismissed, looping on the same rejection.
 */
export function raceRejected(code: number, message: string): never {
  throw new AppRpcError(code, ERROR_ACTION.HOME, message, GRPC_STATUS.INVALID_ARGUMENT);
}

/** The player lacks the race points / medals / eraser the request spends. */
export function raceResourceNotEnough(message: string): never {
  raceRejected(ERROR_CODE.RESOURCE_NOT_ENOUGH, message);
}

/** The race board state forbids the action (pending VENUS, board end, locked tier). */
export function raceConditionInvalid(message: string): never {
  raceRejected(ERROR_CODE.EVENT_CONDITION_INVALID, message);
}

/** `Race:ResetCardCoolTime` on a card that is not actually on cool time. */
export function raceNotInCoolTime(message: string): never {
  raceRejected(ERROR_CODE.NOT_IN_COOL_TIME, message);
}
