// Event registry tests. Pure unit tests against `memoryEventStore`: no database,
// no game master data. Fixed timestamps only — `Date.now` appears nowhere except
// inside `marathonWindow` for the dev-override window.
//
//   node --test src/services/events/registry.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { beforeEach } from 'node:test';
import {
  compiledEvent,
  deleteEvent,
  eventWindowAt,
  initEventRegistry,
  openEvents,
  publishEventDefinition,
  registryLoaded,
  reloadEventRegistry,
  resetEventRegistryForTests,
} from './registry.ts';
import { memoryEventStore, type EventStore } from './store.ts';
import {
  catalogDrafts,
  marathonConfig,
  marathonWindow,
  marathonWindowFor,
  openMarathons,
  setCatalogForTests,
} from '../marathon/catalog.ts';
import { marathonPlugin, type MarathonConfig, type MarathonDraft } from '../marathon/plugin.ts';
import {
  catalogDrafts as moshikoiCatalogDrafts,
  loveConfig,
  loveRoutes,
  MoshikoiError,
  supportedLoveIds,
} from '../moshikoi/catalog.ts';
import {
  moshikoiPlugin,
  type MoshikoiDraft,
  type MoshikoiRuntime,
} from '../moshikoi/plugin.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Run `fn` with SUMIRE_MARATHON_ID temporarily set to `value`. */
function withMarathonId<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.SUMIRE_MARATHON_ID;
  if (value === undefined) delete process.env.SUMIRE_MARATHON_ID;
  else process.env.SUMIRE_MARATHON_ID = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.SUMIRE_MARATHON_ID;
    else process.env.SUMIRE_MARATHON_ID = previous;
  }
}

/** The placeholder catalog draft, the base every test clones from. */
function placeholderDraft(): MarathonDraft {
  const draft = catalogDrafts().find((d) => d.id === 'marathon-placeholder');
  assert.ok(draft, 'placeholder draft should exist in the catalog');
  return draft;
}

/** Clone the placeholder with a different id and an authored schedule. */
function scheduledDraft(
  id: string,
  startsAt: string,
  endsAt: string,
  exchangeEndsAt: string,
): MarathonDraft {
  return { ...placeholderDraft(), id, schedule: { startsAt, endsAt, exchangeEndsAt } };
}

/** Wrap drafts in the shape `initEventRegistry` imports. */
const asDrafts = (
  ...drafts: MarathonDraft[]
): { kind: string; draft: unknown }[] => drafts.map((draft) => ({ kind: 'marathon', draft }));

let store: EventStore & { reset(): void };

beforeEach(() => {
  resetEventRegistryForTests();
  store = memoryEventStore();
  delete process.env.SUMIRE_MARATHON_ID;
});

// Import

test('initEventRegistry imports a definition-less draft as version 1', async () => {
  const draft = placeholderDraft();
  const { imported } = await initEventRegistry({ store, drafts: asDrafts(draft) });

  assert.deepEqual(imported, ['marathon-placeholder']);
  const definition = await store.getDefinition('marathon-placeholder');
  assert.ok(definition);
  assert.equal(definition.publishedVersion, 1);
  assert.equal(definition.updatedBy, 'catalog-import');
  assert.equal(definition.title, draft.name);
  // The published payload is the parsed draft, so compare against parseDraft.
  assert.deepEqual(definition.published, marathonPlugin.parseDraft(draft));

  const history = await store.listHistory('marathon-placeholder');
  assert.equal(history.length, 1);
  assert.equal(history[0].version, 1);
  assert.equal(history[0].publishedBy, 'catalog-import');
});

test('a draft schedule becomes one enabled schedule row; no schedule means no rows', async () => {
  const scheduled = scheduledDraft(
    'marathon-sched',
    '2026-11-13T00:00:00Z',
    '2026-11-28T00:00:00Z',
    '2026-12-05T00:00:00Z',
  );
  await initEventRegistry({ store, drafts: asDrafts(scheduled, placeholderDraft()) });

  const rows = await store.listSchedule();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.eventId, 'marathon-sched');
  assert.equal(row.startsAt.toISOString(), '2026-11-13T00:00:00.000Z');
  assert.equal(row.endsAt.toISOString(), '2026-11-28T00:00:00.000Z');
  assert.equal(row.exchangeEndsAt.toISOString(), '2026-12-05T00:00:00.000Z');
  assert.equal(row.enabled, true);
});

test('re-running initEventRegistry with the same store is a no-op', async () => {
  const draft = placeholderDraft();
  const first = await initEventRegistry({ store, drafts: asDrafts(draft) });
  assert.deepEqual(first.imported, ['marathon-placeholder']);

  const second = await initEventRegistry({ store, drafts: asDrafts(draft) });
  assert.deepEqual(second.imported, []);
  const history = await store.listHistory('marathon-placeholder');
  assert.equal(history.length, 1);
});

test('initEventRegistry never overwrites an existing definition', async () => {
  const draft = placeholderDraft();
  await store.createDefinition(
    {
      id: 'marathon-placeholder',
      kind: 'marathon',
      title: 'Hand-edited title',
      draft: marathonPlugin.parseDraft(draft),
      published: marathonPlugin.parseDraft(draft),
      publishedVersion: 7,
      updatedBy: 'editor',
    },
    [],
  );

  const { imported } = await initEventRegistry({ store, drafts: asDrafts(draft) });
  assert.deepEqual(imported, []);
  const definition = await store.getDefinition('marathon-placeholder');
  assert.ok(definition);
  assert.equal(definition.title, 'Hand-edited title');
  assert.equal(definition.publishedVersion, 7);
});

test('a draft failing validation is skipped and not stored', async () => {
  const bad = { ...placeholderDraft(), id: '../x' };
  const { imported } = await initEventRegistry({ store, drafts: asDrafts(bad) });
  assert.deepEqual(imported, []);
  assert.equal(await store.getDefinition('../x'), undefined);
});

// Schedule lookup. Event A: 2026-11-13 → 2026-11-28, exchange to 2026-12-05.

const A_STARTS = Date.UTC(2026, 10, 13);
const A_ENDS = Date.UTC(2026, 10, 28);
const A_EXCHANGE = Date.UTC(2026, 11, 5);

test('openEvents and eventWindowAt follow the authored window', async () => {
  const a = scheduledDraft('marathon-test-a', '2026-11-13T00:00:00Z', '2026-11-28T00:00:00Z', '2026-12-05T00:00:00Z');
  await initEventRegistry({ store, drafts: asDrafts(a) });

  assert.deepEqual(openEvents('marathon', A_STARTS - DAY_MS), []);
  const during = openEvents<MarathonConfig>('marathon', A_STARTS + 3 * DAY_MS);
  assert.equal(during.length, 1);
  assert.equal(during[0].id, 'marathon-test-a');
  assert.equal(during[0].runtime.id, 'marathon-test-a');
  // Exchange window: still open between endsAt and exchangeEndsAt.
  const exchange = openEvents('marathon', A_ENDS + DAY_MS);
  assert.equal(exchange.length, 1);
  assert.equal(exchange[0].id, 'marathon-test-a');
  assert.deepEqual(openEvents('marathon', A_EXCHANGE), []);
  assert.deepEqual(openEvents('marathon', A_EXCHANGE + DAY_MS), []);

  const window = eventWindowAt('marathon', 'marathon-test-a', A_STARTS + DAY_MS);
  assert.deepEqual(window, {
    startTime: A_STARTS,
    endTime: A_ENDS,
    exchangeEndTime: A_EXCHANGE,
  });
});

test('a disabled schedule row is not open', async () => {
  const draft = marathonPlugin.parseDraft(
    scheduledDraft('marathon-disabled', '2026-11-13T00:00:00Z', '2026-11-28T00:00:00Z', '2026-12-05T00:00:00Z'),
  ) as MarathonDraft;
  await store.createDefinition(
    {
      id: 'marathon-disabled',
      kind: 'marathon',
      title: draft.name,
      draft,
      published: draft,
      publishedVersion: 1,
      updatedBy: 'tester',
    },
    [
      {
        eventId: 'marathon-disabled',
        startsAt: new Date(A_STARTS),
        endsAt: new Date(A_ENDS),
        exchangeEndsAt: new Date(A_EXCHANGE),
        enabled: false,
      },
    ],
  );
  await initEventRegistry({ store, drafts: [] });

  assert.deepEqual(openEvents('marathon', A_STARTS + DAY_MS), []);
  assert.equal(eventWindowAt('marathon', 'marathon-disabled', A_STARTS + DAY_MS), undefined);
});

test('overlapping events are both returned, ordered by start, without warnings', async () => {
  const warn = test.mock.method(console, 'warn', () => undefined);
  const a = scheduledDraft('marathon-test-a', '2026-11-13T00:00:00Z', '2026-11-28T00:00:00Z', '2026-12-05T00:00:00Z');
  const b = scheduledDraft('marathon-test-b', '2026-11-20T00:00:00Z', '2026-12-10T00:00:00Z', '2026-12-17T00:00:00Z');
  await initEventRegistry({ store, drafts: asDrafts(b, a) });

  const now = Date.UTC(2026, 10, 22);
  const open = openEvents('marathon', now);
  assert.deepEqual(open.map((e) => e.id), ['marathon-test-a', 'marathon-test-b']);

  // Overlapping marathon schedules are supported, so nothing is warned about.
  const messages = warn.mock.calls.map((call) => String(call.arguments[0] ?? ''));
  assert.equal(messages.filter((m) => m.includes('overlapping')).length, 0);
  warn.mock.restore();
});

test('marathonConfig serves the registry after init, not the catalog files', async () => {
  const a = scheduledDraft('marathon-test-a', '2026-11-13T00:00:00Z', '2026-11-28T00:00:00Z', '2026-12-05T00:00:00Z');
  await initEventRegistry({ store, drafts: asDrafts(a) });

  const config = marathonConfig('marathon-test-a');
  assert.ok(config);
  assert.equal(config.id, 'marathon-test-a');
  // marathon-not-imported is not imported and is not in any catalog file.
  assert.equal(marathonConfig('marathon-not-imported'), undefined);
});

test('SUMIRE_MARATHON_ID makes an unscheduled import always open', async () => {
  await initEventRegistry({ store, drafts: asDrafts(placeholderDraft()) });
  const now = Date.UTC(2026, 10, 11, 16, 25, 0);

  withMarathonId('marathon-placeholder', () => {
    const open = openMarathons(now);
    assert.equal(open.length, 1);
    assert.equal(open[0].config.id, 'marathon-placeholder');
    assert.deepEqual(open[0].window, marathonWindow(now));
    assert.deepEqual(marathonWindowFor('marathon-placeholder', now), marathonWindow(now));
  });

  withMarathonId(undefined, () => {
    assert.deepEqual(openMarathons(now), []);
    assert.equal(marathonWindowFor('marathon-placeholder', now), undefined);
  });
});

// Publish / reload

test('publishEventDefinition bumps the version and applies live', async () => {
  const draft = placeholderDraft();
  await initEventRegistry({ store, drafts: asDrafts(draft) });

  const result = await publishEventDefinition('marathon-placeholder', {
    draft: { ...draft, name: 'Renamed' },
    by: 'tester',
  });
  assert.equal(result.version, 2);

  const config = marathonConfig('marathon-placeholder');
  assert.ok(config);
  assert.equal(config.name, 'Renamed');

  const definition = await store.getDefinition('marathon-placeholder');
  assert.ok(definition);
  assert.equal(definition.updatedBy, 'tester');
  const history = await store.listHistory('marathon-placeholder');
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((h) => h.version), [1, 2]);
});

test('publishing an invalid draft throws and leaves version and config unchanged', async () => {
  const draft = placeholderDraft();
  await initEventRegistry({ store, drafts: asDrafts(draft) });
  const before = marathonConfig('marathon-placeholder');
  assert.ok(before);

  await assert.rejects(
    publishEventDefinition('marathon-placeholder', { draft: { ...draft, id: '../x' } }),
    /validation errors/,
  );

  const definition = await store.getDefinition('marathon-placeholder');
  assert.ok(definition);
  assert.equal(definition.publishedVersion, 1);
  assert.equal(marathonConfig('marathon-placeholder')?.name, before.name);
});

test('publishing an unknown id throws', async () => {
  await initEventRegistry({ store, drafts: asDrafts(placeholderDraft()) });
  await assert.rejects(
    publishEventDefinition('marathon-nonexistent', { draft: placeholderDraft() }),
    /event definition not found: marathon-nonexistent/,
  );
});

test('publishing a draft with a changed schedule replaces the schedule rows', async () => {
  const draft = scheduledDraft(
    'marathon-sched',
    '2026-11-13T00:00:00Z',
    '2026-11-28T00:00:00Z',
    '2026-12-05T00:00:00Z',
  );
  await initEventRegistry({ store, drafts: asDrafts(draft) });
  assert.deepEqual(eventWindowAt('marathon', 'marathon-sched', A_STARTS + DAY_MS), {
    startTime: A_STARTS,
    endTime: A_ENDS,
    exchangeEndTime: A_EXCHANGE,
  });

  const newStart = Date.UTC(2026, 11, 10);
  const newEnd = Date.UTC(2026, 11, 24);
  const newExchange = Date.UTC(2027, 0, 1);
  const result = await publishEventDefinition('marathon-sched', {
    draft: scheduledDraft(
      'marathon-sched',
      '2026-12-10T00:00:00Z',
      '2026-12-24T00:00:00Z',
      '2027-01-01T00:00:00Z',
    ),
    by: 'tester',
  });
  assert.equal(result.version, 2);

  const rows = (await store.listSchedule()).filter((row) => row.eventId === 'marathon-sched');
  assert.equal(rows.length, 1, 'the old row is replaced, not added to');
  assert.equal(rows[0].startsAt.getTime(), newStart);
  assert.equal(rows[0].endsAt.getTime(), newEnd);
  assert.equal(rows[0].exchangeEndsAt.getTime(), newExchange);
  assert.equal(rows[0].enabled, true);

  // The live window follows the new rows immediately.
  assert.deepEqual(eventWindowAt('marathon', 'marathon-sched', newStart + DAY_MS), {
    startTime: newStart,
    endTime: newEnd,
    exchangeEndTime: newExchange,
  });
  assert.equal(eventWindowAt('marathon', 'marathon-sched', A_STARTS + DAY_MS), undefined);
});

test('publishing a draft without a schedule leaves the existing rows untouched', async () => {
  const draft = scheduledDraft(
    'marathon-sched',
    '2026-11-13T00:00:00Z',
    '2026-11-28T00:00:00Z',
    '2026-12-05T00:00:00Z',
  );
  await initEventRegistry({ store, drafts: asDrafts(draft) });
  const before = await store.listSchedule();
  assert.equal(before.length, 1);

  const { schedule: _omitted, ...withoutSchedule } = draft;
  const result = await publishEventDefinition('marathon-sched', {
    draft: { ...withoutSchedule, name: 'Renamed without schedule' },
    by: 'tester',
  });
  assert.equal(result.version, 2);

  assert.deepEqual(await store.listSchedule(), before);
  assert.deepEqual(eventWindowAt('marathon', 'marathon-sched', A_STARTS + DAY_MS), {
    startTime: A_STARTS,
    endTime: A_ENDS,
    exchangeEndTime: A_EXCHANGE,
  });
});

test('concurrent reloads are serialized and the latest publish wins', async () => {
  let activeReloads = 0;
  let maxActiveReloads = 0;
  const delayed = async <T>(fn: () => Promise<T>): Promise<T> => {
    activeReloads += 1;
    maxActiveReloads = Math.max(maxActiveReloads, activeReloads);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return await fn();
    } finally {
      activeReloads -= 1;
    }
  };
  const tracked: EventStore = {
    ...store,
    listDefinitions: () => delayed(() => store.listDefinitions()),
    listSchedule: () => delayed(() => store.listSchedule()),
  };

  const draft = scheduledDraft(
    'marathon-sched',
    '2026-11-13T00:00:00Z',
    '2026-11-28T00:00:00Z',
    '2026-12-05T00:00:00Z',
  );
  await initEventRegistry({ store: tracked, drafts: asDrafts(draft) });
  maxActiveReloads = 0;

  const newStart = Date.UTC(2026, 11, 10);
  const reloadA = reloadEventRegistry();
  const reloadB = reloadEventRegistry();
  const publish = publishEventDefinition('marathon-sched', {
    draft: {
      ...scheduledDraft(
        'marathon-sched',
        '2026-12-10T00:00:00Z',
        '2026-12-24T00:00:00Z',
        '2027-01-01T00:00:00Z',
      ),
      name: 'Latest published',
    },
    by: 'tester',
  });
  await Promise.all([reloadA, reloadB, publish]);

  assert.equal(maxActiveReloads, 1, 'reload reads never overlap');
  assert.equal(marathonConfig('marathon-sched')?.name, 'Latest published');
  assert.deepEqual(eventWindowAt('marathon', 'marathon-sched', newStart + DAY_MS), {
    startTime: newStart,
    endTime: Date.UTC(2026, 11, 24),
    exchangeEndTime: Date.UTC(2027, 0, 1),
  });
});

test('a failed reload rejects its caller but not later reloads', async () => {
  await initEventRegistry({ store, drafts: asDrafts(placeholderDraft()) });

  let fail = true;
  const flaky: EventStore = {
    ...store,
    listDefinitions: async () => {
      if (fail) throw new Error('database unavailable');
      return store.listDefinitions();
    },
  };
  // Point the registry at the flaky store without importing again.
  resetEventRegistryForTests();
  fail = false;
  await initEventRegistry({ store: flaky, drafts: [] });

  fail = true;
  await assert.rejects(reloadEventRegistry(), /database unavailable/);
  fail = false;
  await reloadEventRegistry();
  assert.equal(marathonConfig('marathon-placeholder')?.id, 'marathon-placeholder');
});

test('before the registry loads, catalog file schedules supply the windows', () => {
  assert.equal(registryLoaded(), false);
  const placeholder = JSON.parse(
    readFileSync(new URL('../marathon/catalog/placeholder.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  const scheduled = {
    ...placeholder,
    id: 'marathon-test-scheduled',
    name: 'Scheduled Test Marathon',
    schedule: {
      startsAt: new Date(A_STARTS).toISOString(),
      endsAt: new Date(A_ENDS).toISOString(),
      exchangeEndsAt: new Date(A_EXCHANGE).toISOString(),
    },
  };
  setCatalogForTests([placeholder, scheduled]);
  try {
    withMarathonId(undefined, () => {
      const inside = Date.UTC(2026, 10, 20);
      const before = A_STARTS - 1;
      const duringExchange = A_ENDS + DAY_MS;
      const closed = A_EXCHANGE;

      assert.deepEqual(marathonWindowFor('marathon-test-scheduled', inside), {
        startTime: A_STARTS,
        endTime: A_ENDS,
        exchangeEndTime: A_EXCHANGE,
      });
      assert.deepEqual(marathonWindowFor('marathon-test-scheduled', duringExchange), {
        startTime: A_STARTS,
        endTime: A_ENDS,
        exchangeEndTime: A_EXCHANGE,
      });
      assert.equal(marathonWindowFor('marathon-test-scheduled', before), undefined);
      assert.equal(marathonWindowFor('marathon-test-scheduled', closed), undefined);
      // The placeholder has no authored schedule, so it has no fallback window.
      assert.equal(marathonWindowFor('marathon-placeholder', inside), undefined);

      assert.deepEqual(openMarathons(inside).map((event) => event.config.id), [
        'marathon-test-scheduled',
      ]);
      assert.deepEqual(openMarathons(duringExchange).map((event) => event.config.id), [
        'marathon-test-scheduled',
      ]);
      assert.deepEqual(openMarathons(before), []);
      assert.deepEqual(openMarathons(closed), []);
    });
  } finally {
    setCatalogForTests(undefined);
  }
});

// Moshikoi (permanent, no schedule)

const MOSHIKOI_ID = 'love-24-1114';

function moshikoiDraft(id = MOSHIKOI_ID): MoshikoiDraft {
  const draft = moshikoiCatalogDrafts().find((candidate) => candidate.id === id);
  assert.ok(draft, `checked-in moshikoi draft ${id}`);
  return draft;
}

function asMoshikoiDrafts(...drafts: MoshikoiDraft[]) {
  return drafts.map((draft) => ({ kind: 'moshikoi', draft }));
}

test('importing a moshikoi draft compiles it with no schedule rows', async () => {
  await initEventRegistry({ store, drafts: asMoshikoiDrafts(moshikoiDraft()) });
  assert.equal(registryLoaded(), true);

  const runtime = compiledEvent<MoshikoiRuntime>('moshikoi', MOSHIKOI_ID);
  assert.ok(runtime, 'compiled runtime exists');
  assert.equal(runtime.config.loveId, MOSHIKOI_ID);
  assert.equal(moshikoiPlugin.lifecycle, 'permanent');
  assert.equal(moshikoiPlugin.draftSchedule(moshikoiDraft()), undefined);

  const rows = await store.listSchedule();
  assert.deepEqual(
    rows.filter((row) => row.eventId === MOSHIKOI_ID),
    [],
  );
});

test('catalog.ts serves supported ids and configs from the loaded registry', async () => {
  await initEventRegistry({ store, drafts: asMoshikoiDrafts(moshikoiDraft()) });

  // The file fallback lists six ids; the registry path lists exactly what is
  // compiled, which proves the read comes from the registry.
  assert.deepEqual(supportedLoveIds(), [MOSHIKOI_ID]);
  const catalog = moshikoiDraft().catalog;
  assert.equal(loveConfig(MOSHIKOI_ID).name, catalog.name);
  assert.deepEqual(loveRoutes(MOSHIKOI_ID), moshikoiPlugin.compile(moshikoiDraft()).routes);
});

test('deleting a moshikoi definition makes loveConfig throw love-event-not-available', async () => {
  await initEventRegistry({ store, drafts: asMoshikoiDrafts(moshikoiDraft()) });
  await deleteEvent(MOSHIKOI_ID);
  await reloadEventRegistry();

  assert.deepEqual(supportedLoveIds(), []);
  assert.throws(
    () => loveConfig(MOSHIKOI_ID),
    (error: unknown) =>
      error instanceof MoshikoiError && error.code === 'love-event-not-available',
  );
});

test('publishing an edited moshikoi route map is visible to loveRoutes without a restart', async () => {
  await initEventRegistry({ store, drafts: asMoshikoiDrafts(moshikoiDraft()) });
  const edited: MoshikoiDraft = structuredClone(moshikoiDraft());
  const endings = edited.routes.endings as { id: string; name: string }[];
  const first = endings[0];
  assert.ok(first, 'the route map has an ending');
  first.name = 'Edited ending';

  await publishEventDefinition(MOSHIKOI_ID, { draft: edited });

  assert.equal(loveRoutes(MOSHIKOI_ID).endings[0]?.name, 'Edited ending');
  assert.deepEqual(
    (await store.listSchedule()).filter((row) => row.eventId === MOSHIKOI_ID),
    [],
  );
});
