import { db } from '../db/client.ts';
import { type Executor } from '../db/tx.ts';
import { listElements, putElements } from './playerState.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Port of Solis `viber.UnlockLiveMusic` (live_music.go).
 *
 * Grants first ownership of a music on a successful Quest/Exercise live. The
 * music collection is keyed by `MusicId`; re-playing a song is a no-op.
 */
const USER_MUSIC_MSG = 'Solis.Common.Proto.Transaction.UserMusic';

export async function unlockLiveMusic(
  playerId: string,
  musicId: string,
  updated: Decoded,
  exec: Executor = db,
): Promise<void> {
  if (!musicId) return;
  const rows = await listElements(playerId, 'Musics', exec);
  if (rows.some((row) => String(row.MusicId ?? '') === musicId)) return;
  const row = { __msg: USER_MUSIC_MSG, MusicId: musicId } as Decoded;
  await putElements(playerId, 'Musics', [row], exec);
  const existing = Array.isArray(updated.Musics) ? (updated.Musics as Decoded[]) : [];
  updated.Musics = [...existing, row];
}
