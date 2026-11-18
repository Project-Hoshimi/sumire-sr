/**
 * Pure helpers for the marathon draft editor.
 *
 * The server stores a draft as opaque JSON; these helpers give the editor a
 * typed view without ever inventing identity. In particular a new box item
 * always gets a fresh random `itemKey`, while reordering an existing box keeps
 * every key exactly where it was: player draw progress is keyed by that value.
 */
import type { ValidationIssue } from './types.ts';

/** One authored box item, matching `BoxItemDef` in the marathon plugin. */
export interface DraftBoxItem {
  order: number;
  itemKey: string;
  itemType: number;
  rewardId?: string;
  liveBonusGroupId?: string;
  initialStock: number;
  isLimited?: boolean;
  isPickup?: boolean;
  /** Optional per-draw chance while in stock; only meaningful on a limited item. */
  rate?: number;
  assetId?: string;
  description?: string;
}

/** One authored box: an ordered list of items. */
export interface DraftBox {
  items: DraftBoxItem[];
}

/** A per-quest NPC roster assignment; the server accepts both spellings. */
export type DraftNpcRoster =
  | string
  | { rosterId: string; levelOffset?: number; fixedLevel?: number };

/** The authored draft shape the Settings/Stages/Boxes tabs edit. */
export interface MarathonDraftShape {
  id: string;
  name: string;
  type: number;
  assetId: string;
  bannerAssetId: string;
  boxGachaGroupId: string;
  initialStamina: number;
  staminaRecoveryMinutes: number;
  staminaRecoveryItemId: string;
  questUnlockItemId: string;
  eventMissionId: string;
  order: number;
  boxGachas: Record<string, DraftBox>;
  npcRosters: Record<string, DraftNpcRoster>;
  boxDrawMax?: number;
  boxInfiniteRate?: number;
  schedule?: { startsAt?: string; endsAt?: string; exchangeEndsAt?: string };
  /** Authored fields the marathon schema does not list yet survive a save. */
  [key: string]: unknown;
}

/** A new item key: `n` plus eight random lowercase hex characters. */
export const ITEM_KEY_PATTERN = /^n[0-9a-f]{8}$/;

/** Eight random lowercase hex characters from `crypto.getRandomValues`. */
export function randomItemKeyHex(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `n${hex}`;
}

/**
 * A key no item in the box uses yet. `next` is injectable for tests; production
 * callers get cryptographic randomness. Collisions are regenerated, never
 * resolved by nudging the value or falling back to the item order.
 */
export function newItemKey(
  existing: ReadonlySet<string>,
  next: () => string = randomItemKeyHex,
): string {
  for (;;) {
    const key = next();
    if (!existing.has(key)) return key;
  }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Coerce one authored item; a missing key stays empty for the box pass to fill. */
function itemFromUnknown(value: unknown, index: number): DraftBoxItem {
  const raw = isRecord(value) ? value : {};
  const order = asNumber(raw.order, index + 1);
  return {
    order,
    itemKey: asString(raw.itemKey),
    itemType: asNumber(raw.itemType, 1),
    ...(typeof raw.rewardId === 'string' ? { rewardId: raw.rewardId } : {}),
    ...(typeof raw.liveBonusGroupId === 'string'
      ? { liveBonusGroupId: raw.liveBonusGroupId }
      : {}),
    initialStock: asNumber(raw.initialStock, 0),
    ...(typeof raw.isLimited === 'boolean' ? { isLimited: raw.isLimited } : {}),
    ...(typeof raw.isPickup === 'boolean' ? { isPickup: raw.isPickup } : {}),
    // A rate is limited-only; dropping it here keeps a loaded draft from
    // carrying a value the editor cannot show or clear on an infinite item.
    ...(raw.isLimited === true &&
      typeof raw.rate === 'number' &&
      Number.isFinite(raw.rate)
      ? { rate: raw.rate }
      : {}),
    ...(typeof raw.assetId === 'string' ? { assetId: raw.assetId } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
  };
}

/**
 * Read a box and repair its item identity: a missing or duplicate `itemKey` gets
 * the same fresh generated key a newly authored item would get. The first
 * occurrence of a duplicated key keeps it, so no item is silently re-identified
 * when the stored data is already unambiguous.
 */
function boxFromUnknown(value: unknown): DraftBox {
  const raw = isRecord(value) ? value : {};
  const used = new Set<string>();
  const items = (Array.isArray(raw.items) ? raw.items : []).map((entry, index) => {
    const item = itemFromUnknown(entry, index);
    if (item.itemKey === '' || used.has(item.itemKey)) {
      item.itemKey = newItemKey(used);
    }
    used.add(item.itemKey);
    return item;
  });
  return { ...raw, items };
}

/**
 * Read a stored draft (or a server-provided default) into the editor shape.
 * Unknown fields and unknown box properties are preserved.
 */
export function draftFromUnknown(raw: unknown): MarathonDraftShape {
  const source = isRecord(raw) ? raw : {};
  const boxes: Record<string, DraftBox> = {};
  const rawBoxes = isRecord(source.boxGachas) ? source.boxGachas : {};
  for (const [boxId, box] of Object.entries(rawBoxes)) boxes[boxId] = boxFromUnknown(box);

  const rosters: Record<string, DraftNpcRoster> = {};
  const rawRosters = isRecord(source.npcRosters) ? source.npcRosters : {};
  for (const [questId, value] of Object.entries(rawRosters)) {
    if (typeof value === 'string') rosters[questId] = value;
    else if (isRecord(value) && typeof value.rosterId === 'string') {
      rosters[questId] = {
        rosterId: value.rosterId,
        ...(typeof value.levelOffset === 'number' ? { levelOffset: value.levelOffset } : {}),
        ...(typeof value.fixedLevel === 'number' ? { fixedLevel: value.fixedLevel } : {}),
      };
    }
  }

  return {
    ...source,
    id: asString(source.id),
    name: asString(source.name),
    type: asNumber(source.type, 1),
    assetId: asString(source.assetId),
    bannerAssetId: asString(source.bannerAssetId),
    boxGachaGroupId: asString(source.boxGachaGroupId),
    initialStamina: asNumber(source.initialStamina),
    staminaRecoveryMinutes: asNumber(source.staminaRecoveryMinutes),
    staminaRecoveryItemId: asString(source.staminaRecoveryItemId),
    questUnlockItemId: asString(source.questUnlockItemId),
    eventMissionId: asString(source.eventMissionId),
    order: asNumber(source.order),
    boxGachas: boxes,
    npcRosters: rosters,
    ...(typeof source.boxDrawMax === 'number' ? { boxDrawMax: source.boxDrawMax } : {}),
    ...(typeof source.boxInfiniteRate === 'number'
      ? { boxInfiniteRate: source.boxInfiniteRate }
      : {}),
    ...(isRecord(source.schedule)
      ? {
          schedule: {
            ...(typeof source.schedule.startsAt === 'string'
              ? { startsAt: source.schedule.startsAt }
              : {}),
            ...(typeof source.schedule.endsAt === 'string'
              ? { endsAt: source.schedule.endsAt }
              : {}),
            ...(typeof source.schedule.exchangeEndsAt === 'string'
              ? { exchangeEndsAt: source.schedule.exchangeEndsAt }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * The stored `npcRosters` value exactly as the server sent it. The editor's
 * typed view normalizes a missing or null table to `{}`; keeping the original
 * lets a save leave an untouched table alone instead of writing `{}` back.
 */
export interface StoredNpcRosters {
  present: boolean;
  value: unknown;
}

/** Capture the raw `npcRosters` value/property presence of a stored draft. */
export function storedNpcRosters(raw: unknown): StoredNpcRosters {
  if (isRecord(raw) && Object.hasOwn(raw, 'npcRosters')) {
    return { present: true, value: raw.npcRosters };
  }
  return { present: false, value: undefined };
}

/**
 * The `npcRosters` value a draft save should send. A stage edit is the only
 * reason to author that table, so until then the stored value goes back as it
 * was: `null` stays null and an absent key stays absent, instead of becoming
 * the editor's normalized `{}` (which would show up as a spurious preview diff).
 */
export function draftSavePayload(
  draft: MarathonDraftShape,
  stored: StoredNpcRosters,
  stagesEdited: boolean,
): MarathonDraftShape {
  if (stagesEdited) return draft;
  const payload: MarathonDraftShape = { ...draft };
  if (stored.present) payload.npcRosters = stored.value as Record<string, DraftNpcRoster>;
  else Reflect.deleteProperty(payload, 'npcRosters');
  return payload;
}

/** Renumber items 1..n in their current array order; keys never change. */
export function normalizeOrders(items: readonly DraftBoxItem[]): DraftBoxItem[] {
  return items.map((item, index) => ({ ...item, order: index + 1 }));
}

/** The next displayed position for an appended item. */
export function nextOrder(items: readonly DraftBoxItem[]): number {
  return items.length + 1;
}

/**
 * One new item for `box`, carrying a key unique in that box. Defaults describe a
 * limited itemType 1 reward; callers override any field except order/itemKey.
 */
export function createBoxItem(
  box: DraftBox,
  overrides: Partial<Omit<DraftBoxItem, 'order' | 'itemKey'>> = {},
  nextKey?: () => string,
): DraftBoxItem {
  const keys = new Set(box.items.map((item) => item.itemKey));
  return {
    order: nextOrder(box.items),
    itemKey: newItemKey(keys, nextKey),
    itemType: 1,
    rewardId: '',
    initialStock: 1,
    isLimited: true,
    ...overrides,
  };
}

/** Append a new item to `box`; returns a new box. */
export function addBoxItem(
  box: DraftBox,
  overrides: Partial<Omit<DraftBoxItem, 'order' | 'itemKey'>> = {},
  nextKey?: () => string,
): DraftBox {
  return { ...box, items: [...box.items, createBoxItem(box, overrides, nextKey)] };
}

/** Remove item `index`; remaining items are renumbered but keep their keys. */
export function removeBoxItem(box: DraftBox, index: number): DraftBox {
  return { ...box, items: normalizeOrders(box.items.filter((_, at) => at !== index)) };
}

/** Move one item within the box; both positions are clamped to the box. */
export function moveBoxItem(box: DraftBox, from: number, to: number): DraftBox {
  if (from < 0 || from >= box.items.length) return box;
  const target = Math.max(0, Math.min(to, box.items.length - 1));
  if (target === from) return box;
  const items = [...box.items];
  const [moved] = items.splice(from, 1);
  items.splice(target, 0, moved);
  return { ...box, items: normalizeOrders(items) };
}

/** Read a top-level draft field as rendered by the Settings tab. */
export function draftValue(draft: MarathonDraftShape, path: string): unknown {
  return draft[path];
}

/** Copy the draft with one top-level field replaced. */
export function withDraftValue(
  draft: MarathonDraftShape,
  path: string,
  value: unknown,
): MarathonDraftShape {
  return { ...draft, [path]: value };
}

/**
 * Issues whose path is exactly `path` or below it. The marathon plugin reports
 * coarse paths (`boxGachas`, `npcRosters`, `schedule.startsAt`), so callers use
 * one prefix per tab or field.
 */
export function issuesFor(issues: readonly ValidationIssue[], path: string): ValidationIssue[] {
  return issues.filter(
    (issue) => issue.path === path || issue.path.startsWith(`${path}.`),
  );
}

/** Group issues by their authored path, preserving the server's order. */
export function groupIssuesByPath(
  issues: readonly ValidationIssue[],
): { path: string; issues: ValidationIssue[] }[] {
  const groups = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    const group = groups.get(issue.path);
    if (group === undefined) groups.set(issue.path, [issue]);
    else group.push(issue);
  }
  return [...groups.entries()].map(([path, grouped]) => ({ path, issues: grouped }));
}

/** The first error message at a path, for inline field display. */
export function errorAt(issues: readonly ValidationIssue[], path: string): string | null {
  const issue = issues.find(
    (candidate) =>
      candidate.severity === 'error' &&
      (candidate.path === path || candidate.path.startsWith(`${path}.`)),
  );
  return issue === undefined ? null : issue.message;
}

/**
 * Render an ISO-8601 UTC timestamp as the value of a `datetime-local` input,
 * always including seconds. The editor labels these inputs UTC, so no implicit
 * local-time conversion.
 */
export function toDatetimeLocal(value: string | undefined): string {
  if (typeof value !== 'string') return '';
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?/.exec(value);
  if (match === null) return '';
  return `${match[1]}:${match[2] ?? '00'}`;
}

/** The two accepted `datetime-local` spellings, with seconds optional. */
const DATETIME_LOCAL_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

/**
 * Turn a `datetime-local` value into the ISO-8601 UTC string the API wants.
 * Returns null for an empty, partial or otherwise malformed value so callers
 * can report a field error instead of sending a bogus timestamp.
 */
export function fromDatetimeLocal(value: string): string | null {
  if (!DATETIME_LOCAL_PATTERN.test(value)) return null;
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  return `${withSeconds}.000Z`;
}
