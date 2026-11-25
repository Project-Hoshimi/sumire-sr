/**
 * Component-level tests for the Events list screen: the master marathon id
 * browser wired to the create/import forms and the master-data warnings.
 * The API module is mocked, so nothing here touches fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { get } from '../api.ts';
import type { AdminSessionUser, EventSummary, LookupMarathon } from '../types.ts';
import { EventListPage } from './EventEditorPage.tsx';

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>();
  return { ...actual, get: vi.fn(), post: vi.fn(), put: vi.fn() };
});

const MARATHONS: LookupMarathon[] = [
  {
    id: 'marathon-2026-11',
    variant: 'marathon',
    questCount: 4,
    boxGachaCount: 2,
    eventDefined: true,
  },
  {
    id: 'marathon-raid-9',
    variant: 'marathon-raid',
    questCount: 5,
    boxGachaCount: 0,
    eventDefined: false,
  },
];

function user(role: AdminSessionUser['role']): AdminSessionUser {
  return { id: `user-${role}`, username: role, role };
}

beforeEach(() => {
  vi.mocked(get).mockReset();
  vi.mocked(get).mockImplementation(((path: string) => {
    if (path === '/events') return Promise.resolve([]);
    if (path === '/lookup/marathons') return Promise.resolve(MARATHONS);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }) as never);
});

/** One list row; `lifecycle` is omitted for a pre-lifecycle server response. */
function summaryOf(overrides: Partial<EventSummary>): EventSummary {
  return {
    id: 'evt-1',
    kind: 'marathon',
    title: 'Event',
    titleEn: null,
    publishedVersion: 0,
    updatedBy: null,
    updatedByName: null,
    updatedAt: '2026-01-01T00:00:00Z',
    draftDiffersFromPublished: false,
    schedule: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

async function openNewEventForm(writer: ReturnType<typeof userEvent.setup>): Promise<void> {
  render(<EventListPage user={user('editor')} />);
  await writer.click(screen.getByRole('button', { name: 'New event' }));
}

describe('EventListPage marathon id browsing', () => {
  it('fills the new event id from the browser', async () => {
    const writer = userEvent.setup();
    await openNewEventForm(writer);

    await writer.click(screen.getByRole('button', { name: 'Browse new event id' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pick a master marathon id' });
    await within(dialog).findByText('marathon-raid-9');

    await writer.click(within(dialog).getByRole('button', { name: /marathon-raid-9/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      (screen.getByPlaceholderText('marathon-2026-11') as HTMLInputElement).value,
    ).toBe('marathon-raid-9');
  });

  it('fills the import id from the browser', async () => {
    const writer = userEvent.setup();
    render(<EventListPage user={user('editor')} />);

    await writer.click(screen.getByRole('button', { name: 'Browse import event id' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pick a master marathon id' });
    await within(dialog).findByText('marathon-2026-11');

    await writer.click(within(dialog).getByRole('button', { name: /marathon-raid-9/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      (screen.getByPlaceholderText('event id in master data') as HTMLInputElement).value,
    ).toBe('marathon-raid-9');
  });

  it('warns about a new event id that is not in master data', async () => {
    const writer = userEvent.setup();
    await openNewEventForm(writer);

    await writer.type(screen.getByPlaceholderText('marathon-2026-11'), 'not-a-marathon');

    expect(
      await screen.findByText(
        'Not a marathon id in master data. The game will have no quests for it.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
  });

  it('warns when an event already uses the new event id', async () => {
    const writer = userEvent.setup();
    await openNewEventForm(writer);

    await writer.type(screen.getByPlaceholderText('marathon-2026-11'), 'marathon-2026-11');

    expect(
      await screen.findByText('An event with this id already exists.'),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        'Not a marathon id in master data. The game will have no quests for it.',
      ),
    ).toBeNull();
  });

  it('warns about an import id that is not in master data', async () => {
    const writer = userEvent.setup();
    render(<EventListPage user={user('editor')} />);

    await writer.type(screen.getByPlaceholderText('event id in master data'), 'not-a-marathon');

    expect(
      await screen.findByText(
        'Not a marathon id in master data. The game will have no quests for it.',
      ),
    ).toBeTruthy();
  });

  it('warns when an event already uses the import id', async () => {
    const writer = userEvent.setup();
    render(<EventListPage user={user('editor')} />);

    await writer.type(screen.getByPlaceholderText('event id in master data'), 'marathon-2026-11');

    expect(
      await screen.findByText('An event with this id already exists.'),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        'Not a marathon id in master data. The game will have no quests for it.',
      ),
    ).toBeNull();
  });
});

describe('EventListPage lifecycle', () => {
  function stubEvents(rows: EventSummary[]): void {
    vi.mocked(get).mockImplementation(((path: string) => {
      if (path === '/events') return Promise.resolve(rows);
      if (path === '/lookup/marathons') return Promise.resolve(MARATHONS);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    }) as never);
  }

  it('shows permanent events as Permanent, with Live or Draft', async () => {
    stubEvents([
      summaryOf({ id: 'sched-1', title: 'Marathon', lifecycle: 'scheduled' }),
      summaryOf({ id: 'moshikoi-live', kind: 'moshikoi', lifecycle: 'permanent', publishedVersion: 3 }),
      summaryOf({ id: 'moshikoi-draft', kind: 'moshikoi', lifecycle: 'permanent' }),
    ]);
    render(<EventListPage user={user('editor')} />);

    expect(await screen.findByText('Permanent · Live')).toBeTruthy();
    expect(screen.getByText('Permanent · Draft')).toBeTruthy();
    expect(screen.queryByText(/\d+ window/)).toBeNull();
  });

  it('sorts permanent events after scheduled ones, then by id', async () => {
    stubEvents([
      summaryOf({ id: 'b-moshikoi', kind: 'moshikoi', lifecycle: 'permanent' }),
      summaryOf({ id: 'z-marathon', lifecycle: 'scheduled' }),
      summaryOf({ id: 'a-moshikoi', kind: 'moshikoi', lifecycle: 'permanent' }),
    ]);
    render(<EventListPage user={user('editor')} />);

    await screen.findByText('b-moshikoi');
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText('z-marathon')).toBeTruthy();
    expect(within(rows[1]).getByText('a-moshikoi')).toBeTruthy();
    expect(within(rows[2]).getByText('b-moshikoi')).toBeTruthy();
  });

  it('treats an event without a lifecycle field as scheduled', async () => {
    stubEvents([
      summaryOf({ id: 'old-server', schedule: [{
        id: 1,
        eventId: 'old-server',
        startsAt: '2026-02-01T00:00:00Z',
        endsAt: '2026-02-02T00:00:00Z',
        exchangeEndsAt: '2026-02-03T00:00:00Z',
        enabled: true,
      }] }),
    ]);
    render(<EventListPage user={user('editor')} />);

    expect(await screen.findByText('1 window')).toBeTruthy();
    expect(screen.queryByText(/Permanent/)).toBeNull();
  });

  it('creates a moshikoi event from the kind picker without marathon hints', async () => {
    stubEvents([]);
    const writer = userEvent.setup();
    render(<EventListPage user={user('editor')} />);

    await writer.click(screen.getByRole('button', { name: 'New event' }));
    await writer.type(screen.getByPlaceholderText('marathon-2026-11'), 'moshikoi-2026');
    await writer.selectOptions(screen.getByLabelText('Kind'), 'moshikoi');

    // No marathon-master hint or browser for a permanent kind.
    expect(screen.queryByText('Not a marathon id in master data. The game will have no quests for it.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Browse new event id' })).toBeNull();
  });
});
