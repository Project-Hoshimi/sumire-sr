/**
 * Component-level tests for the marathon event editor: role gating, the
 * datetime payload it sends, client-side schedule validation and the
 * discard-unsaved-changes guard. The API module is mocked, so nothing here
 * touches fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, del, get, put } from '../api.ts';
import { savePublishNotice } from '../publishNotice.ts';
import type {
  AdminSessionUser,
  EventDetail,
  LookupItem,
  LookupLiveBonusGroup,
  LookupReward,
} from '../types.ts';
import { EventEditorPage } from './EventEditorPage.tsx';

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>();
  return { ...actual, get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() };
});

const EVENT_ID = 'evt-1';

const DRAFT = {
  id: EVENT_ID,
  name: 'Test event',
  type: 1,
  assetId: '',
  bannerAssetId: '',
  boxGachaGroupId: '',
  initialStamina: 10,
  staminaRecoveryMinutes: 5,
  staminaRecoveryItemId: 'stamina-item',
  questUnlockItemId: 'unlock-item',
  eventMissionId: 'mission',
  order: 1,
  boxGachas: {},
  npcRosters: {},
};

function detail(draft: unknown = DRAFT): EventDetail {
  return {
    id: EVENT_ID,
    kind: 'marathon',
    title: 'Test event',
    titleEn: null,
    draft,
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

function stubGet(): void {
  vi.mocked(get).mockImplementation(((path: string) => {
    if (path === `/events/${EVENT_ID}`) return Promise.resolve(detail());
    if (path.startsWith('/lookup/quests')) return Promise.resolve([]);
    if (path === '/rosters') return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }) as never);
}

function stubPut(): void {
  vi.mocked(put).mockImplementation(((path: string) => {
    if (path.endsWith('/schedule')) {
      return Promise.resolve({ schedule: detail().schedule, warnings: [] });
    }
    return Promise.resolve({ saved: true, validation: { ok: true, errors: [] } });
  }) as never);
}

/** Serve one authored draft, keeping the empty lookup answers. */
function stubDraft(draft: unknown): void {
  vi.mocked(get).mockImplementation(((path: string) => {
    if (path === `/events/${EVENT_ID}`) return Promise.resolve(detail(draft));
    if (path.startsWith('/lookup/quests')) return Promise.resolve([]);
    if (path === '/rosters') return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }) as never);
}

/** One authored box item; `itemKey` keeps files stable unless overridden. */
function boxItem(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    order: 1,
    itemKey: 'n00000001',
    itemType: 1,
    rewardId: 'reward-1',
    initialStock: 5,
    isLimited: true,
    ...overrides,
  };
}

function draftWithBox(
  items: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...DRAFT, boxGachas: { box1: { items } }, ...extra };
}

/** The draft object of the last Save draft request. */
async function lastSavedDraft(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(vi.mocked(put)).toHaveBeenCalled());
  const calls = vi.mocked(put).mock.calls;
  const body = calls[calls.length - 1][1] as { draft: Record<string, unknown> };
  return body.draft;
}

/** One box's items in a saved draft. */
function savedBoxItems(saved: Record<string, unknown>): Array<Record<string, unknown>> {
  const boxes = saved.boxGachas as { box1: { items: Array<Record<string, unknown>> } };
  return boxes.box1.items;
}

beforeEach(() => {
  window.location.hash = `#/events/${EVENT_ID}`;
  window.sessionStorage.clear();
  vi.mocked(get).mockReset();
  vi.mocked(put).mockReset();
  vi.mocked(del).mockReset();
  stubGet();
  stubPut();
  vi.mocked(del).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EventEditorPage', () => {
  it('shows the publish warnings handed over with the new version', async () => {
    savePublishNotice(EVENT_ID, {
      version: 3,
      warnings: [
        { path: 'boxGachas.box1', message: 'Stock will be reset', severity: 'warning' },
        { path: '', message: 'Roster is shared with another event', severity: 'warning' },
      ],
    });
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);

    expect(await screen.findByText('Published version 3.')).toBeTruthy();
    expect(screen.getByText('boxGachas.box1: Stock will be reset')).toBeTruthy();
    expect(screen.getByText('Roster is shared with another event')).toBeTruthy();
  });

  it('shows a viewer every action disabled', async () => {
    render(<EventEditorPage id={EVENT_ID} user={user('viewer')} />);

    const save = await screen.findByRole('button', { name: 'Save draft' });
    const validate = screen.getByRole('button', { name: 'Validate' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect((validate as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends schedule times with Z suffixes and full seconds', async () => {
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);

    await writer.click(await screen.findByRole('tab', { name: 'Schedule' }));
    const starts = screen.getAllByDisplayValue('2026-02-01T00:00:07')[0] as HTMLInputElement;
    expect(starts.getAttribute('step')).toBe('1');
    expect(screen.getByDisplayValue('2026-02-02T00:00:07')).toBeTruthy();
    expect(screen.getByDisplayValue('2026-02-03T00:00:07')).toBeTruthy();

    await writer.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => {
      expect(vi.mocked(put)).toHaveBeenCalledWith(`/events/${EVENT_ID}/schedule`, {
        schedules: [
          {
            startsAt: '2026-02-01T00:00:07.000Z',
            endsAt: '2026-02-02T00:00:07.000Z',
            exchangeEndsAt: '2026-02-03T00:00:07.000Z',
            enabled: true,
          },
        ],
      });
    });
    expect(await screen.findByText('Schedule saved.')).toBeTruthy();
  });

  it('blocks an invalid schedule row before the request', async () => {
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);

    await writer.click(await screen.findByRole('tab', { name: 'Schedule' }));
    const starts = (await screen.findByDisplayValue('2026-02-01T00:00:07')) as HTMLInputElement;
    fireEvent.change(starts, { target: { value: '' } });
    await writer.click(screen.getByRole('button', { name: 'Save schedule' }));

    expect(await screen.findByText('All three times are required.')).toBeTruthy();
    expect(vi.mocked(put)).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'null', rosters: null, absent: false },
    { label: 'absent', rosters: undefined, absent: true },
  ])(
    'keeps a stored $label npcRosters when no stage was edited',
    async ({ rosters, absent }) => {
      const withoutRosters = Object.fromEntries(
        Object.entries(DRAFT).filter(([key]) => key !== 'npcRosters'),
      );
      const stored = absent ? withoutRosters : { ...DRAFT, npcRosters: rosters };
      vi.mocked(get).mockImplementation(((path: string) => {
        if (path === `/events/${EVENT_ID}`) return Promise.resolve({ ...detail(), draft: stored });
        if (path.startsWith('/lookup/quests')) return Promise.resolve([]);
        if (path === '/rosters') return Promise.resolve([]);
        return Promise.reject(new Error(`unexpected GET ${path}`));
      }) as never);
      const writer = userEvent.setup();
      render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

      const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
      await writer.type(name, ' edited');
      await writer.click(screen.getByRole('button', { name: 'Save draft' }));

      await waitFor(() => {
        expect(vi.mocked(put)).toHaveBeenCalledWith(
          `/events/${EVENT_ID}/draft`,
          expect.objectContaining({ draft: expect.any(Object) }),
        );
      });
      const body = vi.mocked(put).mock.calls[0]?.[1] as { draft: Record<string, unknown> };
      if (absent) expect(Object.hasOwn(body.draft, 'npcRosters')).toBe(false);
      else expect(body.draft.npcRosters).toBeNull();
    },
  );

  it('resolves box rewards and live bonuses in one batched lookup per kind', async () => {
    const boxDraft = {
      ...DRAFT,
      boxGachas: {
        box1: {
          items: [
            { order: 1, itemKey: 'a1', itemType: 1, rewardId: 'rd_known', initialStock: 1 },
            {
              order: 2,
              itemKey: 'a2',
              itemType: 2,
              liveBonusGroupId: 'group-known',
              initialStock: 1,
            },
            { order: 3, itemKey: 'a3', itemType: 1, rewardId: 'rd_missing', initialStock: 1 },
          ],
        },
      },
    };
    const rewardPath = `/lookup/rewards?ids=${encodeURIComponent('rd_known,rd_missing')}`;
    const groupPath = `/lookup/live-bonus-groups?ids=${encodeURIComponent('group-known')}`;
    const rewards: LookupReward[] = [
      {
        id: 'rd_known',
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
      },
      { id: 'rd_missing', found: false, resources: [] },
    ];
    const groups: LookupLiveBonusGroup[] = [
      {
        groupId: 'group-known',
        found: true,
        bonuses: [
          {
            liveBonusId: 'bonus-1',
            liveAbilityId: 'marathon-lba-vocal_add',
            level: 3,
            description: 'ボーカル1000上昇',
            descriptionEn: 'Vocal +1000',
            skills: [],
          },
        ],
      },
    ];
    vi.mocked(get).mockImplementation(((path: string) => {
      if (path === `/events/${EVENT_ID}`) return Promise.resolve(detail(boxDraft));
      if (path === rewardPath) return Promise.resolve(rewards);
      if (path === groupPath) return Promise.resolve(groups);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    }) as never);
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);

    await writer.click(await screen.findByRole('tab', { name: 'Boxes' }));

    expect(await screen.findByText('Yell Powder')).toBeTruthy();
    expect(screen.getByText('エールパウダー')).toBeTruthy();
    expect(await screen.findByText('Vocal +1000')).toBeTruthy();
    expect(screen.getByText('unknown id')).toBeTruthy();
    expect(vi.mocked(get)).toHaveBeenCalledWith(rewardPath);
    expect(vi.mocked(get)).toHaveBeenCalledWith(groupPath);
  });

  it('keeps a settled badge visible while a changed id is re-resolved', async () => {
    const boxDraft = {
      ...DRAFT,
      boxGachas: {
        box1: {
          items: [
            { order: 1, itemKey: 'a1', itemType: 1, rewardId: 'rd_a', initialStock: 1 },
            { order: 2, itemKey: 'b1', itemType: 1, rewardId: 'rd_b', initialStock: 1 },
          ],
        },
      },
    };
    const reward = (id: string): LookupReward => ({
      id,
      found: true,
      resources: [
        {
          resourceType: 1,
          typeLabel: 'Item',
          resourceId: `item-${id}`,
          amount: 1,
          name: `Name ${id}`,
          nameEn: null,
        },
      ],
    });
    vi.mocked(get).mockImplementation(((path: string) => {
      if (path === `/events/${EVENT_ID}`) return Promise.resolve(detail(boxDraft));
      if (path.startsWith('/lookup/rewards?ids=')) {
        const ids = decodeURIComponent(path.slice('/lookup/rewards?ids='.length)).split(',');
        return Promise.resolve(ids.map(reward));
      }
      if (path.startsWith('/lookup/rewards?q=')) return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    }) as never);
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);

    await writer.click(await screen.findByRole('tab', { name: 'Boxes' }));
    expect(await screen.findByText('Name rd_a')).toBeTruthy();
    expect(screen.getByText('Name rd_b')).toBeTruthy();

    // Change only the second reward id: the first badge is from the previous
    // batch and must stay on screen instead of flickering to nothing.
    fireEvent.change(screen.getByLabelText('Reward for box box1 item b1'), {
      target: { value: 'rd_c' },
    });
    expect(screen.getByText('Name rd_a')).toBeTruthy();

    expect(await screen.findByText('Name rd_c')).toBeTruthy();
    expect(screen.getByText('Name rd_a')).toBeTruthy();
  });

  it('shows resolved names for the stamina and quest-unlock item ids', async () => {
    const withItemFields = detail();
    withItemFields.schema = {
      fields: [
        { path: 'name', type: 'string', label: 'Name' },
        { path: 'staminaRecoveryItemId', type: 'string', label: 'Stamina item' },
        { path: 'questUnlockItemId', type: 'string', label: 'Quest unlock item' },
      ],
    };
    const items: LookupItem[] = [
      { id: 'stamina-item', name: 'スタミナ回復薬', nameEn: 'Stamina Drink' },
      { id: 'unlock-item', name: '解放キー', nameEn: 'Unlock Key' },
    ];
    vi.mocked(get).mockImplementation(((path: string) => {
      if (path === `/events/${EVENT_ID}`) return Promise.resolve(withItemFields);
      if (path === '/lookup/items') return Promise.resolve(items);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    }) as never);
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);

    expect(await screen.findByText('Stamina Drink')).toBeTruthy();
    expect(screen.getByText('スタミナ回復薬')).toBeTruthy();
    expect(screen.getByText('Unlock Key')).toBeTruthy();
    expect(screen.getByText('解放キー')).toBeTruthy();
  });

  it('asks in-page before discarding dirty edits and keeps the hash on cancel', async () => {
    const writer = userEvent.setup();
    const nativeConfirm = vi.spyOn(window, 'confirm');
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    await writer.type(name, ' edited');

    await writer.click(screen.getByRole('button', { name: '← Events' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    expect(window.location.hash).toBe(`#/events/${EVENT_ID}`);
    expect(nativeConfirm).not.toHaveBeenCalled();

    await writer.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(window.location.hash).toBe(`#/events/${EVENT_ID}`);

    await writer.click(screen.getByRole('button', { name: '← Events' }));
    const again = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await writer.click(within(again).getByRole('button', { name: 'Discard' }));
    await waitFor(() => {
      expect(window.location.hash).toBe('#/events');
    });
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('asks before a hash navigation away from dirty edits and navigates on confirm', async () => {
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    await writer.type(name, ' edited');

    window.location.hash = '#/events/other';
    const dialog = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    // The hash is restored while the dialog is open, so the editor stays mounted.
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/events/${EVENT_ID}`);
    });

    await writer.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => {
      expect(window.location.hash).toBe('#/events/other');
    });
  });

  it('saves before opening the publish screen, or stays put on cancel', async () => {
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);

    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    await writer.type(name, ' edited');

    await writer.click(screen.getByRole('button', { name: 'Publish…' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Save changes before publishing?',
    });
    await writer.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(vi.mocked(put)).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(`#/events/${EVENT_ID}`);

    await writer.click(screen.getByRole('button', { name: 'Publish…' }));
    const again = await screen.findByRole('alertdialog', {
      name: 'Save changes before publishing?',
    });
    await writer.click(within(again).getByRole('button', { name: 'Save and continue' }));

    await waitFor(() => {
      expect(vi.mocked(put)).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/events/${EVENT_ID}/publish`);
    });
  });

  it('asks in-page before deleting a box', async () => {
    stubDraft(draftWithBox([boxItem({})]));
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    await writer.click(await screen.findByRole('tab', { name: 'Boxes' }));
    await writer.click(screen.getByRole('button', { name: 'Delete box' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete box "box1"?' });
    expect(screen.getByRole('heading', { name: 'Box box1' })).toBeTruthy();

    await writer.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('heading', { name: 'Box box1' })).toBeTruthy();

    await writer.click(screen.getByRole('button', { name: 'Delete box' }));
    const again = await screen.findByRole('alertdialog', { name: 'Delete box "box1"?' });
    await writer.click(within(again).getByRole('button', { name: 'Delete' }));
    expect(screen.queryByRole('heading', { name: 'Box box1' })).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('shows the box rate budget from the infinite rate and assigned rates', async () => {
    stubDraft(
      draftWithBox(
        [
          boxItem({
            order: 1,
            itemKey: 'n00000001',
            itemType: 2,
            rewardId: undefined,
            liveBonusGroupId: 'group-1',
            initialStock: 7,
            isLimited: false,
          }),
          boxItem({ order: 2, itemKey: 'n00000002', initialStock: 3, rate: 0.01 }),
        ],
        { boxInfiniteRate: 0.7 },
      ),
    );
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    await writer.click(await screen.findByRole('tab', { name: 'Boxes' }));
    const budget = (await waitFor(() => {
      const element = document.querySelector('.rate-budget');
      expect(element).toBeTruthy();
      return element;
    })) as HTMLElement;

    expect(budget.textContent).toContain('Infinite rate 0.7');
    expect(budget.textContent).toContain('Limited items 0.3');
    expect(budget.textContent).toContain('Assigned 0.01');
    expect(budget.textContent).toContain('Available 0.29');
    expect(budget.className).not.toContain('rate-budget-over');
  });

  it('flags a rate budget overrun per box', async () => {
    stubDraft(
      draftWithBox(
        [
          boxItem({ order: 1, itemKey: 'n00000001', initialStock: 7, isLimited: false }),
          boxItem({ order: 2, itemKey: 'n00000002', initialStock: 3, rate: 0.2 }),
          boxItem({ order: 3, itemKey: 'n00000003', initialStock: 3, rate: 0.2 }),
        ],
        { boxInfiniteRate: 0.7 },
      ),
    );
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    await writer.click(await screen.findByRole('tab', { name: 'Boxes' }));
    const budget = (await waitFor(() => {
      const element = document.querySelector('.rate-budget');
      expect(element).toBeTruthy();
      return element;
    })) as HTMLElement;

    expect(budget.className).toContain('rate-budget-over');
    expect(budget.textContent).toContain('Assigned 0.4');
    expect(budget.textContent).toContain('Available -0.1');
    expect(budget.textContent).toContain('over by 0.1');
  });

  it('offers a rate input only on limited items', async () => {
    stubDraft(
      draftWithBox([boxItem({ itemKey: 'n00000001', initialStock: 7, isLimited: false })]),
    );
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    await writer.click(await screen.findByRole('tab', { name: 'Boxes' }));
    await screen.findByText('Item keys are the stable draw identity: existing keys are read-only, and every new item gets a fresh random key.');

    expect(screen.queryByLabelText('Rate for box box1 item n00000001')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('drops an item rate when its input is emptied', async () => {
    stubDraft(draftWithBox([boxItem({ itemKey: 'n00000001', rate: 0.2 })]));
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    await writer.click(await screen.findByRole('tab', { name: 'Boxes' }));
    const input = (await screen.findByLabelText(
      'Rate for box box1 item n00000001',
    )) as HTMLInputElement;
    expect(input.value).toBe('0.2');

    fireEvent.change(input, { target: { value: '' } });
    await writer.click(screen.getByRole('button', { name: 'Save draft' }));

    const items = savedBoxItems(await lastSavedDraft());
    expect(Object.hasOwn(items[0], 'rate')).toBe(false);
  });

  it('drops an item rate when the item stops being limited', async () => {
    stubDraft(draftWithBox([boxItem({ itemKey: 'n00000001', rate: 0.2 })]));
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    await writer.click(await screen.findByRole('tab', { name: 'Boxes' }));
    const limited = (await screen.findAllByRole('checkbox'))[0];
    expect((limited as HTMLInputElement).checked).toBe(true);
    await writer.click(limited);

    expect(screen.queryByLabelText('Rate for box box1 item n00000001')).toBeNull();
    await writer.click(screen.getByRole('button', { name: 'Save draft' }));

    const items = savedBoxItems(await lastSavedDraft());
    expect(items[0].isLimited).toBe(false);
    expect(Object.hasOwn(items[0], 'rate')).toBe(false);
  });

  it('edits the box infinite rate from the Boxes tab', async () => {
    stubDraft(draftWithBox([boxItem({ itemKey: 'n00000001' })]));
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    await writer.click(await screen.findByRole('tab', { name: 'Boxes' }));
    const hint = (await waitFor(() => {
      const element = document.querySelector('.box-rate-row .rate-hint');
      expect(element).toBeTruthy();
      return element;
    })) as HTMLElement;
    expect(hint.textContent).toContain('Unset: each box uses its own stock ratio');

    const input = screen.getByLabelText('Box infinite rate') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.7' } });
    await writer.click(screen.getByRole('button', { name: 'Save draft' }));

    const saved = await lastSavedDraft();
    expect(saved.boxInfiniteRate).toBe(0.7);
  });

  it('labels each box with its own stock ratio when the infinite rate is unset', async () => {
    stubDraft({
      ...DRAFT,
      boxGachas: {
        box1: {
          items: [
            boxItem({ order: 1, itemKey: 'n00000001', initialStock: 1, isLimited: false }),
            boxItem({ order: 2, itemKey: 'n00000002', initialStock: 3 }),
          ],
        },
        box2: {
          items: [
            boxItem({ order: 1, itemKey: 'n00000003', initialStock: 1, isLimited: false }),
            boxItem({ order: 2, itemKey: 'n00000004', initialStock: 1 }),
          ],
        },
      },
    });
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    await writer.click(await screen.findByRole('tab', { name: 'Boxes' }));
    const budgets = await waitFor(() => {
      const elements = document.querySelectorAll('.rate-budget');
      expect(elements).toHaveLength(2);
      return elements;
    });

    expect(budgets[0]?.textContent).toContain('Infinite rate ≈0.25 (stock ratio)');
    expect(budgets[1]?.textContent).toContain('Infinite rate ≈0.5 (stock ratio)');
  });

  it('disables Save draft while a rate input holds invalid text', async () => {
    stubDraft(draftWithBox([boxItem({ itemKey: 'n00000001', rate: 0.2 })]));
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    await writer.click(await screen.findByRole('tab', { name: 'Boxes' }));
    const rate = (await screen.findByLabelText(
      'Rate for box box1 item n00000001',
    )) as HTMLInputElement;
    const save = screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement;

    fireEvent.change(rate, { target: { value: '2' } });
    expect(save.disabled).toBe(true);
    expect(screen.getByText('Fix invalid rates before saving')).toBeTruthy();

    fireEvent.change(rate, { target: { value: '0.3' } });
    expect(save.disabled).toBe(false);
    expect(screen.queryByText('Fix invalid rates before saving')).toBeNull();
  });

  it('disables Save draft while the box infinite rate holds invalid text', async () => {
    stubDraft(draftWithBox([boxItem({ itemKey: 'n00000001' })]));
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    await writer.click(await screen.findByRole('tab', { name: 'Boxes' }));
    const input = screen.getByLabelText('Box infinite rate') as HTMLInputElement;
    const save = screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: '2' } });
    expect(save.disabled).toBe(true);
    expect(screen.getByText('Fix invalid rates before saving')).toBeTruthy();

    fireEvent.change(input, { target: { value: '0.5' } });
    expect(save.disabled).toBe(false);
  });

  it('notes that an exhausted rated item rate goes to the infinite items', async () => {
    stubDraft({
      ...DRAFT,
      boxGachas: {
        ratedInfinite: {
          items: [
            boxItem({ order: 1, itemKey: 'n00000001', initialStock: 5, isLimited: false }),
            boxItem({ order: 2, itemKey: 'n00000002', initialStock: 3, rate: 0.2 }),
          ],
        },
        ratedFinite: {
          items: [boxItem({ order: 1, itemKey: 'n00000003', initialStock: 3, rate: 0.2 })],
        },
        unratedInfinite: {
          items: [
            boxItem({ order: 1, itemKey: 'n00000004', initialStock: 5, isLimited: false }),
            boxItem({ order: 2, itemKey: 'n00000005', initialStock: 3 }),
          ],
        },
      },
    });
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    await writer.click(await screen.findByRole('tab', { name: 'Boxes' }));
    await waitFor(() => {
      expect(document.querySelectorAll('.rate-budget')).toHaveLength(3);
    });

    // Only the box with both a rate and infinite items explains the shift.
    const notes = Array.from(document.querySelectorAll('.rate-hint')).filter((element) =>
      element.textContent?.includes('When a rated item runs out'),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.textContent).toBe(
      'When a rated item runs out, its rate goes to the infinite items.',
    );
  });

  it('shows the unrated item rate as an estimate at full stock', async () => {
    stubDraft(
      draftWithBox([
        boxItem({ order: 1, itemKey: 'n00000001', initialStock: 5, rate: 0.5 }),
        boxItem({ order: 2, itemKey: 'n00000002', initialStock: 20 }),
        boxItem({ order: 3, itemKey: 'n00000003', initialStock: 20 }),
      ]),
    );
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    await writer.click(await screen.findByRole('tab', { name: 'Boxes' }));
    expect(await screen.findAllByText(/≈0\.25 at full stock/)).toHaveLength(2);
  });

  it('hides Delete event from editors and shows it to publishers', async () => {
    const { unmount } = render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);
    await screen.findByRole('button', { name: 'Save draft' });
    expect(screen.queryByRole('button', { name: 'Delete event' })).toBeNull();
    unmount();

    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);
    expect(await screen.findByRole('button', { name: 'Delete event' })).toBeTruthy();
  });

  it('requires the exact event id before Delete is enabled', async () => {
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);

    await writer.click(await screen.findByRole('button', { name: 'Delete event' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(
      screen.getByText(
        'This removes its draft, published versions and schedule. Player progress is kept. This cannot be undone.',
      ),
    ).toBeTruthy();

    const confirm = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Type the event id to confirm'), {
      target: { value: 'evt' },
    });
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Type the event id to confirm'), {
      target: { value: EVENT_ID },
    });
    expect(confirm.disabled).toBe(false);
  });

  it('navigates back to the event list after a successful delete', async () => {
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);

    await writer.click(await screen.findByRole('button', { name: 'Delete event' }));
    fireEvent.change(screen.getByLabelText('Type the event id to confirm'), {
      target: { value: EVENT_ID },
    });
    await writer.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(vi.mocked(del)).toHaveBeenCalledWith(`/events/${EVENT_ID}`);
      expect(window.location.hash).toBe('#/events');
    });
  });

  it('sends one DELETE request when Delete is double-clicked', async () => {
    let resolveDelete: () => void = () => {};
    vi.mocked(del).mockImplementation(
      () => new Promise<void>((resolve) => { resolveDelete = resolve; }),
    );
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);

    await writer.click(await screen.findByRole('button', { name: 'Delete event' }));
    fireEvent.change(screen.getByLabelText('Type the event id to confirm'), {
      target: { value: EVENT_ID },
    });

    const confirm = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    // Two clicks without awaiting in between: the second lands while the first
    // DELETE is still in flight, and the in-flight guard must swallow it.
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(vi.mocked(del)).toHaveBeenCalledTimes(1);

    resolveDelete();
    await waitFor(() => {
      expect(window.location.hash).toBe('#/events');
    });
    expect(vi.mocked(del)).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open and shows the 409 message when the event is live', async () => {
    const writer = userEvent.setup();
    vi.mocked(del).mockRejectedValue(
      new ApiError(409, { error: 'Event is live. Disable its schedule first.' }),
    );
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);

    await writer.click(await screen.findByRole('button', { name: 'Delete event' }));
    fireEvent.change(screen.getByLabelText('Type the event id to confirm'), {
      target: { value: EVENT_ID },
    });
    await writer.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Event is live. Disable its schedule first.')).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(window.location.hash).toBe(`#/events/${EVENT_ID}`);
  });
});
