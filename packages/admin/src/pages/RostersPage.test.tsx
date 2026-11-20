/**
 * Roster editor tests: the shared-roster 409 dialog offers both escape hatches
 * (save for every user, or duplicate to an event-only id), and the card picker
 * filters the lookup list by name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, get, post, put } from '../api.ts';
import { CardPicker } from '../components/CardPicker.tsx';
import { ROSTER_VISUAL_ORDER } from '../roster.ts';
import type { AdminSessionUser, LookupCard, RosterDetail, RosterSummary } from '../types.ts';
import { RostersPage } from './RostersPage.tsx';

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>();
  return { ...actual, get: vi.fn(), post: vi.fn(), put: vi.fn() };
});

const ROSTER_ID = 'r1';

const LOOKUP: LookupCard[] = [
  {
    id: 'card-1',
    name: 'Alpha',
    nameEn: null,
    rarity: 3,
    characterId: 'char-a',
    characterNameEn: null,
  },
  {
    id: 'card-2',
    name: 'Beta',
    nameEn: null,
    rarity: 4,
    characterId: 'char-b',
    characterNameEn: null,
  },
  {
    id: 'card-3',
    name: 'Gamma',
    nameEn: null,
    rarity: 5,
    characterId: 'char-c',
    characterNameEn: null,
  },
];

function roster(): RosterDetail {
  return {
    id: ROSTER_ID,
    name: 'Roster',
    nameEn: null,
    managerLevel: 10,
    cards: [1, 2, 3, 4, 5].map((position) => ({
      CardId: `card-${position}`,
      Position: position,
      Level: 10,
      Rarity: 3,
      LightFanAmount: 1,
      MiddleFanAmount: 2,
      HeavyFanAmount: 3,
      EvolutionLevel: 0,
    })),
    updatedBy: 'alice',
    updatedAt: '2026-01-01T00:00:00Z',
    usage: { quests: [], events: [] },
  };
}

const SHARED = {
  quests: [],
  events: [
    { eventId: 'event-1', questId: 'quest-1' },
    { eventId: 'event-2', questId: 'quest-2' },
  ],
};

function user(role: AdminSessionUser['role']): AdminSessionUser {
  return { id: `user-${role}`, username: role, role };
}

beforeEach(() => {
  window.location.hash = `#/rosters/${ROSTER_ID}`;
  vi.mocked(get).mockReset();
  vi.mocked(put).mockReset();
  vi.mocked(post).mockReset();
  vi.mocked(get).mockImplementation(((path: string) => {
    if (path === `/rosters/${ROSTER_ID}`) return Promise.resolve(roster());
    if (path === '/lookup/cards') return Promise.resolve(LOOKUP);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }) as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RosterEditorPage', () => {
  it('opens the shared dialog and resends with confirmShared', async () => {
    const writer = userEvent.setup();
    vi.mocked(put)
      .mockRejectedValueOnce(new ApiError(409, { code: 'shared-roster', usage: SHARED }))
      .mockResolvedValueOnce(roster());
    render(<RostersPage id={ROSTER_ID} user={user('editor')} />);

    await writer.click(await screen.findByRole('button', { name: 'Save roster' }));
    const dialog = await screen.findByRole('dialog', { name: 'Shared roster' });
    expect(within(dialog).getByText('event-1')).toBeTruthy();
    expect(within(dialog).getByText('event-2')).toBeTruthy();

    await writer.click(within(dialog).getByRole('button', { name: 'Save for all events' }));

    await waitFor(() => {
      expect(vi.mocked(put)).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(put)).toHaveBeenLastCalledWith(
      `/rosters/${ROSTER_ID}`,
      expect.objectContaining({ confirmShared: true, name: 'Roster', managerLevel: 10 }),
    );
    expect(await screen.findByText('Roster saved for all events.')).toBeTruthy();
  });

  it('duplicates the shared roster and navigates to the copy', async () => {
    const writer = userEvent.setup();
    vi.mocked(put).mockRejectedValueOnce(new ApiError(409, { code: 'shared-roster', usage: SHARED }));
    vi.mocked(post).mockResolvedValue(undefined as never);
    render(<RostersPage id={ROSTER_ID} user={user('editor')} />);

    await writer.click(await screen.findByRole('button', { name: 'Save roster' }));
    const dialog = await screen.findByRole('dialog', { name: 'Shared roster' });
    expect((screen.getByLabelText('New roster id') as HTMLInputElement).value).toBe('r1-copy');

    await writer.click(within(dialog).getByRole('button', { name: 'Duplicate as event-only copy' }));

    await waitFor(() => {
      expect(vi.mocked(post)).toHaveBeenCalledWith(`/rosters/${ROSTER_ID}/duplicate`, {
        newId: 'r1-copy',
      });
    });
    await waitFor(() => {
      expect(window.location.hash).toBe('#/rosters/r1-copy');
    });
  });

  it('saves a three-card roster with three cards at their slot positions', async () => {
    const writer = userEvent.setup();
    const threeCardRoster = { ...roster(), cards: roster().cards.slice(0, 3) };
    vi.mocked(get).mockImplementation(((path: string) => {
      if (path === `/rosters/${ROSTER_ID}`) return Promise.resolve(threeCardRoster);
      if (path === '/lookup/cards') return Promise.resolve(LOOKUP);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    }) as never);
    vi.mocked(put).mockResolvedValue({ ...threeCardRoster, usage: { quests: [], events: [] } });
    render(<RostersPage id={ROSTER_ID} user={user('editor')} />);

    expect(await screen.findByText('Empty slots are not saved.')).toBeTruthy();
    await writer.click(await screen.findByRole('button', { name: 'Save roster' }));

    await waitFor(() => {
      expect(vi.mocked(put)).toHaveBeenCalledWith(
        `/rosters/${ROSTER_ID}`,
        expect.objectContaining({
          cards: [
            expect.objectContaining({ CardId: 'card-1', Position: 1 }),
            expect.objectContaining({ CardId: 'card-2', Position: 2 }),
            expect.objectContaining({ CardId: 'card-3', Position: 3 }),
          ],
        }),
      );
    });
    const payload = vi.mocked(put).mock.calls[0]?.[1] as { cards: unknown[] };
    expect(payload.cards).toHaveLength(3);
  });

  it('renders slots in the in-game visual order and edits the center card', async () => {
    const writer = userEvent.setup();
    vi.mocked(put).mockResolvedValue(roster());
    render(<RostersPage id={ROSTER_ID} user={user('editor')} />);

    expect(await screen.findByText(
      'Listed in the in-game lane order, left to right (position 1 is the center).',
    )).toBeTruthy();

    const legends = await screen.findAllByText(/^Position \d/);
    expect(legends.map((legend) => legend.textContent)).toEqual([
      'Position 4',
      'Position 2',
      'Position 1 · Center',
      'Position 3',
      'Position 5',
    ]);
    expect(ROSTER_VISUAL_ORDER).toEqual([4, 2, 1, 3, 5]);

    const centerLevel = screen.getByLabelText('Level position 1');
    expect((centerLevel as HTMLInputElement).value).toBe('10');
    await writer.clear(centerLevel);
    await writer.type(centerLevel, '7');

    await writer.click(await screen.findByRole('button', { name: 'Save roster' }));
    await waitFor(() => {
      expect(vi.mocked(put)).toHaveBeenCalledWith(
        `/rosters/${ROSTER_ID}`,
        expect.objectContaining({
          cards: expect.arrayContaining([
            expect.objectContaining({ CardId: 'card-1', Position: 1, Level: 7 }),
          ]),
        }),
      );
    });
  });

  it('blocks saving when every slot is empty', async () => {
    const writer = userEvent.setup();
    const emptyRoster = { ...roster(), cards: [] };
    vi.mocked(get).mockImplementation(((path: string) => {
      if (path === `/rosters/${ROSTER_ID}`) return Promise.resolve(emptyRoster);
      if (path === '/lookup/cards') return Promise.resolve(LOOKUP);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    }) as never);
    render(<RostersPage id={ROSTER_ID} user={user('editor')} />);

    await writer.click(await screen.findByRole('button', { name: 'Save roster' }));

    expect(await screen.findByText('At least one card is required.')).toBeTruthy();
    expect(vi.mocked(put)).not.toHaveBeenCalled();
  });

  it('rejects an invalid duplicate id before the request', async () => {
    const writer = userEvent.setup();
    vi.mocked(put).mockRejectedValueOnce(new ApiError(409, { code: 'shared-roster', usage: SHARED }));
    render(<RostersPage id={ROSTER_ID} user={user('editor')} />);

    await writer.click(await screen.findByRole('button', { name: 'Save roster' }));
    const dialog = await screen.findByRole('dialog', { name: 'Shared roster' });
    const newId = screen.getByLabelText('New roster id');
    await writer.clear(newId);
    await writer.type(newId, 'bad id!');
    await writer.click(within(dialog).getByRole('button', { name: 'Duplicate as event-only copy' }));

    expect(await screen.findByText(/Invalid roster id/)).toBeTruthy();
    expect(vi.mocked(post)).not.toHaveBeenCalled();
  });

  it('closes the shared dialog with Escape and restores focus to the opener', async () => {
    const writer = userEvent.setup();
    vi.mocked(put).mockRejectedValueOnce(new ApiError(409, { code: 'shared-roster', usage: SHARED }));
    render(<RostersPage id={ROSTER_ID} user={user('editor')} />);

    const opener = await screen.findByRole('button', { name: 'Save roster' });
    await writer.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Shared roster' });
    expect(document.activeElement).toBe(dialog);

    await writer.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Shared roster' })).toBeNull();
    });
    expect(document.activeElement).toBe(opener);
  });

  it('hides the save control from a viewer', async () => {
    render(<RostersPage id={ROSTER_ID} user={user('viewer')} />);

    expect(await screen.findByText('Editing requires the editor role.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save roster' })).toBeNull();
  });
});

describe('RosterListPage', () => {
  it('shows New roster to an editor and hides it from a viewer', async () => {
    const list: RosterSummary[] = [];
    vi.mocked(get).mockImplementation(((path: string) => {
      if (path === '/rosters') return Promise.resolve(list);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    }) as never);

    render(<RostersPage user={user('editor')} />);
    expect(await screen.findByRole('button', { name: 'New roster' })).toBeTruthy();
    cleanup();

    render(<RostersPage user={user('viewer')} />);
    expect(await screen.findByText(/Read-only access/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New roster' })).toBeNull();
  });
});

describe('New roster', () => {
  const SUMMARY: RosterSummary = {
    id: ROSTER_ID,
    name: 'Roster',
    nameEn: null,
    managerLevel: 10,
    updatedBy: 'alice',
    updatedAt: '2026-01-01T00:00:00Z',
    usageCount: 0,
  };

  function mockNewGets(): void {
    vi.mocked(get).mockImplementation(((path: string) => {
      if (path === '/rosters') return Promise.resolve([SUMMARY]);
      if (path === '/lookup/cards') return Promise.resolve(LOOKUP);
      if (path === `/rosters/${ROSTER_ID}`) return Promise.resolve(roster());
      return Promise.reject(new Error(`unexpected GET ${path}`));
    }) as never);
  }

  beforeEach(() => {
    window.location.hash = '#/rosters/new';
  });

  it('rejects an invalid id and never posts', async () => {
    const writer = userEvent.setup();
    mockNewGets();
    render(<RostersPage newRoster user={user('editor')} />);

    const idInput = await screen.findByLabelText('Roster id');
    await writer.type(idInput, 'bad id!');
    expect(await screen.findByText(/Invalid roster id/)).toBeTruthy();

    await writer.click(screen.getByRole('button', { name: 'Create roster' }));
    expect(vi.mocked(post)).not.toHaveBeenCalled();
  });

  it('copies name, manager level and cards from Start from', async () => {
    const writer = userEvent.setup();
    mockNewGets();
    render(<RostersPage newRoster user={user('editor')} />);

    await writer.selectOptions(await screen.findByLabelText('Start from'), ROSTER_ID);

    await waitFor(() => {
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Roster');
    });
    expect((screen.getByLabelText('Manager level') as HTMLInputElement).value).toBe('10');
    expect((screen.getByLabelText('Card for position 1') as HTMLSelectElement).value).toBe('card-1');
  });

  it('posts the chosen id and fields, then navigates to the new roster', async () => {
    const writer = userEvent.setup();
    mockNewGets();
    vi.mocked(post).mockResolvedValue({ ...roster(), id: 'fresh-roster' });
    render(<RostersPage newRoster user={user('editor')} />);

    await writer.type(await screen.findByLabelText('Roster id'), 'fresh-roster');
    await writer.selectOptions(screen.getByLabelText('Start from'), ROSTER_ID);
    await waitFor(() => {
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Roster');
    });
    await writer.click(screen.getByRole('button', { name: 'Create roster' }));

    await waitFor(() => {
      expect(vi.mocked(post)).toHaveBeenCalledWith('/rosters', {
        id: 'fresh-roster',
        name: 'Roster',
        managerLevel: 10,
        cards: expect.arrayContaining([
          expect.objectContaining({ CardId: 'card-1', Position: 1 }),
          expect.objectContaining({ CardId: 'card-5', Position: 5 }),
        ]),
      });
    });
    await waitFor(() => {
      expect(window.location.hash).toBe('#/rosters/fresh-roster');
    });
  });

  it('shows the id conflict when the server answers 409', async () => {
    const writer = userEvent.setup();
    mockNewGets();
    vi.mocked(post).mockRejectedValue(new ApiError(409, { error: 'roster already exists' }));
    render(<RostersPage newRoster user={user('editor')} />);

    await writer.type(await screen.findByLabelText('Roster id'), 'taken-roster');
    await writer.selectOptions(screen.getByLabelText('Start from'), ROSTER_ID);
    await waitFor(() => {
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Roster');
    });
    await writer.click(screen.getByRole('button', { name: 'Create roster' }));

    expect(await screen.findByText('A roster with this id already exists')).toBeTruthy();
  });
});

describe('CardPicker', () => {
  it('filters options by name', async () => {
    const writer = userEvent.setup();
    render(<CardPicker position={1} cards={LOOKUP} value="" onChange={() => undefined} />);

    await writer.type(screen.getByLabelText('Search cards for position 1'), 'Beta');

    const select = screen.getByLabelText('Card for position 1');
    expect(within(select).getByRole('option', { name: /Beta/ })).toBeTruthy();
    expect(within(select).queryByRole('option', { name: /Alpha/ })).toBeNull();
    expect(within(select).queryByRole('option', { name: /Gamma/ })).toBeNull();
  });

  it('shows name, rarity and character in option labels', () => {
    render(<CardPicker position={2} cards={LOOKUP} value="" onChange={() => undefined} />);
    expect(screen.getByRole('option', { name: 'Alpha · rarity 3 · char-a' })).toBeTruthy();
  });

  it('matches English names and shows them ahead of Japanese', async () => {
    const writer = userEvent.setup();
    const cards: LookupCard[] = [
      {
        id: 'card-en',
        name: '導きのファンファーレ',
        nameEn: 'Fanfare of Guidance',
        rarity: 4,
        characterId: 'char-ai',
        characterNameEn: 'Ai',
      },
      ...LOOKUP,
    ];
    render(<CardPicker position={3} cards={cards} value="" onChange={() => undefined} />);

    const select = screen.getByLabelText('Card for position 3');
    expect(
      within(select).getByRole('option', { name: 'Fanfare of Guidance · rarity 4 · Ai' }),
    ).toBeTruthy();

    await writer.type(screen.getByLabelText('Search cards for position 3'), 'guidance');
    expect(within(select).getByRole('option', { name: /Fanfare of Guidance/ })).toBeTruthy();
    expect(within(select).queryByRole('option', { name: /Alpha/ })).toBeNull();
  });
});
