// Default favourite idols against the dev Postgres and the master data.
//
//   npm run test:profiledefaults
//
// `ensureDefaultFavoriteCharacters` must seed three distinct owned main idols
// (master `Character.Type` 1) the first time a profile is served, keep an
// existing selection untouched, and pick deterministically for a deterministic
// rng. The `User:Get` case drives the real handler to prove the call site runs
// before the response is assembled. Skips when the database is unreachable.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test, type TestContext } from 'node:test';
import { sql } from 'drizzle-orm';
import '@sumire-sr/protocol/gen/registry.ts';
import { client, db } from '../db/client.ts';
import { accounts, players } from '../db/schema.ts';
import { masterCharacter } from '../db/masterSchema.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { getHandler, type RpcContext } from './handlers.ts';
import { getSingleton, putElements, putSingleton } from './playerState.ts';
import { getCorpusResponse, loadCorpus } from './replay/corpus.ts';
import { ensureDefaultFavoriteCharacters } from './profileDefaults.ts';
// Registers `User:Get` (the handler this test drives).
import './user.ts';

const PROFILE_MSG = 'Solis.Common.Proto.Transaction.UserProfile';
const CHARACTER_MSG = 'Solis.Common.Proto.Transaction.UserCharacter';

/**
 * The capture corpus under DATA_DIR/captures is private game data and is not in
 * the public export, so the User:Get test skips there instead of failing on a
 * missing capture template.
 */
loadCorpus();
const MISSING_USER_GET_TEMPLATE =
  !getCorpusResponse('User:Get') &&
  'DATA_DIR/captures (the capture corpus) is private data, not in this checkout';

let available = false;
const created: { accountId: string; playerId: string }[] = [];

function ready(t: TestContext): boolean {
  if (available) return true;
  t.skip('dev postgres / master data is not available; run `npm run db:migrate` and retry');
  return false;
}

before(async () => {
  try {
    await db.execute(sql`select 1`);
  } catch {
    return;
  }
  const mainIdols = await mainIdolIds();
  available = mainIdols.length > 0;
});

after(async () => {
  for (const entry of created) {
    try {
      await db.execute(sql`delete from player_entities where player_id = ${entry.playerId}`);
      await db.execute(sql`delete from players where id = ${entry.playerId}`);
      await db.execute(sql`delete from accounts where id = ${entry.accountId}`);
    } catch {
      // Nothing was created when the database is unreachable.
    }
  }
  await client.end({ timeout: 5 });
});

/** Sorted ids of the master main idols (`Character.Type` 1). */
async function mainIdolIds(): Promise<string[]> {
  const rows = await db
    .select({ Id: masterCharacter.Id, Type: masterCharacter.Type })
    .from(masterCharacter);
  return rows
    .filter((row) => Number(row.Type ?? 0) === 1)
    .map((row) => String(row.Id ?? ''))
    .filter(Boolean)
    .sort();
}

async function newPlayer(): Promise<{ accountId: string; playerId: string }> {
  const suffix = randomUUID();
  const accountId = `test-profile-defaults-${suffix}`;
  const playerId = `test-profile-defaults-player-${suffix}`;
  await db
    .insert(accounts)
    .values({ id: accountId, displayName: `profile defaults ${suffix.slice(0, 8)}` })
    .onConflictDoNothing();
  await db
    .insert(players)
    .values({ id: playerId, accountId, name: `profile-defaults-${suffix.slice(0, 8)}` })
    .onConflictDoNothing();
  const entry = { accountId, playerId };
  created.push(entry);
  return entry;
}

/** Give the player the given characters in their owned `Characters` collection. */
async function seedOwned(playerId: string, characterIds: readonly string[]): Promise<void> {
  await putElements(
    playerId,
    'Characters',
    characterIds.map((id) => ({ __msg: CHARACTER_MSG, CharacterId: id }) as Decoded),
  );
}

async function favoritesOf(playerId: string): Promise<string[]> {
  const profile = await getSingleton(playerId, 'Profile');
  return ((profile?.FavoriteCharacterIds as unknown[] | undefined) ?? []).map((v) => String(v ?? ''));
}

function rpcContext(name: string, accountId: string, request: Decoded): RpcContext {
  return {
    name,
    service: name.split(':')[0] ?? '',
    method: name.split(':')[1] ?? '',
    requestShape: '',
    responseShape: '',
    request,
    requestBytes: Buffer.alloc(0),
    fastifyReq: { log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } },
    auth: {
      ok: true,
      claims: { sub: accountId, iat: 0, exp: 0, iss: 'test', aud: 'test' },
    },
  } as unknown as RpcContext;
}

async function call(name: string, accountId: string, request: Decoded = {}): Promise<Decoded> {
  const handler = getHandler(name);
  return (await handler(rpcContext(name, accountId, request))) as Decoded;
}

test('an empty profile gets three distinct owned main idols', async (t) => {
  if (!ready(t)) return;
  const mainIdols = await mainIdolIds();
  const owned = mainIdols.slice(0, 5);
  if (owned.length < 3) {
    t.skip('master data has fewer than three main idols');
    return;
  }
  const { playerId } = await newPlayer();
  await seedOwned(playerId, owned);

  const changed = await ensureDefaultFavoriteCharacters(playerId, db, () => 0.5);
  assert.equal(changed, true, 'an empty profile must be seeded');
  const favorites = await favoritesOf(playerId);
  assert.equal(favorites.length, 3);
  assert.equal(new Set(favorites).size, 3, 'the picks must be distinct');
  for (const id of favorites) assert.ok(owned.includes(id), `${id} must be an owned main idol`);
});

test('fewer than three owned main idols seeds every one of them', async (t) => {
  if (!ready(t)) return;
  const owned = (await mainIdolIds()).slice(0, 2);
  if (owned.length < 2) {
    t.skip('master data has fewer than two main idols');
    return;
  }
  const { playerId } = await newPlayer();
  await seedOwned(playerId, owned);

  assert.equal(await ensureDefaultFavoriteCharacters(playerId, db, () => 0), true);
  const favorites = await favoritesOf(playerId);
  assert.equal(favorites.length, owned.length);
  assert.deepEqual([...favorites].sort(), [...owned].sort());
});

test('an existing selection is left untouched', async (t) => {
  if (!ready(t)) return;
  const { playerId } = await newPlayer();
  await putSingleton(playerId, 'Profile', {
    __msg: PROFILE_MSG,
    Message: 'keep me',
    FavoriteCharacterIds: ['char-existing'],
  } as Decoded);

  assert.equal(await ensureDefaultFavoriteCharacters(playerId, db, () => 0), false);
  const profile = await getSingleton(playerId, 'Profile');
  assert.deepEqual(profile?.FavoriteCharacterIds, ['char-existing']);
  assert.equal(profile?.Message, 'keep me', 'other profile fields must stay unchanged');
});

test('a deterministic rng gives deterministic picks', async (t) => {
  if (!ready(t)) return;
  const owned = (await mainIdolIds()).slice(0, 5);
  if (owned.length < 3) {
    t.skip('master data has fewer than three main idols');
    return;
  }
  const first = await newPlayer();
  const second = await newPlayer();
  await seedOwned(first.playerId, owned);
  await seedOwned(second.playerId, owned);

  const rng = () => 0;
  assert.equal(await ensureDefaultFavoriteCharacters(first.playerId, db, rng), true);
  assert.equal(await ensureDefaultFavoriteCharacters(second.playerId, db, rng), true);

  const picksA = await favoritesOf(first.playerId);
  const picksB = await favoritesOf(second.playerId);
  assert.deepEqual(picksA, picksB, 'the same rng over the same pool must pick the same ids');
  assert.deepEqual(picksA, owned.slice(0, 3), 'rng() => 0 takes the first three sorted ids');

  // Re-running over an already-seeded profile changes nothing.
  assert.equal(await ensureDefaultFavoriteCharacters(first.playerId, db, () => 0.99), false);
  assert.deepEqual(await favoritesOf(first.playerId), picksA);
});

test('User:Get serves the default favourites on the first call', { skip: MISSING_USER_GET_TEMPLATE }, async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer();
  // Start from a stored profile without favourites (the reported soft-lock
  // state); the corpus roster still seeds the owned characters.
  await putSingleton(playerId, 'Profile', { __msg: PROFILE_MSG } as Decoded);

  const response = await call('User:Get', accountId);
  const served = ((response.Profile as Decoded | undefined)?.FavoriteCharacterIds as unknown[] | undefined) ?? [];
  assert.equal(served.length, 3, 'the first User:Get must already carry the favourites');
  assert.deepEqual(await favoritesOf(playerId), served.map((v) => String(v)), 'the picks are persisted');

  // A second login serves the same favourites.
  const again = await call('User:Get', accountId);
  const second = ((again.Profile as Decoded | undefined)?.FavoriteCharacterIds as unknown[] | undefined) ?? [];
  assert.deepEqual(second.map((v) => String(v)), served.map((v) => String(v)));
});
