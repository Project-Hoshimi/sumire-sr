// Race phase-2 handler tests against the dev Postgres.
//
//   npm run test:race
//
// Each test seeds a throwaway account/player pair, publishes `race-26-0226`
// into an in-memory event registry with a schedule covering now (the server only
// auto-imports marathon/moshikoi drafts), then drives the registered RPC
// handlers through `getHandler` with a synthetic authenticated context. The live
// handlers are exercised for real: five high-stat cards are granted and saved as
// a race deck, so panel clears and area-quest clears are genuine simulations.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before, type TestContext } from 'node:test';
import { eq, inArray, sql } from 'drizzle-orm';
import '@sumire-sr/protocol/gen/registry.ts';
import { client, db } from '../../db/client.ts';
import { accounts, playerEntities, players } from '../../db/schema.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import {
  initEventRegistry,
  publishEventDefinition,
  resetEventRegistryForTests,
} from '../events/registry.ts';
import { memoryEventStore } from '../events/store.ts';
import { getCharacter, getCostume, listCards, listCharacters } from '../../master/index.ts';
import { getCard, getItemAmount, grantCard, grantItem } from '../inventory.ts';
import { getHandler, type RpcContext } from '../handlers.ts';
import { AppRpcError, ERROR_CODE } from '../errors.ts';
import { publicUserIdOf } from '../friendLinks.ts';
import { raceConfigFor } from './catalog.ts';
import { loadRaceFormation } from './live.ts';
import { racePlugin } from './plugin.ts';
import {
  emptyRaceState,
  loadRaceDecks,
  loadRaceState,
  markRaceInitialLogin,
  normalizeRaceState,
  saveRaceDeck,
  saveRaceState,
  type RaceState,
} from './state.ts';
import { getSingleton, listElements, putElements, putSingleton } from '../playerState.ts';
import { getRacePanel, getRacePanelReward, listRacePanels, listRaceQuestDifficulties } from './master.ts';
import { applyGrants } from '../../master/reward.ts';
import { isRivalCharacter, raceBotIdols } from './botIdols.ts';
import { nearestTier, tierUnlocked } from './tiers.ts';
import { nextTallyAt } from './tally.ts';
import type { RaceConfig } from './types.ts';
import './index.ts';

const RACE_ID = 'race-26-0226';
const PT_QUEST = 'race-qt-26-0226-pt';
const MEDAL_QUEST = 'race-qt-26-0226-medal';
const VENUS_PANEL_NUMBER = 50;
const LIVE_BONUS_ID = 'race_live_bonus-vocal_add';
const HOUR_MS = 60 * 60 * 1000;
/** `Race:ReceiveActivityLesson`'s fixed step cadence (userRaceInfo.ts). */
const STEP_MS = 10_000;

let available = false;
let config!: RaceConfig;
const created: { accountId: string; playerId: string }[] = [];
let deckCards: string[] | null = null;

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function s(value: unknown): string {
  return value == null ? '' : String(value);
}

/**
 * The absolute amount of `itemId` the handler reported in
 * `CommonResponse.UpdatedData.Items`, or `undefined` when it reported none.
 */
function updatedItemAmount(out: Record<string, unknown>, itemId: string): number | undefined {
  const common = out.CommonResponse as Decoded | undefined;
  const updated = common?.UpdatedData as Decoded | undefined;
  const rows = ((updated?.Items as Decoded[] | undefined) ?? []) as Decoded[];
  const row = rows.find((candidate) => s(candidate.ItemId) === itemId);
  return row === undefined ? undefined : n(row.Amount);
}

function ready(t: TestContext): boolean {
  if (available) return true;
  t.skip('dev postgres is not reachable; run `npm run db:migrate` and retry');
  return false;
}

before(async () => {
  try {
    await db.execute(sql`select 1`);
  } catch {
    return;
  }
  const draft = await racePlugin.importFromMaster(RACE_ID);
  const { imported } = await initEventRegistry({
    store: memoryEventStore(),
    drafts: [
      {
        kind: 'race',
        draft: {
          ...draft,
          schedule: {
            startsAt: '2026-01-01T00:00:00Z',
            endsAt: '2027-01-01T00:00:00Z',
            exchangeEndsAt: '2027-01-02T00:00:00Z',
          },
        },
      },
    ],
  });
  const loaded = raceConfigFor(RACE_ID);
  available = imported.includes(RACE_ID) && loaded !== undefined;
  if (loaded !== undefined) config = loaded;
});

after(async () => {
  if (created.length > 0) {
    const playerIds = created.map((entry) => entry.playerId);
    const accountIds = created.map((entry) => entry.accountId);
    await db.delete(playerEntities).where(inArray(playerEntities.playerId, playerIds));
    await db.delete(players).where(inArray(players.id, playerIds));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
  resetEventRegistryForTests();
  await client.end({ timeout: 5 });
});

async function newPlayer(label: string): Promise<{ accountId: string; playerId: string }> {
  const suffix = randomUUID();
  const accountId = `test-race-p2-${suffix}`;
  const playerId = `test-race-p2-player-${suffix}`;
  await db
    .insert(accounts)
    .values({ id: accountId, displayName: `phase2 ${suffix.slice(0, 8)}` })
    .onConflictDoNothing();
  await db
    .insert(players)
    .values({ id: playerId, accountId, name: `phase2-${label}-${suffix.slice(0, 8)}` })
    .onConflictDoNothing();
  const entry = { accountId, playerId };
  created.push(entry);
  return entry;
}

function rpcContext(accountId: string, request: Decoded): RpcContext {
  return {
    name: 'test',
    service: 'Race',
    method: 'test',
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

async function call(
  name: string,
  accountId: string,
  request: Decoded,
): Promise<Record<string, unknown>> {
  const handler = getHandler(name);
  return (await handler(rpcContext(accountId, request))) as Record<string, unknown>;
}

/** Load the player's race state, apply `patch`, persist it (initialized). */
async function seedState(playerId: string, patch: Partial<RaceState>): Promise<RaceState> {
  const state = { ...(await loadRaceState(playerId, RACE_ID)), ...patch };
  markRaceInitialLogin(state);
  await saveRaceState(playerId, RACE_ID, state);
  return state;
}

/**
 * Publish `race-26-0226` with `panelRewards` overrides and return a function
 * that publishes the original draft back. The handlers read the config per
 * call, so the next `MovePanel` sees the override without a restart.
 */
async function publishPanelRewards(
  panelRewards: Record<string, string[]>,
): Promise<() => Promise<void>> {
  await publishEventDefinition(RACE_ID, {
    by: 'test',
    draft: { ...config, panelRewards },
  });
  return async () => {
    await publishEventDefinition(RACE_ID, { by: 'test', draft: { ...config } });
  };
}

/**
 * Five master cards with distinct idols whose default outfit is a real live
 * costume (not an `sd-` variant), so the live appearance resolves from the
 * outfits `grantCard` spawns.
 */
async function pickDeckCards(): Promise<string[]> {
  if (deckCards) return deckCards;
  const picked = await collectPlayableCards(5);
  assert.equal(picked.length, 5, 'master data must provide five playable deck cards');
  deckCards = picked;
  return picked;
}

/**
 * The first `limit` master cards, one per idol, whose default outfit is a real
 * live costume. Ordered as `listCards` returns them, so the first five are
 * always `pickDeckCards()`.
 */
async function collectPlayableCards(limit: number): Promise<string[]> {
  const picked: string[] = [];
  const seenCharacters = new Set<string>();
  for (const row of (await listCards()) as unknown as Decoded[]) {
    const cardId = s(row.Id);
    const characterId = s(row.CharacterId);
    if (cardId === '' || characterId === '' || seenCharacters.has(characterId)) continue;
    const character = (await getCharacter(characterId)) as unknown as Decoded | null;
    if (!character) continue;
    const costumeId = s(character.DefaultLiveCostumeId) || s(character.DefaultCostumeId);
    if (costumeId === '') continue;
    const costume = (await getCostume(costumeId)) as unknown as Decoded | null;
    if (!costume || s(costume.CharacterId) !== characterId) continue;
    if (s(costume.CostumeTypeId).startsWith('sd-')) continue;
    seenCharacters.add(characterId);
    picked.push(cardId);
    if (picked.length === limit) break;
  }
  return picked;
}

/**
 * Grant five cards at the given Vocal/Dance/Visual stat and save them as race
 * deck 1. The VENUS panel difficulty test needs a deck between two clear
 * scores, so the attack stat is a parameter.
 */
async function seedDeckAtPower(playerId: string, power: number): Promise<string[]> {
  const cards = await pickDeckCards();
  await seedDeckAtPowerOn(playerId, power, 1, cards);
  return cards;
}

/** Grant `cards` at the given stat and save them as race deck `deckNumber`. */
async function seedDeckAtPowerOn(
  playerId: string,
  power: number,
  deckNumber: number,
  cards: readonly string[],
): Promise<void> {
  for (const cardId of cards) {
    await grantCard(playerId, {
      CardId: cardId,
      Level: 80,
      Rarity: 5,
      Vocal: power,
      Dance: power,
      Visual: power,
      Stamina: 2_000_000,
      Mental: 100,
      Technique: 100,
    } as Decoded);
  }
  await saveRaceDeck(playerId, RACE_ID, {
    Number: deckNumber,
    Name: 'phase2',
    Positions: cards.map((cardId, index) => ({
      Number: deckNumber,
      Position: index + 1,
      CardId: cardId,
    })),
  });
}

/** Grant a very strong five-card deck and save it as race deck 1. */
async function seedDeck(playerId: string): Promise<string[]> {
  return seedDeckAtPower(playerId, 300_000);
}

// --- panel board -----------------------------------------------------------

test('MovePanel advances to the first story panel and spends its race points', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('move');
  await grantItem(playerId, config.racePointItemId, 5000);

  const out = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  const info = out.UserRaceInfo as Decoded;
  assert.equal(out.__msg, 'Solis.Common.Proto.Api.RaceMovePanelResponse');
  // Panel 1 is the area's first story panel, so the walk ends on it.
  assert.equal(n(info.CurrentPanelNumber), 1);
  assert.equal(n(info.TotalClearPanelCount), 1);
  const after = 4000 + config.initialRacePointAmount;
  assert.equal(await getItemAmount(playerId, config.racePointItemId), after);
  // The client keeps its own race pt counter: the spend must be echoed as the
  // item's absolute amount or it keeps calling MovePanel with a stale balance.
  assert.equal(updatedItemAmount(out, config.racePointItemId), after);
});

test('MovePanel walks the whole "Advance N tile" distance to the story panel 22 tiles ahead', async (t) => {
  if (!ready(t)) return;
  // The reported case: standing on panel 3 with 37,245 race pt, the client
  // labels the button "Advance 22 tile" and animates to panel 25, the area's
  // second story panel. Panels 4..25 each cost 1,000 race points.
  const { accountId, playerId } = await newPlayer('walk');
  await seedState(playerId, { panelNumber: 3 });
  await grantItem(playerId, config.racePointItemId, 37_245);

  const out = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  const info = out.UserRaceInfo as Decoded;
  assert.equal(n(info.CurrentPanelNumber), 25);
  assert.equal(n(info.TotalClearPanelCount), 22);
  // One call charges every panel it entered: 22 panels at 1,000 pt each.
  const remaining = 37_245 - 22 * 1000;
  assert.equal(await getItemAmount(playerId, config.racePointItemId), remaining);
  assert.equal(updatedItemAmount(out, config.racePointItemId), remaining);
  // The reward panels 6, 10, 14, 17 and 21 passed on the way are granted.
  const results = out.RewardResults as Decoded[];
  assert.equal(results.length, 5, 'every reward panel on the way must be granted');
  assert.equal(await getItemAmount(playerId, 'item-race_medal-26-0226'), 2000);
  assert.equal(await getItemAmount(playerId, 'item-photo_reroll'), 2000);
  assert.equal(await getItemAmount(playerId, 'item-gacha_ticket_piece'), 10);
  assert.ok((await getItemAmount(playerId, 'item-card_skill')) > 0);

  const state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.panelNumber, 25);
  assert.equal(state.areaIndex, 0);
  assert.equal(state.pendingVenus, false);
  assert.deepEqual(state.readStoryEpisodes, [2], 'landing on panel 25 records story episode 2');
});

test('MovePanel rejects with insufficient race points and keeps the state', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('broke');
  // Already initialised (starting stock not granted here) and holding no race pt.
  await seedState(playerId, { panelNumber: 0 });

  await assert.rejects(call('Race:MovePanel', accountId, { RaceId: RACE_ID }), (error: unknown) => {
    assert.ok(error instanceof AppRpcError, 'the rejection must be a coded app error, not a plain Error');
    assert.equal(error.code, ERROR_CODE.RESOURCE_NOT_ENOUGH);
    assert.match(error.message, /Race:MovePanel: insufficient race point/);
    return true;
  });
  const state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.panelNumber, 0);
  assert.equal(state.totalClearPanelCount, 0);
  assert.equal(await getItemAmount(playerId, config.racePointItemId), 0);
});

test('MovePanel stops when the race points run out and keeps the rewards it passed', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('reward');
  await seedState(playerId, { panelNumber: 2 });
  await grantItem(playerId, config.racePointItemId, 5000);

  // Panels 3..7 all cost 1,000, so 5,000 race points buy five of them; panel 8
  // is unaffordable and ends the walk.
  const out = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  const info = out.UserRaceInfo as Decoded;
  assert.equal(n(info.CurrentPanelNumber), 7);
  assert.equal(n(info.TotalClearPanelCount), 5);
  // Panels 3 (`item-card_enhance`) and 6 (`gold`) are the reward panels passed.
  assert.equal((out.RewardResults as Decoded[]).length, 2);
  // Panel 3 of race-area-005-01 rewards `rd_auto;item;item-card_enhance;...`.
  assert.ok(
    (await getItemAmount(playerId, 'item-card_enhance')) > 0,
    'the reward panel must grant its item',
  );
  assert.equal(await getItemAmount(playerId, config.racePointItemId), 0);
  assert.equal(updatedItemAmount(out, config.racePointItemId), 0);

  // Nothing left to pay for: the next call refuses instead of moving for free.
  await assert.rejects(call('Race:MovePanel', accountId, { RaceId: RACE_ID }), (error: unknown) => {
    assert.ok(error instanceof AppRpcError);
    assert.equal(error.code, ERROR_CODE.RESOURCE_NOT_ENOUGH);
    assert.match(error.message, /Race:MovePanel: insufficient race point/);
    return true;
  });
  assert.equal((await loadRaceState(playerId, RACE_ID)).panelNumber, 7);
});

test('MovePanel grants a panelRewards override instead of the master row', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('reward-override');
  // Panel 3 of the first area is a reward panel; its master row grants
  // `item-card_enhance`, so the override grants a different amount of the same
  // item and the grant cannot be mistaken for the master one.
  await seedState(playerId, { areaIndex: 0, panelNumber: 2 });
  await grantItem(playerId, config.racePointItemId, 1000);
  const restore = await publishPanelRewards({
    [`${config.areaIds[0]}:3`]: ['rd_auto;item;item-card_enhance;7'],
  });
  try {
    const out = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
    assert.equal(n((out.UserRaceInfo as Decoded).CurrentPanelNumber), 3);
    const results = out.RewardResults as Decoded[];
    assert.equal(results.length, 1, 'one reward ref of the override is granted');
    assert.equal(s(results[0].ResourceId), 'item-card_enhance');
    assert.equal(n(results[0].AmountI64), 7);
    assert.equal(await getItemAmount(playerId, 'item-card_enhance'), 7);
  } finally {
    await restore();
  }
});

test('MovePanel keeps the master reward for a panel without an override', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('reward-master');
  // Panels 6 and 7 are reward panels; only panel 3 carries an override.
  await seedState(playerId, { areaIndex: 0, panelNumber: 5 });
  await grantItem(playerId, config.racePointItemId, 2000);
  const restore = await publishPanelRewards({
    [`${config.areaIds[0]}:3`]: ['rd_auto;item;item-card_enhance;7'],
  });
  try {
    const out = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
    assert.equal(n((out.UserRaceInfo as Decoded).CurrentPanelNumber), 7);
    assert.equal(
      (out.RewardResults as Decoded[]).length,
      1,
      'the reward panel of the walk grants its master reward',
    );
    assert.equal(
      await getItemAmount(playerId, 'item-card_enhance'),
      0,
      'the panel 3 override must not apply to another panel',
    );
    // Panel 6's master `RacePanelReward` row is still the source.
    const panels = (await listRacePanels(config.areaIds[0])) as unknown as Decoded[];
    const panel6 = panels.find((row) => n(row.Number) === 6);
    assert.ok(panel6 !== undefined);
    const masterRow = await getRacePanelReward(s(panel6.RacePanelRewardId), RACE_ID);
    assert.ok(masterRow !== null, 'panel 6 must have a master reward row');
    assert.ok(s(masterRow.RewardId) !== '');
  } finally {
    await restore();
  }
});

test('MovePanel grants a card rarity exp reward panel (ResourceType 24)', async (t) => {
  if (!ready(t)) return;
  // Areas 005-04 .. 005-15 carry `rd-race-rarity_exp-card-*` reward rows, whose
  // `Reward.Resources` use ResourceType 24 (`CardRarityExp`). Panel 20 of
  // race-area-005-04 is one: 25 exp for `card-mna-02-eve-03`.
  const { accountId, playerId } = await newPlayer('rarity-exp');
  const cardId = 'card-mna-02-eve-03';
  await grantCard(playerId, { CardId: cardId });
  const before = (await getCard(playerId, cardId)) as unknown as Decoded | null;
  assert.ok(before, 'the reward card must be owned by the test player');
  const beforeExp = n(before.RarityTotalExp);
  // ★2 → ★3 needs 35 cumulative exp; a fresh ★2 card starts at 10.
  await seedState(playerId, { areaIndex: 3, panelNumber: 19 });
  await grantItem(playerId, config.racePointItemId, 4000);

  const out = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  const info = out.UserRaceInfo as Decoded;
  assert.equal(n(info.CurrentPanelNumber), 20);
  const results = out.RewardResults as Decoded[];
  const expRows = results.filter((row) => n(row.ResourceType) === 24);
  assert.equal(expRows.length, 1, 'the rarity-exp reward must be echoed as a ResourceType 24 result');
  assert.equal(s(expRows[0].ResourceId), cardId);
  assert.equal(n(expRows[0].AmountI64), 25);
  assert.equal(n(expRows[0].BeforeAmount), beforeExp);
  // The exp is persisted on the card (auto-blooming ★2 → ★3 at 35 exp) and the
  // card is echoed in `UpdatedData` so the client refreshes it.
  const after = (await getCard(playerId, cardId)) as unknown as Decoded | null;
  assert.ok(after);
  assert.equal(n(after.RarityTotalExp), beforeExp + 25);
  assert.equal(n(after.Rarity), 3);
  const common = out.CommonResponse as Decoded;
  const updatedCards = ((common.UpdatedData as Decoded | undefined)?.Cards as Decoded[]) ?? [];
  assert.ok(
    updatedCards.some((card) => s(card.CardId) === cardId && n(card.RarityTotalExp) === beforeExp + 25),
    'the bloomed card must be echoed in UpdatedData.Cards',
  );
  assert.equal(await getItemAmount(playerId, 'item-card_limit_break'), 0);
});

test('MovePanel acquires an unowned reward card before applying its rarity exp', async (t) => {
  if (!ready(t)) return;
  // Same panel as above, but the player does not own the reward card yet: the
  // card must be granted first (standard card-grant path) and the rarity exp
  // applied to the new card — never the old "unowned → Bloom Pieces" fallback.
  const { accountId, playerId } = await newPlayer('rarity-exp-new');
  const cardId = 'card-mna-02-eve-03';
  assert.equal(await getCard(playerId, cardId), null, 'the reward card must start unowned');
  await seedState(playerId, { areaIndex: 3, panelNumber: 19 });
  await grantItem(playerId, config.racePointItemId, 4000);

  const out = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  assert.equal(n((out.UserRaceInfo as Decoded).CurrentPanelNumber), 20);
  const results = out.RewardResults as Decoded[];
  const acquired = results.find((row) => n(row.ResourceType) === 2 && s(row.ResourceId) === cardId);
  assert.ok(acquired, 'the card acquisition must be echoed as a ResourceType 2 result');
  assert.equal(acquired.IsNew, true);
  const expRows = results.filter((row) => n(row.ResourceType) === 24);
  assert.equal(expRows.length, 1, 'the rarity exp must still be echoed as a ResourceType 24 result');
  assert.equal(s(expRows[0].ResourceId), cardId);
  assert.equal(n(expRows[0].AmountI64), 25);

  // The granted card is a fresh ★2 (10 exp); +25 auto-blooms it to ★3 at 35.
  const owned = (await getCard(playerId, cardId)) as unknown as Decoded | null;
  assert.ok(owned, 'the card must be owned after the reward');
  assert.equal(n(owned.RarityTotalExp), 35);
  assert.equal(n(owned.Rarity), 3);
  assert.equal(await getItemAmount(playerId, 'item-card_limit_break'), 0);
  const updatedCards =
    ((out.CommonResponse as Decoded).UpdatedData as Decoded | undefined)?.Cards as Decoded[] | undefined;
  assert.ok(
    (updatedCards ?? []).some((card) => s(card.CardId) === cardId && n(card.RarityTotalExp) === 35),
    'the bloomed, newly granted card must be echoed in UpdatedData.Cards',
  );
});

test('applyGrants applies unowned CardRarityExpLimitChange (25) to the acquired card', async (t) => {
  if (!ready(t)) return;
  const { playerId } = await newPlayer('bloom-unowned');
  const cardId = 'card-mna-02-eve-03';
  assert.equal(await getCard(playerId, cardId), null, 'the card must start unowned');

  const applied = await applyGrants(playerId, [{ resourceType: 25, resourceId: cardId, amount: 100 }]);
  const results = applied.results as Decoded[];
  const acquired = results.find((row) => n(row.ResourceType) === 2 && s(row.ResourceId) === cardId);
  assert.ok(acquired, 'the card acquisition must be echoed as a ResourceType 2 result');
  assert.equal(acquired.IsNew, true);
  const ptRows = results.filter((row) => n(row.ResourceType) === 25);
  assert.equal(ptRows.length, 1, 'the bloom Pt must still be echoed as a ResourceType 25 result');
  assert.equal(s(ptRows[0].ResourceId), cardId);

  // Fresh ★2 (10 exp) + 100 blooms at least once; nothing overflows ★10.
  const owned = (await getCard(playerId, cardId)) as unknown as Decoded | null;
  assert.ok(owned, 'the card must be owned after the bloom Pt');
  assert.ok(n(owned.Rarity) > 2, 'the granted card must auto-bloom with the applied Pt');
  assert.equal(n(owned.RarityTotalExp), 110);
  assert.equal(await getItemAmount(playerId, 'item-card_limit_break'), 0);
  const updatedCards = (applied.updated as Decoded | null)?.Cards as Decoded[] | undefined;
  assert.ok(
    (updatedCards ?? []).some((card) => s(card.CardId) === cardId && n(card.RarityTotalExp) === 110),
    'the bloomed card must be echoed in UpdatedData.Cards',
  );
});

test('rarity exp past the ★10 cap still converts to Bloom Pieces (24 and 25)', async (t) => {
  if (!ready(t)) return;
  const { playerId } = await newPlayer('rarity-overflow');
  const cardId = 'card-mna-02-eve-03';
  // A ★10 card already holding the cap.
  await grantCard(playerId, { CardId: cardId, Rarity: 10, RarityTotalExp: 1210 } as Decoded);

  const rarityExp = await applyGrants(playerId, [{ resourceType: 24, resourceId: cardId, amount: 30 }]);
  assert.equal(await getItemAmount(playerId, 'item-card_limit_break'), 30);
  assert.ok(
    (rarityExp.results as Decoded[]).some((row) => n(row.ResourceType) === 1 && s(row.ResourceId) === 'item-card_limit_break'),
    'the type-24 overflow must be echoed as a Bloom Piece item result',
  );

  const bloomPt = await applyGrants(playerId, [{ resourceType: 25, resourceId: cardId, amount: 45 }]);
  assert.equal(await getItemAmount(playerId, 'item-card_limit_break'), 75);
  assert.ok(
    (bloomPt.results as Decoded[]).some((row) => n(row.ResourceType) === 1 && s(row.ResourceId) === 'item-card_limit_break'),
    'the type-25 overflow must be echoed as a Bloom Piece item result',
  );
  const owned = (await getCard(playerId, cardId)) as unknown as Decoded | null;
  assert.ok(owned);
  assert.equal(n(owned.Rarity), 10);
  assert.equal(n(owned.RarityTotalExp), 1210, 'the card exp must stay pinned to the ★10 cap');
});

test('MovePanel stops on the VENUS panel that ends the area', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('venus-walk');
  await seedState(playerId, { panelNumber: 45 });
  await grantItem(playerId, config.racePointItemId, 6000);

  // 46..49 cost 1,000 each and panel 50 (VENUS) costs 1,500: the walk enters it
  // and stops there instead of wrapping into the next area.
  const moved = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  const info = moved.UserRaceInfo as Decoded;
  assert.equal(n(info.CurrentPanelNumber), VENUS_PANEL_NUMBER);
  // The VENUS panel only counts once its live is cleared.
  assert.equal(n(info.TotalClearPanelCount), 4);
  assert.equal(await getItemAmount(playerId, config.racePointItemId), 500);
  // Panel 47 is the only reward panel of 46..50.
  const results = moved.RewardResults as Decoded[];
  assert.equal(results.length, 1);
  assert.equal(await getItemAmount(playerId, 'item-card_support_release'), 1000);
  const state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.panelNumber, VENUS_PANEL_NUMBER);
  assert.equal(state.pendingVenus, true);

  await assert.rejects(call('Race:MovePanel', accountId, { RaceId: RACE_ID }), (error: Error) => {
    assert.match(error.message, /the VENUS panel live must be cleared first/);
    return true;
  });
});

// --- stepping onto an adjacent VENUS panel from Race:Top ---------------------

/** The type-3 panel at `VENUS_PANEL_NUMBER` of the first area, as master data. */
async function firstAreaVenusPanel(): Promise<Decoded> {
  const panel = (await getRacePanel(config.areaIds[0], VENUS_PANEL_NUMBER)) as unknown as Decoded;
  assert.equal(n(panel.Type), 3, 'panel 50 of the first area must be the VENUS panel');
  return panel;
}

test('Race:Top steps onto the adjacent VENUS panel once the player can pay for it', async (t) => {
  if (!ready(t)) return;
  // Reported case: the walk stopped on the panel right before the VENUS panel
  // with too few race points; the client showed "Advance 0 tile" forever and
  // never sent MovePanel again, even after earning enough race points.
  const { accountId, playerId } = await newPlayer('venus-autostep');
  const areaId = config.areaIds[0];
  const panel = await firstAreaVenusPanel();
  const cost = n(panel.RequiredRacePointAmount);
  assert.ok(cost > 0, 'the VENUS panel must have a race point cost');
  const balance = cost + 500;
  await seedState(playerId, { panelNumber: VENUS_PANEL_NUMBER - 1, pendingVenus: false });
  await grantItem(playerId, config.racePointItemId, balance);

  const top = await call('Race:Top', accountId, { RaceId: RACE_ID });
  const info = top.UserRaceInfo as Decoded;
  assert.equal(s(info.CurrentAreaId), areaId);
  assert.equal(n(info.CurrentPanelNumber), VENUS_PANEL_NUMBER);
  // A freshly entered VENUS panel is not cleared: the client offers the live.
  assert.equal(n(info.CurrentLivePanelScore), 0);
  // The consumed race pt is reported the same way MovePanel reports a spend.
  assert.equal(updatedItemAmount(top, config.racePointItemId), balance - cost);
  assert.equal(await getItemAmount(playerId, config.racePointItemId), balance - cost);

  const state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.areaIndex, 0);
  assert.equal(state.panelNumber, VENUS_PANEL_NUMBER);
  assert.equal(state.pendingVenus, true);
  assert.equal(state.currentLivePanelScore, 0);
  // Like the walk, entering the VENUS panel does not count it as cleared.
  assert.equal(state.totalClearPanelCount, 0);

  // The board is now locked on the VENUS panel, as if the walk had entered it.
  await assert.rejects(call('Race:MovePanel', accountId, { RaceId: RACE_ID }), (error: Error) => {
    assert.match(error.message, /the VENUS panel live must be cleared first/);
    return true;
  });
});

test('Race:Top leaves the piece before the VENUS panel when it cannot pay for it', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('venus-autostep-short');
  const cost = n((await firstAreaVenusPanel()).RequiredRacePointAmount);
  const balance = cost - 1;
  await seedState(playerId, { panelNumber: VENUS_PANEL_NUMBER - 1, pendingVenus: false });
  await grantItem(playerId, config.racePointItemId, balance);

  const top = await call('Race:Top', accountId, { RaceId: RACE_ID });
  const info = top.UserRaceInfo as Decoded;
  assert.equal(n(info.CurrentPanelNumber), VENUS_PANEL_NUMBER - 1);
  // Nothing was spent, so no item row is reported.
  assert.equal(updatedItemAmount(top, config.racePointItemId), undefined);
  assert.equal(await getItemAmount(playerId, config.racePointItemId), balance);
  const state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.panelNumber, VENUS_PANEL_NUMBER - 1);
  assert.equal(state.pendingVenus, false);
});

test('Race:Top does not step when the next panel is not a VENUS panel', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('venus-autostep-normal');
  const nextPanel = (await getRacePanel(config.areaIds[0], 2)) as unknown as Decoded;
  assert.notEqual(n(nextPanel.Type), 3, 'panel 2 must not be a VENUS panel');
  await seedState(playerId, { panelNumber: 1, pendingVenus: false });
  await grantItem(playerId, config.racePointItemId, 5000);

  const top = await call('Race:Top', accountId, { RaceId: RACE_ID });
  assert.equal(n((top.UserRaceInfo as Decoded).CurrentPanelNumber), 1);
  assert.equal(updatedItemAmount(top, config.racePointItemId), undefined);
  assert.equal(await getItemAmount(playerId, config.racePointItemId), 5000);
  const state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.panelNumber, 1);
  assert.equal(state.pendingVenus, false);
});

test('Race:Top does not step when a VENUS panel is already pending', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('venus-autostep-pending');
  await seedState(playerId, { panelNumber: VENUS_PANEL_NUMBER, pendingVenus: true });
  await grantItem(playerId, config.racePointItemId, 5000);

  const top = await call('Race:Top', accountId, { RaceId: RACE_ID });
  const info = top.UserRaceInfo as Decoded;
  assert.equal(n(info.CurrentPanelNumber), VENUS_PANEL_NUMBER);
  assert.equal(updatedItemAmount(top, config.racePointItemId), undefined);
  assert.equal(await getItemAmount(playerId, config.racePointItemId), 5000);
  const state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.panelNumber, VENUS_PANEL_NUMBER);
  assert.equal(state.pendingVenus, true);
});

test('MovePanel blocks on a VENUS panel until StartLivePanelQuest clears it', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('venus');
  const cards = await seedDeck(playerId);
  await seedState(playerId, { panelNumber: VENUS_PANEL_NUMBER - 1 });
  await grantItem(playerId, config.racePointItemId, 5000);

  const moved = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  const movedInfo = moved.UserRaceInfo as Decoded;
  assert.equal(n(movedInfo.CurrentPanelNumber), VENUS_PANEL_NUMBER);
  // The VENUS panel only counts once its live is cleared.
  assert.equal(n(movedInfo.TotalClearPanelCount), 0);
  let state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.pendingVenus, true);

  await assert.rejects(call('Race:MovePanel', accountId, { RaceId: RACE_ID }), (error: Error) => {
    assert.match(error.message, /the VENUS panel live must be cleared first/);
    return true;
  });

  const cleared = await call('Race:StartLivePanelQuest', accountId, {
    RaceId: RACE_ID,
    DeckNumber: 1,
  });
  assert.equal((cleared.Result as Decoded).Cleared, true);
  const clearedInfo = cleared.UserRaceInfo as Decoded;
  assert.equal(n(clearedInfo.TotalClearPanelCount), 1);
  assert.equal(
    ((clearedInfo.CardCoolTimeInfos as Decoded[]) ?? []).length,
    5,
    'a cleared panel puts the whole deck on cool time',
  );
  state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.pendingVenus, false);
  for (const cardId of cards) assert.ok(state.cardCoolTimes[cardId] > Date.now());
});

test('MovePanel clears the VENUS stage score when it lands on the next area VENUS panel', async (t) => {
  if (!ready(t)) return;
  // Reported case: area 005-01's VENUS live was cleared with a score far above
  // area 005-02's VENUS `ClearScore`, then the player walked to that next VENUS
  // panel. The client derives "this VENUS live is cleared" from
  // `UserRaceInfo.CurrentLivePanelScore` only, so carrying the previous panel's
  // score over made it offer "Advance" instead of the VENUS live, and the next
  // `Race:MovePanel` was refused with "the VENUS panel live must be cleared
  // first".
  const { accountId, playerId } = await newPlayer('venus-next-area');
  await seedDeck(playerId);
  await seedState(playerId, { panelNumber: VENUS_PANEL_NUMBER - 1 });
  await grantItem(playerId, config.racePointItemId, 200_000);

  const firstVenus = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  assert.equal(n((firstVenus.UserRaceInfo as Decoded).CurrentPanelNumber), VENUS_PANEL_NUMBER);
  const firstClear = await call('Race:StartLivePanelQuest', accountId, {
    RaceId: RACE_ID,
    DeckNumber: 1,
  });
  assert.equal((firstClear.Result as Decoded).Cleared, true);
  const firstScore = n((firstClear.UserRaceInfo as Decoded).CurrentLivePanelScore);
  // The next area's VENUS panel is ranked at the configured panel difficulty.
  const nextAreaId = config.areaIds[1];
  const nextVenusPanel = (await getRacePanel(nextAreaId, VENUS_PANEL_NUMBER)) as unknown as Decoded;
  const nextQuestId = s(nextVenusPanel.RaceQuestId);
  const nextDifficulties = (await listRaceQuestDifficulties(nextQuestId)) as unknown as Decoded[];
  const nextTier = nearestTier(nextDifficulties, config.livePanelDifficultyNumber);
  const nextClearScore = n(
    nextDifficulties.find((row) => n(row.DifficultyNumber) === nextTier)?.ClearScore,
  );
  assert.ok(nextClearScore > 0, 'the next area VENUS panel must have a clear score');
  assert.ok(
    firstScore > nextClearScore,
    `the previous score ${firstScore} must exceed the next panel's clear score ${nextClearScore} to reproduce the client state`,
  );

  // Leave the cleared panel: the walk wraps into the next area and stops on its
  // story panel 25.
  const story = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  const storyInfo = story.UserRaceInfo as Decoded;
  assert.equal(s(storyInfo.CurrentAreaId), nextAreaId);
  assert.equal(n(storyInfo.CurrentPanelNumber), 25);
  let state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.areaIndex, 1);
  assert.equal(state.pendingVenus, false);

  // The next walk lands on the next area's VENUS panel. Its stage score must be
  // empty again: no live has been played on *this* panel.
  const nextVenus = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  const nextInfo = nextVenus.UserRaceInfo as Decoded;
  assert.equal(n(nextInfo.CurrentPanelNumber), VENUS_PANEL_NUMBER);
  assert.equal(
    n(nextInfo.CurrentLivePanelScore),
    0,
    'a freshly entered VENUS panel must not inherit the previous panel score',
  );
  state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.currentLivePanelScore, 0);
  assert.equal(state.pendingVenus, true);

  // The client now shows the VENUS live, and the board stays locked until it is
  // cleared; the stale-score Advance that hit 3024 is gone.
  await assert.rejects(call('Race:MovePanel', accountId, { RaceId: RACE_ID }), (error: Error) => {
    assert.match(error.message, /the VENUS panel live must be cleared first/);
    return true;
  });
});

test('MovePanel drops the VENUS stage score once the walk leaves the cleared panel', async (t) => {
  if (!ready(t)) return;
  const staleScore = 1_480_513_339;
  const { accountId, playerId } = await newPlayer('venus-leave');
  await seedState(playerId, {
    panelNumber: VENUS_PANEL_NUMBER,
    pendingVenus: false,
    currentLivePanelScore: staleScore,
  });
  await grantItem(playerId, config.racePointItemId, 100_000);

  // While the piece stands on the cleared VENUS panel the client still needs
  // the total to compare it with the panel's `ClearScore`.
  const before = await call('Race:Top', accountId, { RaceId: RACE_ID });
  const beforeInfo = before.UserRaceInfo as Decoded;
  assert.equal(n(beforeInfo.CurrentPanelNumber), VENUS_PANEL_NUMBER);
  assert.equal(n(beforeInfo.CurrentLivePanelScore), staleScore);

  // Walk off it: the wrap enters the next area and stops on its story panel 25.
  const moved = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  const movedInfo = moved.UserRaceInfo as Decoded;
  assert.equal(s(movedInfo.CurrentAreaId), config.areaIds[1]);
  assert.equal(n(movedInfo.CurrentPanelNumber), 25);
  assert.equal(
    n(movedInfo.CurrentLivePanelScore),
    0,
    'leaving the VENUS panel must drop its stage score from UserRaceInfo',
  );
  const state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.currentLivePanelScore, 0, 'the walk must zero the stored total');

  const top = await call('Race:Top', accountId, { RaceId: RACE_ID });
  assert.equal(n((top.UserRaceInfo as Decoded).CurrentLivePanelScore), 0);
});

test('Race:Top reports 0 for a stale VENUS total while on a normal panel', async (t) => {
  if (!ready(t)) return;
  const staleScore = 1_480_513_339;
  const { accountId, playerId } = await newPlayer('venus-stale');
  // A save written before the walk reset still holds the previous VENUS
  // panel's total while the piece stands on an empty panel.
  await seedState(playerId, { panelNumber: 2, currentLivePanelScore: staleScore });
  const panel = (await getRacePanel(config.areaIds[0], 2)) as unknown as Decoded;
  assert.notEqual(n(panel.Type), 3, 'the seeded panel must not be a VENUS panel');

  const top = await call('Race:Top', accountId, { RaceId: RACE_ID });
  const info = top.UserRaceInfo as Decoded;
  assert.equal(n(info.CurrentPanelNumber), 2);
  assert.equal(
    n(info.CurrentLivePanelScore),
    0,
    'a non-VENUS panel must not report the stored total',
  );
  // This is a read-path filter only: the stored value must stay untouched.
  const state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.currentLivePanelScore, staleScore);
});

// --- per-player VENUS difficulty --------------------------------------------

test('Race:Top freezes the sandbox BIG4 difficulty (tier 7) for a player with no VENUS points', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('difficulty-none');

  const out = await call('Race:Top', accountId, { RaceId: RACE_ID });
  // In sandbox every player is BIG4 (hie-001), which is tier 7.
  assert.equal(n((out.RaceInfo as Decoded).LivePanelDifficultyNumber), 7);
  const state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.difficultyNumber, 7, 'the first open freezes the difficulty into the state');
});

test('Race:Top never re-derives a frozen difficulty', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('difficulty-freeze');

  const first = await call('Race:Top', accountId, { RaceId: RACE_ID });
  assert.equal(n((first.RaceInfo as Decoded).LivePanelDifficultyNumber), 7);
  assert.equal((await loadRaceState(playerId, RACE_ID)).difficultyNumber, 7);

  // Simulate a value frozen earlier: overwrite the stored tier directly.
  const frozen = await loadRaceState(playerId, RACE_ID);
  frozen.difficultyNumber = 5;
  await saveRaceState(playerId, RACE_ID, frozen);

  const second = await call('Race:Top', accountId, { RaceId: RACE_ID });
  assert.equal(n((second.RaceInfo as Decoded).LivePanelDifficultyNumber), 5);
  assert.equal((await loadRaceState(playerId, RACE_ID)).difficultyNumber, 5);
});

test('the VENUS panel live plays at the difficulty frozen into the state', async (t) => {
  if (!ready(t)) return;
  // The next-area test's setup (a five-card deck on the area's VENUS panel),
  // with the difficulty pinned. The deck is tuned to sit between the two clear
  // scores: its live scores ~2.0M, so tier 1 (1,080,000) is cleared and tier 7
  // (40,800,000) is not.
  const areaId = config.areaIds[0];
  const venusPanel = (await getRacePanel(areaId, VENUS_PANEL_NUMBER)) as unknown as Decoded;
  const questId = s(venusPanel.RaceQuestId);
  const difficulties = (await listRaceQuestDifficulties(questId)) as unknown as Decoded[];
  const clearScoreOf = (tier: number): number =>
    n(difficulties.find((row) => n(row.DifficultyNumber) === tier)?.ClearScore);
  assert.ok(
    clearScoreOf(1) > 0 && clearScoreOf(7) > clearScoreOf(1) * 10,
    'tier 1 must have a clear score far below tier 7',
  );

  const play = async (label: string, difficultyNumber: number) => {
    const { accountId, playerId } = await newPlayer(label);
    await seedDeckAtPower(playerId, 10_000);
    await seedState(playerId, {
      panelNumber: VENUS_PANEL_NUMBER,
      pendingVenus: true,
      difficultyNumber,
    });
    const out = await call('Race:StartLivePanelQuest', accountId, {
      RaceId: RACE_ID,
      DeckNumber: 1,
    });
    const result = out.Result as Decoded;
    const userInfos = (result.UserInfos as Decoded[] | undefined) ?? [];
    const score = n((userInfos[0]?.UserResult as Decoded | undefined)?.Score);
    return { playerId, result, score };
  };

  const hard = await play('difficulty-venus-7', 7);
  assert.equal(
    hard.result.Cleared,
    false,
    `tier 7 (ClearScore ${clearScoreOf(7)}) must not be cleared; score ${hard.score}`,
  );
  assert.ok(hard.score < clearScoreOf(7), `score ${hard.score} is below ${clearScoreOf(7)}`);
  let state = await loadRaceState(hard.playerId, RACE_ID);
  assert.equal(state.pendingVenus, true, 'a failed VENUS live leaves the panel pending');
  assert.equal(state.totalClearPanelCount, 0);
  assert.equal(state.difficultyNumber, 7, 'the failed live keeps the frozen difficulty');

  const easy = await play('difficulty-venus-1', 1);
  assert.equal(
    easy.result.Cleared,
    true,
    `tier 1 (ClearScore ${clearScoreOf(1)}) must be cleared; score ${easy.score}`,
  );
  assert.ok(easy.score >= clearScoreOf(1), `score ${easy.score} reaches ${clearScoreOf(1)}`);
  state = await loadRaceState(easy.playerId, RACE_ID);
  assert.equal(state.pendingVenus, false);
  assert.equal(state.totalClearPanelCount, 1);
  assert.equal(state.difficultyNumber, 1, 'the cleared live keeps the frozen difficulty');
});

test('a failed VENUS panel live puts the used cards on cool time', async (t) => {
  if (!ready(t)) return;
  // Same weak deck as the tier-7 case above: the live scores ~2.0M against a
  // 40.8M clear score, so it fails. Officially the whole deck still goes on
  // cool time, so the AUTO formation cannot retry with the same cards.
  const { accountId, playerId } = await newPlayer('venus-fail-cool');
  const playable = await collectPlayableCards(10);
  assert.equal(playable.length, 10, 'master data must provide ten playable deck cards');
  const firstDeck = playable.slice(0, 5);
  const secondDeck = playable.slice(5);
  await seedDeckAtPowerOn(playerId, 10_000, 1, firstDeck);
  await seedState(playerId, {
    panelNumber: VENUS_PANEL_NUMBER,
    pendingVenus: true,
    difficultyNumber: 7,
  });

  const failed = await call('Race:StartLivePanelQuest', accountId, {
    RaceId: RACE_ID,
    DeckNumber: 1,
  });
  assert.equal((failed.Result as Decoded).Cleared, false, 'the weak deck must fail tier 7');
  const failedInfo = failed.UserRaceInfo as Decoded;
  const coolRows = (failedInfo.CardCoolTimeInfos as Decoded[]) ?? [];
  assert.deepEqual(
    new Set(coolRows.map((row) => s(row.CardId))),
    new Set(firstDeck),
    'the failed response must list every used card on cool time',
  );
  let state = await loadRaceState(playerId, RACE_ID);
  for (const cardId of firstDeck) {
    assert.ok(
      n(state.cardCoolTimes[cardId]) > Date.now(),
      `a failed live must still put ${cardId} on cool time`,
    );
  }
  assert.equal(state.pendingVenus, true, 'a failed VENUS live leaves the panel pending');
  assert.equal(state.totalClearPanelCount, 0);

  // An immediate retry with the same cards is refused.
  await assert.rejects(
    call('Race:StartLivePanelQuest', accountId, { RaceId: RACE_ID, DeckNumber: 1 }),
    (error: Error) => {
      assert.match(error.message, /card .* is on cool time/);
      return true;
    },
  );

  // A retry with a different deck is accepted (and fails again on tier 7).
  await seedDeckAtPowerOn(playerId, 10_000, 2, secondDeck);
  const retry = await call('Race:StartLivePanelQuest', accountId, {
    RaceId: RACE_ID,
    DeckNumber: 2,
  });
  assert.equal((retry.Result as Decoded).Cleared, false);
  state = await loadRaceState(playerId, RACE_ID);
  for (const cardId of secondDeck) {
    assert.ok(n(state.cardCoolTimes[cardId]) > Date.now(), 'the retried deck is also cooled down');
  }
});

test('VENUS panel attempts add up toward the clear score', async (t) => {
  if (!ready(t)) return;
  // Tier 7's clear score (40.8M) is far above one weak attempt (~2.0M), so a
  // single attempt can never clear it: the panel has to add attempts up.
  const areaId = config.areaIds[0];
  const venusPanel = (await getRacePanel(areaId, VENUS_PANEL_NUMBER)) as unknown as Decoded;
  const questId = s(venusPanel.RaceQuestId);
  const difficulties = (await listRaceQuestDifficulties(questId)) as unknown as Decoded[];
  const clearScore = n(difficulties.find((row) => n(row.DifficultyNumber) === 7)?.ClearScore);
  assert.ok(clearScore > 1_000_000, `tier 7 must have a large clear score (got ${clearScore})`);

  const { accountId, playerId } = await newPlayer('venus-sum');
  const playable = await collectPlayableCards(10);
  assert.equal(playable.length, 10, 'master data must provide ten playable deck cards');
  const firstDeck = playable.slice(0, 5);
  const secondDeck = playable.slice(5);
  await seedDeckAtPowerOn(playerId, 10_000, 1, firstDeck);
  await seedDeckAtPowerOn(playerId, 10_000, 2, secondDeck);
  await seedState(playerId, {
    panelNumber: VENUS_PANEL_NUMBER,
    pendingVenus: true,
    difficultyNumber: 7,
  });

  const attemptScore = (out: Record<string, unknown>): number => {
    const result = out.Result as Decoded;
    const userInfos = (result.UserInfos as Decoded[] | undefined) ?? [];
    return n((userInfos[0]?.UserResult as Decoded | undefined)?.Score);
  };

  // Attempt 1: scores far below the clear score, so the panel stays pending and
  // its score becomes the running total.
  const first = await call('Race:StartLivePanelQuest', accountId, {
    RaceId: RACE_ID,
    DeckNumber: 1,
  });
  const firstResult = first.Result as Decoded;
  const firstScore = attemptScore(first);
  assert.ok(
    firstScore > 0 && firstScore < clearScore,
    `the first attempt (${firstScore}) must score below ${clearScore}`,
  );
  assert.equal(firstResult.Cleared, false, 'one attempt below the clear score must not clear the panel');
  assert.equal(n(first.BeforeScore), 0, 'the first attempt starts from an empty panel total');
  assert.equal(
    n((first.UserRaceInfo as Decoded).CurrentLivePanelScore),
    firstScore,
    'the response must report the accumulated panel total, not the attempt score repeatedly',
  );
  let state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.currentLivePanelScore, firstScore, 'a failed attempt stores its score as the running total');
  assert.equal(state.pendingVenus, true);
  assert.equal(state.totalClearPanelCount, 0);

  // The live score depends on a random chart seed, so two real ~2.0M attempts
  // can never be made to cross 40.8M by construction. Top the stored total up
  // to one point short of the clear score instead: any positive second attempt
  // then crosses it deterministically. The attempts below are asserted to stay
  // under the clear score on their own.
  const toppedUp = clearScore - 1;
  await seedState(playerId, { currentLivePanelScore: toppedUp });

  // Attempt 2 must use another deck: attempt 1 put the first one on cool time.
  const second = await call('Race:StartLivePanelQuest', accountId, {
    RaceId: RACE_ID,
    DeckNumber: 2,
  });
  const secondResult = second.Result as Decoded;
  const secondScore = attemptScore(second);
  assert.ok(
    secondScore > 0 && secondScore < clearScore,
    `the second attempt (${secondScore}) must also stay below ${clearScore} on its own`,
  );
  assert.equal(
    secondResult.Cleared,
    true,
    'the running total reaches the clear score even though this attempt alone does not',
  );
  assert.equal(n(second.BeforeScore), toppedUp, 'BeforeScore reports the total carried into the attempt');
  const secondInfo = second.UserRaceInfo as Decoded;
  assert.equal(
    n(secondInfo.CurrentLivePanelScore),
    toppedUp + secondScore,
    'CurrentLivePanelScore reports the accumulated total',
  );
  assert.equal(n(secondInfo.TotalClearPanelCount), 1, 'the cleared panel is counted');
  assert.equal(n(secondInfo.CurrentPanelNumber), VENUS_PANEL_NUMBER);
  state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.pendingVenus, false, 'the board unlocks after the cumulative clear');
  assert.equal(state.totalClearPanelCount, 1);
  const storedTotal = toppedUp + secondScore;
  assert.ok(storedTotal >= clearScore, `the stored total ${storedTotal} must reach ${clearScore}`);
  assert.equal(
    state.currentLivePanelScore,
    storedTotal,
    'the stored total keeps the clearing attempt so the board shows the panel as cleared',
  );

  // The cleared panel must keep reading as cleared: the next `Race:Top` still
  // reports the same total, which is >= the panel's ClearScore.
  const top = await call('Race:Top', accountId, { RaceId: RACE_ID });
  const topInfo = top.UserRaceInfo as Decoded;
  assert.equal(n(topInfo.CurrentPanelNumber), VENUS_PANEL_NUMBER);
  assert.equal(
    n(topInfo.CurrentLivePanelScore),
    storedTotal,
    'Race:Top keeps reporting the cleared total, not 0',
  );
  assert.ok(
    n(topInfo.CurrentLivePanelScore) >= clearScore,
    `Race:Top's total ${n(topInfo.CurrentLivePanelScore)} must stay at or above ${clearScore}`,
  );

  // The reset now lives in `board.ts`: walking onto the next VENUS panel starts
  // that panel from 0. Reaching it from here needs a wrap into the next area and
  // two walks (not cheap), and the earlier test
  // 'MovePanel clears the VENUS stage score when it lands on the next area VENUS panel'
  // already asserts it.
});

// --- looping last area ------------------------------------------------------

test('MovePanel wraps the last area back to its panel 1 and counts a loop lap', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('loop-wrap');
  const lastAreaIndex = config.areaIds.length - 1;
  const lastAreaId = config.areaIds[lastAreaIndex];
  const panels = (await listRacePanels(lastAreaId)) as unknown as Decoded[];
  const lastPanelNumber = n(panels[panels.length - 1].Number);
  assert.equal(
    n(panels[panels.length - 1].Type),
    3,
    'the last panel of the last area must be a VENUS panel',
  );
  const firstVenusNumber = n(panels.find((row) => n(row.Type) === 3)?.Number);
  const firstLapCost = panels
    .filter((row) => n(row.Number) <= firstVenusNumber)
    .reduce((sum, row) => sum + n(row.RequiredRacePointAmount), 0);

  // The state left by clearing the last VENUS panel: standing on it, its live
  // no longer pending.
  await seedState(playerId, {
    areaIndex: lastAreaIndex,
    panelNumber: lastPanelNumber,
    totalClearPanelCount: 75,
  });
  await grantItem(playerId, config.racePointItemId, 2_000_000);

  // The old handler threw "the race board has no next panel" here; the board
  // now loops to panel 1 of the same area and walks to its first VENUS panel.
  const out = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  const info = out.UserRaceInfo as Decoded;
  assert.equal(s(info.CurrentAreaId), lastAreaId);
  assert.equal(n(info.CurrentPanelNumber), firstVenusNumber);
  assert.equal(n(info.TotalClearPanelCount), 75 + firstVenusNumber - 1);
  assert.equal(await getItemAmount(playerId, config.racePointItemId), 2_000_000 - firstLapCost);
  assert.ok(
    (out.RewardResults as Decoded[]).length > 0,
    'the loop lap re-grants the reward panels it passes',
  );
  let state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.areaIndex, lastAreaIndex, 'a loop never changes the area');
  assert.equal(state.panelNumber, firstVenusNumber);
  assert.equal(state.loopCount, 1);
  assert.equal(state.pendingVenus, true);

  // The VENUS panel still locks the loop lap until its live is cleared.
  await assert.rejects(call('Race:MovePanel', accountId, { RaceId: RACE_ID }), (error: Error) => {
    assert.match(error.message, /the VENUS panel live must be cleared first/);
    return true;
  });

  // Clearing it and walking off the last panel again counts the next lap.
  await seedState(playerId, {
    areaIndex: lastAreaIndex,
    panelNumber: lastPanelNumber,
    loopCount: 1,
    pendingVenus: false,
  });
  await grantItem(playerId, config.racePointItemId, 2_000_000);
  await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.loopCount, 2);
  assert.equal(state.areaIndex, lastAreaIndex);
  assert.equal(state.panelNumber, firstVenusNumber);
});

test('MovePanel re-grants the last area reward panels on the second lap', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('loop-reward');
  const lastAreaIndex = config.areaIds.length - 1;
  const panels = (await listRacePanels(config.areaIds[lastAreaIndex])) as unknown as Decoded[];
  const lastPanelNumber = n(panels[panels.length - 1].Number);
  const firstVenusNumber = n(panels.find((row) => n(row.Type) === 3)?.Number);

  // First pass: from before panel 1 up to the area's first VENUS panel.
  await seedState(playerId, { areaIndex: lastAreaIndex, panelNumber: 0 });
  await grantItem(playerId, config.racePointItemId, 2_000_000);
  const firstPass = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  const firstPassResults = firstPass.RewardResults as Decoded[];
  assert.ok(firstPassResults.length > 0, 'the first pass grants the reward panels');
  assert.equal(n((firstPass.UserRaceInfo as Decoded).CurrentPanelNumber), firstVenusNumber);
  const firstPassMedals = await getItemAmount(playerId, 'item-race_medal-26-0226');
  assert.ok(firstPassMedals > 0, 'a reward panel of the lap grants race medals');

  // The state after clearing the area's last VENUS panel: the next call is the
  // board's second lap.
  await seedState(playerId, {
    areaIndex: lastAreaIndex,
    panelNumber: lastPanelNumber,
    totalClearPanelCount: 75,
    pendingVenus: false,
  });
  const secondPass = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  const secondPassResults = secondPass.RewardResults as Decoded[];
  // The first lap also reports one-time unlocks (IsNew card, idol, costume,
  // hair) for a card reward the player did not own yet; compare panel grants only.
  const panelGrants = (rows: Decoded[]) => rows.filter((row) => row.IsNew !== true).length;
  assert.equal(
    panelGrants(secondPassResults),
    panelGrants(firstPassResults),
    'every reward panel of the lap is granted again',
  );
  assert.ok(
    (await getItemAmount(playerId, 'item-race_medal-26-0226')) > firstPassMedals,
    'the second lap grants the medal rewards again',
  );
  assert.equal(n((secondPass.UserRaceInfo as Decoded).CurrentPanelNumber), firstVenusNumber);
  assert.equal((await loadRaceState(playerId, RACE_ID)).loopCount, 1);
});

test('MovePanel passes story panels through on a loop lap but stops on the first pass', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('loop-story');
  // The first area has story panels 1 and 25; `loopCount > 0` is what switches
  // the walk to the last-area loop rules (the first area itself never loops).
  await seedState(playerId, { panelNumber: 0, readStoryEpisodes: [] });
  await grantItem(playerId, config.racePointItemId, 100_000);
  const firstPass = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  assert.equal(
    n((firstPass.UserRaceInfo as Decoded).CurrentPanelNumber),
    1,
    'the first pass stops on the area story panel 1',
  );
  let state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.loopCount, 0);
  assert.deepEqual(state.readStoryEpisodes, [1], 'the first pass records the story episode');

  // Second lap: stories 1 and 25 are pass-throughs that still cost their race
  // point and count as cleared panels; the walk ends on VENUS panel 50.
  await seedState(playerId, {
    panelNumber: 0,
    loopCount: 1,
    totalClearPanelCount: 0,
    readStoryEpisodes: [],
  });
  const secondPass = await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  const info = secondPass.UserRaceInfo as Decoded;
  assert.equal(n(info.CurrentPanelNumber), VENUS_PANEL_NUMBER);
  assert.equal(n(info.TotalClearPanelCount), VENUS_PANEL_NUMBER - 1);
  state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.loopCount, 1, 'passing a story panel does not count a lap');
  assert.deepEqual(state.readStoryEpisodes, [], 'loop laps do not re-read the story');
  assert.equal(state.pendingVenus, true, 'the VENUS panel still stops the loop lap');
});

test('normalizeRaceState defaults loopCount to 0 for a state saved before loops existed', () => {
  const legacy = normalizeRaceState({
    areaIndex: 2,
    panelNumber: 7,
    totalClearPanelCount: 12,
  } as Decoded);
  assert.equal(legacy.loopCount, 0);
  assert.equal(emptyRaceState().loopCount, 0);
});

test('ResetCardCoolTime clears a deck card and spends race points', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('cool');
  const cards = await seedDeck(playerId);
  await seedState(playerId, { panelNumber: VENUS_PANEL_NUMBER - 1 });
  await grantItem(playerId, config.racePointItemId, 5000);
  await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  await call('Race:StartLivePanelQuest', accountId, { RaceId: RACE_ID, DeckNumber: 1 });

  const cardId = cards[0];
  assert.ok((await loadRaceState(playerId, RACE_ID)).cardCoolTimes[cardId] > Date.now());
  const before = await getItemAmount(playerId, config.racePointItemId);
  assert.ok(before > 0, 'the VENUS panel must have left some race points');

  const out = await call('Race:ResetCardCoolTime', accountId, { RaceId: RACE_ID, CardId: cardId });
  const info = out.UserRaceInfo as Decoded;
  const after = before - config.requiredCardCoolTimeRacePointAmount;
  assert.equal(await getItemAmount(playerId, config.racePointItemId), after);
  assert.equal(updatedItemAmount(out, config.racePointItemId), after);
  assert.equal(((info.CardCoolTimeInfos as Decoded[]) ?? []).length, 4);
  assert.equal((await loadRaceState(playerId, RACE_ID)).cardCoolTimes[cardId], undefined);
});

// --- area quests -----------------------------------------------------------

test('StartLiveAreaQuest clears a pt tier, grants race points and unlocks the next tier', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('pt');
  await seedDeck(playerId);

  const out = await call('Race:StartLiveAreaQuest', accountId, {
    RaceId: RACE_ID,
    RaceQuestId: PT_QUEST,
    DifficultyNumber: 2,
    DeckNumber: 1,
  });
  assert.equal((out.Result as Decoded).Cleared, true);
  const expected = config.areaQuestReward.racePointPerTier * 2 + config.initialRacePointAmount;
  assert.equal(await getItemAmount(playerId, config.racePointItemId), expected);
  const state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.areaQuestClear[PT_QUEST], 2);

  // Tier 2 cleared: tier 3 is now unlocked, tier 4 is not.
  const difficulties = (await listRaceQuestDifficulties(PT_QUEST)) as unknown as Decoded[];
  assert.equal(tierUnlocked(difficulties, state.areaQuestClear[PT_QUEST] ?? 0, 3), true);
  assert.equal(tierUnlocked(difficulties, state.areaQuestClear[PT_QUEST] ?? 0, 4), false);
  await assert.rejects(
    call('Race:StartLiveAreaQuest', accountId, {
      RaceId: RACE_ID,
      RaceQuestId: PT_QUEST,
      DifficultyNumber: 4,
      DeckNumber: 1,
    }),
    (error: Error) => {
      assert.match(error.message, new RegExp(`difficulty 4 of ${PT_QUEST} is locked`));
      return true;
    },
  );
});

test('StartLiveAreaQuest clears the versus medal quest with the default NPC roster', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('medal');
  await seedDeck(playerId);

  // The medal tiers have ClearScore 0, so the live needs a roster; the draft's
  // default `qt-main-1-007-04` supplies it (this used to throw "NPC roster ...
  // is not configured").
  const out = await call('Race:StartLiveAreaQuest', accountId, {
    RaceId: RACE_ID,
    RaceQuestId: MEDAL_QUEST,
    DifficultyNumber: 2,
    DeckNumber: 1,
  });
  assert.equal((out.Result as Decoded).Cleared, true);
  const expected = config.areaQuestReward.raceMedalPerTier * 2;
  assert.equal(await getItemAmount(playerId, config.raceMedalItemId), expected);
  assert.equal((await loadRaceState(playerId, RACE_ID)).areaQuestClear[MEDAL_QUEST], 2);
});

test('the first race visit starts the activity clock and grants the starting stock once', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('first-visit');

  const first = await call('Race:Top', accountId, { RaceId: RACE_ID });
  assert.equal(first.IsInitialLogin, true);
  const progress = (first.UserRaceInfo as Decoded).ActivityLessonProgress as Decoded;
  const clockStart = n(progress.LastReceiveTime);
  // Initialising the state starts the lesson clock, so points accrue while the
  // player is still on the board instead of after the first claim.
  assert.ok(clockStart > 0, 'the first visit starts the lesson clock');
  assert.equal(n(progress.MaxRewardTime), clockStart + config.activityLesson.maxHours * HOUR_MS);
  assert.equal(await getItemAmount(playerId, config.racePointItemId), config.initialRacePointAmount);

  const second = await call('Race:Top', accountId, { RaceId: RACE_ID });
  assert.equal(second.IsInitialLogin, false);
  assert.equal(await getItemAmount(playerId, config.racePointItemId), config.initialRacePointAmount);
  const secondProgress = (second.UserRaceInfo as Decoded).ActivityLessonProgress as Decoded;
  assert.equal(n(secondProgress.LastReceiveTime), clockStart);
});

test('a fresh player has only tier 2 of each area quest unlocked', async (t) => {
  if (!ready(t)) return;
  const pt = (await listRaceQuestDifficulties(PT_QUEST)) as unknown as Decoded[];
  const medal = (await listRaceQuestDifficulties(MEDAL_QUEST)) as unknown as Decoded[];
  for (const rows of [pt, medal]) {
    assert.equal(tierUnlocked(rows, 0, 2), true);
    assert.equal(tierUnlocked(rows, 0, 3), false);
  }
});

test('StartLiveAreaQuest accepts a tier unlocked by manager level and rejects it below the gate', async (t) => {
  if (!ready(t)) return;
  // Pt tier 3's condition (cd-race-qt-26-0226-pt-003) needs ManagerLevel 35.
  const { accountId, playerId } = await newPlayer('tier-level');
  await seedDeck(playerId);

  await db.update(players).set({ level: 34 }).where(eq(players.id, playerId));
  await assert.rejects(
    call('Race:StartLiveAreaQuest', accountId, {
      RaceId: RACE_ID,
      RaceQuestId: PT_QUEST,
      DifficultyNumber: 3,
      DeckNumber: 1,
    }),
    (error: Error) => {
      assert.match(error.message, new RegExp(`difficulty 3 of ${PT_QUEST} is locked`));
      return true;
    },
  );

  await db.update(players).set({ level: 35 }).where(eq(players.id, playerId));
  const out = await call('Race:StartLiveAreaQuest', accountId, {
    RaceId: RACE_ID,
    RaceQuestId: PT_QUEST,
    DifficultyNumber: 3,
    DeckNumber: 1,
  });
  assert.ok(out.Result, 'a manager-level-unlocked tier must start its live');
});

// --- activity lesson -------------------------------------------------------

test('ReceiveActivityLesson starts the clock, then pays capped steps', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('lesson');

  const first = await call('Race:ReceiveActivityLesson', accountId, { RaceId: RACE_ID });
  const startRewards = first.Rewards as Decoded[];
  // The very first call creates the state, so it also pays the starting stock.
  assert.equal(startRewards.length, 1);
  assert.equal(startRewards[0].ResourceId, config.racePointItemId);
  assert.equal(n(startRewards[0].Amount), config.initialRacePointAmount);
  const firstInfo = first.UserRaceInfo as Decoded;
  const firstProgress = firstInfo.ActivityLessonProgress as Decoded;
  assert.ok(n(firstProgress.LastReceiveTime) > 0, 'the first call starts the clock');

  // 44 idle hours: capped at `activityLesson.maxHours` (36 by default).
  const last = Date.now() - (config.activityLesson.maxHours + 8) * HOUR_MS;
  await seedState(playerId, { lastActivityReceiveMs: last });
  const second = await call('Race:ReceiveActivityLesson', accountId, { RaceId: RACE_ID });
  const steps = Math.floor((config.activityLesson.maxHours * HOUR_MS) / STEP_MS);
  // A fresh player has no cleared pt tier, so the lesson pays the tier-1 base.
  const expectedPoints = config.activityLesson.racePointPerStepBase * steps;
  const expectedMedals = config.activityLesson.raceMedalPerStepBase * steps;
  assert.equal(
    await getItemAmount(playerId, config.racePointItemId),
    expectedPoints + config.initialRacePointAmount,
  );
  assert.equal(await getItemAmount(playerId, config.raceMedalItemId), expectedMedals);
  assert.equal((second.Rewards as Decoded[]).length, 2);
  const state = await loadRaceState(playerId, RACE_ID);
  assert.ok(state.lastActivityReceiveMs > last, 'the clock moves to now');
});

test('ReceiveActivityLesson keeps the sub-step remainder between claims', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('lesson-remainder');
  const base = Date.now();
  const clock = t.mock.method(Date, 'now', () => base + 15_000);

  await seedState(playerId, { lastActivityReceiveMs: base });
  await call('Race:ReceiveActivityLesson', accountId, { RaceId: RACE_ID });
  // Claim at +15s pays one step; the remainder (5s) stays on the clock.
  assert.equal(await getItemAmount(playerId, config.racePointItemId), config.activityLesson.racePointPerStepBase * 1);
  assert.equal((await loadRaceState(playerId, RACE_ID)).lastActivityReceiveMs, base + STEP_MS);

  // Claim at +30s pays two more steps, for three in total.
  clock.mock.mockImplementation(() => base + 30_000);
  await call('Race:ReceiveActivityLesson', accountId, { RaceId: RACE_ID });
  assert.equal(await getItemAmount(playerId, config.racePointItemId), config.activityLesson.racePointPerStepBase * 3);
  assert.equal((await loadRaceState(playerId, RACE_ID)).lastActivityReceiveMs, base + 3 * STEP_MS);
});

test('ReceiveActivityLesson zero-step claim keeps the clock until a step is paid', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('lesson-zero-step');
  const base = Date.now();
  const clock = t.mock.method(Date, 'now', () => base + 5_000);

  await seedState(playerId, { lastActivityReceiveMs: base });
  await call('Race:ReceiveActivityLesson', accountId, { RaceId: RACE_ID });
  // Claim at +5s is under one step: nothing paid, clock untouched.
  assert.equal(await getItemAmount(playerId, config.racePointItemId), 0);
  assert.equal((await loadRaceState(playerId, RACE_ID)).lastActivityReceiveMs, base);

  // Claim at +12s pays one step and moves the clock by that step.
  clock.mock.mockImplementation(() => base + 12_000);
  await call('Race:ReceiveActivityLesson', accountId, { RaceId: RACE_ID });
  assert.equal(await getItemAmount(playerId, config.racePointItemId), config.activityLesson.racePointPerStepBase * 1);
  assert.equal((await loadRaceState(playerId, RACE_ID)).lastActivityReceiveMs, base + STEP_MS);
});

// --- activity lesson tally (2-day efficiency level) -------------------------

/** The race start the phase2 event is registered with. */
const RACE_START_MS = Date.parse('2026-01-01T00:00:00Z');

test('Race:Top NextDailyAggregationTime is the next lesson tally boundary', async (t) => {
  if (!ready(t)) return;
  const { accountId } = await newPlayer('tally-countdown');
  // A fixed clock between two boundaries (JST midnights, 15:00 UTC).
  const now = nextTallyAt(RACE_START_MS, Date.now()) - HOUR_MS;
  t.mock.method(Date, 'now', () => now);
  const expected = nextTallyAt(RACE_START_MS, now);

  const out = await call('Race:Top', accountId, { RaceId: RACE_ID });
  assert.equal(n(out.NextDailyAggregationTime), expected);
  assert.equal(new Date(expected).getUTCHours(), 15);
});

test('ReceiveActivityLesson pays a boundary-crossing claim at each tallied tier', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('lesson-tally');
  const boundary = nextTallyAt(RACE_START_MS, Date.now());
  const clock = boundary - HOUR_MS;
  const now = boundary + HOUR_MS;
  t.mock.method(Date, 'now', () => now);

  // Pt tier 5 was reached before the boundary, so the first hour still pays the
  // base rate and only the second hour pays the tier-5 rate. The medal quest
  // has no clears.
  await seedState(playerId, {
    lastActivityReceiveMs: clock,
    areaQuestClear: { [PT_QUEST]: 5 },
    areaQuestTierReachedAt: { pt: { '5': boundary - 2 * HOUR_MS }, medal: {} },
  });
  const before = await getItemAmount(playerId, config.racePointItemId);

  await call('Race:ReceiveActivityLesson', accountId, { RaceId: RACE_ID });

  const stepsPerHour = Math.floor(HOUR_MS / STEP_MS);
  const basePoint = config.activityLesson.racePointPerStepBase;
  // Tiers start at difficulty 2, so clearing difficulty 5 is the 4th cleared
  // tier: the lesson tier is 4 and the rate is base + 3 × per-tier.
  const talliedPoint = Math.floor(
    config.activityLesson.racePointPerStepBase +
      config.activityLesson.racePointPerStepPerTier * 3,
  );
  const expected = basePoint * stepsPerHour + talliedPoint * stepsPerHour;
  assert.equal((await getItemAmount(playerId, config.racePointItemId)) - before, expected);
  // The clock advanced by exactly the paid steps (no cap, no remainder).
  const state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.lastActivityReceiveMs, clock + 2 * stepsPerHour * STEP_MS);
});

test('a clear reached inside a segment waits for the tally boundary', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('lesson-tally-wait');
  const boundary = nextTallyAt(RACE_START_MS, Date.now()) + 2 * 24 * HOUR_MS;
  const now = boundary - HOUR_MS;
  const clock = now;
  t.mock.method(Date, 'now', () => now);

  // Tier 5 is reached after the previous boundary, so the whole claim pays the
  // base rate even though the state already records the clear.
  await seedState(playerId, {
    lastActivityReceiveMs: clock - 30 * 60 * 1000,
    areaQuestClear: { [PT_QUEST]: 5 },
    areaQuestTierReachedAt: { pt: { '5': now - 10 * 60 * 1000 }, medal: {} },
  });
  const before = await getItemAmount(playerId, config.racePointItemId);

  await call('Race:ReceiveActivityLesson', accountId, { RaceId: RACE_ID });

  const steps = Math.floor((30 * 60 * 1000) / STEP_MS);
  assert.equal(
    (await getItemAmount(playerId, config.racePointItemId)) - before,
    config.activityLesson.racePointPerStepBase * steps,
    'the tallied rate is still tier 1',
  );
});

// --- live bonuses ----------------------------------------------------------

test('EnhanceLiveBonus raises several levels in one call and spends their sum', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('bonus');
  // Levels 1..3 cost 3,000 each in the race-26-0226 master data.
  await grantItem(playerId, config.raceMedalItemId, 9000);

  const enhanced = await call('Race:EnhanceLiveBonus', accountId, { RaceId: RACE_ID, LiveBonusId: LIVE_BONUS_ID, Level: 3 });
  let state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.liveBonuses[LIVE_BONUS_ID], 3);
  assert.equal(state.medalsSpentOnBonuses, 9000);
  assert.equal(await getItemAmount(playerId, config.raceMedalItemId), 0);
  assert.equal(updatedItemAmount(enhanced, config.raceMedalItemId), 0);

  // A request at or below the current level is refused with the race code.
  await grantItem(playerId, config.raceMedalItemId, 3000);
  for (const level of [3, 2]) {
    await assert.rejects(
      call('Race:EnhanceLiveBonus', accountId, { RaceId: RACE_ID, LiveBonusId: LIVE_BONUS_ID, Level: level }),
      (error: unknown) => {
        assert.ok(error instanceof AppRpcError);
        assert.equal(error.code, ERROR_CODE.EVENT_CONDITION_INVALID);
        assert.match(error.message, /is already at level 3/);
        return true;
      },
    );
  }
  state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.liveBonuses[LIVE_BONUS_ID], 3);
  assert.equal(state.medalsSpentOnBonuses, 9000);
  assert.equal(await getItemAmount(playerId, config.raceMedalItemId), 3000);
});

test('EnhanceLiveBonus rejects an unaffordable multi-level jump and spends nothing', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('bonus-broke');
  // Levels 1..3 total 9,000 medals; 8,000 is one short.
  await grantItem(playerId, config.raceMedalItemId, 8000);

  await assert.rejects(
    call('Race:EnhanceLiveBonus', accountId, { RaceId: RACE_ID, LiveBonusId: LIVE_BONUS_ID, Level: 3 }),
    (error: unknown) => {
      assert.ok(error instanceof AppRpcError);
      assert.equal(error.code, ERROR_CODE.RESOURCE_NOT_ENOUGH);
      assert.match(error.message, /need 9000/);
      return true;
    },
  );
  const state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.liveBonuses[LIVE_BONUS_ID], undefined);
  assert.equal(state.medalsSpentOnBonuses, 0);
  assert.equal(await getItemAmount(playerId, config.raceMedalItemId), 8000);
});

test('ResetLiveBonus consumes the eraser and refunds every medal spent', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('reset');
  await grantItem(playerId, config.raceMedalItemId, 3000);
  await grantItem(playerId, config.raceLiveBonusResetItemId, 1);
  await call('Race:EnhanceLiveBonus', accountId, { RaceId: RACE_ID, LiveBonusId: LIVE_BONUS_ID, Level: 1 });
  assert.equal(await getItemAmount(playerId, config.raceMedalItemId), 0);

  const reset = await call('Race:ResetLiveBonus', accountId, { RaceId: RACE_ID });
  assert.equal(await getItemAmount(playerId, config.raceLiveBonusResetItemId), 0);
  assert.equal(await getItemAmount(playerId, config.raceMedalItemId), 3000);
  assert.equal(updatedItemAmount(reset, config.raceLiveBonusResetItemId), 0);
  assert.equal(updatedItemAmount(reset, config.raceMedalItemId), 3000);
  const state = await loadRaceState(playerId, RACE_ID);
  assert.deepEqual(state.liveBonuses, {});
  assert.equal(state.medalsSpentOnBonuses, 0);
});

// --- opponents (RaceOpponentProgressInfo) ---------------------------------

test('the leader sees the closest players behind on the board', async (t) => {
  if (!ready(t)) return;
  // The leader sits above every other board this file (and the other race test
  // files) creates; the dedicated follower right behind them is therefore the
  // nearest player behind, whichever rows the earlier tests left in the race.
  const { accountId, playerId } = await newPlayer('board-lead');
  await seedState(playerId, { totalClearPanelCount: 1_000_000 });
  const follower = await newPlayer('board-follower');
  const followerState = await seedState(follower.playerId, {
    totalClearPanelCount: 999_999,
    liveBonuses: { [LIVE_BONUS_ID]: 2 },
  });

  const out = await call('Race:Top', accountId, { RaceId: RACE_ID });
  const infos = out.OpponentProgressInfos as Decoded[];
  assert.ok(infos.length > 0, 'the leader must see the players behind');
  assert.ok(infos.length <= config.rivals, 'the list respects the rivals limit');

  const [selfRow, followerRow] = await Promise.all(
    [playerId, follower.playerId].map(async (id) => {
      const [row] = await db.select().from(players).where(eq(players.id, id));
      return row;
    }),
  );
  // The caller's own row never appears when another player is listed.
  assert.equal(
    infos.some((row) => s(row.UserId) === publicUserIdOf(selfRow!)),
    false,
    'the leader must not see their own row',
  );
  // The nearest follower is listed first, as rank 2.
  const followerInfo = infos[0]!;
  assert.equal(s(followerInfo.UserId), publicUserIdOf(followerRow!));
  assert.equal(n(followerInfo.ClearPanelCount), followerState.totalClearPanelCount);
  assert.equal(n(followerInfo.Rank), 2);
  assert.deepEqual(followerInfo.LiveBonusInfos, [
    {
      __msg: 'Solis.Common.Proto.Api.RaceLiveBonusInfo',
      LiveBonusId: LIVE_BONUS_ID,
      Level: 2,
    },
  ]);
  // Rows are ordered by rank ascending.
  const rankValues = infos.map((row) => n(row.Rank));
  assert.deepEqual(rankValues, [...rankValues].sort((a, b) => a - b));
});

test('the board lists the players ahead with their real name, clear count and bonuses', async (t) => {
  if (!ready(t)) return;
  const leader = await newPlayer('board-leader');
  const leaderState = await seedState(leader.playerId, {
    totalClearPanelCount: 1_000_000_000,
    liveBonuses: { [LIVE_BONUS_ID]: 2 },
  });
  // Ranked directly behind the leader, so the leader is the nearest player
  // ahead of the caller and leads the list; the closest players behind the
  // caller then backfill the remaining rows.
  const { accountId, playerId } = await newPlayer('board-caller');
  await seedState(playerId, { totalClearPanelCount: 999_999_999 });

  const out = await call('Race:Top', accountId, { RaceId: RACE_ID });
  const infos = out.OpponentProgressInfos as Decoded[];
  assert.ok(infos.length > 0, 'the leader must be listed ahead of the caller');
  assert.ok(infos.length <= config.rivals, 'the list respects the rivals limit');
  assert.equal(infos.length, config.rivals, 'the players behind backfill the list');

  const [leaderRow, callerRow] = await Promise.all(
    [leader.playerId, playerId].map(async (id) => {
      const [row] = await db.select().from(players).where(eq(players.id, id));
      return row;
    }),
  );
  const leaderInfo = infos.find((row) => s(row.Name) === s(leaderRow?.name));
  assert.ok(leaderInfo, 'the leader must be listed');
  // Real players only: ids are public user ids, counts come from the race state.
  assert.equal(s(leaderInfo!.UserId), publicUserIdOf(leaderRow!));
  assert.equal(n(leaderInfo!.ClearPanelCount), leaderState.totalClearPanelCount);
  assert.equal(n(leaderInfo!.Rank), 1);
  assert.deepEqual(leaderInfo!.LiveBonusInfos, [
    {
      __msg: 'Solis.Common.Proto.Api.RaceLiveBonusInfo',
      LiveBonusId: LIVE_BONUS_ID,
      Level: 2,
    },
  ]);
  // The caller never appears on their own board.
  assert.equal(infos.some((row) => s(row.Name) === s(callerRow?.name)), false);
  // Rows are ordered by rank ascending.
  const rankValues = infos.map((row) => n(row.Rank));
  assert.deepEqual(rankValues, [...rankValues].sort((a, b) => a - b));

  // The leader has no profile favourite character here, so the row falls back
  // to the first master character that owns cards.
  const characters = (await listCharacters()) as unknown as {
    Id: string;
    Type?: number | string | null;
  }[];
  const fallback = characters.find((character) =>
    isRivalCharacter({ Id: s(character.Id), Name: null, Type: character.Type }),
  );
  assert.equal(s(leaderInfo!.DisplayCharacterId), s(fallback?.Id));
});

// --- ranking ---------------------------------------------------------------

test('Ranking orders players by cleared panel count', async (t) => {
  if (!ready(t)) return;
  const weaker = await newPlayer('rank-low');
  const stronger = await newPlayer('rank-high');
  await seedState(weaker.playerId, { totalClearPanelCount: 5 });
  await seedState(stronger.playerId, { totalClearPanelCount: 9 });

  const out = await call('Race:Ranking', weaker.accountId, { RaceId: RACE_ID });
  const infos = out.RankingInfos as Decoded[];
  assert.equal(n(out.SelfClearPanelCount), 5);

  const [weakRow] = await db
    .select({ name: players.name })
    .from(players)
    .where(eq(players.id, weaker.playerId));
  const [strongRow] = await db
    .select({ name: players.name })
    .from(players)
    .where(eq(players.id, stronger.playerId));
  const weakInfo = infos.find((row) => s(row.Name) === s(weakRow?.name));
  const strongInfo = infos.find((row) => s(row.Name) === s(strongRow?.name));
  assert.ok(weakInfo, 'the weaker player must be listed');
  assert.ok(strongInfo, 'the stronger player must be listed');
  assert.equal(n(weakInfo!.ClearPanelCount), 5);
  assert.equal(n(strongInfo!.ClearPanelCount), 9);
  assert.ok(n(strongInfo!.Rank) < n(weakInfo!.Rank), 'more cleared panels ranks higher');
});

test('Ranking reports the caller own panel count and rank', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('rank-self');
  await seedState(playerId, { totalClearPanelCount: 7 });

  const out = await call('Race:Ranking', accountId, { RaceId: RACE_ID });
  assert.equal(n(out.SelfClearPanelCount), 7);
  const infos = out.RankingInfos as Decoded[];
  const [row] = await db
    .select({ name: players.name })
    .from(players)
    .where(eq(players.id, playerId));
  const self = infos.find((info) => s(info.Name) === s(row?.name));
  assert.ok(self, 'the caller must appear in the ranking');
  assert.equal(n(out.SelfRank), n(self!.Rank));
});

// --- tied ranks -------------------------------------------------------------
//
// These tests seed counts above every other player this file creates, so each
// pair is the top of the ranking on its own and the expected rank numbers hold
// no matter what the earlier tests left in the database.

async function playerName(playerId: string): Promise<string> {
  const [row] = await db
    .select({ name: players.name })
    .from(players)
    .where(eq(players.id, playerId));
  return s(row?.name);
}

test('players tied at the top share rank 1 and see each other', async (t) => {
  if (!ready(t)) return;
  const tiedCount = 1_100_000_049;
  const first = await newPlayer('tie-top-a');
  const second = await newPlayer('tie-top-b');
  await seedState(first.playerId, { totalClearPanelCount: tiedCount });
  await seedState(second.playerId, { totalClearPanelCount: tiedCount });

  const rivalUserId = new Map<string, string>();
  for (const playerId of [first.playerId, second.playerId]) {
    const [row] = await db.select().from(players).where(eq(players.id, playerId));
    rivalUserId.set(playerId, publicUserIdOf(row!));
  }

  for (const [caller, rival] of [
    [first, second],
    [second, first],
  ] as const) {
    const out = await call('Race:Top', caller.accountId, { RaceId: RACE_ID });
    const infos = out.OpponentProgressInfos as Decoded[];
    // Two players on the same count are both rank 1, so each sees the other
    // first; the closest players behind backfill the remaining rows.
    assert.ok(infos.length > 0, 'a tied leader must see the other tied player');
    assert.ok(infos.length <= config.rivals, 'the list respects the rivals limit');
    assert.equal(s(infos[0]!.UserId), rivalUserId.get(rival.playerId));
    assert.equal(n(infos[0]!.ClearPanelCount), tiedCount);
    assert.equal(n(infos[0]!.Rank), 1);
    assert.equal(
      infos.some((row) => s(row.UserId) === rivalUserId.get(caller.playerId)),
      false,
      'the caller must not see their own row',
    );
    assert.ok(
      infos.slice(1).every((row) => n(row.Rank) > 1),
      'the backfilled rows rank behind the caller',
    );
    assert.equal(n((out.UserRaceInfo as Decoded).CurrnentRank), 1);
  }
});

test('a player behind two tied leaders sees both at rank 1 and is rank 3', async (t) => {
  if (!ready(t)) return;
  const tiedCount = 1_200_000_049;
  const behindCount = 1_200_000_040;
  const first = await newPlayer('tie-ahead-a');
  const second = await newPlayer('tie-ahead-b');
  const behind = await newPlayer('tie-behind');
  await seedState(first.playerId, { totalClearPanelCount: tiedCount });
  await seedState(second.playerId, { totalClearPanelCount: tiedCount });
  await seedState(behind.playerId, { totalClearPanelCount: behindCount });

  const out = await call('Race:Top', behind.accountId, { RaceId: RACE_ID });
  const infos = out.OpponentProgressInfos as Decoded[];
  // The two tied leaders come first; the closest players behind backfill.
  assert.ok(infos.length >= 2, 'both tied leaders are listed');
  assert.ok(infos.length <= config.rivals, 'the list respects the rivals limit');
  const aheadUserIds: string[] = [];
  for (const playerId of [first.playerId, second.playerId]) {
    const [row] = await db.select().from(players).where(eq(players.id, playerId));
    aheadUserIds.push(publicUserIdOf(row!));
  }
  assert.deepEqual(
    [...aheadUserIds].sort(),
    [...infos.slice(0, 2).map((row) => s(row.UserId))].sort(),
    'both tied leaders are listed first',
  );
  // Tied rows keep the ranking list order (the stored state order), which is
  // what `Race:Ranking` reports.
  const rankingOut = await call('Race:Ranking', behind.accountId, { RaceId: RACE_ID });
  const rankingOrder = (rankingOut.RankingInfos as Decoded[])
    .map((row) => s(row.UserId))
    .filter((userId) => aheadUserIds.includes(userId));
  assert.deepEqual(
    infos
      .map((row) => s(row.UserId))
      .filter((userId) => aheadUserIds.includes(userId)),
    rankingOrder,
    'rows come in ranking order',
  );
  assert.deepEqual(infos.slice(0, 2).map((row) => n(row.Rank)), [1, 1], 'ties share rank 1');
  assert.ok(
    infos.slice(2).every((row) => n(row.Rank) > 1),
    'the backfilled rows rank behind the caller',
  );
  assert.deepEqual(
    infos.slice(0, 2).map((row) => n(row.ClearPanelCount)),
    [tiedCount, tiedCount],
  );
  // Two players above, so the next distinct count is rank 3, not rank 2.
  assert.equal(n((out.UserRaceInfo as Decoded).CurrnentRank), 3);
});

test('Ranking returns shared ranks for ties', async (t) => {
  if (!ready(t)) return;
  const tiedCount = 1_300_000_049;
  const behindCount = 1_300_000_040;
  const first = await newPlayer('rank-tie-a');
  const second = await newPlayer('rank-tie-b');
  const behind = await newPlayer('rank-tie-behind');
  await seedState(first.playerId, { totalClearPanelCount: tiedCount });
  await seedState(second.playerId, { totalClearPanelCount: tiedCount });
  await seedState(behind.playerId, { totalClearPanelCount: behindCount });

  const out = await call('Race:Ranking', first.accountId, { RaceId: RACE_ID });
  const infos = out.RankingInfos as Decoded[];
  const [firstName, secondName, behindName] = await Promise.all(
    [first.playerId, second.playerId, behind.playerId].map((playerId) => playerName(playerId)),
  );
  const firstInfo = infos.find((row) => s(row.Name) === firstName);
  const secondInfo = infos.find((row) => s(row.Name) === secondName);
  assert.ok(firstInfo, 'the first tied player must be listed');
  assert.ok(secondInfo, 'the second tied player must be listed');
  assert.equal(n(firstInfo!.ClearPanelCount), tiedCount);
  assert.equal(n(secondInfo!.ClearPanelCount), tiedCount);
  assert.equal(n(firstInfo!.Rank), 1, 'tied players share rank 1');
  assert.equal(n(secondInfo!.Rank), 1, 'tied players share rank 1');
  assert.equal(n(out.SelfRank), 1, 'the caller self rank is the shared rank');

  const behindOut = await call('Race:Ranking', behind.accountId, { RaceId: RACE_ID });
  const behindInfos = behindOut.RankingInfos as Decoded[];
  const behindInfo = behindInfos.find((row) => s(row.Name) === behindName);
  assert.ok(behindInfo, 'the player behind the tie must be listed');
  assert.equal(n(behindInfo!.Rank), 3, 'the rank after two ties is 3');
  assert.equal(n(behindOut.SelfRank), 3);
});

// --- synthetic bots ---------------------------------------------------------

/** Publish the race with `bots` and return a function restoring the draft. */
async function publishBots(bots: RaceConfig['bots']): Promise<() => Promise<void>> {
  await publishEventDefinition(RACE_ID, { by: 'test', draft: { ...config, bots } });
  return async () => {
    await publishEventDefinition(RACE_ID, { by: 'test', draft: { ...config } });
  };
}

/**
 * A daily pace high enough that every bot clears more panels than any player
 * this suite seeds, so the bots sit at the top of the ranking and the rival
 * list regardless of the rows the other race tests leave behind.
 */
const BOT_PANELS_PER_DAY = 1_000_000_000;

test('bots pad the ranking, self rank and board rivals without player rows', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('bots-on');
  await seedState(playerId, { totalClearPanelCount: 0 });
  const restore = await publishBots({
    enabled: true,
    count: 5,
    minPanelsPerDay: BOT_PANELS_PER_DAY,
    maxPanelsPerDay: BOT_PANELS_PER_DAY,
    names: [],
  });
  try {
    const out = await call('Race:Ranking', accountId, { RaceId: RACE_ID });
    const infos = out.RankingInfos as Decoded[];
    const botRows = infos.filter((row) => s(row.UserId).startsWith('racebot-'));
    assert.equal(botRows.length, 5, 'every bot is listed');
    // With no custom names each bot is named after a master idol.
    const idols = await raceBotIdols();
    assert.ok(idols.length > 0, 'master data must provide named idols');
    const idolIdByName = new Map(idols.map((idol) => [idol.name, idol.id] as const));
    for (const row of botRows) {
      const name = s(row.Name).replace(/ \d+$/, '');
      assert.ok(idolIdByName.has(name), `${name} is a master idol name`);
    }
    assert.equal(
      new Set(botRows.map((row) => s(row.Name))).size,
      5,
      'default bot names are unique',
    );
    for (const row of botRows) {
      assert.equal(s(row.EmblemId), '', 'bots carry no emblem');
      assert.ok(n(row.ManagerLevel) >= 20 && n(row.ManagerLevel) <= 200);
      assert.ok(n(row.ClearPanelCount) > 0, 'bots clear panels as the race runs');
      assert.equal(
        infos.some((other) => other !== row && s(other.UserId) === s(row.UserId)),
        false,
        'bot user ids are unique',
      );
    }
    // The caller (0 panels) ranks behind every bot, so the self rank counts them.
    assert.equal(n(out.SelfClearPanelCount), 0);
    const above = infos.filter((row) => n(row.ClearPanelCount) > 0).length;
    assert.ok(botRows.every((row) => n(row.ClearPanelCount) > 0));
    assert.equal(n(out.SelfRank), above + 1, 'self rank counts the bots ahead');

    // The board rival list draws from the merged ranking too.
    const top = await call('Race:Top', accountId, { RaceId: RACE_ID });
    const rivals = top.OpponentProgressInfos as Decoded[];
    assert.ok(rivals.length > 0);
    assert.ok(rivals.length <= config.rivals, 'the list respects the rivals limit');
    const rivalBots = rivals.filter((row) => s(row.UserId).startsWith('racebot-'));
    assert.ok(rivalBots.length > 0, 'the leading bots are listed as rivals');
    const playable = idols.map((idol) => idol.id);
    assert.ok(playable.length > 0, 'master data must provide playable idols');
    for (const row of rivalBots) {
      assert.deepEqual(row.LiveBonusInfos, [], 'bots have no live bonuses');
      const name = s(row.Name).replace(/ \d+$/, '');
      assert.equal(
        s(row.DisplayCharacterId),
        idolIdByName.get(name),
        'a bot dresses as the idol it is named after',
      );
      assert.ok(playable.includes(s(row.DisplayCharacterId)), 'a bot dresses as a playable idol');
    }

    // Bots own no rows: no race state and no player row is ever written for them.
    const botIds = Array.from({ length: 5 }, (_, index) => `racebot:${RACE_ID}:${index}`);
    const entityRows = await db
      .select()
      .from(playerEntities)
      .where(inArray(playerEntities.playerId, botIds));
    assert.equal(entityRows.length, 0, 'bot ids never own race state rows');
    const botPlayerRows = await db.select().from(players).where(inArray(players.id, botIds));
    assert.equal(botPlayerRows.length, 0, 'bot ids never own player rows');
  } finally {
    await restore();
  }
});

test('with bots disabled the ranking and rivals list only real players', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('bots-off');
  await seedState(playerId, { totalClearPanelCount: 0 });

  const out = await call('Race:Ranking', accountId, { RaceId: RACE_ID });
  const infos = out.RankingInfos as Decoded[];
  assert.equal(
    infos.some((row) => s(row.UserId).startsWith('racebot-')),
    false,
    'a race without bots lists no bot rows',
  );
  const above = infos.filter((row) => n(row.ClearPanelCount) > 0).length;
  assert.equal(n(out.SelfRank), above + 1);

  const top = await call('Race:Top', accountId, { RaceId: RACE_ID });
  const rivals = top.OpponentProgressInfos as Decoded[];
  assert.equal(
    rivals.some((row) => s(row.UserId).startsWith('racebot-')),
    false,
    'a race without bots lists no bot rivals',
  );
});

// --- race decks ------------------------------------------------------------
//
// `Race:SaveDeck` is the normal `Deck:Save` behind a race response: `Number` 0
// allocates the next account deck number from `User.DeckSequence`, any other
// number edits that account deck. Old builds stored race formations in
// `RaceDecks:<raceId>`; those rows still list, but an account deck of the same
// number wins.

/** Grant the shared five-card roster (no race deck saved) for a SaveDeck test. */
async function grantDeckCards(playerId: string): Promise<string[]> {
  const cards = await pickDeckCards();
  for (const cardId of cards) {
    await grantCard(playerId, {
      CardId: cardId,
      Level: 80,
      Rarity: 5,
      Vocal: 1000,
      Dance: 1000,
      Visual: 1000,
      Stamina: 1000,
      Mental: 10,
      Technique: 10,
    } as Decoded);
  }
  return cards;
}

/** Put the player's `User` singleton at a known `DeckSequence`. */
async function seedDeckSequence(playerId: string, deckSequence: number): Promise<void> {
  await putSingleton(playerId, 'User', {
    __msg: 'Solis.Common.Proto.Transaction.User',
    DeckSequence: deckSequence,
  } as Decoded);
}

/** `CommonResponse.UpdatedData.User` from a handler response, if present. */
function updatedUser(out: Record<string, unknown>): Decoded | undefined {
  const common = out.CommonResponse as Decoded | undefined;
  const updated = common?.UpdatedData as Decoded | undefined;
  return updated?.User as Decoded | undefined;
}

function deckPositions(cards: string[]): Decoded[] {
  return cards.map((cardId, index) => ({ Position: index + 1, CardId: cardId }) as Decoded);
}

/**
 * Give the player the two normal account decks the client holds locally:
 * deck 1 with two cards, deck 5 with three.
 */
async function seedAccountDecks(playerId: string, cards: string[]): Promise<void> {
  await putElements(playerId, 'Decks', [
    { Number: 1, Name: 'Unit 2' } as Decoded,
    { Number: 5, Name: 'Unit 5' } as Decoded,
  ]);
  await putElements(playerId, 'DeckPositions', [
    ...cards.slice(0, 2).map((cardId, index) => ({ Number: 1, Position: index + 1, CardId: cardId }) as Decoded),
    ...cards.slice(2, 5).map((cardId, index) => ({ Number: 5, Position: index + 1, CardId: cardId }) as Decoded),
  ]);
}

/** Deck numbers of a `Race:ListDeck` response, in response order. */
async function listedDeckNumbers(accountId: string): Promise<number[]> {
  const out = await call('Race:ListDeck', accountId, { RaceId: RACE_ID });
  return (((out.DeckInfos ?? []) as Decoded[])).map((row) => n(row.Number));
}

test('ListDeck covers every account deck as well as the saved race deck', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('deck-union');
  const cards = await grantDeckCards(playerId);
  await seedAccountDecks(playerId, cards);
  await seedDeckSequence(playerId, 5);

  // Before the first race save the account decks are listed on their own.
  assert.deepEqual(await listedDeckNumbers(accountId), [1, 5]);

  const saved = await call('Race:SaveDeck', accountId, {
    RaceId: RACE_ID,
    Name: 'Unit 6',
    UserDeckPositions: deckPositions(cards.slice(0, 1)),
  });
  assert.equal(n((saved.DeckInfo as Decoded).Number), 6, 'the save allocates account deck 6');

  // The client builds `RaceDeckLiveBonus` from these entries and looks the
  // overlay up by deck number for every deck it holds, so the new deck is
  // listed next to the decks the account already had.
  assert.deepEqual(await listedDeckNumbers(accountId), [1, 5, 6]);

  const listed = (((await call('Race:ListDeck', accountId, { RaceId: RACE_ID })).DeckInfos ?? []) as Decoded[]);
  const byNumber = new Map(listed.map((row) => [n(row.Number), row]));
  assert.deepEqual(
    ((byNumber.get(6)?.CardDetailInfos ?? []) as Decoded[]).map((row) => n(row.Position)),
    [1],
    'deck 6 holds the saved race formation',
  );
  assert.deepEqual(
    ((byNumber.get(1)?.CardDetailInfos ?? []) as Decoded[]).map((row) => n(row.Position)),
    [1, 2],
    'deck 1 keeps its account formation',
  );
  assert.deepEqual(
    ((byNumber.get(5)?.CardDetailInfos ?? []) as Decoded[]).map((row) => n(row.Position)),
    [1, 2, 3],
    'deck 5 keeps its account formation',
  );
  for (const row of listed) {
    assert.equal(row.__msg, 'Solis.Common.Proto.Api.RaceDeckInfo');
    const details = (row.CardDetailInfos ?? []) as Decoded[];
    assert.ok(details.length > 0, `deck ${n(row.Number)} must carry its card details`);
    assert.ok(n(row.DeckOverallValue) > 0, `deck ${n(row.Number)} must carry its overall value`);
    for (const detail of details) {
      assert.equal(detail.__msg, 'Solis.Common.Proto.Api.RaceDeckCardDetailInfo');
      assert.ok(Array.isArray(detail.AccessoryInfos), 'accessory infos are always present');
      assert.ok(Array.isArray(detail.PhotoInfos), 'photo infos are always present');
    }
  }
});

test('ListQuestAsset uses the account formation for a deck without a race save', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('deck-union-asset');
  const cards = await grantDeckCards(playerId);
  await seedAccountDecks(playerId, cards);
  await seedDeckSequence(playerId, 5);

  const saved = await call('Race:SaveDeck', accountId, {
    RaceId: RACE_ID,
    UserDeckPositions: deckPositions(cards.slice(0, 1)),
  });
  assert.equal(n((saved.DeckInfo as Decoded).Number), 6);

  // The decks the account already had still resolve from the account formation.
  const accountDeck = await call('Race:ListQuestAsset', accountId, { RaceId: RACE_ID, DeckNumber: 1 });
  assert.equal(((accountDeck.CharacterAssets ?? []) as Decoded[]).length, 2);

  // The newly allocated deck lists the formation that was just saved.
  const raceDeck = await call('Race:ListQuestAsset', accountId, { RaceId: RACE_ID, DeckNumber: 6 });
  assert.equal(((raceDeck.CharacterAssets ?? []) as Decoded[]).length, 1);

  // Nothing is stored for deck 0: it is neither an account deck nor an old race deck.
  const unstored = await call('Race:ListQuestAsset', accountId, { RaceId: RACE_ID, DeckNumber: 0 });
  assert.equal(((unstored.CharacterAssets ?? []) as Decoded[]).length, 0);
});

test('SaveDeck Number 0 allocates the next account deck and a second save edits it', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('deck-zero');
  const cards = await grantDeckCards(playerId);
  await seedAccountDecks(playerId, cards);
  // Account decks 1 and 5 are stored and the sequence counts them both: the next
  // new deck is 6.
  await seedDeckSequence(playerId, 5);

  // `Number` is missing from the wire, which decodes to 0: like `Deck:Save`, it
  // allocates a new account deck instead of editing a race-only deck 0.
  const first = await call('Race:SaveDeck', accountId, {
    RaceId: RACE_ID,
    Name: 'Unit 6',
    UserDeckPositions: deckPositions(cards.slice(0, 2)),
  });
  assert.equal(first.__msg, 'Solis.Common.Proto.Api.RaceSaveDeckResponse');
  assert.equal(n((first.DeckInfo as Decoded).Number), 6, 'the allocated number is echoed');
  assert.deepEqual(
    (((first.DeckInfo as Decoded).CardDetailInfos ?? []) as Decoded[]).map((row) => n(row.Position)),
    [1, 2],
    'the deck info describes the saved positions',
  );
  const firstData = (first.CommonResponse as Decoded).UpdatedData as Decoded;
  const firstDeck = (firstData.Decks as Decoded[])[0];
  assert.equal(n(firstDeck.Number), 6, 'UpdatedData.Decks carries the allocated deck');
  assert.equal(s(firstDeck.Name), 'Unit 6');
  assert.deepEqual(
    (((firstData.DeckPositions ?? []) as Decoded[])).map((row) => [n(row.Number), n(row.Position)]),
    [
      [6, 1],
      [6, 2],
    ],
    'UpdatedData.DeckPositions carries the saved positions under the new number',
  );
  // The client names its next new deck from the advanced sequence.
  assert.equal(n(updatedUser(first)?.DeckSequence), 6, 'the save advances User.DeckSequence');

  // The saved deck is a normal account deck now.
  assert.deepEqual(
    ((await listElements(playerId, 'Decks', db)).map((row) => n(row.Number))).sort((a, b) => a - b),
    [1, 5, 6],
  );
  assert.deepEqual(
    (await listElements(playerId, 'DeckPositions', db))
      .filter((row) => n(row.Number) === 6)
      .sort((a, b) => n(a.Position) - n(b.Position))
      .map((row) => [n(row.Position), s(row.CardId)]),
    [
      [1, cards[0]],
      [2, cards[1]],
    ],
  );
  assert.deepEqual(await listedDeckNumbers(accountId), [1, 5, 6]);
  // The save no longer writes a `RaceDecks:<raceId>` row.
  assert.deepEqual(await loadRaceDecks(playerId, RACE_ID), { decks: [], positions: [] });

  // A second save with the allocated number edits it in place: no allocation.
  const second = await call('Race:SaveDeck', accountId, {
    RaceId: RACE_ID,
    Number: 6,
    Name: 'edited',
    UserDeckPositions: deckPositions(cards.slice(2, 5)),
  });
  assert.equal(n((second.DeckInfo as Decoded).Number), 6);
  assert.equal(updatedUser(second), undefined, 'saving a numbered deck allocates nothing');
  assert.deepEqual(
    (await listElements(playerId, 'DeckPositions', db))
      .filter((row) => n(row.Number) === 6)
      .sort((a, b) => n(a.Position) - n(b.Position))
      .map((row) => [n(row.Position), s(row.CardId)]),
    [
      [1, cards[2]],
      [2, cards[3]],
      [3, cards[4]],
    ],
    'deck 6 is replaced with the second save\'s cards',
  );
  const listed = ((await call('Race:ListDeck', accountId, { RaceId: RACE_ID })).DeckInfos ?? []) as Decoded[];
  const deck6 = listed.find((row) => n(row.Number) === 6);
  assert.ok(deck6, 'deck 6 stays listed');
  assert.deepEqual(
    ((deck6.CardDetailInfos ?? []) as Decoded[]).map((row) => n(row.Position)),
    [1, 2, 3],
    'the listed deck holds the second save',
  );
  const user = await getSingleton(playerId, 'User', db);
  assert.equal(n(user?.DeckSequence), 6, 'the deck sequence stays put');
});

test('SaveDeck Number 1 edits deck 1', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('deck-edit');
  const cards = await grantDeckCards(playerId);
  await seedAccountDecks(playerId, cards);
  await seedDeckSequence(playerId, 5);

  const out = await call('Race:SaveDeck', accountId, {
    RaceId: RACE_ID,
    Number: 1,
    Name: 'edited',
    UserDeckPositions: deckPositions(cards.slice(2, 4)),
  });
  assert.equal(n((out.DeckInfo as Decoded).Number), 1);
  assert.equal((out.DeckInfo as Decoded).__msg, 'Solis.Common.Proto.Api.RaceDeckInfo');
  assert.deepEqual(
    (((out.DeckInfo as Decoded).CardDetailInfos ?? []) as Decoded[]).map((row) => n(row.Position)),
    [1, 2],
  );
  assert.equal(updatedUser(out), undefined, 'saving a numbered deck allocates nothing');

  const decks = await listElements(playerId, 'Decks', db);
  assert.deepEqual(
    decks.map((row) => [n(row.Number), s(row.Name)]).sort((a, b) => n(a[0]) - n(b[0])),
    [
      [1, 'edited'],
      [5, 'Unit 5'],
    ],
    'deck 1 is renamed in the account store and no deck is added',
  );
  assert.deepEqual(
    (await listElements(playerId, 'DeckPositions', db))
      .filter((row) => n(row.Number) === 1)
      .sort((a, b) => n(a.Position) - n(b.Position))
      .map((row) => [n(row.Position), s(row.CardId)]),
    [
      [1, cards[2]],
      [2, cards[3]],
    ],
  );
  const user = await getSingleton(playerId, 'User', db);
  assert.equal(n(user?.DeckSequence), 5, 'the deck sequence stays put');
  assert.deepEqual(await loadRaceDecks(playerId, RACE_ID), { decks: [], positions: [] });
});

test('SaveDeck with a negative Number rejects', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('deck-negative');

  await assert.rejects(
    call('Race:SaveDeck', accountId, {
      RaceId: RACE_ID,
      Number: -1,
      Name: 'invalid',
      UserDeckPositions: [],
    }),
    (error: Error) => {
      assert.match(error.message, /Race:SaveDeck: Number is required/);
      return true;
    },
  );
  assert.deepEqual(await loadRaceDecks(playerId, RACE_ID), { decks: [], positions: [] });
});

test('ListQuestAsset lists the deck SaveDeck allocated', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('deck-zero-asset');
  const cards = await grantDeckCards(playerId);

  const saved = await call('Race:SaveDeck', accountId, {
    RaceId: RACE_ID,
    UserDeckPositions: deckPositions(cards),
  });
  const number = n((saved.DeckInfo as Decoded).Number);
  assert.equal(number, 1, 'a fresh account allocates deck 1');

  const out = await call('Race:ListQuestAsset', accountId, { RaceId: RACE_ID, DeckNumber: number });
  assert.equal(out.__msg, 'Solis.Common.Proto.Api.RaceQuestListAssetResponse');
  assert.equal(((out.CharacterAssets ?? []) as Decoded[]).length, cards.length);

  // Deck 0 is neither an account deck nor an old race deck, so it has no assets.
  const none = await call('Race:ListQuestAsset', accountId, { RaceId: RACE_ID, DeckNumber: 0 });
  assert.equal(((none.CharacterAssets ?? []) as Decoded[]).length, 0);
});

test('a saved account deck wins over a stale stored race deck of the same number', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('deck-precedence');
  const cards = await grantDeckCards(playerId);
  await seedAccountDecks(playerId, cards);
  // Old builds wrote race formations into `RaceDecks:<raceId>`. Deck 1's stored
  // row is stale (the account deck holds more cards now); deck 9 exists only
  // there.
  await saveRaceDeck(playerId, RACE_ID, {
    Number: 1,
    Name: 'stale',
    Positions: [{ Number: 1, Position: 1, CardId: cards[0] }],
  });
  await saveRaceDeck(playerId, RACE_ID, {
    Number: 9,
    Name: 'old-only',
    Positions: [{ Number: 9, Position: 1, CardId: cards[0] }],
  });

  assert.deepEqual(await listedDeckNumbers(accountId), [1, 5, 9], 'old race-only decks still list');
  const listed = (((await call('Race:ListDeck', accountId, { RaceId: RACE_ID })).DeckInfos ?? []) as Decoded[]);
  const byNumber = new Map(listed.map((row) => [n(row.Number), row]));
  assert.deepEqual(
    ((byNumber.get(1)?.CardDetailInfos ?? []) as Decoded[]).map((row) => n(row.Position)),
    [1, 2],
    'the account deck 1 wins over the stale race deck',
  );
  assert.deepEqual(
    ((byNumber.get(9)?.CardDetailInfos ?? []) as Decoded[]).map((row) => n(row.Position)),
    [1],
    'a race-only deck still lists its stored formation',
  );

  const accountDeck = await call('Race:ListQuestAsset', accountId, { RaceId: RACE_ID, DeckNumber: 1 });
  assert.equal(((accountDeck.CharacterAssets ?? []) as Decoded[]).length, 2, 'assets come from the account deck');
  const oldOnly = await call('Race:ListQuestAsset', accountId, { RaceId: RACE_ID, DeckNumber: 9 });
  assert.equal(((oldOnly.CharacterAssets ?? []) as Decoded[]).length, 1);
});

test('StartLivePanelQuest loads an account deck even when a legacy race deck exists', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer('deck-live-account');
  // `seedDeck` grants the strong five-card roster and stores it as the legacy
  // race deck 1; deck 0 is another legacy-only race deck.
  const cards = await seedDeck(playerId);
  await saveRaceDeck(playerId, RACE_ID, {
    Number: 0,
    Name: 'legacy-zero',
    Positions: [{ Number: 0, Position: 1, CardId: cards[0] }],
  });
  // The next allocated account deck is 10.
  await seedDeckSequence(playerId, 9);
  const saved = await call('Race:SaveDeck', accountId, {
    RaceId: RACE_ID,
    UserDeckPositions: deckPositions(cards),
  });
  assert.equal(n((saved.DeckInfo as Decoded).Number), 10, 'the race save allocates account deck 10');

  // The account deck is loaded directly even though the legacy race store is
  // not empty, and a legacy-only number still loads from it.
  const accountFormation = await loadRaceFormation(playerId, RACE_ID, 10);
  assert.deepEqual(
    accountFormation.Positions.map((row) => s(row.CardId)),
    cards,
    'deck 10 comes from the account deck store',
  );
  const legacyFormation = await loadRaceFormation(playerId, RACE_ID, 0);
  assert.deepEqual(
    legacyFormation.Positions.map((row) => s(row.CardId)),
    [cards[0]],
    'a legacy-only deck number still loads its stored formation',
  );

  await seedState(playerId, { panelNumber: VENUS_PANEL_NUMBER - 1 });
  await grantItem(playerId, config.racePointItemId, 5000);
  await call('Race:MovePanel', accountId, { RaceId: RACE_ID });
  assert.equal((await loadRaceState(playerId, RACE_ID)).pendingVenus, true);

  const cleared = await call('Race:StartLivePanelQuest', accountId, {
    RaceId: RACE_ID,
    DeckNumber: 10,
  });
  assert.equal((cleared.Result as Decoded).Cleared, true, 'the account deck 10 clears the VENUS live');
  assert.equal(n((cleared.UserRaceInfo as Decoded).TotalClearPanelCount), 1);
});
