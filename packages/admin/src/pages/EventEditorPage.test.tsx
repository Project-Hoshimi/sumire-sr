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
  RaceBoardPreview,
  RosterSummary,
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

describe('EventEditorPage permanent events', () => {
  /** A moshikoi love event: permanent, so no schedule rows and no lifecycle dates. */
  function permanentDetail(): EventDetail {
    return {
      ...detail(),
      kind: 'moshikoi',
      lifecycle: 'permanent',
      schedule: [],
    };
  }

  function stubPermanent(): void {
    vi.mocked(get).mockImplementation(((path: string) => {
      if (path === `/events/${EVENT_ID}`) return Promise.resolve(permanentDetail());
      if (path.startsWith('/lookup/quests')) return Promise.resolve([]);
      if (path === '/rosters') return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    }) as never);
  }

  it('hides the schedule tab and date inputs and shows the permanent note', async () => {
    stubPermanent();
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);

    expect(
      await screen.findByText(
        'Permanent event: no schedule. Publishing makes changes live in the Love menu.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Schedule' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeTruthy();
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save schedule' })).toBeNull();
  });

  it('saves the draft without issuing a schedule PUT', async () => {
    stubPermanent();
    const writer = userEvent.setup();
    render(<EventEditorPage id={EVENT_ID} user={user('publisher')} />);

    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    await writer.type(name, ' edited');
    await writer.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(vi.mocked(put)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(put).mock.calls[0][0]).toBe(`/events/${EVENT_ID}/draft`);
    expect(
      vi.mocked(put).mock.calls.some(([path]) => String(path).endsWith('/schedule')),
    ).toBe(false);
  });
});

describe('EventEditorPage race events', () => {
  const RACE_ROSTER: RosterSummary = {
    id: 'qt-main-1-007-04',
    name: 'QT main roster',
    nameEn: null,
    managerLevel: 1,
    updatedBy: null,
    updatedAt: '2026-01-01T00:00:00Z',
    usageCount: 0,
  };

  const RACE_DRAFT = {
    raceId: 'race-26-0226',
    name: 'Race 26-0226',
    assetId: 'event-race-26-0226',
    bannerAssetId: 'img_banner_l_event-race-26-0226',
    racePointItemId: 'item-race_point-26-0226',
    raceMedalItemId: 'item-race_medal-26-0226',
    raceLiveBonusResetItemId: 'item-race_reset-live-bonus-26-0226',
    eventMissionId: 'event-race-26-0226',
    eventStoryId: 'story-1',
    areaIds: ['race-area-005-01', 'race-area-005-02'],
    raceLiveBonusGroupId: 'race_live_bonus_group-001',
    areaQuestIds: { pt: 'race-qt-26-0226-pt', medal: 'race-qt-26-0226-medal' },
    livePanelDifficultyNumber: 1,
    cardCoolTimeMinutes: 60,
    requiredCardCoolTimeRacePointAmount: 100,
    initialRacePointAmount: 3000,
    rankGrades: [
      {
        id: 'race_rank_grade-bronze',
        name: 'Bronze',
        hierarchyPointFrom: 0,
        topColorCode: '#C08A5A',
        bottomColorCode: '#7A4E2A',
      },
      {
        id: 'race_rank_grade-silver',
        name: 'Silver',
        hierarchyPointFrom: 50,
        topColorCode: '#D8D8D8',
        bottomColorCode: '#8C8C8C',
      },
    ],
    activityLesson: {
      racePointPerStepBase: 34,
      racePointPerStepPerTier: 4.5,
      raceMedalPerStepBase: 17,
      raceMedalPerStepPerTier: 3.3,
      maxHours: 36,
    },
    areaQuestReward: { racePointPerTier: 2000, raceMedalPerTier: 100 },
    rivals: 4,
    npcRosterId: 'qt-main-1-007-04',
    npcRosterByQuest: {},
  };

  function raceDetail(draft: unknown = RACE_DRAFT, publishedVersion = 0): EventDetail {
    return {
      ...detail(draft),
      kind: 'race',
      published: publishedVersion > 0,
      publishedVersion,
      schema: {
        fields: [
          { path: 'raceId', type: 'string', label: 'Race id', readOnly: true },
          { path: 'name', type: 'string', label: 'Name', readOnly: true },
          { path: 'assetId', type: 'string', label: 'Asset id', readOnly: true },
          { path: 'areaIds', type: 'array', label: 'Board areas', readOnly: true },
          {
            path: 'areaQuestIds.pt',
            type: 'string',
            label: 'Race point area quest',
            readOnly: true,
          },
          { path: 'livePanelDifficultyNumber', type: 'number', label: 'Live panel difficulty' },
          { path: 'cardCoolTimeMinutes', type: 'number', label: 'Card cool time (minutes)' },
          {
            path: 'requiredCardCoolTimeRacePointAmount',
            type: 'number',
            label: 'Card cool time reset cost',
          },
          { path: 'initialRacePointAmount', type: 'number', label: 'Starting race points' },
          { path: 'rivals', type: 'number', label: 'Opponents shown (real players)' },
          { path: 'npcRosterId', type: 'string', label: 'Versus NPC roster' },
          { path: 'rankGrades', type: 'array', label: 'Rank grades' },
          { path: 'activityLesson', type: 'object', label: 'Activity lesson' },
          {
            path: 'activityLesson.racePointPerStepBase',
            type: 'number',
            label: 'Race points per step (base)',
          },
          {
            path: 'activityLesson.racePointPerStepPerTier',
            type: 'number',
            label: 'Race points per step per tier',
          },
          {
            path: 'activityLesson.raceMedalPerStepBase',
            type: 'number',
            label: 'Race medals per step (base)',
          },
          {
            path: 'activityLesson.raceMedalPerStepPerTier',
            type: 'number',
            label: 'Race medals per step per tier',
          },
          {
            path: 'activityLesson.maxHours',
            type: 'number',
            label: 'Activity lesson cap (hours)',
          },
          { path: 'areaQuestReward', type: 'object', label: 'Area quest reward' },
          {
            path: 'areaQuestReward.racePointPerTier',
            type: 'number',
            label: 'Race points per tier',
          },
          {
            path: 'areaQuestReward.raceMedalPerTier',
            type: 'number',
            label: 'Race medals per tier',
          },
        ],
      },
    };
  }

  function stubRace(draft: unknown = RACE_DRAFT, publishedVersion = 0): void {
    vi.mocked(get).mockImplementation(((path: string) => {
      if (path === `/events/${EVENT_ID}`) return Promise.resolve(raceDetail(draft, publishedVersion));
      if (path.startsWith('/lookup/quests')) return Promise.resolve([]);
      if (path === '/rosters') return Promise.resolve([RACE_ROSTER]);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    }) as never);
  }

  it('links to the race players page once a version is published', async () => {
    stubRace(RACE_DRAFT, 2);
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    const link = await screen.findByRole('link', { name: 'Players (live ops)' });
    expect(link.getAttribute('href')).toBe(`#/events/${encodeURIComponent(EVENT_ID)}/players`);
  });

  it('shows no players link while the race is unpublished', async () => {
    stubRace();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    await screen.findByLabelText('Race id');
    expect(screen.queryByRole('link', { name: 'Players (live ops)' })).toBeNull();
  });

  it('shows master-derived fields read-only and saves edited tuning', async () => {
    stubRace();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    const raceId = (await screen.findByLabelText('Race id')) as HTMLInputElement;
    expect(raceId.value).toBe('race-26-0226');
    expect(raceId.readOnly).toBe(true);
    expect((screen.getByLabelText('Name') as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText('Board areas') as HTMLInputElement).value).toBe(
      'race-area-005-01, race-area-005-02',
    );

    fireEvent.change(screen.getByLabelText('Card cool time (minutes)'), {
      target: { value: '30' },
    });
    fireEvent.change(screen.getByLabelText('Race points per step (base)'), {
      target: { value: '40' },
    });
    fireEvent.change(screen.getByLabelText('Race medals per tier'), {
      target: { value: '150' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    const saved = await lastSavedDraft();
    expect(saved.cardCoolTimeMinutes).toBe(30);
    expect(saved.activityLesson).toEqual({
      racePointPerStepBase: 40,
      racePointPerStepPerTier: 4.5,
      raceMedalPerStepBase: 17,
      raceMedalPerStepPerTier: 3.3,
      maxHours: 36,
    });
    expect(saved.areaQuestReward).toEqual({ racePointPerTier: 2000, raceMedalPerTier: 150 });
    // The nested edits did not replace the whole draft with dotted keys.
    expect(saved['activityLesson.racePointPerStepBase']).toBeUndefined();
  });

  it('keeps the JSON tab in sync with the Settings form', async () => {
    stubRace();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    fireEvent.change(await screen.findByLabelText('Card cool time (minutes)'), {
      target: { value: '25' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));

    const json = (await screen.findByLabelText('Draft JSON')) as HTMLTextAreaElement;
    expect(json.value).toContain('"cardCoolTimeMinutes": 25');

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect((screen.getByLabelText('Card cool time (minutes)') as HTMLInputElement).value).toBe('25');
  });

  it('adds, moves and saves rank grade rows', async () => {
    stubRace();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    expect(await screen.findAllByLabelText(/Grade \d+ id/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Add grade' }));
    expect(screen.getAllByLabelText(/Grade \d+ id/)).toHaveLength(3);

    fireEvent.change(screen.getByLabelText('Grade 3 hierarchy points from'), {
      target: { value: '150' },
    });
    fireEvent.click(screen.getByLabelText('Move grade 3 up'));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    const saved = await lastSavedDraft();
    const grades = saved.rankGrades as Array<{ hierarchyPointFrom: number; id: string }>;
    expect(grades.map((grade) => grade.hierarchyPointFrom)).toEqual([0, 150, 50]);

    fireEvent.click(screen.getByLabelText('Remove grade 2'));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const afterRemove = (await lastSavedDraft()).rankGrades as Array<{ id: string }>;
    expect(afterRemove.map((grade) => grade.id)).toEqual([
      'race_rank_grade-bronze',
      'race_rank_grade-silver',
    ]);
  });

  it('shows the server rank-grade validation inline', async () => {
    stubRace({
      ...RACE_DRAFT,
      rankGrades: [
        ...RACE_DRAFT.rankGrades,
        {
          id: 'race_rank_grade-gold',
          name: 'Gold',
          hierarchyPointFrom: 0,
          topColorCode: '#F4D35E',
          bottomColorCode: '#B8860B',
        },
      ],
    });
    vi.mocked(put).mockResolvedValue({
      saved: true,
      validation: {
        ok: false,
        errors: [
          {
            path: 'rankGrades.2.hierarchyPointFrom',
            severity: 'error',
            message: 'must be greater than the previous grade (50)',
          },
        ],
      },
    } as never);
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    fireEvent.change(await screen.findByLabelText('Card cool time (minutes)'), {
      target: { value: '45' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(
      (await screen.findAllByText('must be greater than the previous grade (50)')).length,
    ).toBeGreaterThan(0);
  });


  const ALT_ROSTER: RosterSummary = {
    ...RACE_ROSTER,
    id: 'qt-alt-roster',
    name: 'Alt roster',
  };

  const VENUS_QUEST_ID = 'race-qt-26-0226-panel-001-001';

  const BOARD_PREVIEW: RaceBoardPreview = {
    raceId: 'race-26-0226',
    eventStoryId: 'story-1',
    areas: [
      {
        index: 0,
        areaId: 'race-area-005-01',
        panelCount: 3,
        totalRacePointCost: 3000,
        panels: [
          {
            number: 1,
            type: 4,
            typeLabel: 'Story',
            requiredRacePointAmount: 1000,
            rewardId: null,
            reward: null,
            storyEpisode: 1,
            storyId: 'story-1',
            venus: null,
          },
          {
            number: 2,
            type: 2,
            typeLabel: 'Reward',
            requiredRacePointAmount: 1000,
            rewardId: 'rd_auto;item;item-a;5',
            reward: {
              id: 'rd_auto;item;item-a;5',
              found: true,
              resources: [
                {
                  resourceType: 1,
                  typeLabel: 'Item',
                  resourceId: 'item-a',
                  amount: 5,
                  name: 'Item A',
                  nameEn: 'Item A EN',
                },
              ],
            },
            storyEpisode: null,
            storyId: null,
            venus: null,
          },
          {
            number: 3,
            type: 3,
            typeLabel: 'VENUS',
            requiredRacePointAmount: 1000,
            rewardId: null,
            reward: null,
            storyEpisode: null,
            storyId: null,
            venus: {
              questId: VENUS_QUEST_ID,
              questName: 'Panel duel 1',
              difficultyNumber: 1,
              difficultyLevel: 10,
              clearScore: 120000,
              difficultyFound: true,
            },
          },
        ],
      },
      {
        index: 1,
        areaId: 'race-area-005-02',
        panelCount: 1,
        totalRacePointCost: 1000,
        panels: [
          {
            number: 1,
            type: 1,
            typeLabel: 'Empty',
            requiredRacePointAmount: 1000,
            rewardId: null,
            reward: null,
            storyEpisode: null,
            storyId: null,
            venus: null,
          },
        ],
      },
    ],
  };

  /** `stubRace` plus the board preview and a configurable roster list. */
  function stubRaceBoard(
    draft: unknown = RACE_DRAFT,
    options: { rosters?: RosterSummary[]; board?: RaceBoardPreview } = {},
  ): void {
    const rosters = options.rosters ?? [RACE_ROSTER];
    const board = options.board ?? BOARD_PREVIEW;
    vi.mocked(get).mockImplementation(((path: string) => {
      if (path === `/events/${EVENT_ID}`) return Promise.resolve(raceDetail(draft));
      if (path.startsWith('/lookup/quests')) return Promise.resolve([]);
      if (path.startsWith('/lookup/race-board')) return Promise.resolve(board);
      if (path.startsWith('/lookup/rewards?ids=')) {
        const ids = decodeURIComponent(path.slice('/lookup/rewards?ids='.length)).split(',');
        return Promise.resolve(
          ids.map((id): LookupReward => ({
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
          })),
        );
      }
      if (path === '/rosters') return Promise.resolve(rosters);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    }) as never);
  }

  async function openBoardTab(): Promise<void> {
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);
    await screen.findByLabelText('Race id');
    fireEvent.click(screen.getByRole('tab', { name: 'Board' }));
  }

  it('previews lesson rates per step, hour and max claim for tier 1 and 55', async () => {
    stubRace();
    render(<EventEditorPage id={EVENT_ID} user={user('editor')} />);

    const table = await screen.findByTestId('lesson-preview');
    const cells = (tier: string): string[] =>
      within(table.querySelector(`tr[data-tier="${tier}"]`) as HTMLElement)
        .getAllByRole('cell')
        .map((cell) => cell.textContent ?? '');

    expect(cells('1')).toEqual(['1', '34', '17', '12240', '6120', '440640', '220320']);
    expect(cells('55')).toEqual([
      '55',
      '277',
      '195',
      '99720',
      '70200',
      '3589920',
      '2527200',
    ]);

    // The preview follows live edits to the rates and to the tier input.
    fireEvent.change(screen.getByLabelText('Race points per step (base)'), {
      target: { value: '10' },
    });
    expect(cells('1')[1]).toBe('10');
    fireEvent.change(screen.getByLabelText('Preview tier'), { target: { value: '55' } });
    expect(cells('55')[1]).toBe('253');
  });

  it('renders the board preview areas and panel contents', async () => {
    stubRaceBoard();
    await openBoardTab();

    expect(
      await screen.findByText(/2 areas · 4 panels · 4000 race points total/),
    ).toBeTruthy();
    const requested = vi
      .mocked(get)
      .mock.calls.map(([path]) => String(path))
      .find((path) => path.startsWith('/lookup/race-board'));
    expect(requested).toContain('eventId=race-26-0226');
    expect(requested).toContain('difficulty=1');
    expect(requested).toContain('areas=race-area-005-01%2Crace-area-005-02');

    expect(screen.getByText('race-area-005-01', { selector: 'code' })).toBeTruthy();
    expect(screen.getByText('race-area-005-02', { selector: 'code' })).toBeTruthy();
    expect(screen.getAllByText('Story').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Reward').length).toBeGreaterThan(0);
    expect(screen.getAllByText('VENUS').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Empty').length).toBeGreaterThan(0);

    // Story panels show their episode, reward panels their resolved grants,
    // VENUS panels their quest and ClearScore.
    expect(screen.getByText('story-1', { selector: 'code' })).toBeTruthy();
    expect(screen.getByText(/5 × Item A/)).toBeTruthy();
    expect(screen.getByText(VENUS_QUEST_ID, { selector: 'code' })).toBeTruthy();
    expect(screen.getByText(/ClearScore 120000 · difficulty 1/)).toBeTruthy();
  });

  it('writes a per-panel roster override into the draft', async () => {
    stubRaceBoard(RACE_DRAFT, { rosters: [RACE_ROSTER, ALT_ROSTER] });
    await openBoardTab();

    const select = (await screen.findByLabelText(
      `NPC roster for ${VENUS_QUEST_ID}`,
    )) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.options[0]?.textContent).toBe('default (qt-main-1-007-04)');

    fireEvent.change(select, { target: { value: 'qt-alt-roster' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    const saved = await lastSavedDraft();
    expect(saved.npcRosterByQuest).toEqual({ [VENUS_QUEST_ID]: 'qt-alt-roster' });
  });

  it('removes a per-panel roster override when the default is selected', async () => {
    stubRaceBoard(
      { ...RACE_DRAFT, npcRosterByQuest: { [VENUS_QUEST_ID]: 'qt-alt-roster' } },
      { rosters: [RACE_ROSTER, ALT_ROSTER] },
    );
    await openBoardTab();

    const select = (await screen.findByLabelText(
      `NPC roster for ${VENUS_QUEST_ID}`,
    )) as HTMLSelectElement;
    expect(select.value).toBe('qt-alt-roster');

    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    const saved = await lastSavedDraft();
    expect(saved.npcRosterByQuest).toEqual({});
  });

  it('marks reward panels as master and offers the shared reward picker', async () => {
    stubRaceBoard();
    await openBoardTab();

    const edit = await screen.findByRole('button', {
      name: 'Edit rewards for race-area-005-01 panel 2',
    });
    expect(screen.getByText('master')).toBeTruthy();
    expect(screen.getByText(/5 × Item A/)).toBeTruthy();

    fireEvent.click(edit);

    // The modal reuses the marathon editor's picker, prefilled per reference.
    expect(await screen.findByRole('dialog', { name: 'Panel rewards' })).toBeTruthy();
    const input = screen.getByLabelText(
      'Reward 1 for area race-area-005-01 panel 2',
    ) as HTMLInputElement;
    expect(input.value).toBe('rd_auto;item;item-a;5');
    expect(screen.queryByRole('button', { name: 'Reset to master' })).toBeNull();
  });

  it('saves a panel reward override from the picker into the draft', async () => {
    stubRaceBoard();
    await openBoardTab();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit rewards for race-area-005-01 panel 2' }),
    );
    const input = (await screen.findByLabelText(
      'Reward 1 for area race-area-005-01 panel 2',
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'rd_auto;item;item-b;9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('edited')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Panel rewards' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    const saved = await lastSavedDraft();
    expect(saved.panelRewards).toEqual({
      'race-area-005-01:2': ['rd_auto;item;item-b;9'],
    });
  });

  it('removes a panel reward override with reset to master', async () => {
    stubRaceBoard({
      ...RACE_DRAFT,
      panelRewards: { 'race-area-005-01:2': ['rd_auto;item;item-b;9'] },
    });
    await openBoardTab();

    expect(await screen.findByText('edited')).toBeTruthy();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit rewards for race-area-005-01 panel 2' }),
    );
    const input = (await screen.findByLabelText(
      'Reward 1 for area race-area-005-01 panel 2',
    )) as HTMLInputElement;
    expect(input.value).toBe('rd_auto;item;item-b;9');

    fireEvent.click(screen.getByRole('button', { name: 'Reset to master' }));
    expect(await screen.findByText('master')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    const saved = await lastSavedDraft();
    expect(saved.panelRewards).toEqual({});
  });
});
