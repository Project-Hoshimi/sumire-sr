import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config.ts';

/**
 * Optional pinned identity for the account captured in the replay corpus.
 *
 * The real values used to be constants in `src/services/auth.ts`; they now live
 * in the private data tree at `captures/identity.json` so the server source can
 * be published without an account's identifiers. When the file is absent every
 * account is treated as new and boot still works.
 */
export type PinnedPlayer = {
  name: string;
  level: number;
  exp: number;
  gold: number;
  freeJewel: number;
};

export type PinnedIdentity = {
  firebaseUid: string;
  serverUserId: string;
  publicUserId: string;
  player: PinnedPlayer;
};

let cached: PinnedIdentity | null | undefined;

export function identityPath(): string {
  return join(DATA_DIR, 'captures', 'identity.json');
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseIdentity(raw: unknown): PinnedIdentity | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const player = value.player as Record<string, unknown> | undefined;
  if (!player || typeof player !== 'object') return null;
  if (
    !nonEmptyString(value.firebaseUid) ||
    !nonEmptyString(value.serverUserId) ||
    !nonEmptyString(value.publicUserId) ||
    !nonEmptyString(player.name) ||
    !finiteNumber(player.level) ||
    !finiteNumber(player.exp) ||
    !finiteNumber(player.gold) ||
    !finiteNumber(player.freeJewel)
  ) {
    return null;
  }
  return {
    firebaseUid: value.firebaseUid,
    serverUserId: value.serverUserId,
    publicUserId: value.publicUserId,
    player: {
      name: player.name,
      level: player.level,
      exp: player.exp,
      gold: player.gold,
      freeJewel: player.freeJewel,
    },
  };
}

/** Load the pinned identity, or `null` when there is no (valid) identity file. */
export function loadPinnedIdentity(): PinnedIdentity | null {
  if (cached !== undefined) return cached;
  cached = null;
  const path = identityPath();
  if (!existsSync(path)) return null;
  try {
    cached = parseIdentity(JSON.parse(readFileSync(path, 'utf8')));
    if (!cached) console.warn(`ignoring invalid pinned identity file: ${path}`);
  } catch (error) {
    console.warn(`ignoring unreadable pinned identity file: ${path} (${(error as Error).message})`);
  }
  return cached;
}

/** The pinned identity only applies to its own Firebase UID. */
export function pinnedIdentityForUid(uid: string | null): PinnedIdentity | null {
  if (!uid) return null;
  const pinned = loadPinnedIdentity();
  return pinned && pinned.firebaseUid === uid ? pinned : null;
}

/** Test hook: forget the memoised file contents. */
export function resetPinnedIdentityCache(): void {
  cached = undefined;
}
