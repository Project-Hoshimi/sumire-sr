import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { get } from '../api.ts';
import {
  ResourceLookupPicker,
  liveBonusGroupOptionLabel,
  rewardOptionLabel,
} from './ResourceLookupPicker.tsx';
import type {
  LookupBrowsePage,
  LookupLiveBonusGroup,
  LookupResource,
  LookupReward,
  LookupRewardType,
} from '../types.ts';

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>();
  return { ...actual, get: vi.fn() };
});

const ITEM_REWARD: LookupReward = {
  id: 'rd_auto;item;item-card_ability;100',
  found: true,
  resources: [
    {
      resourceType: 1,
      typeLabel: 'Item',
      resourceId: 'item-card_ability',
      amount: 100,
      name: 'エールパウダー',
      nameEn: 'Yell Powder',
    },
  ],
};

const STONE_REWARD: LookupReward = {
  id: 'rd-stones',
  found: true,
  resources: [
    {
      resourceType: 15,
      typeLabel: 'Stone',
      resourceId: '',
      amount: 500,
      name: null,
      nameEn: null,
    },
  ],
};

const TYPES: LookupRewardType[] = [
  { resourceType: 1, typeLabel: 'Item', snakeName: 'item', count: 3, grantable: true, idless: false },
  { resourceType: 15, typeLabel: 'Stone', snakeName: 'stone', count: 2, grantable: true, idless: false },
  // Story rows exist in rewards but the server cannot grant them.
  { resourceType: 10, typeLabel: 'Story', snakeName: 'story', count: 1, grantable: false, idless: false },
  // PaidStone has no name-table rows: composes with an empty resource id.
  { resourceType: 16, typeLabel: 'PaidStone', snakeName: 'paid_stone', count: 0, grantable: true, idless: true },
];

const RESOURCES: LookupResource[] = [
  {
    resourceType: 1,
    typeLabel: 'Item',
    resourceId: 'item-a',
    name: 'アイテムA',
    nameEn: 'Item A',
  },
  {
    resourceType: 1,
    typeLabel: 'Item',
    resourceId: 'item;bad',
    name: '壊れたアイテム',
    nameEn: 'Bad Item',
  },
];

const GROUP: LookupLiveBonusGroup = {
  groupId: 'live-bonus-group-box1-001',
  found: true,
  bonuses: [
    {
      liveBonusId: 'bonus-1',
      liveAbilityId: 'marathon-lba-vocal_add',
      level: 3,
      description: 'ボーカル1000上昇',
      descriptionEn: 'Vocal +1000',
      skills: [
        {
          skillId: 'sk-marathon-lba-vocal_add',
          name: 'ボーカル上昇',
          nameEn: 'Vocal Boost',
          level: 3,
          description: 'ボーカルが1000上昇',
          descriptionEn: 'Vocal increases by 1000',
        },
      ],
    },
  ],
};

function page<T>(items: T[], total: number): LookupBrowsePage<T> {
  return { items, total };
}

/**
 * Route every lookup call through a fake server: the picker fires several
 * independent requests when it opens, so a single resolved value cannot cover
 * the panel.
 */
function mockServer(): void {
  vi.mocked(get).mockImplementation((async (path: string) => {
    if (path === '/lookup/resource-types') return TYPES;
    if (path.startsWith('/lookup/rewards?')) {
      const params = new URLSearchParams(path.slice('/lookup/rewards?'.length));
      if (params.get('type') === '15') return page([STONE_REWARD], 1);
      return params.get('offset') === '1'
        ? page([STONE_REWARD], 2)
        : page([ITEM_REWARD], 2);
    }
    if (path.startsWith('/lookup/resources?')) return page(RESOURCES, RESOURCES.length);
    if (path.startsWith('/lookup/live-bonus-groups?')) return page([GROUP], 1);
    throw new Error(`unexpected lookup: ${path}`);
  }) as never);
}

function Harness({ kind }: { kind: 'rewards' | 'live-bonus-groups' }) {
  const [value, setValue] = useState('');
  return (
    <>
      <ResourceLookupPicker
        kind={kind}
        value={value}
        onChange={setValue}
        ariaLabel={kind === 'rewards' ? 'Reward' : 'Live bonus group'}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

beforeEach(() => {
  vi.mocked(get).mockReset();
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

describe('option labels', () => {
  it('summarises every reward grant, including rd_auto ids', () => {
    expect(rewardOptionLabel(ITEM_REWARD)).toBe(
      'rd_auto;item;item-card_ability;100 · Item Yell Powder ×100',
    );
  });

  it('summarises the first live bonus description and level', () => {
    expect(liveBonusGroupOptionLabel(GROUP)).toBe(
      'live-bonus-group-box1-001 · Lv3 Vocal +1000',
    );
  });
});

describe('ResourceLookupPicker', () => {
  it('opens the reward panel from the Browse button, without typing', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);

    await writer.click(screen.getByRole('button', { name: 'Browse Reward' }));

    const dialog = await screen.findByRole('dialog', { name: 'Reward browse' });
    expect(get).toHaveBeenCalledWith('/lookup/resource-types');
    expect(get).toHaveBeenCalledWith('/lookup/rewards?offset=0&limit=50');
    expect(await within(dialog).findByText(ITEM_REWARD.id)).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: 'Existing reward' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('does not open the panel when the id input is focused or clicked', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);
    const input = screen.getByLabelText('Reward');

    await writer.click(input);
    act(() => input.focus());

    expect(document.body.querySelector('.resource-modal-backdrop')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(get).not.toHaveBeenCalled();

    await writer.type(input, 'rd_auto;item;item-x;7');
    expect(screen.getByTestId('value').textContent).toBe('rd_auto;item;item-x;7');
  });

  it('filters existing rewards by type and loads more pages', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);
    await writer.click(screen.getByRole('button', { name: 'Browse Reward' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reward browse' });

    const filter = await screen.findByLabelText('Reward type filter');
    await within(filter).findByRole('option', { name: 'Stone (2)' });
    await writer.selectOptions(filter, '15');
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/lookup/rewards?type=15&offset=0&limit=50'),
    );
    expect(await within(dialog).findByText('rd-stones')).toBeTruthy();

    await writer.selectOptions(filter, '1');
    await within(dialog).findByText(ITEM_REWARD.id);
    expect(within(dialog).getByText('1 of 2')).toBeTruthy();
    await writer.click(within(dialog).getByRole('button', { name: 'Load more' }));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/lookup/rewards?type=1&offset=1&limit=50'),
    );
    await within(dialog).findByText('rd-stones');
    expect(within(dialog).getByText('2 of 2')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('discards a Load-more response that arrives after the search changed', async () => {
    const pending: ((page: LookupBrowsePage<LookupReward>) => void)[] = [];
    let searched = false;
    vi.mocked(get).mockImplementation((async (path: string) => {
      if (path === '/lookup/resource-types') return TYPES;
      if (path.startsWith('/lookup/rewards?')) {
        const params = new URLSearchParams(path.slice('/lookup/rewards?'.length));
        if (params.get('offset') === '1') {
          return new Promise<LookupBrowsePage<LookupReward>>((resolve) => {
            pending.push(resolve);
          });
        }
        if (params.get('q') === 'stone') searched = true;
        return page([ITEM_REWARD], 2);
      }
      throw new Error(`unexpected lookup: ${path}`);
    }) as never);

    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);
    await writer.click(screen.getByRole('button', { name: 'Browse Reward' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reward browse' });
    await within(dialog).findByText(ITEM_REWARD.id);
    expect(within(dialog).getByText('1 of 2')).toBeTruthy();

    await writer.click(within(dialog).getByRole('button', { name: 'Load more' }));
    expect(pending).toHaveLength(1);

    await writer.type(screen.getByLabelText('Reward search'), 'stone');
    await waitFor(() => expect(searched).toBe(true));

    // The stale page lands after the search reset; it must not be appended.
    await act(async () => {
      pending[0]?.(page([STONE_REWARD], 99));
    });
    expect(within(dialog).queryByText('rd-stones')).toBeNull();
    expect(within(dialog).getByText('1 of 2')).toBeTruthy();
  });

  it('composes an rd_auto id from a custom type, resource and amount', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);
    await writer.click(screen.getByRole('button', { name: 'Browse Reward' }));

    await writer.click(await screen.findByRole('tab', { name: 'Custom' }));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/lookup/resources?type=1&offset=0&limit=100'),
    );
    const resourceButton = await screen.findByRole('button', { name: /Item A/ });
    await writer.click(resourceButton);

    const amount = screen.getByLabelText('Reward amount');
    await writer.clear(amount);
    await writer.type(amount, '3');
    expect(await screen.findByText('rd_auto;item;item-a;3')).toBeTruthy();

    await writer.click(screen.getByRole('button', { name: 'Use custom Reward' }));
    expect(screen.getByTestId('value').textContent).toBe('rd_auto;item;item-a;3');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('composes an idless type with an empty resource id', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);
    await writer.click(screen.getByRole('button', { name: 'Browse Reward' }));
    await writer.click(await screen.findByRole('tab', { name: 'Custom' }));

    const customType = await screen.findByLabelText('Reward custom type');
    await writer.selectOptions(customType, '16');

    // No resource search or list for a type that has no ids.
    expect(screen.queryByLabelText('Reward resource search')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Reward resources' })).toBeNull();
    expect(screen.getByText('No item to pick — set the amount only.')).toBeTruthy();

    const amount = screen.getByLabelText('Reward amount');
    await writer.clear(amount);
    await writer.type(amount, '500');
    expect(await screen.findByText('rd_auto;paid_stone;;500')).toBeTruthy();

    await writer.click(screen.getByRole('button', { name: 'Use custom Reward' }));
    expect(screen.getByTestId('value').textContent).toBe('rd_auto;paid_stone;;500');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('refuses a custom amount below one', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);
    await writer.click(screen.getByRole('button', { name: 'Browse Reward' }));
    await writer.click(await screen.findByRole('tab', { name: 'Custom' }));
    await writer.click(await screen.findByRole('button', { name: /Item A/ }));

    const amount = screen.getByLabelText('Reward amount');
    await writer.clear(amount);
    await writer.type(amount, '0');
    const use = screen.getByRole('button', { name: 'Use custom Reward' });
    expect((use as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers only grantable types in the Custom tab but all in Existing', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);
    await writer.click(screen.getByRole('button', { name: 'Browse Reward' }));

    const typeFilter = await screen.findByLabelText('Reward type filter');
    await within(typeFilter).findByRole('option', { name: 'Story (1)' });

    await writer.click(screen.getByRole('tab', { name: 'Custom' }));
    const customType = await screen.findByLabelText('Reward custom type');
    expect(within(customType).getByRole('option', { name: 'Item' })).toBeTruthy();
    expect(within(customType).getByRole('option', { name: 'Stone' })).toBeTruthy();
    expect(within(customType).queryByRole('option', { name: 'Story' })).toBeNull();
  });

  it('refuses to compose from a resource id containing a semicolon', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);
    await writer.click(screen.getByRole('button', { name: 'Browse Reward' }));
    await writer.click(await screen.findByRole('tab', { name: 'Custom' }));

    await writer.click(await screen.findByRole('button', { name: /Bad Item/ }));

    expect(screen.getByText('Resource id contains “;”, cannot compose')).toBeTruthy();
    const use = screen.getByRole('button', { name: 'Use custom Reward' });
    expect((use as HTMLButtonElement).disabled).toBe(true);
  });

  it('applies the chosen existing reward id and closes the panel', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);
    await writer.click(screen.getByRole('button', { name: 'Browse Reward' }));

    const row = await screen.findByRole('button', { name: new RegExp(ITEM_REWARD.id) });
    await writer.click(row);
    expect(screen.getByTestId('value').textContent).toBe(ITEM_REWARD.id);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('browses live bonus groups without typing, with descriptions and skills', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="live-bonus-groups" />);

    await writer.click(screen.getByRole('button', { name: 'Browse Live bonus group' }));
    const dialog = await screen.findByRole('dialog', { name: 'Live bonus group browse' });
    expect(get).toHaveBeenCalledWith('/lookup/live-bonus-groups?q=&offset=0&limit=50');
    expect(await within(dialog).findByText('Vocal +1000')).toBeTruthy();
    expect(within(dialog).getByText('Vocal Boost')).toBeTruthy();
    expect(within(dialog).getByText('ボーカル上昇')).toBeTruthy();

    await writer.click(within(dialog).getByRole('button', { name: new RegExp(GROUP.groupId) }));
    expect(screen.getByTestId('value').textContent).toBe(GROUP.groupId);
  });

  it('still accepts an id typed by hand', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);

    await writer.type(screen.getByLabelText('Reward'), 'rd_auto;item;item-x;7');

    expect(screen.getByTestId('value').textContent).toBe('rd_auto;item;item-x;7');
  });

  it('keeps the input usable when the lookup fails', async () => {
    vi.mocked(get).mockRejectedValue(new Error('offline'));
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);

    await writer.type(screen.getByLabelText('Reward'), 'broken');
    await writer.click(screen.getByRole('button', { name: 'Browse Reward' }));
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.getByTestId('value').textContent).toBe('broken');
    expect(await screen.findByText('No matching rewards')).toBeTruthy();
  });
});

describe('ResourceLookupPicker modal', () => {
  function openBrowse(writer: ReturnType<typeof userEvent.setup>): Promise<void> {
    return writer.click(screen.getByRole('button', { name: 'Browse Reward' }));
  }

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function panelFocusables(): HTMLElement[] {
    const panel = document.body.querySelector('.resource-browse') as HTMLElement;
    return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
  }

  it('renders the panel in a body-level backdrop marked aria-modal', async () => {
    mockServer();
    const writer = userEvent.setup();
    const { container } = render(<Harness kind="rewards" />);

    await openBrowse(writer);

    const backdrop = document.body.querySelector('.resource-modal-backdrop');
    expect(backdrop).not.toBeNull();
    expect(container.querySelector('.resource-modal-backdrop')).toBeNull();
    const dialog = await screen.findByRole('dialog', { name: 'Reward browse' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(backdrop?.contains(dialog)).toBe(true);
  });

  it('focuses the browse search box every time it opens', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);

    await openBrowse(writer);
    await screen.findByRole('dialog', { name: 'Reward browse' });
    expect(document.activeElement).toBe(screen.getByLabelText('Reward search'));

    await writer.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await openBrowse(writer);
    await screen.findByRole('dialog', { name: 'Reward browse' });
    expect(document.activeElement).toBe(screen.getByLabelText('Reward search'));
  });

  it('closes on Escape and returns focus to the Browse button', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);
    await openBrowse(writer);
    await screen.findByRole('dialog', { name: 'Reward browse' });

    await writer.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.querySelector('.resource-modal-backdrop')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Browse Reward' }),
    );
  });

  it('closes on a backdrop click but not on a click inside the panel', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);
    await openBrowse(writer);
    const dialog = await screen.findByRole('dialog', { name: 'Reward browse' });

    await writer.click(dialog);
    expect(screen.queryByRole('dialog')).not.toBeNull();

    const backdrop = document.body.querySelector('.resource-modal-backdrop') as HTMLElement;
    await writer.click(backdrop);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not close when a press starts in the panel and releases on the backdrop', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);
    await openBrowse(writer);
    const dialog = await screen.findByRole('dialog', { name: 'Reward browse' });
    await within(dialog).findByText(ITEM_REWARD.id);
    const backdrop = document.body.querySelector('.resource-modal-backdrop') as HTMLElement;

    fireEvent.mouseDown(dialog);
    fireEvent.click(backdrop);

    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('closes when both the press and the release target the backdrop', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);
    await openBrowse(writer);
    await screen.findByRole('dialog', { name: 'Reward browse' });
    const backdrop = document.body.querySelector('.resource-modal-backdrop') as HTMLElement;

    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('wraps Tab from the last focusable element to the first', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);
    await openBrowse(writer);
    const dialog = await screen.findByRole('dialog', { name: 'Reward browse' });
    await within(dialog).findByText(ITEM_REWARD.id);

    const focusable = panelFocusables();
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect(first).not.toBe(last);

    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Tab' });

    expect(document.activeElement).toBe(first);
  });

  it('wraps Shift+Tab from the first focusable element to the last', async () => {
    mockServer();
    const writer = userEvent.setup();
    render(<Harness kind="rewards" />);
    await openBrowse(writer);
    const dialog = await screen.findByRole('dialog', { name: 'Reward browse' });
    await within(dialog).findByText(ITEM_REWARD.id);

    const focusable = panelFocusables();
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(last);
  });

  it('locks body scroll while open and restores it on close', async () => {
    mockServer();
    const writer = userEvent.setup();
    document.body.style.overflow = 'auto';
    render(<Harness kind="rewards" />);

    await openBrowse(writer);
    await screen.findByRole('dialog', { name: 'Reward browse' });
    expect(document.body.style.overflow).toBe('hidden');

    await writer.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.style.overflow).toBe('auto');
  });

  it('restores body overflow when unmounted while open', async () => {
    mockServer();
    const writer = userEvent.setup();
    document.body.style.overflow = 'auto';
    const { unmount } = render(<Harness kind="rewards" />);

    await openBrowse(writer);
    await screen.findByRole('dialog', { name: 'Reward browse' });
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(document.body.style.overflow).toBe('auto');
  });
});
