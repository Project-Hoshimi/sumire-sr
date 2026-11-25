/**
 * Race live-ops screen: the player table and ranking come from the admin API,
 * an edit is saved with PATCH, cool times are cleared with PATCH and a reset only
 * fires after the confirmation dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { get, patch, post } from '../../api.ts';
import type { AdminSessionUser } from '../../types.ts';
import { RacePlayersPage } from './RacePlayersPage.tsx';

vi.mock('../../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api.ts')>();
  return { ...actual, get: vi.fn(), patch: vi.fn(), post: vi.fn() };
});

const RACE_ID = 'race-26-0226';

function user(role: AdminSessionUser['role']): AdminSessionUser {
  return { id: `user-${role}`, username: role, role };
}

const detail = {
  raceId: RACE_ID,
  player: { playerId: 'p-1', userId: 'pub-1', name: 'alpha', level: 12 },
  state: {
    initialized: true,
    areaIndex: 0,
    panelNumber: 2,
    totalClearPanelCount: 10,
    pendingVenus: true,
    currentLivePanelScore: 1234,
    cardCoolTimes: { 'card-1': 1900000000000 },
    lastActivityReceiveMs: 1795258772510,
  },
  racePoints: 5000,
  medals: 7,
  difficultyNumber: 5,
  effectiveDifficultyNumber: 5,
  cardCoolTimes: [{ cardId: 'card-1', endsAt: 1900000000000 }],
  lastUpdated: '2026-11-21T10:00:00.000Z',
  areas: [
    { index: 0, areaId: 'race-area-005-01', panelCount: 4 },
    { index: 1, areaId: 'race-area-005-02', panelCount: 2 },
  ],
};

const playersPage = {
  total: 2,
  offset: 0,
  limit: 50,
  players: [
    {
      playerId: 'p-1',
      userId: 'pub-1',
      name: 'alpha',
      level: 12,
      areaIndex: 0,
      areaId: 'race-area-005-01',
      panelNumber: 2,
      totalClearPanelCount: 10,
      rank: 1,
      racePoints: 5000,
      medals: 7,
      pendingVenus: true,
      difficultyNumber: 5,
      effectiveDifficultyNumber: 5,
      lastUpdated: '2026-11-21T10:00:00.000Z',
    },
    {
      playerId: 'p-2',
      userId: 'pub-2',
      name: 'bravo',
      level: 9,
      areaIndex: 1,
      areaId: 'race-area-005-02',
      panelNumber: 1,
      totalClearPanelCount: 4,
      rank: 2,
      racePoints: 120,
      medals: 1,
      pendingVenus: false,
      difficultyNumber: null,
      effectiveDifficultyNumber: 3,
      lastUpdated: '2026-11-20T10:00:00.000Z',
    },
  ],
};

const ranking = {
  displayNum: 1000,
  ranking: [
    {
      playerId: 'p-1',
      userId: 'pub-1',
      name: 'alpha',
      managerLevel: 12,
      clearPanelCount: 10,
      rank: 1,
      emblemId: '',
    },
    {
      playerId: 'p-2',
      userId: 'pub-2',
      name: 'bravo',
      managerLevel: 9,
      clearPanelCount: 4,
      rank: 2,
      emblemId: '',
    },
  ],
};

function mockReads(): void {
  vi.mocked(get).mockImplementation((async (path: string) => {
    if (path === '/races') {
      return {
        races: [
          {
            id: RACE_ID,
            title: 'Race — Sekai wa Kawaru',
            publishedVersion: 3,
            lifecycle: 'scheduled',
            schedule: [],
          },
        ],
      };
    }
    if (path === `/races/${RACE_ID}/players`) return playersPage;
    if (path === `/races/${RACE_ID}/ranking?limit=100`) return ranking;
    if (path === `/races/${RACE_ID}/players/p-1`) return detail;
    throw new Error(`unexpected GET ${path}`);
  }) as never);
}

beforeEach(() => {
  vi.mocked(get).mockReset();
  vi.mocked(patch).mockReset();
  vi.mocked(post).mockReset();
  mockReads();
  vi.mocked(patch).mockImplementation((async () => detail) as never);
  vi.mocked(post).mockImplementation((async () => detail) as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openAlpha(): Promise<ReturnType<typeof userEvent.setup>> {
  const writer = userEvent.setup();
  render(<RacePlayersPage id={RACE_ID} user={user('editor')} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit alpha' })).toBeTruthy());
  await writer.click(screen.getByRole('button', { name: 'Edit alpha' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save player' })).toBeTruthy());
  return writer;
}

describe('RacePlayersPage', () => {
  it('renders the player table and the ranking from the API', async () => {
    render(<RacePlayersPage id={RACE_ID} user={user('viewer')} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit alpha' })).toBeTruthy());
    // Both the player table and the ranking table list the same names.
    expect(screen.getAllByText('alpha')).toHaveLength(2);
    expect(screen.getAllByText('bravo')).toHaveLength(2);
    expect(screen.getAllByText('pub-1')).toHaveLength(2);
    expect(screen.getByText('5000')).toBeTruthy();
    // A frozen number shows as-is; a cleared one shows the effective fallback.
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('— (fallback 3)')).toBeTruthy();
    expect(screen.getByText('Race — Sekai wa Kawaru (race-26-0226, v3)')).toBeTruthy();

    // The ranking table repeats the names; both views must show the counts.
    expect(screen.getAllByRole('row').length).toBeGreaterThanOrEqual(6);
    expect(screen.getByRole('button', { name: 'Edit alpha' })).toBeTruthy();
  });

  it('saves the edited board values with a PATCH', async () => {
    const writer = await openAlpha();

    const panels = screen.getByLabelText('Panels cleared');
    await writer.clear(panels);
    await writer.type(panels, '14');
    await writer.click(screen.getByRole('button', { name: 'Save player' }));

    await waitFor(() => expect(vi.mocked(patch)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(patch).mock.calls[0]).toEqual([
      `/races/${RACE_ID}/players/p-1`,
      {
        areaIndex: 0,
        panelNumber: 2,
        totalClearPanelCount: 14,
        currentLivePanelScore: 1234,
        racePointAmount: 5000,
        medalAmount: 7,
        pendingVenus: true,
      },
    ]);
    await waitFor(() => expect(screen.getByText('Saved alpha.')).toBeTruthy());
  });

  it('sends the frozen difficulty only when it was edited', async () => {
    const writer = await openAlpha();

    const difficulty = screen.getByLabelText('Difficulty');
    await writer.clear(difficulty);
    await writer.type(difficulty, '6');
    await writer.click(screen.getByRole('button', { name: 'Save player' }));

    await waitFor(() => expect(vi.mocked(patch)).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(patch).mock.calls[0] as [string, Record<string, unknown>];
    expect(body).toMatchObject({ difficultyNumber: 6, totalClearPanelCount: 10 });
  });

  it('clears the frozen difficulty with a null patch', async () => {
    const writer = await openAlpha();
    await writer.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => expect(vi.mocked(patch)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(patch).mock.calls[0]).toEqual([
      `/races/${RACE_ID}/players/p-1`,
      { difficultyNumber: null },
    ]);
    await waitFor(() =>
      expect(screen.getByText('Cleared the fixed difficulty for alpha.')).toBeTruthy(),
    );
  });

  it('clears card cool times as its own PATCH action', async () => {
    const writer = await openAlpha();
    await writer.click(screen.getByRole('button', { name: 'Clear cool times' }));

    await waitFor(() => expect(vi.mocked(patch)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(patch).mock.calls[0]).toEqual([
      `/races/${RACE_ID}/players/p-1`,
      { clearCardCoolTimes: true },
    ]);
  });

  it('resets the state only after the confirmation dialog', async () => {
    const writer = await openAlpha();
    await writer.click(screen.getByRole('button', { name: 'Reset race state' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Reset state')).toBeTruthy();
    expect(vi.mocked(post)).not.toHaveBeenCalled();

    await writer.click(within(dialog).getByRole('button', { name: 'Reset state' }));
    await waitFor(() => expect(vi.mocked(post)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(post).mock.calls[0]).toEqual([
      `/races/${RACE_ID}/players/p-1/reset`,
      {},
    ]);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByText('Reset the race state of alpha.')).toBeTruthy();
  });

  it('keeps the write actions disabled for a viewer', async () => {
    const writer = userEvent.setup();
    render(<RacePlayersPage id={RACE_ID} user={user('viewer')} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit alpha' })).toBeTruthy());
    await writer.click(screen.getByRole('button', { name: 'Edit alpha' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save player' })).toBeTruthy());

    expect((screen.getByRole('button', { name: 'Save player' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Clear' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Clear cool times' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reset race state' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
