// Marathon box item keys: stable per-item identity for player draw records.
// Pure unit tests against `memoryEventStore`; no database, no master data.
//
//   node --test src/services/marathon/boxKeys.test.ts
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import {
  boxItemStocks,
  pickBoxDraws,
  remainingStock,
  type BoxDrawState,
  type CompiledBoxItemDef,
} from './box.ts';
import { marathonPlugin, type MarathonConfig } from './plugin.ts';
import { initEventRegistry, registryLoaded, resetEventRegistryForTests } from '../events/registry.ts';
import { memoryEventStore, type EventStore } from '../events/store.ts';

const BOX_ID = 'box1';

/** A minimal authored marathon draft; box itemKeys are whatever `items` says. */
function rawDraft(items: Record<string, unknown>[], id = 'marathon-keys'): Record<string, unknown> {
  return {
    id,
    name: 'Keys',
    type: 1,
    assetId: 'asset',
    bannerAssetId: 'banner',
    boxGachaGroupId: 'group',
    initialStamina: 10,
    staminaRecoveryMinutes: 5,
    staminaRecoveryItemId: 'stamina-item',
    questUnlockItemId: 'unlock-item',
    eventMissionId: 'mission',
    order: 1,
    boxGachas: { [BOX_ID]: { items } },
  };
}

/** A valid finite box item; `extra` overrides or adds authored fields. */
function rawItem(
  order: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { order, itemType: 1, rewardId: `reward-${order}`, initialStock: 2, isLimited: true, ...extra };
}

/** Compile an authored draft the way the registry does. */
function compileDraft(draft: Record<string, unknown>): MarathonConfig {
  return marathonPlugin.compile(marathonPlugin.parseDraft(draft));
}

/** Compile a stored (untyped) draft/published body. */
function compileStored(value: unknown): MarathonConfig {
  return marathonPlugin.compile(marathonPlugin.parseDraft(value));
}

/** The resolved keys of one compiled box, in authored order. */
function keysOf(config: MarathonConfig): string[] {
  return (config.boxGachas?.[BOX_ID]?.items ?? []).map((def) => def.itemKey);
}

/** A compiled item for the pure draw helpers. */
function compiled(
  itemKey: string,
  order: number,
  initialStock: number,
  extra: Partial<CompiledBoxItemDef> = {},
): CompiledBoxItemDef {
  return { itemKey, order, itemType: 1, initialStock, isLimited: true, ...extra };
}

let store: EventStore & { reset(): void };

beforeEach(() => {
  resetEventRegistryForTests();
  store = memoryEventStore();
  delete process.env.SUMIRE_MARATHON_ID;
});

// Defaults and validation

test('an item without an itemKey defaults to String(order)', () => {
  const config = compileDraft(rawDraft([rawItem(2), rawItem(1)]));
  assert.deepEqual(keysOf(config), ['2', '1']);
});

test('an explicit itemKey is kept as authored', () => {
  const config = compileDraft(
    rawDraft([rawItem(1, { itemKey: 'first-prize' }), rawItem(2, { itemKey: 'second-prize' })]),
  );
  assert.deepEqual(keysOf(config), ['first-prize', 'second-prize']);
});

test('parseDraft fills defaults without mutating the authored draft', () => {
  const draft = rawDraft([rawItem(1), rawItem(2)]);
  const parsed = marathonPlugin.parseDraft(draft) as { boxGachas: unknown };
  const items = (
    parsed.boxGachas as Record<string, { items: { itemKey?: string }[] }>
  )[BOX_ID].items;
  assert.deepEqual(items.map((item) => item.itemKey), ['1', '2']);
  const authored = (draft.boxGachas as Record<string, { items: Record<string, unknown>[] }>)[BOX_ID]
    .items;
  assert.equal('itemKey' in authored[0], false, 'the authored draft must not be mutated');
});

test('duplicate explicit itemKeys are rejected', () => {
  const draft = rawDraft([
    rawItem(1, { itemKey: 'same' }),
    rawItem(2, { itemKey: 'same' }),
  ]);
  const issues = marathonPlugin.validate(marathonPlugin.parseDraft(draft));
  assert.equal(
    issues.some((issue) => issue.severity === 'error' && /duplicate itemKey "same"/.test(issue.message)),
    true,
  );
  assert.throws(() => compileDraft(draft), /duplicate itemKey "same"/);
});

test('an explicit itemKey colliding with a default is rejected', () => {
  // Item 1 has no key, so it defaults to "1"; item 2 claims "1" explicitly.
  const draft = rawDraft([rawItem(1), rawItem(2, { itemKey: '1' })]);
  assert.throws(() => compileDraft(draft), /duplicate itemKey "1"/);
});

test('an empty or non-string itemKey is rejected', () => {
  assert.throws(() => compileDraft(rawDraft([rawItem(1, { itemKey: '' })])), /itemKey must be a non-empty string/);
  assert.throws(() => compileDraft(rawDraft([rawItem(1, { itemKey: 7 })])), /itemKey must be a non-empty string/);
});

test('upgradeDraft fills missing keys and returns null once every key is present', () => {
  const legacy = rawDraft([rawItem(1), rawItem(2, { itemKey: 'kept' })]);
  const upgraded = marathonPlugin.upgradeDraft!(legacy) as Record<string, unknown>;
  assert.notEqual(upgraded, legacy);
  const items = (upgraded.boxGachas as Record<string, { items: { itemKey: string }[] }>)[BOX_ID].items;
  assert.deepEqual(items.map((item) => item.itemKey), ['1', 'kept']);
  // Idempotent: the upgraded draft is already complete.
  assert.equal(marathonPlugin.upgradeDraft!(upgraded), null);
});

// Reordering

test('draw counts survive the box items being reordered', () => {
  const before: CompiledBoxItemDef[] = [compiled('alpha', 1, 2), compiled('beta', 2, 3)];
  const drawn: BoxDrawState['drawn'] = { alpha: 2 };
  assert.equal(remainingStock(before, drawn), 3);

  // Same itemKeys, display order swapped.
  const after: CompiledBoxItemDef[] = [compiled('beta', 1, 3), compiled('alpha', 2, 2)];
  assert.deepEqual(
    boxItemStocks(after, drawn).map(({ def, stock }) => [def.itemKey, stock]),
    [
      ['beta', 3],
      ['alpha', 0],
    ],
  );
  assert.equal(remainingStock(after, drawn), 3);
  // Only the item that still has stock can be drawn, wherever it now sits.
  assert.deepEqual(pickBoxDraws(after, drawn, 5, () => 0), ['beta', 'beta', 'beta']);
});

// Startup upgrade

const LEGACY_VERSION = 3;

/** Seed a definition stored before itemKeys existed, plus a schedule. */
async function seedLegacyDefinition(id = 'marathon-keys'): Promise<void> {
  const legacy = rawDraft([rawItem(1), rawItem(2)], id);
  await store.createDefinition(
    {
      id,
      kind: 'marathon',
      title: 'Legacy',
      draft: legacy,
      published: legacy,
      publishedVersion: LEGACY_VERSION,
      updatedBy: 'editor',
    },
    [
      {
        eventId: id,
        startsAt: new Date('2026-01-01T00:00:00Z'),
        endsAt: new Date('2026-01-15T00:00:00Z'),
        exchangeEndsAt: new Date('2026-01-22T00:00:00Z'),
        enabled: true,
      },
    ],
  );
}

/** Run `fn` while capturing `console.info` lines. */
async function capturingInfo<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console.info = original;
  }
}

test('initEventRegistry upgrades a legacy stored definition exactly once', async () => {
  await seedLegacyDefinition();
  const scheduleBefore = await store.listSchedule();

  const { lines } = await capturingInfo(() => initEventRegistry({ store, drafts: [] }));
  const upgraded = lines.filter((line) => line.includes('[events] upgraded'));
  assert.equal(upgraded.length, 1);
  assert.match(upgraded[0], /marathon-keys/);

  const definition = await store.getDefinition('marathon-keys');
  assert.ok(definition);
  assert.equal(definition.publishedVersion, LEGACY_VERSION + 1);
  assert.equal(definition.updatedBy, 'system-upgrade');
  assert.deepEqual(keysOf(compileStored(definition.published)), ['1', '2']);
  assert.deepEqual(keysOf(compileStored(definition.draft)), ['1', '2']);

  const history = await store.listHistory('marathon-keys');
  assert.deepEqual(
    history.map((row) => [row.version, row.publishedBy]),
    [
      [LEGACY_VERSION, 'editor'],
      [LEGACY_VERSION + 1, 'system-upgrade'],
    ],
  );
  // No schedule was passed, so the authored window survives untouched.
  assert.deepEqual(await store.listSchedule(), scheduleBefore);
});

test('a second initEventRegistry writes nothing more', async () => {
  await seedLegacyDefinition();
  await capturingInfo(() => initEventRegistry({ store, drafts: [] }));

  const { lines } = await capturingInfo(() => initEventRegistry({ store, drafts: [] }));
  assert.equal(lines.filter((line) => line.includes('[events] upgraded')).length, 0);

  const definition = await store.getDefinition('marathon-keys');
  assert.ok(definition);
  assert.equal(definition.publishedVersion, LEGACY_VERSION + 1);
  assert.equal((await store.listHistory('marathon-keys')).length, 2);
  assert.equal((await store.listSchedule()).length, 1);
});

test('an upgrade whose publish throws is warned about and the others still upgrade', async () => {
  await seedLegacyDefinition('marathon-keys');
  await seedLegacyDefinition('marathon-keys-b');
  const failing: EventStore = {
    ...store,
    publish: async (id, update) => {
      if (id === 'marathon-keys') throw new Error('write failed');
      return store.publish(id, update);
    },
  };

  const warn = test.mock.method(console, 'warn', () => undefined);
  try {
    // The first definition's publish throws; init still resolves.
    await initEventRegistry({ store: failing, drafts: [] });
  } finally {
    warn.mock.restore();
  }

  const messages = warn.mock.calls.map((call) => call.arguments.map((arg) => String(arg)).join(' '));
  const failure = messages.filter((line) => line.includes('marathon-keys') && line.includes('write failed'));
  assert.equal(failure.length, 1, 'the failed definition is warned about by id');

  const failed = await store.getDefinition('marathon-keys');
  assert.ok(failed);
  assert.equal(failed.publishedVersion, LEGACY_VERSION, 'the failed definition is untouched');

  const upgraded = await store.getDefinition('marathon-keys-b');
  assert.ok(upgraded);
  assert.equal(upgraded.publishedVersion, LEGACY_VERSION + 1);
  assert.deepEqual(keysOf(compileStored(upgraded.published)), ['1', '2']);
  assert.equal(registryLoaded(), true);
});

test('a definition with a null published payload is skipped', async () => {
  const legacy = rawDraft([rawItem(1), rawItem(2)]);
  await store.createDefinition(
    {
      id: 'marathon-keys',
      kind: 'marathon',
      title: 'Draft only',
      draft: legacy,
      published: null,
      publishedVersion: 0,
      updatedBy: null,
    },
    [],
  );

  const { lines } = await capturingInfo(() => initEventRegistry({ store, drafts: [] }));
  assert.equal(lines.filter((line) => line.includes('[events] upgraded')).length, 0);

  const definition = await store.getDefinition('marathon-keys');
  assert.ok(definition);
  assert.equal(definition.published, null);
  assert.equal(definition.publishedVersion, 0);
  assert.deepEqual(definition.draft, legacy);
  assert.equal((await store.listHistory('marathon-keys')).length, 0);
  assert.equal(registryLoaded(), true);
});

test('a draft-only upgrade writes no new version', async () => {
  // The published body is complete; only the draft still lacks itemKeys.
  const published = rawDraft([
    rawItem(1, { itemKey: '1' }),
    rawItem(2, { itemKey: '2' }),
  ]);
  const draft = rawDraft([rawItem(1), rawItem(2)]);
  await store.createDefinition(
    {
      id: 'marathon-keys',
      kind: 'marathon',
      title: 'Draft-only change',
      draft,
      published,
      publishedVersion: LEGACY_VERSION,
      updatedBy: 'editor',
    },
    [],
  );

  const { lines } = await capturingInfo(() => initEventRegistry({ store, drafts: [] }));
  assert.equal(lines.filter((line) => line.includes('[events] upgraded')).length, 0);

  const definition = await store.getDefinition('marathon-keys');
  assert.ok(definition);
  assert.equal(definition.publishedVersion, LEGACY_VERSION);
  assert.equal(definition.updatedBy, 'editor');
  assert.deepEqual(definition.draft, draft, 'the draft-only upgrade is not persisted');
  assert.equal((await store.listHistory('marathon-keys')).length, 1);
  assert.deepEqual(keysOf(compileStored(definition.published)), ['1', '2']);
});

// Draw rates

test('a limited item rate is carried through compile', () => {
  const config = compileDraft(rawDraft([rawItem(1, { rate: 0.1 }), rawItem(2)]));
  const items = config.boxGachas?.[BOX_ID]?.items ?? [];
  assert.equal(items[0].rate, 0.1);
  assert.equal('rate' in items[1], false);
});

test('a rate on a non-limited item is rejected', () => {
  assert.throws(
    () => compileDraft(rawDraft([rawItem(1, { isLimited: false, rate: 0.1 })])),
    /rate is only allowed on a limited item/,
  );
});

test('a rate outside (0, 1] is rejected', () => {
  for (const rate of [0, -0.1, 1.5]) {
    assert.throws(
      () => compileDraft(rawDraft([rawItem(1, { rate })])),
      /rate must be in \(0, 1\]/,
    );
  }
});

test('a non-number rate is rejected', () => {
  for (const rate of ['0.1', null, Number.NaN]) {
    assert.throws(
      () => compileDraft(rawDraft([rawItem(1, { rate })])),
      /rate must be a finite number/,
    );
  }
});

test('rates over the finite budget are a validation error on the box path', () => {
  const draft = {
    ...rawDraft([
      rawItem(1, { isLimited: false, initialStock: 5 }),
      rawItem(2, { rate: 0.2 }),
      rawItem(3, { rate: 0.2 }),
    ]),
    boxInfiniteRate: 0.7,
  };
  const issues = marathonPlugin.validate(marathonPlugin.parseDraft(draft));
  const issue = issues.find((candidate) => candidate.path === `boxGachas.${BOX_ID}`);
  assert.ok(issue);
  assert.equal(issue.severity, 'error');
  assert.equal(
    issue.message,
    'rates assigned 0.4 exceed the 0.3 available after box infinite rate 0.7',
  );
  assert.throws(() => compileDraft(draft), /boxGachas\.box1: rates assigned 0\.4 exceed/);
});

test('an invalid boxInfiniteRate skips the per-box rate-sum check', () => {
  const draft = {
    ...rawDraft([
      rawItem(1, { isLimited: false, initialStock: 5 }),
      rawItem(2, { rate: 0.6 }),
      rawItem(3, { rate: 0.6 }),
    ]),
    boxInfiniteRate: 2,
  };
  const issues = marathonPlugin.validate(marathonPlugin.parseDraft(draft));
  assert.ok(issues.some((candidate) => candidate.path === 'boxInfiniteRate'));
  assert.equal(
    issues.some((candidate) => candidate.path === `boxGachas.${BOX_ID}`),
    false,
  );
});

test('the default infinite rate for the budget is the stock ratio', () => {
  // Infinite stock 3, limited stock 7: pInf = 0.3, so the budget is 0.7.
  const draft = rawDraft([
    rawItem(1, { isLimited: false, initialStock: 3 }),
    rawItem(2, { initialStock: 7, rate: 0.8 }),
  ]);
  const issues = marathonPlugin.validate(marathonPlugin.parseDraft(draft));
  const issue = issues.find((candidate) => candidate.path === `boxGachas.${BOX_ID}`);
  assert.ok(issue);
  assert.equal(
    issue.message,
    'rates assigned 0.8 exceed the 0.7 available after box infinite rate 0.3',
  );
});

test('a box with no infinite items has the whole finite budget', () => {
  assert.doesNotThrow(() => compileDraft(rawDraft([rawItem(1, { rate: 0.6 }), rawItem(2, { rate: 0.4 })])));
  assert.throws(
    () => compileDraft(rawDraft([rawItem(1, { rate: 0.6 }), rawItem(2, { rate: 0.5 })])),
    /rates assigned 1\.1 exceed the 1 available/,
  );
});
