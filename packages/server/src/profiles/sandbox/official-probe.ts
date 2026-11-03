/**
 * Child-process probe for the sandbox DB test: runs with
 * `SUMIRE_PROFILE=official` so `PROFILE` resolves to `official` at import time, creates a throwaway
 * account, and reports how much sandbox state it received.
 *
 * Prints one JSON line so the parent test can parse it.
 */
import '@sumire-sr/protocol/gen/registry.ts';

const uid = process.argv[2] ?? 'sbxtest-official-' + Date.now();

const { findOrCreateIdentityByUid } = await import('../../services/auth.ts');
await import('../../services/all.ts');
const { listElements } = await import('../../services/playerState.ts');
const { getCurrency } = await import('../../services/currency.ts');
const { db } = await import('../../db/client.ts');
const { PROFILE } = await import('../../profile.ts');

const identity = await findOrCreateIdentityByUid(uid);
const [cards, costumes, musics, photoRecipes, homeTalks] = await Promise.all([
  listElements(identity.serverUserId, 'Cards', db),
  listElements(identity.serverUserId, 'Costumes', db),
  listElements(identity.serverUserId, 'Musics', db),
  listElements(identity.serverUserId, 'PhotoRecipes', db),
  listElements(identity.serverUserId, 'HomeTalks', db),
]);
const freeJewel = await getCurrency(identity.serverUserId, 'freeJewel', db);

console.log(
  JSON.stringify({
    profile: PROFILE,
    uid,
    ...identity,
    cards: cards.length,
    costumes: costumes.length,
    musics: musics.length,
    photoRecipes: photoRecipes.length,
    homeTalks: homeTalks.length,
    freeJewel,
  }),
);
process.exit(0);
