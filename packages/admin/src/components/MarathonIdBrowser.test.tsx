/**
 * Component-level tests for the master marathon id browser: loading the list,
 * search and variant filtering, the event-defined guard, selection and Escape.
 * The API module is mocked, so nothing here touches fetch.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { get } from '../api.ts';
import type { LookupMarathon } from '../types.ts';
import { MarathonIdBrowser } from './MarathonIdBrowser.tsx';

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>();
  return { ...actual, get: vi.fn() };
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
  {
    id: 'mini-marathon-1',
    variant: 'mini-marathon',
    questCount: 2,
    boxGachaCount: 1,
    eventDefined: true,
  },
  {
    id: 'mini-marathon-raid-42',
    variant: 'mini-marathon-raid',
    questCount: 0,
    boxGachaCount: 3,
    eventDefined: false,
  },
  {
    id: 'legacy-event',
    variant: 'other',
    questCount: 1,
    boxGachaCount: 0,
    eventDefined: false,
  },
];

function Harness({ disableDefined = false }: { disableDefined?: boolean }) {
  const [open, setOpen] = useState(true);
  const [picked, setPicked] = useState('');
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open browser
      </button>
      <span data-testid="picked">{picked}</span>
      <MarathonIdBrowser
        open={open}
        title="Pick a master marathon id"
        disableDefined={disableDefined}
        onClose={() => setOpen(false)}
        onPick={(id) => setPicked(id)}
      />
    </div>
  );
}

beforeEach(() => {
  vi.mocked(get).mockReset();
  vi.mocked(get).mockResolvedValue(MARATHONS);
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

describe('MarathonIdBrowser', () => {
  it('renders every master marathon with counts, variants and event badges', async () => {
    render(<Harness />);

    const dialog = await screen.findByRole('dialog', { name: 'Pick a master marathon id' });
    expect(get).toHaveBeenCalledWith('/lookup/marathons');
    expect(await within(dialog).findByText('marathon-2026-11')).toBeTruthy();
    expect(within(dialog).getByText('marathon · 4 quests · 2 box gachas')).toBeTruthy();
    expect(within(dialog).getByText('legacy-event')).toBeTruthy();
    expect(within(dialog).getAllByText('Event exists')).toHaveLength(2);
  });

  it('filters the list by id substring, case-insensitively', async () => {
    const writer = userEvent.setup();
    render(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Pick a master marathon id' });
    await within(dialog).findByText('marathon-2026-11');

    await writer.type(screen.getByLabelText('Pick a master marathon id search'), '2026');

    expect(within(dialog).getByText('marathon-2026-11')).toBeTruthy();
    expect(within(dialog).queryByText('marathon-raid-9')).toBeNull();
    expect(within(dialog).queryByText('legacy-event')).toBeNull();
  });

  it('filters by variant tab', async () => {
    const writer = userEvent.setup();
    render(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Pick a master marathon id' });
    await within(dialog).findByText('marathon-2026-11');

    await writer.click(within(dialog).getByRole('tab', { name: 'Raid' }));
    expect(within(dialog).getByText('marathon-raid-9')).toBeTruthy();
    expect(within(dialog).queryByText('marathon-2026-11')).toBeNull();
    expect(within(dialog).queryByText('mini-marathon-raid-42')).toBeNull();

    await writer.click(within(dialog).getByRole('tab', { name: 'Mini' }));
    expect(within(dialog).getByText('mini-marathon-1')).toBeTruthy();
    expect(within(dialog).queryByText('marathon-raid-9')).toBeNull();

    await writer.click(within(dialog).getByRole('tab', { name: 'Mini raid' }));
    expect(within(dialog).getByText('mini-marathon-raid-42')).toBeTruthy();

    await writer.click(within(dialog).getByRole('tab', { name: 'All' }));
    expect(within(dialog).getByText('legacy-event')).toBeTruthy();
  });

  it('disables ids that already have an event when disableDefined is set', async () => {
    render(<Harness disableDefined />);
    const dialog = await screen.findByRole('dialog', { name: 'Pick a master marathon id' });
    await within(dialog).findByText('marathon-2026-11');

    const defined = within(dialog).getByRole('button', { name: /marathon-2026-11/ });
    expect((defined as HTMLButtonElement).disabled).toBe(true);
    expect(defined.getAttribute('aria-disabled')).toBe('true');
    expect(defined.getAttribute('title')).toBe('An event already uses this id');

    const free = within(dialog).getByRole('button', { name: /marathon-raid-9/ });
    expect((free as HTMLButtonElement).disabled).toBe(false);
    expect(free.getAttribute('aria-disabled')).toBeNull();
  });

  it('keeps defined ids selectable when disableDefined is off', async () => {
    render(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Pick a master marathon id' });
    await within(dialog).findByText('marathon-2026-11');

    const defined = within(dialog).getByRole('button', { name: /marathon-2026-11/ });
    expect((defined as HTMLButtonElement).disabled).toBe(false);
  });

  it('picks an id and closes the browser', async () => {
    const writer = userEvent.setup();
    render(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Pick a master marathon id' });
    await within(dialog).findByText('marathon-raid-9');

    await writer.click(within(dialog).getByRole('button', { name: /marathon-raid-9/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('picked').textContent).toBe('marathon-raid-9');
  });

  it('closes on Escape', async () => {
    const writer = userEvent.setup();
    render(<Harness />);
    await screen.findByRole('dialog', { name: 'Pick a master marathon id' });

    await writer.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
