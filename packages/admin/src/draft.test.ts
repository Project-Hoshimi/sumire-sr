/**
 * Pure draft-editor helpers. The identity rules matter most: a new item key is
 * random and unique in its box, and reordering never touches existing keys.
 */
import { describe, expect, it } from 'vitest';
import {
  ITEM_KEY_PATTERN,
  addBoxItem,
  createBoxItem,
  draftFromUnknown,
  draftSavePayload,
  errorAt,
  fromDatetimeLocal,
  groupIssuesByPath,
  issuesFor,
  moveBoxItem,
  newItemKey,
  normalizeOrders,
  removeBoxItem,
  storedNpcRosters,
  toDatetimeLocal,
  withDraftValue,
  type DraftBox,
} from './draft.ts';
import type { ValidationIssue } from './types.ts';

function box(...keys: string[]): DraftBox {
  return {
    items: keys.map((itemKey, index) => ({
      order: index + 1,
      itemKey,
      itemType: 1,
      rewardId: `reward-${itemKey}`,
      initialStock: 10,
      isLimited: true,
    })),
  };
}

describe('newItemKey', () => {
  it('is n plus eight lowercase hex characters', () => {
    const key = newItemKey(new Set());
    expect(key).toMatch(ITEM_KEY_PATTERN);
    expect(key).toHaveLength(9);
  });

  it('regenerates on collision instead of reusing or deriving a key', () => {
    const existing = new Set(['n00000001']);
    const sequence = ['n00000001', 'n00000002'];
    const key = newItemKey(existing, () => sequence.shift() as string);
    expect(key).toBe('n00000002');
  });

  it('produces many distinct keys', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const key = newItemKey(seen);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(200);
  });
});

describe('box items', () => {
  it('gives every new item a fresh key and never reuses an existing one', () => {
    const before = box('a', 'b');
    const after = addBoxItem(before);
    const keys = after.items.map((item) => item.itemKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe('a');
    expect(keys[1]).toBe('b');
    expect(keys[2]).toMatch(ITEM_KEY_PATTERN);
    expect(after.items[2].order).toBe(3);
  });

  it('regenerates a colliding key when adding an item', () => {
    const before = box('a', 'b');
    const sequence = ['a', 'b', 'c'];
    const after = addBoxItem(before, undefined, () => sequence.shift() as string);
    expect(after.items[2].itemKey).toBe('c');
  });

  it('never derives the new key from item order', () => {
    const before = box('a');
    const item = createBoxItem(before, { itemType: 2, liveBonusGroupId: 'bonus' });
    expect(item.itemKey).not.toBe('2');
    expect(item.itemKey).toMatch(ITEM_KEY_PATTERN);
  });

  it('reordering keeps every existing key attached to its item', () => {
    const before = box('a', 'b', 'c');
    const after = moveBoxItem(before, 0, 2);
    expect(after.items.map((item) => item.itemKey)).toEqual(['b', 'c', 'a']);
    expect(after.items.map((item) => item.order)).toEqual([1, 2, 3]);
    expect(after.items[2].rewardId).toBe('reward-a');
    // The input was not mutated.
    expect(before.items.map((item) => item.itemKey)).toEqual(['a', 'b', 'c']);
  });

  it('moving up keeps keys and renumbers', () => {
    const after = moveBoxItem(box('a', 'b', 'c'), 2, 1);
    expect(after.items.map((item) => item.itemKey)).toEqual(['a', 'c', 'b']);
    expect(after.items.map((item) => item.order)).toEqual([1, 2, 3]);
  });

  it('removing renumbers but keeps the surviving keys', () => {
    const after = removeBoxItem(box('a', 'b', 'c'), 1);
    expect(after.items.map((item) => item.itemKey)).toEqual(['a', 'c']);
    expect(after.items.map((item) => item.order)).toEqual([1, 2]);
  });

  it('normalizeOrders is stable for keys', () => {
    const items = box('a', 'b').items.map((item) => ({ ...item, order: 9 }));
    expect(normalizeOrders(items).map((item) => item.order)).toEqual([1, 2]);
  });
});

describe('draftFromUnknown', () => {
  it('reads boxes, rosters, schedule and preserves unknown authored fields', () => {
    const draft = draftFromUnknown({
      id: 'marathon-a',
      name: 'Event A',
      type: 2,
      boxGachas: {
        box1: { items: [{ order: 1, itemKey: 'k1', itemType: 2, liveBonusGroupId: 'b', initialStock: 3 }] },
        box2: { items: [{ order: 2, itemType: 1, rewardId: 'r' }] },
      },
      npcRosters: { quest1: 'roster-a', quest2: { rosterId: 'roster-b', levelOffset: -2 } },
      schedule: { startsAt: '2026-01-01T00:00:00Z' },
      extra: { keep: true },
    });
    expect(draft.id).toBe('marathon-a');
    expect(draft.type).toBe(2);
    expect(draft.boxGachas.box1.items[0].itemKey).toBe('k1');
    // A legacy item without a key gets a fresh generated key, not the order.
    expect(draft.boxGachas.box2.items[0].itemKey).toMatch(ITEM_KEY_PATTERN);
    expect(draft.boxGachas.box2.items[0].itemKey).not.toBe('2');
    expect(draft.npcRosters.quest1).toBe('roster-a');
    expect(draft.npcRosters.quest2).toEqual({ rosterId: 'roster-b', levelOffset: -2 });
    expect(draft.schedule?.startsAt).toBe('2026-01-01T00:00:00Z');
    expect(draft.extra).toEqual({ keep: true });
  });

  it('tolerates a missing or malformed draft', () => {
    const draft = draftFromUnknown(null);
    expect(draft.type).toBe(1);
    expect(draft.boxGachas).toEqual({});
    expect(draft.npcRosters).toEqual({});
  });

  it('repairs duplicate and missing item keys while keeping the first occurrence', () => {
    const draft = draftFromUnknown({
      boxGachas: {
        box1: {
          items: [
            { order: 1, itemKey: 'dup', itemType: 1, initialStock: 1 },
            { order: 2, itemKey: 'dup', itemType: 1, initialStock: 1 },
            { order: 3, itemType: 1, initialStock: 1 },
            { order: 4, itemKey: '', itemType: 1, initialStock: 1 },
          ],
        },
      },
    });
    const keys = draft.boxGachas.box1.items.map((item) => item.itemKey);
    expect(keys[0]).toBe('dup');
    expect(new Set(keys).size).toBe(4);
    for (const key of keys.slice(1)) expect(key).toMatch(ITEM_KEY_PATTERN);
  });

  it('drops a stored rate unless the item is explicitly limited', () => {
    const draft = draftFromUnknown({
      boxGachas: {
        box1: {
          items: [
            { order: 1, itemKey: 'k1', itemType: 1, initialStock: 5, isLimited: false, rate: 0.2 },
            { order: 2, itemKey: 'k2', itemType: 1, initialStock: 5, isLimited: true, rate: 0.2 },
            { order: 3, itemKey: 'k3', itemType: 1, initialStock: 5, rate: 0.3 },
          ],
        },
      },
    });
    const [unlimited, limited, unmarked] = draft.boxGachas.box1.items;
    expect(Object.hasOwn(unlimited ?? {}, 'rate')).toBe(false);
    expect(limited?.rate).toBe(0.2);
    expect(Object.hasOwn(unmarked ?? {}, 'rate')).toBe(false);
  });
});

describe('draft value helpers', () => {
  it('replaces one field without mutating the input', () => {
    const draft = draftFromUnknown({ id: 'a', initialStamina: 1 });
    const next = withDraftValue(draft, 'initialStamina', 5);
    expect(next.initialStamina).toBe(5);
    expect(draft.initialStamina).toBe(1);
    expect(next).not.toBe(draft);
  });
});

describe('issue helpers', () => {
  const issues: ValidationIssue[] = [
    { path: 'id', message: 'bad id', severity: 'error' },
    { path: 'schedule.startsAt', message: 'bad start', severity: 'error' },
    { path: 'schedule', message: 'start after end', severity: 'error' },
    { path: 'boxGachas', message: 'bad box', severity: 'error' },
  ];

  it('selects a path and its children', () => {
    expect(issuesFor(issues, 'schedule').map((issue) => issue.path)).toEqual([
      'schedule.startsAt',
      'schedule',
    ]);
    expect(issuesFor(issues, 'schedule.startsAt')).toHaveLength(1);
  });

  it('groups by path in server order', () => {
    expect(groupIssuesByPath(issues).map((group) => group.path)).toEqual([
      'id',
      'schedule.startsAt',
      'schedule',
      'boxGachas',
    ]);
  });

  it('finds the first error at a path', () => {
    expect(errorAt(issues, 'boxGachas')).toBe('bad box');
    expect(errorAt(issues, 'npcRosters')).toBeNull();
    expect(errorAt([...issues, { path: 'id', message: 'warn', severity: 'warning' }], 'id')).toBe(
      'bad id',
    );
  });
});

describe('schedule timestamp helpers', () => {
  it('keeps seconds in datetime-local values', () => {
    expect(toDatetimeLocal('2026-02-01T03:04:05.000Z')).toBe('2026-02-01T03:04:05');
    expect(toDatetimeLocal('2026-02-01T03:04:05Z')).toBe('2026-02-01T03:04:05');
    expect(toDatetimeLocal('2026-02-01T03:04Z')).toBe('2026-02-01T03:04:00');
    expect(toDatetimeLocal(undefined)).toBe('');
    expect(toDatetimeLocal('not a date')).toBe('');
  });

  it('turns datetime-local values back into UTC ISO strings', () => {
    expect(fromDatetimeLocal('2026-02-01T03:04')).toBe('2026-02-01T03:04:00.000Z');
    expect(fromDatetimeLocal('2026-02-01T03:04:05')).toBe('2026-02-01T03:04:05.000Z');
    expect(fromDatetimeLocal('')).toBeNull();
  });

  it('round-trips a timestamp with non-zero seconds', () => {
    const iso = '2026-02-01T03:04:05.000Z';
    expect(fromDatetimeLocal(toDatetimeLocal(iso))).toBe(iso);
  });

  it('rejects partial or malformed values', () => {
    expect(fromDatetimeLocal('2026-02-01')).toBeNull();
    expect(fromDatetimeLocal('2026-02-01T03')).toBeNull();
    expect(fromDatetimeLocal('2026-02-01T03:04:')).toBeNull();
    expect(fromDatetimeLocal('2026-02-01 03:04')).toBeNull();
    expect(fromDatetimeLocal('not a date')).toBeNull();
  });
});

describe('stored npcRosters', () => {
  it('records whether the stored draft owns the key', () => {
    expect(storedNpcRosters({ npcRosters: null })).toEqual({ present: true, value: null });
    expect(storedNpcRosters({ npcRosters: { q1: 'roster-1' } })).toEqual({
      present: true,
      value: { q1: 'roster-1' },
    });
    expect(storedNpcRosters({})).toEqual({ present: false, value: undefined });
    expect(storedNpcRosters(null)).toEqual({ present: false, value: undefined });
    expect(storedNpcRosters('draft')).toEqual({ present: false, value: undefined });
  });

  it('keeps an untouched stored value instead of the normalized table', () => {
    const draft = draftFromUnknown({ name: 'Marathon', npcRosters: { q1: 'roster-1' } });
    expect(draftSavePayload(draft, { present: true, value: null }, false).npcRosters).toBeNull();
    expect(draftSavePayload(draft, { present: true, value: { q1: 'roster-9' } }, false).npcRosters)
      .toEqual({ q1: 'roster-9' });
    expect(
      Object.hasOwn(draftSavePayload(draft, { present: false, value: undefined }, false), 'npcRosters'),
    ).toBe(false);
  });

  it('sends the edited table once a stage changed', () => {
    const draft = draftFromUnknown({ name: 'Marathon', npcRosters: { q1: 'roster-1' } });
    expect(draftSavePayload(draft, { present: true, value: null }, true)).toBe(draft);
  });

  it('does not mutate the draft it copies', () => {
    const draft = draftFromUnknown({ name: 'Marathon' });
    const payload = draftSavePayload(draft, { present: true, value: null }, false);
    expect(payload).not.toBe(draft);
    expect(draft.npcRosters).toEqual({});
    expect(payload.npcRosters).toBeNull();
  });
});
