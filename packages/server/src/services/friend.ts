import { register } from './handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Friend service — inert in the single-player sandbox.
 *
 * There are no other players, so every friend list is always empty. Mutating
 * friend RPCs (`Apply`, `Search`, ...) stay unimplemented on purpose so they
 * show the not-implemented dialog and return home.
 */

function emptyFriendList(): Decoded {
  return { __msg: '', Profiles: [] } as Decoded;
}

for (const name of ['Friend:List', 'Friend:ListApplied', 'Friend:ListApplying']) {
  register(name, () => emptyFriendList());
}
