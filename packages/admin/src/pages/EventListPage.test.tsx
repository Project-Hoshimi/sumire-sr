/**
 * Component-level tests for the Events list screen: the master marathon id
 * browser wired to the create/import forms and the master-data warnings.
 * The API module is mocked, so nothing here touches fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { get } from '../api.ts';
import type { AdminSessionUser, LookupMarathon } from '../types.ts';
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
