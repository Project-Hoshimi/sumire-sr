// Client-state fingerprint tests: which registry changes a game client can see.
// Pure unit tests against `memoryEventStore`: no database, no game master data.
//
//   node --test src/services/events/clientState.test.ts
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import {
  createEventDefinition,
  deleteEvent,
  initEventRegistry,
  publishEventDefinition,
  reloadEventRegistry,
  replaceEventSchedule,
  resetEventRegistryForTests,
  saveEventDraft,
} from './registry.ts';
import { clientStateFingerprint, clientStatePhase, resetClientStateCacheForTests } from './clientState.ts';
import { memoryEventStore, type EventStore } from './store.ts';
import { memoryMarathonPlayerStateReader } from './preview.ts';
import { catalogDrafts } from '../marathon/catalog.ts';
import { marathonPlugin, type MarathonDraft } from '../marathon/plugin.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const STARTS = Date.UTC(2026, 10, 13);
const ENDS = Date.UTC(2026, 10, 28);
const EXCHANGE = Date.UTC(2026, 11, 5);
const EVENT_ID = 'marathon-client-state';

function placeholderDraft(): MarathonDraft {
  const draft = catalogDrafts().find((d) => d.id === 'marathon-placeholder');
  assert.ok(draft, 'placeholder draft should exist in the catalog');
  return draft;
}

function scheduledDraft(
  id: string,
  startsAt: string,
  endsAt: string,
  exchangeEndsAt: string,
): MarathonDraft {
  return { ...placeholderDraft(), id, schedule: { startsAt, endsAt, exchangeEndsAt } };
}

const asDrafts = (...drafts: MarathonDraft[]): { kind: string; draft: unknown }[] =>
  drafts.map((draft) => ({ kind: 'marathon', draft }));

const players = () => memoryMarathonPlayerStateReader([]);

let store: EventStore & { reset(): void };

beforeEach(async () => {
  resetEventRegistryForTests();
  resetClientStateCacheForTests();
  store = memoryEventStore();
  await initEventRegistry({
    store,
    drafts: asDrafts(
      scheduledDraft(
        EVENT_ID,
        '2026-11-13T00:00:00Z',
        '2026-11-28T00:00:00Z',
        '2026-12-05T00:00:00Z',
      ),
    ),
  });
});

test('clientStatePhase covers before/running/exchange/ended/disabled', () => {
  const schedule = [
    {
      startsAt: STARTS,
      endsAt: ENDS,
      exchangeEndsAt: EXCHANGE,
      enabled: true,
    },
  ];
  assert.equal(clientStatePhase(schedule, STARTS - 1), 'before');
  assert.equal(clientStatePhase(schedule, STARTS), 'running');
  assert.equal(clientStatePhase(schedule, ENDS - 1), 'running');
  assert.equal(clientStatePhase(schedule, ENDS), 'exchange');
  assert.equal(clientStatePhase(schedule, EXCHANGE - 1), 'exchange');
  assert.equal(clientStatePhase(schedule, EXCHANGE), 'ended');
  assert.equal(clientStatePhase([{ ...schedule[0]!, enabled: false }], STARTS), 'disabled');
  assert.equal(clientStatePhase([], STARTS), 'disabled');
});

test('the fingerprint is stable across calls', async () => {
  const now = new Date(STARTS + DAY_MS);
  assert.equal(clientStateFingerprint(now), clientStateFingerprint(new Date(now.getTime())));
  // A reload that changes nothing keeps the same fingerprint.
  await reloadEventRegistry();
  assert.equal(clientStateFingerprint(now), clientStateFingerprint(now));
});

test('a draft save does not change the fingerprint', async () => {
  const now = new Date(STARTS + DAY_MS);
  const before = clientStateFingerprint(now);
  await saveEventDraft(EVENT_ID, {
    draft: { ...placeholderDraft(), id: EVENT_ID, boxDrawMax: (placeholderDraft().boxDrawMax ?? 0) + 1 },
  });
  assert.equal(clientStateFingerprint(now), before, 'drafts are invisible to clients');
});

test('an unpublished definition does not change the fingerprint', async () => {
  const now = new Date(STARTS + DAY_MS);
  const before = clientStateFingerprint(now);
  await createEventDefinition({
    id: 'marathon-unpublished',
    kind: 'marathon',
    title: 'Not live yet',
    draft: { ...placeholderDraft(), id: 'marathon-unpublished' },
  });
  await reloadEventRegistry();
  assert.equal(clientStateFingerprint(now), before);
});

test('publishing changes the fingerprint', async () => {
  const now = new Date(STARTS + DAY_MS);
  const before = clientStateFingerprint(now);
  await saveEventDraft(EVENT_ID, {
    draft: { ...placeholderDraft(), id: EVENT_ID, boxDrawMax: (placeholderDraft().boxDrawMax ?? 0) + 1 },
  });
  assert.equal(clientStateFingerprint(now), before);
  await publishEventDefinition(EVENT_ID, { players: players() });
  assert.notEqual(clientStateFingerprint(now), before);
});

test('a schedule change changes the fingerprint', async () => {
  const now = new Date(STARTS + DAY_MS);
  const before = clientStateFingerprint(now);
  await replaceEventSchedule(EVENT_ID, [
    {
      startsAt: '2026-11-14T00:00:00Z',
      endsAt: '2026-11-28T00:00:00Z',
      exchangeEndsAt: '2026-12-05T00:00:00Z',
    },
  ]);
  assert.notEqual(clientStateFingerprint(now), before);
});

test('enabling/disabling a schedule row changes the fingerprint', async () => {
  const now = new Date(STARTS + DAY_MS);
  const before = clientStateFingerprint(now);
  await replaceEventSchedule(EVENT_ID, [
    {
      startsAt: '2026-11-13T00:00:00Z',
      endsAt: '2026-11-28T00:00:00Z',
      exchangeEndsAt: '2026-12-05T00:00:00Z',
      enabled: false,
    },
  ]);
  const disabled = clientStateFingerprint(now);
  assert.notEqual(disabled, before, 'the disabled flag and the phase both change');
  await replaceEventSchedule(EVENT_ID, [
    {
      startsAt: '2026-11-13T00:00:00Z',
      endsAt: '2026-11-28T00:00:00Z',
      exchangeEndsAt: '2026-12-05T00:00:00Z',
      enabled: true,
    },
  ]);
  assert.equal(clientStateFingerprint(now), before, 're-enabling restores the same state');
});

test('deleting an event changes the fingerprint', async () => {
  const now = new Date(EXCHANGE + DAY_MS);
  const before = clientStateFingerprint(now);
  await deleteEvent(EVENT_ID, { now: EXCHANGE + DAY_MS });
  assert.notEqual(clientStateFingerprint(now), before);
});

test('the fingerprint changes as now crosses startsAt and endsAt', () => {
  const before = clientStateFingerprint(new Date(STARTS - 1));
  const running = clientStateFingerprint(new Date(STARTS));
  const exchange = clientStateFingerprint(new Date(ENDS));
  const ended = clientStateFingerprint(new Date(EXCHANGE));
  assert.notEqual(running, before, 'before → running');
  assert.notEqual(exchange, running, 'running → exchange');
  assert.notEqual(ended, exchange, 'exchange → ended');
  assert.equal(new Set([before, running, exchange, ended]).size, 4);
});

test('the projection is ordered by id regardless of load order', async () => {
  resetEventRegistryForTests();
  store = memoryEventStore();
  await initEventRegistry({ store, drafts: [] });
  // Two published definitions created directly, in reverse id order.
  const make = async (id: string) => {
    const draft = marathonPlugin.parseDraft(
      scheduledDraft(
        id,
        '2026-11-13T00:00:00Z',
        '2026-11-28T00:00:00Z',
        '2026-12-05T00:00:00Z',
      ),
    ) as MarathonDraft;
    await store.createDefinition(
      {
        id,
        kind: 'marathon',
        title: draft.name,
        draft,
        published: draft,
        publishedVersion: 1,
        updatedBy: 'tester',
      },
      [
        {
          eventId: id,
          startsAt: new Date(STARTS),
          endsAt: new Date(ENDS),
          exchangeEndsAt: new Date(EXCHANGE),
          enabled: true,
        },
      ],
    );
  };
  await make('marathon-z');
  await make('marathon-a');
  await reloadEventRegistry();
  const first = clientStateFingerprint(new Date(STARTS + DAY_MS));

  resetEventRegistryForTests();
  store = memoryEventStore();
  await initEventRegistry({ store, drafts: [] });
  await make('marathon-a');
  await make('marathon-z');
  await reloadEventRegistry();
  assert.equal(clientStateFingerprint(new Date(STARTS + DAY_MS)), first);
});
