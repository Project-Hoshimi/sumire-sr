/**
 * Component tests for the moshikoi (もし恋) event editor: the tab set it swaps
 * in for the marathon tabs, and the edits the Catalog/Routes/Endings/JSON panels
 * push into the shared draft that Save draft sends.
 *
 * The draft below is a trimmed copy of the `love-24-1114` event shipped in
 * `fastify-api/src/services/moshikoi/`: the same catalog scalars, the same
 * ending ids and the same episode id shape, reduced to a handful of episodes.
 * The API module is mocked, so nothing here touches fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { get, put } from '../api.ts';
import type { AdminSessionUser, EventDetail } from '../types.ts';
import type { MoshikoiEnding, MoshikoiEpisode } from './moshikoi/moshikoi.ts';
import { EventEditorPage } from './EventEditorPage.tsx';

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>();
  return { ...actual, get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() };
});

const EVENT_ID = 'evt-love-24-1114';
const LOVE_ID = 'love-24-1114';
const EPISODE_PREFIX = `love-event-story-${LOVE_ID}-`;

/** A full episode id from the event's short suffix ("001", "008-bad"). */
function episode(suffix: string): string {
  return `${EPISODE_PREFIX}${suffix}`;
}

/** The catalog document of love-24-1114, trimmed to the fields the tab shows. */
function catalogFixture(): Record<string, unknown> {
  return {
    loveId: LOVE_ID,
    name: 'もし恋 ~もしも君と恋をしたら~',
    description: '鈴村優編',
    simpleName: 'もし恋 鈴村優編',
    startTime: 1731553200000,
    unlockConditionId: 'cd-clear-area-main-002',
    bannerAssetId: 'img_banner_l_event-love-24-1114',
    characterId: 'char-yu',
    costumeId: 'cos-yu-casl-02',
    characterAssetId: 'img_chr_mem_yu',
    color: 'AECE6E',
    storyReadItemId: 'item-love-24-1114-story',
    presentItemId: 'item-love-24-1114-present',
    promoteItemId: 'item-love-24-1114-promote',
    lessonMaxHours: 12,
    eventMissionIds: ['event-love-24-1114-normal', 'event-love-24-1114-normal-card'],
    limitedEventMissionIds: ['event-love-24-1114-limited'],
    episodeUnlockLevels: { '1': 1, '2': 2 },
    hintUnlockLevels: { '1': 9, '2': 10 },
  };
}

interface RoutesFixture {
  loveId: string;
  endingConditions: Record<string, string>;
  endings: MoshikoiEnding[];
  episodes: Record<string, MoshikoiEpisode>;
}

/** The route map of love-24-1114, trimmed to a few representative episodes. */
function routesFixture(): RoutesFixture {
  const episodes: Record<string, MoshikoiEpisode> = {
    [episode('001')]: {
      groups: [{ index: 1, count: 2, scores: [10, 20] }],
      next: episode('002'),
      outcomes: [
        { all: [{ group: 1, choice: 1 }], next: episode('002') },
        {
          all: [{ group: 1, choice: 2 }],
          ending: 'love-end-love-24-1114-003-bad',
          maxPoints: 30,
        },
      ],
    },
    [episode('002')]: {
      groups: [{ index: 1, count: 3, best: 2, scores: [1, 2, 3], points: [5, 5, 5] }],
      next: episode('007'),
    },
    // Deliberately points at an episode this event does not author, so the
    // broken-reference highlight has something to show.
    [episode('005')]: { next: episode('999-missing') },
    [episode('007')]: {
      groups: [
        { index: 1, count: 2, scores: [0, 0] },
        { index: 2, count: 2, scores: [0, 0], requires: [{ group: 1, choice: 2 }] },
      ],
      outcomes: [{ all: [{ episode: episode('002'), group: 1, choice: 3 }], next: episode('008-bad') }],
    },
    [episode('008-bad')]: {
      branches: [
        {
          group: 1,
          match: 1,
          otherwise: 2,
          all: [{ episode: episode('007'), group: 1, choice: 1 }],
        },
      ],
    },
  };
  return {
    loveId: LOVE_ID,
    endingConditions: {
      'cd-event-love-24-1114-normal-mission_love-end_emb': 'love-end-love-24-1114-008-happy-001',
      'cd-event-love-24-1114-limited-mission_love-end_emb-sp':
        'love-end-love-24-1114-008-happy-001',
    },
    endings: [
      { id: 'love-end-love-24-1114-003-bad', name: 'BAD END', favorability: 206 },
      {
        id: 'love-end-love-24-1114-008-happy-001',
        name: 'TRUE END',
        favorability: 2059,
        endRollAssetId: 'event_2411_02_02',
      },
      { id: 'love-end-love-24-1114-008-normal-001', name: 'NORMAL END', favorability: 618 },
    ],
    episodes,
  };
}

/** A moshikoi draft: `{ id, title, catalog, routes }`, nothing else. */
function moshikoiDraft(): Record<string, unknown> {
  return {
    id: LOVE_ID,
    title: 'もし恋 ~もしも君と恋をしたら~',
    catalog: catalogFixture(),
    routes: routesFixture(),
  };
}

/** The stored draft after one edit, for a whole-body comparison. */
function expectedDraft(mutate: (draft: Record<string, unknown>) => void): Record<string, unknown> {
  const draft = JSON.parse(JSON.stringify(moshikoiDraft())) as Record<string, unknown>;
  mutate(draft);
  return draft;
}

function moshikoiDetail(): EventDetail {
  return {
    id: EVENT_ID,
    kind: 'moshikoi',
    lifecycle: 'permanent',
    title: 'もし恋 ~もしも君と恋をしたら~',
    titleEn: null,
    draft: moshikoiDraft(),
    published: false,
    publishedVersion: 0,
    updatedBy: null,
    updatedByName: null,
    updatedAt: '2026-01-01T00:00:00Z',
    schedule: [],
    schema: {
      fields: [
        { path: 'id', type: 'string', label: 'Id', readOnly: true },
        { path: 'title', type: 'string', label: 'Title' },
        { path: 'catalog', type: 'object', label: 'Catalog' },
        { path: 'routes', type: 'object', label: 'Routes' },
      ],
    },
    history: [],
  };
}

function marathonDetail(): EventDetail {
  return {
    id: EVENT_ID,
    kind: 'marathon',
    title: 'Marathon event',
    titleEn: null,
    draft: {
      id: EVENT_ID,
      name: 'Marathon event',
      type: 1,
      boxGachas: {},
      npcRosters: {},
    },
    published: false,
    publishedVersion: 0,
    updatedBy: null,
    updatedByName: null,
    updatedAt: '2026-01-01T00:00:00Z',
    schedule: [
      {
        id: 1,
        eventId: EVENT_ID,
        startsAt: '2026-02-01T00:00:07Z',
        endsAt: '2026-02-02T00:00:07Z',
        exchangeEndsAt: '2026-02-03T00:00:07Z',
        enabled: true,
      },
    ],
    schema: { fields: [{ path: 'name', type: 'string', label: 'Name' }] },
    history: [],
  };
}

function user(role: AdminSessionUser['role']): AdminSessionUser {
  return { id: `user-${role}`, username: role, role };
}

/** Serve one event, answering any lookup question with an empty list. */
function stubGet(build: () => EventDetail): void {
  vi.mocked(get).mockImplementation(((path: string) => {
    if (path === `/events/${EVENT_ID}`) return Promise.resolve(build());
    if (path.startsWith('/lookup/')) return Promise.resolve([]);
    if (path === '/rosters') return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }) as never);
}

function stubPut(): void {
  vi.mocked(put).mockImplementation((() =>
    Promise.resolve({ saved: true, validation: { ok: true, errors: [] } })) as never);
}

/** The draft body of the most recent draft PUT. */
function lastSavedDraft(): Record<string, unknown> {
  const call = vi.mocked(put).mock.calls.at(-1);
  if (call === undefined) throw new Error('no PUT was sent');
  const body = call[1] as { draft: Record<string, unknown> };
  return body.draft;
}

/** Render the editor, open a tab, and wait for its panel. */
async function openTab(
  name: string,
  writer: ReturnType<typeof userEvent.setup> = userEvent.setup(),
): Promise<void> {
  await writer.click(await screen.findByRole('tab', { name }));
}

beforeEach(() => {
  window.location.hash = `#/events/${EVENT_ID}`;
  sessionStorage.clear();
  vi.mocked(get).mockReset();
  vi.mocked(put).mockReset();
  stubPut();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EventEditorPage moshikoi tabs', () => {
  it('shows the catalog, routes, endings and JSON tabs instead of stages and boxes', async () => {
    stubGet(moshikoiDetail);
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);

    await screen.findByRole('tab', { name: 'Catalog' });
    for (const name of ['Settings', 'Catalog', 'Routes', 'Endings', 'JSON']) {
      expect(screen.getByRole('tab', { name })).toBeTruthy();
    }
    expect(screen.queryByRole('tab', { name: 'Stages' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Boxes' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Schedule' })).toBeNull();
  });

  it('keeps the stages and boxes tabs for a marathon event', async () => {
    stubGet(marathonDetail);
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);

    expect(await screen.findByRole('tab', { name: 'Stages' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Boxes' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Catalog' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'JSON' })).toBeNull();
  });
});

describe('EventEditorPage moshikoi routes', () => {
  it('saves an edited score at its own path and leaves the rest of the draft alone', async () => {
    stubGet(moshikoiDetail);
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);
    await openTab('Routes');

    const score = await screen.findByLabelText('group 1 score 1');
    expect((score as HTMLInputElement).value).toBe('10');
    fireEvent.change(score, { target: { value: '42' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(vi.mocked(put)).toHaveBeenCalledTimes(1));

    expect(vi.mocked(put).mock.calls[0][0]).toBe(`/events/${EVENT_ID}/draft`);
    const expected = expectedDraft((draft) => {
      const routes = draft.routes as RoutesFixture;
      routes.episodes[episode('001')]!.groups![0]!.scores[0] = 42;
    });
    expect(lastSavedDraft()).toEqual(expected);
  });

  it('updates an episode next and highlights a next that resolves to nothing', async () => {
    stubGet(moshikoiDetail);
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);
    await openTab('Routes', writer);

    await writer.click(await screen.findByRole('button', { name: '005' }));
    const next = (await screen.findByLabelText('Next episode')) as HTMLSelectElement;
    expect(next.value).toBe(episode('999-missing'));
    expect(next.className).toContain('ref-invalid');

    await writer.selectOptions(next, episode('008-bad'));
    expect(next.value).toBe(episode('008-bad'));
    expect(next.className).not.toContain('ref-invalid');

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(vi.mocked(put)).toHaveBeenCalledTimes(1));
    const expected = expectedDraft((draft) => {
      const routes = draft.routes as RoutesFixture;
      routes.episodes[episode('005')]!.next = episode('008-bad');
    });
    expect(lastSavedDraft()).toEqual(expected);
  });
});

describe('EventEditorPage moshikoi endings', () => {
  it('saves an edited favorability', async () => {
    stubGet(moshikoiDetail);
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);
    await openTab('Endings');

    const favorability = (await screen.findByLabelText('ending 2 favorability')) as HTMLInputElement;
    expect(favorability.value).toBe('2059');
    fireEvent.change(favorability, { target: { value: '2100' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(vi.mocked(put)).toHaveBeenCalledTimes(1));
    const expected = expectedDraft((draft) => {
      const routes = draft.routes as RoutesFixture;
      routes.endings[1]!.favorability = 2100;
    });
    expect(lastSavedDraft()).toEqual(expected);
  });
});

describe('EventEditorPage moshikoi JSON tab', () => {
  it('reports invalid JSON on blur and leaves the draft untouched', async () => {
    stubGet(moshikoiDetail);
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);
    await openTab('JSON');

    const routes = (await screen.findByLabelText('routes')) as HTMLTextAreaElement;
    fireEvent.change(routes, { target: { value: '{ "loveId": ' } });
    fireEvent.blur(routes);

    expect(await screen.findByText('Invalid JSON.')).toBeTruthy();
    // Nothing reached the draft, so there is nothing to save.
    expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(vi.mocked(put)).not.toHaveBeenCalled();
  });
});
