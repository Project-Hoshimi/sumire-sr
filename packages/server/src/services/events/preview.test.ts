// Marathon state-impact and publish-preview tests. Pure unit tests against
// `memoryEventStore` and the memory player-state reader; no database.
//
//   node --test src/services/events/preview.test.ts
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { npcRosters } from '../../live/data/npcRosters.ts';
import { marathonPlugin, type MarathonDraft } from '../marathon/plugin.ts';
import {
  initEventRegistry,
  previewPublish,
  publishEventDefinition,
  resetEventRegistryForTests,
} from './registry.ts';
import { memoryEventStore, type EventStore } from './store.ts';
import {
  memoryMarathonPlayerStateReader,
  type MarathonPlayerStateRow,
} from './preview.ts';

const EVENT_ID = 'marathon-preview';
const QUEST_A = 'quest-a';
const QUEST_B = 'quest-b';
const ROSTER_A = Object.keys(npcRosters)[0] as string;
const ROSTER_B = Object.keys(npcRosters)[1] as string;

function item(order: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order,
    itemKey: String(order),
    itemType: 1,
    rewardId: `reward-${order}`,
    initialStock: 3,
    isLimited: true,
    ...extra,
  };
}

/** A valid marathon draft with two boxes and two authored stages. */
function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EVENT_ID,
    name: 'Preview',
    type: 1,
    assetId: '',
    bannerAssetId: '',
    boxGachaGroupId: '',
    initialStamina: 10,
    staminaRecoveryMinutes: 5,
    staminaRecoveryItemId: 'stamina-item',
    questUnlockItemId: 'unlock-item',
    eventMissionId: 'mission',
    order: 1,
    boxGachas: {
      box1: { items: [item(1), item(2)] },
      box2: { items: [item(1)] },
    },
    npcRosters: {
      [QUEST_A]: ROSTER_A,
      [QUEST_B]: { rosterId: ROSTER_B, levelOffset: 2 },
    },
    ...overrides,
  };
}

function impactsOf(
  published: Record<string, unknown>,
  next: Record<string, unknown>,
): ReturnType<typeof marathonPlugin.stateImpact> {
  return marathonPlugin.stateImpact(
    marathonPlugin.parseDraft(published) as MarathonDraft,
    marathonPlugin.parseDraft(next) as MarathonDraft,
  );
}

function player(
  playerId: string,
  boxes: Record<string, Record<string, number>> = {},
): MarathonPlayerStateRow {
  return {
    playerId,
    state: {
      stamina: 0,
      staminaUpdatedTime: 0,
      quests: {},
      boxes: Object.fromEntries(
        Object.entries(boxes).map(([boxId, drawn]) => [boxId, { drawn, resetCount: 0 }]),
      ),
    },
  };
}

let store: EventStore & { reset(): void };

beforeEach(() => {
  resetEventRegistryForTests();
  store = memoryEventStore();
});

async function seedPublished(source: Record<string, unknown> = draft()): Promise<void> {
  await initEventRegistry({ store, drafts: [{ kind: 'marathon', draft: source }] });
}

function boxesOf(source: Record<string, unknown>): Record<string, unknown> {
  return source.boxGachas as Record<string, unknown>;
}

// Impact codes

test('box-removed: a published box id missing from the draft blocks', () => {
  const next = { ...draft(), boxGachas: { box1: boxesOf(draft()).box1 } };
  const impacts = impactsOf(draft(), next);
  assert.equal(impacts.length, 1);
  assert.deepEqual(impacts[0], {
    code: 'box-removed',
    severity: 'block',
    message: impacts[0]?.message,
    boxId: 'box2',
    requiresPlayerCheck: true,
  });
});

test('item-removed: an itemKey missing from its box blocks', () => {
  const published = draft();
  const next = {
    ...draft(),
    boxGachas: { box1: { items: [item(1)] }, box2: boxesOf(published).box2 },
  };
  const impacts = impactsOf(published, next);
  assert.equal(impacts.length, 1);
  assert.equal(impacts[0]?.code, 'item-removed');
  assert.equal(impacts[0]?.severity, 'block');
  assert.equal(impacts[0]?.boxId, 'box1');
  assert.equal(impacts[0]?.itemKey, '2');
  assert.equal(impacts[0]?.requiresPlayerCheck, true);
});

test('stock-lowered: a lower initialStock blocks and reports newStock', () => {
  const published = draft();
  const next = {
    ...draft(),
    boxGachas: {
      box1: { items: [item(1, { initialStock: 1 }), item(2)] },
      box2: boxesOf(published).box2,
    },
  };
  const impacts = impactsOf(published, next);
  assert.equal(impacts.length, 1);
  assert.deepEqual(impacts[0], {
    code: 'stock-lowered',
    severity: 'block',
    message: impacts[0]?.message,
    boxId: 'box1',
    itemKey: '1',
    newStock: 1,
    requiresPlayerCheck: true,
  });
});

test('stock-lowered: lowering an unlimited item produces no impact', () => {
  const published = {
    ...draft(),
    boxGachas: {
      box1: { items: [item(1, { isLimited: false }), item(2)] },
      box2: boxesOf(draft()).box2,
    },
  };
  const next = {
    ...published,
    boxGachas: {
      box1: { items: [item(1, { isLimited: false, initialStock: 1 }), item(2)] },
      box2: boxesOf(published).box2,
    },
  };
  assert.deepEqual(impactsOf(published, next), []);
});

test('item-removed: removing an unlimited item warns and does not block', async () => {
  const published = {
    ...draft(),
    boxGachas: {
      box1: { items: [item(1), item(2, { isLimited: false })] },
      box2: boxesOf(draft()).box2,
    },
  };
  await seedPublished(published);
  const next = {
    ...draft(),
    boxGachas: { box1: { items: [item(1)] }, box2: boxesOf(published).box2 },
  };
  const impacts = impactsOf(published, next);
  assert.equal(impacts.length, 1);
  assert.equal(impacts[0]?.code, 'item-removed');
  assert.equal(impacts[0]?.severity, 'warn');
  assert.equal(impacts[0]?.itemKey, '2');
  assert.equal(impacts[0]?.requiresPlayerCheck, true);

  const preview = await previewPublish(EVENT_ID, {
    draft: next,
    players: memoryMarathonPlayerStateReader([player('p1', { box1: { '2': 1 } })]),
  });
  const impact = preview.impacts.find((entry) => entry.code === 'item-removed');
  assert.ok(impact);
  assert.equal(impact.severity, 'warn');
  assert.equal(impact.affectedPlayers, 1);
  assert.equal(preview.blocking, false);
});

test('limit-changed: flipping an item to unlimited blocks only when a player drew it', async () => {
  const published = draft();
  await seedPublished(published);
  const next = {
    ...draft(),
    boxGachas: {
      box1: { items: [item(1, { isLimited: false }), item(2)] },
      box2: boxesOf(published).box2,
    },
  };
  const impacts = impactsOf(published, next);
  assert.equal(impacts.length, 1);
  assert.equal(impacts[0]?.code, 'limit-changed');
  assert.equal(impacts[0]?.severity, 'block');
  assert.equal(impacts[0]?.boxId, 'box1');
  assert.equal(impacts[0]?.itemKey, '1');
  assert.equal(impacts[0]?.requiresPlayerCheck, true);

  const drawn = await previewPublish(EVENT_ID, {
    draft: next,
    players: memoryMarathonPlayerStateReader([player('p1', { box1: { '1': 1 } })]),
  });
  const blocking = drawn.impacts.find((entry) => entry.code === 'limit-changed');
  assert.ok(blocking);
  assert.equal(blocking.affectedPlayers, 1);
  assert.equal(drawn.blocking, true);

  const untouched = await previewPublish(EVENT_ID, {
    draft: next,
    players: memoryMarathonPlayerStateReader([player('p2', { box1: { '2': 2 } })]),
  });
  const quiet = untouched.impacts.find((entry) => entry.code === 'limit-changed');
  assert.ok(quiet);
  assert.equal(quiet.affectedPlayers, 0);
  assert.equal(untouched.blocking, false);
});

test('item-key-missing: an unkeyed raw item blocks even with zero players', async () => {
  const published = draft();
  await seedPublished(published);
  const next = {
    ...draft(),
    boxGachas: {
      box1: { items: [item(1, { itemKey: undefined }), item(2)] },
      box2: boxesOf(published).box2,
    },
  };
  const preview = await previewPublish(EVENT_ID, {
    draft: next,
    players: memoryMarathonPlayerStateReader([]),
  });
  const missing = preview.impacts.filter((entry) => entry.code === 'item-key-missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.severity, 'block');
  assert.equal(missing[0]?.boxId, 'box1');
  assert.equal(missing[0]?.requiresPlayerCheck, false);
  assert.match(missing[0]?.message ?? '', /explicit itemKey/);
  assert.equal(preview.blocking, true);

  await assert.rejects(
    publishEventDefinition(EVENT_ID, {
      draft: next,
      players: memoryMarathonPlayerStateReader([]),
    }),
    /publish blocked by player-state impacts.*item-key-missing/,
  );
});

test('item-key-missing: a first publish is unaffected', async () => {
  await initEventRegistry({ store, drafts: [] });
  await store.createDefinition(
    {
      id: EVENT_ID,
      kind: 'marathon',
      title: 'Preview',
      draft: marathonPlugin.parseDraft(draft()),
      published: null,
      publishedVersion: 0,
      updatedBy: 'tester',
    },
    [],
  );
  const next = {
    ...draft(),
    boxGachas: {
      box1: { items: [item(1, { itemKey: undefined })] },
      box2: boxesOf(draft()).box2,
    },
  };
  const preview = await previewPublish(EVENT_ID, {
    draft: next,
    players: memoryMarathonPlayerStateReader([]),
  });
  assert.equal(
    preview.impacts.some((entry) => entry.code === 'item-key-missing'),
    false,
  );
  assert.equal(preview.blocking, false);
});

test('item-changed: a different type or reward warns and needs a player check', () => {
  const published = draft();
  const next = {
    ...draft(),
    boxGachas: {
      box1: { items: [item(1, { rewardId: 'other-reward' }), item(2)] },
      box2: boxesOf(published).box2,
    },
  };
  const impacts = impactsOf(published, next);
  assert.equal(impacts.length, 1);
  assert.equal(impacts[0]?.code, 'item-changed');
  assert.equal(impacts[0]?.severity, 'warn');
  assert.equal(impacts[0]?.requiresPlayerCheck, true);
});

test('rate changes alone produce no state impact', () => {
  const published = draft({
    boxGachas: {
      box1: { items: [item(1, { rate: 0.1 }), item(2)] },
      box2: boxesOf(draft()).box2,
    },
  });
  const next = draft({
    boxGachas: {
      box1: { items: [item(1, { rate: 0.3 }), item(2)] },
      box2: boxesOf(draft()).box2,
    },
  });
  assert.deepEqual(impactsOf(published, next), []);
});

test('stage-removed: a published npcRosters quest missing from the draft warns', () => {
  const next = { ...draft(), npcRosters: { [QUEST_A]: ROSTER_A } };
  const impacts = impactsOf(draft(), next);
  assert.equal(impacts.length, 1);
  assert.deepEqual(impacts[0], {
    code: 'stage-removed',
    severity: 'warn',
    message: impacts[0]?.message,
    questId: QUEST_B,
    requiresPlayerCheck: false,
  });
});

test('roster-changed: a different roster id or level rule warns without a player check', () => {
  const next = {
    ...draft(),
    npcRosters: {
      [QUEST_A]: ROSTER_B,
      [QUEST_B]: { rosterId: ROSTER_B, fixedLevel: 99 },
    },
  };
  const impacts = impactsOf(draft(), next);
  assert.equal(impacts.length, 2);
  assert.deepEqual(
    impacts.map(({ code, severity, questId, requiresPlayerCheck }) => ({
      code,
      severity,
      questId,
      requiresPlayerCheck,
    })),
    [
      { code: 'roster-changed', severity: 'warn', questId: QUEST_A, requiresPlayerCheck: false },
      { code: 'roster-changed', severity: 'warn', questId: QUEST_B, requiresPlayerCheck: false },
    ],
  );
});

test('reordering fully keyed items produces no impacts', () => {
  const published = draft();
  const next = {
    ...draft(),
    boxGachas: {
      box1: { items: [item(2), item(1)] },
      box2: boxesOf(published).box2,
    },
  };
  assert.deepEqual(impactsOf(published, next), []);
});

test('a first publish has no impacts', () => {
  assert.deepEqual(marathonPlugin.stateImpact(undefined, marathonPlugin.parseDraft(draft())), []);
});

// Affected-player counting

test('box-removed counts players with any draw in the box', async () => {
  await seedPublished();
  const boxes = boxesOf(draft());
  const preview = await previewPublish(EVENT_ID, {
    draft: { ...draft(), boxGachas: { box1: boxes.box1 } },
    players: memoryMarathonPlayerStateReader([
      player('p1', { box2: { '1': 1 } }),
      player('p2', { box2: { '9': 1 } }),
      player('p3', { box1: { '1': 1 } }),
    ]),
  });
  const impact = preview.impacts.find((entry) => entry.code === 'box-removed');
  assert.ok(impact);
  assert.equal(impact.affectedPlayers, 2);
  assert.equal(preview.blocking, true);
});

test('item-removed counts players who drew that item', async () => {
  await seedPublished();
  const boxes = boxesOf(draft());
  const preview = await previewPublish(EVENT_ID, {
    draft: { ...draft(), boxGachas: { box1: { items: [item(1)] }, box2: boxes.box2 } },
    players: memoryMarathonPlayerStateReader([
      player('p1', { box1: { '2': 1 } }),
      player('p2', { box1: { '1': 3 } }),
      player('p3', { box1: { '2': 0 } }),
    ]),
  });
  const impact = preview.impacts.find((entry) => entry.code === 'item-removed');
  assert.ok(impact);
  assert.equal(impact.affectedPlayers, 1);
});

test('stock-lowered counts players whose draws exceed the new stock', async () => {
  await seedPublished();
  const boxes = boxesOf(draft());
  const preview = await previewPublish(EVENT_ID, {
    draft: {
      ...draft(),
      boxGachas: {
        box1: { items: [item(1, { initialStock: 1 }), item(2)] },
        box2: boxes.box2,
      },
    },
    players: memoryMarathonPlayerStateReader([
      player('p1', { box1: { '1': 2 } }),
      player('p2', { box1: { '1': 1 } }),
      player('p3', { box1: { '1': 4 } }),
    ]),
  });
  const impact = preview.impacts.find((entry) => entry.code === 'stock-lowered');
  assert.ok(impact);
  assert.equal(impact.affectedPlayers, 2);
  assert.equal(impact.newStock, 1);
});

test('item-changed also gains affectedPlayers', async () => {
  await seedPublished();
  const boxes = boxesOf(draft());
  const preview = await previewPublish(EVENT_ID, {
    draft: {
      ...draft(),
      boxGachas: {
        box1: { items: [item(1, { rewardId: 'other' }), item(2)] },
        box2: boxes.box2,
      },
    },
    players: memoryMarathonPlayerStateReader([
      player('p1', { box1: { '1': 1 } }),
      player('p2', { box1: { '2': 1 } }),
    ]),
  });
  const impact = preview.impacts.find((entry) => entry.code === 'item-changed');
  assert.ok(impact);
  assert.equal(impact.affectedPlayers, 1);
  assert.equal(preview.blocking, false);
});

test('an undecodable player state counts as affected for every player check', async () => {
  await seedPublished();
  const boxes = boxesOf(draft());
  const preview = await previewPublish(EVENT_ID, {
    draft: { ...draft(), boxGachas: { box1: { items: [item(1)] }, box2: boxes.box2 } },
    players: memoryMarathonPlayerStateReader([
      { playerId: 'bad', state: null },
      player('p2', {}),
    ]),
  });
  const impact = preview.impacts.find((entry) => entry.code === 'item-removed');
  assert.ok(impact);
  assert.equal(impact.affectedPlayers, 1);
  assert.equal(preview.blocking, true);
});

// Publish gate

test('a block impact with zero affected players does not block', async () => {
  await seedPublished();
  const boxes = boxesOf(draft());
  const preview = await previewPublish(EVENT_ID, {
    draft: { ...draft(), boxGachas: { box1: boxes.box1 } },
    players: memoryMarathonPlayerStateReader([player('p1', { box1: { '1': 1 } })]),
  });
  const impact = preview.impacts.find((entry) => entry.code === 'box-removed');
  assert.ok(impact);
  assert.equal(impact.affectedPlayers, 0);
  assert.equal(preview.blocking, false);

  const result = await publishEventDefinition(EVENT_ID, {
    draft: { ...draft(), boxGachas: { box1: boxes.box1 } },
    players: memoryMarathonPlayerStateReader([player('p1', { box1: { '1': 1 } })]),
  });
  assert.equal(result.version, 2);
});

test('publish is refused when a block impact affects a player', async () => {
  await seedPublished();
  const boxes = boxesOf(draft());
  await assert.rejects(
    publishEventDefinition(EVENT_ID, {
      draft: { ...draft(), boxGachas: { box1: boxes.box1 } },
      players: memoryMarathonPlayerStateReader([player('p1', { box2: { '1': 1 } })]),
    }),
    /publish blocked by player-state impacts.*box-removed.*2/,
  );
  const definition = await store.getDefinition(EVENT_ID);
  assert.ok(definition);
  assert.equal(definition.publishedVersion, 1);
});

test('publish is allowed when the same block impact has no affected player', async () => {
  await seedPublished();
  const boxes = boxesOf(draft());
  const result = await publishEventDefinition(EVENT_ID, {
    draft: { ...draft(), boxGachas: { box1: boxes.box1 } },
    players: memoryMarathonPlayerStateReader([]),
  });
  assert.equal(result.version, 2);
});

test('a warning-only publish succeeds', async () => {
  await seedPublished();
  const result = await publishEventDefinition(EVENT_ID, {
    draft: { ...draft(), npcRosters: { [QUEST_A]: ROSTER_A } },
    players: memoryMarathonPlayerStateReader([player('p1', { box1: { '1': 1 } })]),
  });
  assert.equal(result.version, 2);
});

test('previewPublish reports changed top-level keys and a first publish from version 0', async () => {
  await initEventRegistry({ store, drafts: [] });
  await store.createDefinition(
    {
      id: EVENT_ID,
      kind: 'marathon',
      title: 'Preview',
      draft: marathonPlugin.parseDraft(draft()),
      published: null,
      publishedVersion: 0,
      updatedBy: 'tester',
    },
    [],
  );
  const preview = await previewPublish(EVENT_ID, {
    players: memoryMarathonPlayerStateReader([player('p1', { box1: { '1': 1 } })]),
  });
  assert.equal(preview.fromVersion, 0);
  assert.deepEqual(preview.impacts, []);
  assert.equal(preview.blocking, false);
  assert.ok(preview.changedKeys.includes('boxGachas'));
});

test('previewPublish lists only the top-level keys whose JSON changed', async () => {
  await seedPublished();
  const published = draft();
  const next = {
    ...draft({ name: 'Renamed' }),
    boxGachas: {
      box1: { items: [item(1, { initialStock: 1 }), item(2)] },
      box2: boxesOf(published).box2,
    },
  };
  const preview = await previewPublish(EVENT_ID, {
    draft: next,
    players: memoryMarathonPlayerStateReader([]),
  });
  assert.deepEqual(preview.changedKeys.sort(), ['boxGachas', 'name'].sort());
});
