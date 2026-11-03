/**
 * Sandbox Special Photography.
 *
 * There is no master table of special-shooting campaigns: the client only shows
 * the home icon when `Home:Enter` carries a `SpecialPhotoShootingInfo`, and
 * sends that server-defined id back to the special-shooting photo endpoints.
 */
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

export const SANDBOX_SPECIAL_PHOTO_SHOOTING_ID = 'special_photo_shooting-sandbox';

/** The always-unlocked Special Photography campaign shown to sandbox players. */
export function sandboxSpecialPhotoShootingInfo(): Decoded {
  return {
    __msg: 'Solis.Common.Proto.Api.SpecialPhotoShootingInfo',
    SpecialPhotoShootingId: SANDBOX_SPECIAL_PHOTO_SHOOTING_ID,
    IsUnlocked: true,
    UnlockConditionId: '',
  } as Decoded;
}
