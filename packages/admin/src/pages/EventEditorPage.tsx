import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, del, get, post, put } from '../api.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { ErrorBanner } from '../components/ErrorBanner.tsx';
import { JsonDraftEditor } from '../components/JsonDraftEditor.tsx';
import { MarathonIdBrowser } from '../components/MarathonIdBrowser.tsx';
import { ItemNameHint, LiveBonusGroupSummary, RewardSummary } from '../components/ResourceBadge.tsx';
import { ResourceLookupPicker } from '../components/ResourceLookupPicker.tsx';
import {
  addBoxItem,
  draftFromUnknown,
  draftSavePayload,
  errorAt,
  fromDatetimeLocal,
  groupIssuesByPath,
  moveBoxItem,
  removeBoxItem,
  storedNpcRosters,
  toDatetimeLocal,
  withDraftValue,
  type DraftBox,
  type DraftBoxItem,
  type DraftNpcRoster,
  type MarathonDraftShape,
  type StoredNpcRosters,
} from '../draft.ts';
import { boxHasInfiniteItems, boxRateBudget, formatRate, impliedItemRate } from '../boxRates.ts';
import { MOSHIKOI_TABS, MoshikoiTabContent, isMoshikoiTab } from './moshikoi/MoshikoiEditor.tsx';
import { RaceBoardTab } from './race/RaceBoardTab.tsx';
import { RaceSettingsTab } from './race/RaceSettingsTab.tsx';
import { asEditorDraft, asMoshikoiDraft, moshikoiDraftFromUnknown } from './moshikoi/moshikoi.ts';
import { roleAtLeast } from '../role.ts';
import { navigate } from '../router.ts';
import { takePublishNotice } from '../publishNotice.ts';
import type {
  AdminSessionUser,
  DraftValidation,
  EventDetail,
  EventScheduleRow,
  EventSummary,
  LookupItem,
  LookupLiveBonusGroup,
  LookupMarathon,
  LookupQuest,
  LookupReward,
  RosterSummary,
  SaveDraftResponse,
  ValidationIssue,
} from '../types.ts';

/**
 * Tabs the editor can show. The marathon kinds use the first four; a moshikoi
 * love event swaps stages/boxes for its own documents (see MOSHIKOI_TABS).
 */
type Tab =
  | 'settings'
  | 'board'
  | 'schedule'
  | 'stages'
  | 'boxes'
  | 'catalog'
  | 'routes'
  | 'endings'
  | 'json';

/** What the open in-page confirmation will do once confirmed. */
type PendingConfirm =
  | { kind: 'leave' }
  | { kind: 'navigate'; hash: string }
  | { kind: 'publish' }
  | { kind: 'delete-box'; boxId: string };

/** Copy for the in-page confirmation of a pending action. */
function pendingConfirmText(pending: PendingConfirm): {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
} {
  switch (pending.kind) {
    case 'leave':
    case 'navigate':
      return {
        title: 'Discard unsaved changes?',
        message: 'Edits on this event have not been saved and will be lost.',
        confirmLabel: 'Discard',
        danger: true,
      };
    case 'publish':
      return {
        title: 'Save changes before publishing?',
        message:
          'The publish preview is computed from the saved draft, so your edits are saved first.',
        confirmLabel: 'Save and continue',
        danger: false,
      };
    case 'delete-box':
      return {
        title: `Delete box "${pending.boxId}"?`,
        message: 'Its items are removed with the box. This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
      };
  }
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'settings', label: 'Settings' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'stages', label: 'Stages' },
  { id: 'boxes', label: 'Boxes' },
];

interface ScheduleDraftRow {
  startsAt: string;
  endsAt: string;
  exchangeEndsAt: string;
  enabled: boolean;
}

/** Kinds the create form can request; `moshikoi` love events are permanent. */
type EventCreateKind = 'marathon' | 'moshikoi' | 'race';

/** Server errors carry `{ errors: string[] }` on validation failures. */
function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body;
    if (body && typeof body === 'object') {
      const errors = (body as { errors?: unknown }).errors;
      if (Array.isArray(errors) && errors.length > 0) {
        return errors.map((entry) => String(entry)).join('; ');
      }
      const message = (body as { error?: unknown }).error;
      if (typeof message === 'string' && message !== '') return message;
    }
    return `request failed (${error.status})`;
  }
  return error instanceof Error ? error.message : String(error);
}

function scheduleRowsOf(rows: EventScheduleRow[]): ScheduleDraftRow[] {
  return rows.map((row) => ({
    startsAt: toDatetimeLocal(row.startsAt),
    endsAt: toDatetimeLocal(row.endsAt),
    exchangeEndsAt: toDatetimeLocal(row.exchangeEndsAt),
    enabled: row.enabled,
  }));
}

function valueOf(record: unknown, key: string): unknown {
  return record !== null && typeof record === 'object' && !Array.isArray(record)
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

function rosterIdOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const rosterId = valueOf(value, 'rosterId');
  return typeof rosterId === 'string' ? rosterId : '';
}

function levelOffsetOf(value: unknown): string {
  const offset = valueOf(value, 'levelOffset');
  return typeof offset === 'number' ? String(offset) : '';
}

function fixedLevelOf(value: unknown): string {
  const level = valueOf(value, 'fixedLevel');
  return typeof level === 'number' ? String(level) : '';
}

/** Which level rule a stage assignment carries; none keeps a plain roster key. */
type StageMode = 'none' | 'fixed' | 'offset';

function stageModeOf(value: unknown): StageMode {
  if (typeof valueOf(value, 'fixedLevel') === 'number') return 'fixed';
  if (typeof valueOf(value, 'levelOffset') === 'number') return 'offset';
  return 'none';
}

function stageLevelOf(value: unknown, mode: StageMode): string {
  if (mode === 'fixed') return fixedLevelOf(value);
  if (mode === 'offset') return levelOffsetOf(value);
  return '';
}

/**
 * Rebuild one stage value for the selected mode. Exactly one spelling is
 * written: a plain roster key, a fixed level, or a level offset.
 */
function stageAssignment(rosterId: string, mode: StageMode, level: string): DraftNpcRoster {
  if (mode === 'fixed') return { rosterId, fixedLevel: level === '' ? 0 : Number(level) };
  if (mode === 'offset') return { rosterId, levelOffset: level === '' ? 0 : Number(level) };
  return rosterId;
}

/** Raw text of a numeric input; null means "not a number yet". */
function parseNumberText(raw: string): number | null {
  if (raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** The lookup routes accept at most 200 ids per request. */
const LOOKUP_BATCH_SIZE = 200;
const LOOKUP_DEBOUNCE_MS = 250;

/** Resolved rows keyed by the exact id list they were fetched for. */
interface LookupRows<T> {
  key: string;
  rows: Record<string, T>;
}

async function fetchRewardLookups(ids: string[]): Promise<LookupReward[]> {
  const requests: Promise<LookupReward[]>[] = [];
  for (let start = 0; start < ids.length; start += LOOKUP_BATCH_SIZE) {
    const batch = ids.slice(start, start + LOOKUP_BATCH_SIZE);
    requests.push(get<LookupReward[]>(`/lookup/rewards?ids=${encodeURIComponent(batch.join(','))}`));
  }
  return (await Promise.all(requests)).flat();
}

async function fetchLiveBonusGroupLookups(ids: string[]): Promise<LookupLiveBonusGroup[]> {
  const requests: Promise<LookupLiveBonusGroup[]>[] = [];
  for (let start = 0; start < ids.length; start += LOOKUP_BATCH_SIZE) {
    const batch = ids.slice(start, start + LOOKUP_BATCH_SIZE);
    requests.push(
      get<LookupLiveBonusGroup[]>(
        `/lookup/live-bonus-groups?ids=${encodeURIComponent(batch.join(','))}`,
      ),
    );
  }
  return (await Promise.all(requests)).flat();
}

export function EventEditorPage({ id, user }: { id: string; user: AdminSessionUser }) {
  const canEdit = roleAtLeast(user.role, 'editor');
  const canPublish = roleAtLeast(user.role, 'publisher');
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [draft, setDraft] = useState<MarathonDraftShape | null>(null);
  const [savedJson, setSavedJson] = useState('');
  const [tab, setTab] = useState<Tab>('settings');
  /** Parse error in a race draft's JSON editor; a save is blocked while set. */
  const [raceJsonError, setRaceJsonError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [scheduleRows, setScheduleRows] = useState<ScheduleDraftRow[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quests, setQuests] = useState<LookupQuest[]>([]);
  const [rosters, setRosters] = useState<RosterSummary[]>([]);
  const [stagesLoaded, setStagesLoaded] = useState(false);
  const [scheduleErrors, setScheduleErrors] = useState<(string | null)[]>([]);
  const [numberText, setNumberText] = useState<Record<string, string>>({});
  const [numberErrors, setNumberErrors] = useState<Record<string, string>>({});
  /** In-progress text for the Boxes-tab infinite rate input; null follows the draft. */
  const [boxRateText, setBoxRateText] = useState<string | null>(null);
  const [boxRateError, setBoxRateError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** The pending "are you sure?" action rendered as an in-page dialog. */
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const allowNavigation = useRef(false);
  /** The stored npcRosters value, so an untouched table is never rewritten as {}. */
  const storedRosters = useRef<StoredNpcRosters>({ present: false, value: undefined });
  /** Set by any stage-table edit; only then is `npcRosters` authored on save. */
  const stagesEdited = useRef(false);
  const deletingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setDraft(null);
    setIssues([]);
    setError(null);
    setMessage(null);
    setWarnings([]);
    setScheduleErrors([]);
    setNumberText({});
    setNumberErrors({});
    setBoxRateText(null);
    setBoxRateError(null);
    setRaceJsonError(null);
    setDeleteOpen(false);
    setDeleteText('');
    setDeleteError(null);
    setPendingConfirm(null);
    allowNavigation.current = false;
    get<EventDetail>(`/events/${encodeURIComponent(id)}`)
      .then((next) => {
        if (cancelled) return;
        const publishNotice = takePublishNotice(id);
        if (publishNotice !== null) {
          setMessage(`Published version ${publishNotice.version}.`);
          setWarnings(
            publishNotice.warnings.map((issue) =>
              issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`,
            ),
          );
        }
        // A moshikoi draft is two verbatim documents; the marathon reader would
        // add every field it owns (boxes, rosters, stamina) and a save would
        // write those back. Read it as-is instead. A race draft is read the same
        // way, so saving it never writes back fields the race kind does not own.
        const parsed =
          next.kind === 'moshikoi'
            ? asEditorDraft(moshikoiDraftFromUnknown(next.draft))
            : next.kind === 'race'
              ? (next.draft as unknown as MarathonDraftShape)
              : draftFromUnknown(next.draft);
        setDetail(next);
        // A permanent kind has no schedule tab; never leave it selected.
        // A race draft has no stage or box tabs, so it also opens on Settings.
        if (next.lifecycle === 'permanent' || next.kind === 'moshikoi' || next.kind === 'race') {
          setTab('settings');
        }
        setDraft(parsed);
        setSavedJson(JSON.stringify(parsed));
        storedRosters.current =
          next.kind === 'race' ? { present: false, value: undefined } : storedNpcRosters(next.draft);
        stagesEdited.current = false;
        setScheduleRows(scheduleRowsOf(next.schedule));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (tab !== 'stages' || stagesLoaded) return;
    let cancelled = false;
    Promise.all([
      get<LookupQuest[]>(`/lookup/quests?eventId=${encodeURIComponent(id)}`),
      get<RosterSummary[]>('/rosters'),
    ])
      .then(([nextQuests, nextRosters]) => {
        if (cancelled) return;
        setQuests(nextQuests);
        setRosters(nextRosters);
        setStagesLoaded(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [tab, stagesLoaded, id]);

  useEffect(() => {
    // A race's Settings form uses the same roster list the marathon Stages tab
    // does (the versus NPC picker), so load it as soon as a race is open.
    if (detail?.kind !== 'race' || stagesLoaded) return;
    let cancelled = false;
    get<RosterSummary[]>('/rosters')
      .then((nextRosters) => {
        if (cancelled) return;
        setRosters(nextRosters);
        setStagesLoaded(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [detail?.kind, stagesLoaded]);

  const dirty = draft !== null && JSON.stringify(draft) !== savedJson;
  /** True while a rate input holds text the draft cannot accept. */
  const invalidRatePending =
    boxRateError !== null || Object.keys(numberErrors).some((key) => key.startsWith('rate:'));
  const schema = detail?.schema ?? null;

  /** Leave the editor, asking first when there are unsaved changes. */
  function leaveEditor(): void {
    if (dirty) {
      setPendingConfirm({ kind: 'leave' });
      return;
    }
    allowNavigation.current = true;
    navigate('/events');
  }

  // Any hash change away from a dirty editor asks before discarding; the hash
  // is restored right away and the confirmed navigation runs afterwards.
  useEffect(() => {
    if (!dirty) return;
    const editorHash = window.location.hash;
    const onHashChange = () => {
      if (allowNavigation.current) {
        allowNavigation.current = false;
        return;
      }
      if (window.location.hash === editorHash) return;
      const target = window.location.hash;
      // Cancel the navigation now; the dialog decides whether to redo it.
      window.location.hash = editorHash;
      setPendingConfirm((pending) => pending ?? { kind: 'navigate', hash: target });
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [dirty]);

  // Browsers show their own prompt, but only when returnValue is set.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const settingsFields = useMemo(
    () => (schema === null ? [] : schema.fields.filter((field) => field.type !== 'object' && field.type !== 'array')),
    [schema],
  );

  const [rewardLookups, setRewardLookups] = useState<LookupRows<LookupReward> | null>(null);
  const [liveBonusLookups, setLiveBonusLookups] = useState<LookupRows<LookupLiveBonusGroup> | null>(
    null,
  );
  const [lookupItems, setLookupItems] = useState<LookupItem[] | null>(null);

  /** Every reward id and live-bonus group id authored in any box. */
  const boxLookupIds = useMemo(() => {
    const rewards = new Set<string>();
    const groups = new Set<string>();
    if (draft !== null) {
      for (const box of Object.values(draft.boxGachas ?? {})) {
        for (const item of box.items) {
          if (item.itemType === 2) {
            if (item.liveBonusGroupId !== undefined && item.liveBonusGroupId !== '') {
              groups.add(item.liveBonusGroupId);
            }
          } else if (item.rewardId !== undefined && item.rewardId !== '') {
            rewards.add(item.rewardId);
          }
        }
      }
    }
    return { rewards: [...rewards].sort(), groups: [...groups].sort() };
  }, [draft]);
  const rewardIdsKey = boxLookupIds.rewards.join('\n');
  const liveBonusGroupIdsKey = boxLookupIds.groups.join('\n');

  // One batched request per tab load/id change, re-run after a short debounce so
  // typing an id does not fire a request per keystroke.
  useEffect(() => {
    if (tab !== 'boxes' || rewardIdsKey === '') {
      setRewardLookups(null);
      return;
    }
    const ids = rewardIdsKey.split('\n');
    let cancelled = false;
    const timer = setTimeout(() => {
      void fetchRewardLookups(ids)
        .then((rows) => {
          if (cancelled) return;
          setRewardLookups({
            key: rewardIdsKey,
            rows: Object.fromEntries(rows.map((row) => [row.id, row])),
          });
        })
        .catch(() => {
          // Keep the previous rows on display; the guard below already keeps
          // them from being read as the current batch.
        });
    }, LOOKUP_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tab, rewardIdsKey]);

  useEffect(() => {
    if (tab !== 'boxes' || liveBonusGroupIdsKey === '') {
      setLiveBonusLookups(null);
      return;
    }
    const ids = liveBonusGroupIdsKey.split('\n');
    let cancelled = false;
    const timer = setTimeout(() => {
      void fetchLiveBonusGroupLookups(ids)
        .then((groups) => {
          if (cancelled) return;
          setLiveBonusLookups({
            key: liveBonusGroupIdsKey,
            rows: Object.fromEntries(groups.map((group) => [group.groupId, group])),
          });
        })
        .catch(() => {
          // Keep the previous groups on display (see the reward effect above).
        });
    }, LOOKUP_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tab, liveBonusGroupIdsKey]);

  /** The two settings item ids, but only when the schema actually shows them. */
  const settingsItemIdsKey = useMemo(() => {
    if (draft === null) return '';
    const shown = new Set(settingsFields.map((field) => field.path));
    const ids = new Set<string>();
    for (const path of ['staminaRecoveryItemId', 'questUnlockItemId']) {
      if (!shown.has(path)) continue;
      const value = draft[path];
      if (typeof value === 'string' && value !== '') ids.add(value);
    }
    return [...ids].join('\n');
  }, [draft, settingsFields]);

  useEffect(() => {
    if (tab !== 'settings' || settingsItemIdsKey === '' || lookupItems !== null) return;
    let cancelled = false;
    get<LookupItem[]>('/lookup/items')
      .then((items) => {
        if (!cancelled) setLookupItems(items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tab, settingsItemIdsKey, lookupItems]);

  function changeDraft(next: MarathonDraftShape): void {
    setDraft(next);
    setMessage(null);
  }

  function changeBox(boxId: string, next: unknown): void {
    if (draft === null) return;
    const boxGachas = { ...draft.boxGachas };
    if (next === null) delete boxGachas[boxId];
    else boxGachas[boxId] = next as DraftBox;
    changeDraft(withDraftValue(draft, 'boxGachas', boxGachas));
  }

  function changeItem(
    boxId: string,
    index: number,
    patch: Partial<DraftBoxItem>,
  ): void {
    if (draft === null) return;
    const box = draft.boxGachas[boxId];
    if (box === undefined) return;
    const items = box.items.map((item, at) => (at === index ? { ...item, ...patch } : item));
    changeBox(boxId, { ...box, items });
  }

  /** The pending-text key for one item's rate input. */
  function rateKeyFor(boxId: string, itemKey: string): string {
    return `rate:${boxId}|${itemKey}`;
  }

  /** Drop both the pending text and any error for one numeric input. */
  function clearPendingNumber(key: string): void {
    setNumberText((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setNumberErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  /** Replace or delete one item's authored rate, leaving every other field alone. */
  function setItemRate(boxId: string, index: number, rate: number | undefined): void {
    if (draft === null) return;
    const box = draft.boxGachas[boxId];
    if (box === undefined) return;
    const items = box.items.map((item, at) => {
      if (at !== index) return item;
      if (rate === undefined) {
        const next = { ...item };
        delete next.rate;
        return next;
      }
      return { ...item, rate };
    });
    changeBox(boxId, { ...box, items });
  }

  /** Rate input edits: an empty value drops the rate; invalid text stays unsaved. */
  function changeRate(boxId: string, index: number, raw: string): void {
    const box = draft?.boxGachas[boxId];
    if (box === undefined) return;
    const itemKey = box.items[index]?.itemKey ?? '';
    const key = rateKeyFor(boxId, itemKey);
    if (raw.trim() === '') {
      clearPendingNumber(key);
      setItemRate(boxId, index, undefined);
      return;
    }
    setNumberText((prev) => ({ ...prev, [key]: raw }));
    const parsed = parseNumberText(raw);
    if (parsed === null || parsed <= 0 || parsed > 1) {
      setNumberErrors((prev) => ({
        ...prev,
        [key]: 'Enter a rate between 0 (exclusive) and 1.',
      }));
      return;
    }
    setNumberErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setItemRate(boxId, index, parsed);
  }

  /** Toggle Limited; unchecking drops the rate, which is limited-only. */
  function setItemLimited(boxId: string, index: number, limited: boolean): void {
    const box = draft?.boxGachas[boxId];
    if (box === undefined) return;
    if (!limited) {
      const itemKey = box.items[index]?.itemKey ?? '';
      clearPendingNumber(rateKeyFor(boxId, itemKey));
      const items = box.items.map((item, at) => {
        if (at !== index) return item;
        const next = { ...item, isLimited: false };
        delete next.rate;
        return next;
      });
      changeBox(boxId, { ...box, items });
      return;
    }
    changeItem(boxId, index, { isLimited: true });
  }

  /** The Boxes-tab infinite rate input writes the same draft field as Settings. */
  function changeBoxInfiniteRate(raw: string): void {
    if (draft === null) return;
    if (raw.trim() === '') {
      setBoxRateText(null);
      setBoxRateError(null);
      const next = { ...draft };
      delete next.boxInfiniteRate;
      changeDraft(next);
      return;
    }
    setBoxRateText(raw);
    const parsed = parseNumberText(raw);
    if (parsed === null || parsed < 0 || parsed > 1) {
      setBoxRateError('Enter a number from 0 to 1.');
      return;
    }
    setBoxRateError(null);
    changeDraft(withDraftValue(draft, 'boxInfiniteRate', parsed));
  }

  function numberKeyForField(path: string): string {
    return `settings:${path}`;
  }

  function numberKeyForStock(boxId: string, itemKey: string): string {
    return `stock:${boxId}|${itemKey}`;
  }

  /** The text a numeric input shows: the in-progress raw string or the draft value. */
  function displayedNumber(key: string, value: unknown): string {
    if (key in numberText) return numberText[key] as string;
    return typeof value === 'number' ? String(value) : '';
  }

  function changeNumberText(key: string, raw: string): void {
    setNumberText((prev) => ({ ...prev, [key]: raw }));
    setNumberErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function blurNumber(key: string, raw: string, apply: (value: number) => void): void {
    if (raw.trim() === '') {
      // Keep the empty text so Save can refuse it instead of storing 0.
      setNumberText((prev) => ({ ...prev, [key]: raw }));
      return;
    }
    const parsed = parseNumberText(raw);
    if (parsed === null) {
      setNumberErrors((prev) => ({ ...prev, [key]: 'Enter a number.' }));
      return;
    }
    apply(parsed);
    setNumberText((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setNumberErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  /** Merge pending numeric text into the draft, or report which inputs are empty. */
  function withPendingNumbers(source: MarathonDraftShape): {
    draft: MarathonDraftShape;
    errors: Record<string, string>;
  } {
    const errors: Record<string, string> = {};
    let next = source;
    for (const [key, raw] of Object.entries(numberText)) {
      const parsed = parseNumberText(raw);
      if (parsed === null) {
        errors[key] = 'Enter a number.';
        continue;
      }
      if (key.startsWith('settings:')) {
        next = withDraftValue(next, key.slice('settings:'.length), parsed);
        continue;
      }
      if (key.startsWith('stock:')) {
        const payload = key.slice('stock:'.length);
        const separator = payload.indexOf('|');
        const boxId = payload.slice(0, separator);
        const itemKey = payload.slice(separator + 1);
        const box = next.boxGachas[boxId];
        if (box === undefined) continue;
        next = {
          ...next,
          boxGachas: {
            ...next.boxGachas,
            [boxId]: {
              ...box,
              items: box.items.map((item) =>
                item.itemKey === itemKey ? { ...item, initialStock: parsed } : item,
              ),
            },
          },
        };
      }
    }
    return { draft: next, errors };
  }

  async function handleSave(): Promise<boolean> {
    if (draft === null || !canEdit) return false;
    if (invalidRatePending || raceJsonError !== null) return false;
    // A race draft is saved exactly as the JSON editor left it: no marathon
    // number merge and no npcRosters handling.
    const isRace = detail?.kind === 'race';
    const prepared = isRace
      ? { draft, errors: {} as Record<string, string> }
      : withPendingNumbers(draft);
    if (Object.keys(prepared.errors).length > 0) {
      setNumberErrors(prepared.errors);
      setMessage(null);
      return false;
    }
    setDraft(prepared.draft);
    setNumberText({});
    setNumberErrors({});
    setBusy(true);
    setError(null);
    setMessage(null);
    // Preserve the stored table until a stage is edited; see draftSavePayload.
    const payload = isRace
      ? prepared.draft
      : draftSavePayload(prepared.draft, storedRosters.current, stagesEdited.current);
    try {
      const result = await put<SaveDraftResponse>(`/events/${encodeURIComponent(id)}/draft`, {
        draft: payload,
      });
      setIssues(result.validation.errors);
      setSavedJson(JSON.stringify(prepared.draft));
      storedRosters.current = storedNpcRosters(payload);
      stagesEdited.current = false;
      setMessage(
        result.validation.ok
          ? 'Draft saved.'
          : `Draft saved with ${result.validation.errors.length} issue(s).`,
      );
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Open the publish screen. Unsaved edits must be saved first: the publish
   * preview is computed from the server's stored draft, not from local state.
   */
  async function handlePublishClick(): Promise<void> {
    if (!canPublish) return;
    if (dirty) {
      setPendingConfirm({ kind: 'publish' });
      return;
    }
    allowNavigation.current = true;
    navigate(`/events/${encodeURIComponent(id)}/publish`);
  }

  /** Run the action of the open confirmation dialog. */
  async function confirmPending(): Promise<void> {
    const pending = pendingConfirm;
    if (pending === null) return;
    setPendingConfirm(null);
    switch (pending.kind) {
      case 'leave':
        allowNavigation.current = true;
        navigate('/events');
        return;
      case 'navigate':
        allowNavigation.current = true;
        window.location.hash = pending.hash;
        return;
      case 'delete-box':
        changeBox(pending.boxId, null);
        return;
      case 'publish':
        if (!(await handleSave())) return;
        allowNavigation.current = true;
        navigate(`/events/${encodeURIComponent(id)}/publish`);
        return;
    }
  }

  async function handleValidate(): Promise<void> {
    if (draft === null || !canEdit) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await post<DraftValidation>(`/events/${encodeURIComponent(id)}/validate`, {
        draft,
      });
      setIssues(result.errors);
      setMessage(result.ok ? 'Validation passed.' : `Found ${result.errors.length} issue(s).`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  /** Validate every row locally; no row may be sent with a bad or missing time. */
  function validateScheduleRows(rows: ScheduleDraftRow[]): {
    errors: (string | null)[];
    payload: { startsAt: string; endsAt: string; exchangeEndsAt: string; enabled: boolean }[];
  } {
    const errors: (string | null)[] = [];
    const payload: { startsAt: string; endsAt: string; exchangeEndsAt: string; enabled: boolean }[] =
      [];
    for (const row of rows) {
      const startsAt = fromDatetimeLocal(row.startsAt);
      const endsAt = fromDatetimeLocal(row.endsAt);
      const exchangeEndsAt = fromDatetimeLocal(row.exchangeEndsAt);
      if (startsAt === null || endsAt === null || exchangeEndsAt === null) {
        errors.push('All three times are required.');
        continue;
      }
      if (!(startsAt < endsAt)) {
        errors.push('Starts must be before ends.');
        continue;
      }
      if (!(endsAt <= exchangeEndsAt)) {
        errors.push('Ends must not be after exchange ends.');
        continue;
      }
      errors.push(null);
      payload.push({ startsAt, endsAt, exchangeEndsAt, enabled: row.enabled });
    }
    return { errors, payload };
  }

  async function handleSaveSchedule(): Promise<void> {
    if (!canPublish) return;
    // Permanent kinds have no schedule rows; the server rejects a PUT with 400.
    if (detail?.lifecycle === 'permanent') return;
    const checked = validateScheduleRows(scheduleRows);
    setScheduleErrors(checked.errors);
    if (checked.errors.some((entry) => entry !== null)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await put<{ schedule: EventScheduleRow[]; warnings: string[] }>(
        `/events/${encodeURIComponent(id)}/schedule`,
        { schedules: checked.payload },
      );
      setScheduleRows(scheduleRowsOf(result.schedule));
      setScheduleErrors([]);
      setWarnings(result.warnings);
      setMessage('Schedule saved.');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!canPublish || deleteText !== id || deletingRef.current) return;
    deletingRef.current = true;
    setBusy(true);
    setDeleteError(null);
    try {
      await del(`/events/${encodeURIComponent(id)}`);
      allowNavigation.current = true;
      navigate('/events');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setDeleteError(describeError(err));
      } else {
        setDeleteOpen(false);
        setError(describeError(err));
      }
    } finally {
      deletingRef.current = false;
      setBusy(false);
    }
  }

  if (error !== null && detail === null) {
    return (
      <section>
        <button type="button" className="link-button" onClick={() => leaveEditor()}>
          ← Events
        </button>
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      </section>
    );
  }

  if (detail === null || draft === null) return <p className="loading">Loading event…</p>;

  /** Permanent kinds (e.g. moshikoi) never have schedule rows. */
  const permanent = detail.lifecycle === 'permanent';
  /**
   * A moshikoi love event stores catalog/routes documents instead of marathon
   * stages and boxes, so those tabs are not shown at all.
   */
  const moshikoi = detail.kind === 'moshikoi';
  /** A race draft has no marathon stages or boxes; it keeps its own tabs. */
  const race = detail.kind === 'race';
  const tabs: { id: Tab; label: string }[] = moshikoi
    ? [{ id: 'settings', label: 'Settings' }, ...MOSHIKOI_TABS]
    : race
      ? [
          { id: 'settings', label: 'Settings' },
          { id: 'board', label: 'Board' },
          ...(permanent ? [] : [{ id: 'schedule' as Tab, label: 'Schedule' }]),
          { id: 'json', label: 'JSON' },
        ]
      : TABS.filter(
          (entry) =>
            (!race || (entry.id !== 'stages' && entry.id !== 'boxes')) &&
            (!permanent || entry.id !== 'schedule'),
        );

  const confirmCopy = pendingConfirm === null ? null : pendingConfirmText(pendingConfirm);

  // A lookup only applies to the exact id set it was fetched for; anything else
  // is still resolving (never a false "unknown id"). Rows from the previous
  // batch stay available per id so an unchanged id keeps its badge instead of
  // flickering to null while the new batch loads.
  const rewardRows =
    rewardLookups !== null && rewardLookups.key === rewardIdsKey ? rewardLookups.rows : null;
  const previousRewardRows =
    rewardLookups !== null && rewardLookups.key !== rewardIdsKey ? rewardLookups.rows : null;
  const liveBonusRows =
    liveBonusLookups !== null && liveBonusLookups.key === liveBonusGroupIdsKey
      ? liveBonusLookups.rows
      : null;
  const previousLiveBonusRows =
    liveBonusLookups !== null && liveBonusLookups.key !== liveBonusGroupIdsKey
      ? liveBonusLookups.rows
      : null;

  const stageQuests = [...quests];
  for (const questId of Object.keys(draft.npcRosters ?? {})) {
    if (!stageQuests.some((quest) => quest.id === questId)) {
      stageQuests.push({ id: questId, name: null, nameEn: null, order: null });
    }
  }

  return (
    <section className="editor">
      <div className="editor-head">
        <button type="button" className="link-button" onClick={() => leaveEditor()}>
          ← Events
        </button>
        <h2>
          {detail.titleEn ?? detail.title} <code>{detail.id}</code>
        </h2>
        {detail.titleEn == null ? null : <div className="muted">{detail.title}</div>}
        <span className="muted">
          {detail.kind} · published v{detail.publishedVersion}
          {dirty ? ' · unsaved changes' : ''}
        </span>
        <div className="editor-actions">
          <button type="button" disabled={!canEdit || busy} onClick={() => void handleValidate()}>
            Validate
          </button>
          <button
            type="button"
            disabled={!canEdit || busy || !dirty || invalidRatePending || raceJsonError !== null}
            onClick={() => void handleSave()}
          >
            Save draft
          </button>
          {invalidRatePending ? (
            <span className="field-error">Fix invalid rates before saving</span>
          ) : null}
          {raceJsonError === null ? null : (
            <span className="field-error">Fix the draft JSON before saving</span>
          )}
          <button
            type="button"
            disabled={!canPublish || busy || invalidRatePending}
            title={canPublish ? 'Review impacts and publish' : 'Requires the publisher role'}
            onClick={() => void handlePublishClick()}
          >
            Publish…
          </button>
          {canPublish ? (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                setDeleteText('');
                setDeleteError(null);
                setDeleteOpen(true);
              }}
            >
              Delete event
            </button>
          ) : null}
        </div>
      </div>

      {deleteOpen ? (
        <div
          className="dialog"
          role="alertdialog"
          aria-modal="true"
          aria-label="Delete event"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setDeleteOpen(false);
            }
          }}
        >
          <h3>
            Delete event <code>{id}</code>?
          </h3>
          <p>
            This removes its draft, published versions and schedule. Player progress is kept. This
            cannot be undone.
          </p>
          <label className="field" htmlFor="delete-event-id">
            Type the event id to confirm
            <input
              id="delete-event-id"
              type="text"
              autoFocus
              value={deleteText}
              onChange={(event) => setDeleteText(event.target.value)}
            />
          </label>
          {deleteError === null ? null : <p className="error">{deleteError}</p>}
          <div className="row-actions">
            <button
              type="button"
              className="danger"
              disabled={deleteText !== id || busy}
              onClick={() => void handleDelete()}
            >
              Delete
            </button>
            <button type="button" disabled={busy} onClick={() => setDeleteOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {confirmCopy === null ? null : (
        <ConfirmDialog
          open
          title={confirmCopy.title}
          message={confirmCopy.message}
          confirmLabel={confirmCopy.confirmLabel}
          danger={confirmCopy.danger}
          busy={busy}
          onConfirm={() => void confirmPending()}
          onCancel={() => setPendingConfirm(null)}
        />
      )}

      {error === null ? null : <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {message === null ? null : <p className="notice">{message}</p>}
      {warnings.map((warning) => (
        <p className="warning" key={warning}>
          {warning}
        </p>
      ))}

      <div className="tabs-row">
        <div className="tabs" role="tablist">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={tab === entry.id ? 'tab active' : 'tab'}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {/* Live ops only has player state once a race version exists. */}
        {race && detail.publishedVersion > 0 ? (
          <a className="tab-link" href={`#/events/${encodeURIComponent(id)}/players`}>
            Players (live ops)
          </a>
        ) : null}
      </div>

      {permanent ? (
        <p className="notice">
          Permanent event: no schedule. Publishing makes changes live in the Love menu.
        </p>
      ) : null}

      {issues.length > 0 ? (
        <div className="issues" role="status">
          <strong>{issues.length} issue(s)</strong>
          <ul>
            {groupIssuesByPath(issues).map((group) => (
              <li key={group.path}>
                <code>{group.path}</code>
                <ul>
                  {group.issues.map((issue) => (
                    <li key={`${issue.path}:${issue.message}`} className={issue.severity}>
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {tab === 'settings' && race ? (
        <RaceSettingsTab
          draft={draft}
          schema={schema}
          issues={issues}
          canEdit={canEdit}
          rosters={rosters}
          onChange={changeDraft}
        />
      ) : null}

      {tab === 'board' && race ? (
        <RaceBoardTab
          draft={draft}
          canEdit={canEdit}
          rosters={rosters}
          onChange={changeDraft}
        />
      ) : null}

      {tab === 'json' && race ? (
        <div className="panel">
          <p className="muted">
            The whole race draft as stored. The Settings form and this JSON view write the same
            draft; invalid JSON blocks saving until it parses again.
          </p>
          <JsonDraftEditor
            value={draft}
            disabled={!canEdit}
            onValid={(next) => changeDraft(next as MarathonDraftShape)}
            onError={setRaceJsonError}
          />
        </div>
      ) : null}

      {tab === 'settings' && !race ? (
        <div className="panel">
          <p className="muted">
            Fields the marathon plugin marks read-only are shown disabled; they change only by
            importing from master data.
          </p>
          {schema === null ? <p>This event kind has no editor schema.</p> : null}
          <div className="field-grid">
            {settingsFields.map((field) => {
              const value = draft[field.path];
              const inline = errorAt(issues, field.path);
              const readOnly = field.readOnly === true || !canEdit;
              return (
                <label key={field.path} className="field">
                  <span>{field.label ?? field.path}</span>
                  {field.type === 'boolean' ? (
                    <input
                      type="checkbox"
                      checked={value === true}
                      disabled={readOnly}
                      className={
                        field.readOnly === true
                          ? 'field-readonly'
                          : readOnly
                            ? undefined
                            : 'field-editable'
                      }
                      onChange={(event) =>
                        changeDraft(withDraftValue(draft, field.path, event.target.checked))
                      }
                    />
                  ) : (
                    <input
                      type={field.type === 'number' ? 'number' : 'text'}
                      value={
                        field.type === 'number'
                          ? displayedNumber(numberKeyForField(field.path), value)
                          : typeof value === 'number' || typeof value === 'string'
                            ? value
                            : ''
                      }
                      readOnly={readOnly}
                      disabled={readOnly}
                      className={
                        field.readOnly === true
                          ? 'field-readonly'
                          : readOnly
                            ? undefined
                            : 'field-editable'
                      }
                      onChange={(event) => {
                        const raw = event.target.value;
                        if (field.type === 'number') {
                          changeNumberText(numberKeyForField(field.path), raw);
                          return;
                        }
                        changeDraft(withDraftValue(draft, field.path, raw));
                      }}
                      onBlur={
                        field.type === 'number'
                          ? (event) =>
                              blurNumber(
                                numberKeyForField(field.path),
                                event.target.value,
                                (next) => changeDraft(withDraftValue(draft, field.path, next)),
                              )
                          : undefined
                      }
                    />
                  )}
                  {field.readOnly === true ? <span className="readonly-tag">read-only</span> : null}
                  {numberErrors[numberKeyForField(field.path)] === undefined ? null : (
                    <span className="field-error">
                      {numberErrors[numberKeyForField(field.path)]}
                    </span>
                  )}
                  {inline === null ? null : <span className="field-error">{inline}</span>}
                  {field.path === 'staminaRecoveryItemId' || field.path === 'questUnlockItemId' ? (
                    <ItemNameHint
                      id={typeof value === 'string' ? value : ''}
                      items={lookupItems}
                    />
                  ) : null}
                </label>
              );
            })}
          </div>
        </div>
      ) : null}

      {moshikoi && isMoshikoiTab(tab) ? (
        <MoshikoiTabContent
          tab={tab}
          draft={asMoshikoiDraft(draft)}
          issues={issues}
          canEdit={canEdit}
          onChange={(next) => changeDraft(asEditorDraft(next))}
        />
      ) : null}

      {tab === 'schedule' ? (
        <div className="panel">
          <p className="muted">Times are UTC. Overlapping playable windows are allowed but warned.</p>
          <table>
            <thead>
              <tr>
                <th>Starts (UTC)</th>
                <th>Ends (UTC)</th>
                <th>Exchange ends (UTC)</th>
                <th>Enabled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {scheduleRows.map((row, index) => (
                <Fragment key={index}>
                  <tr>
                    {(['startsAt', 'endsAt', 'exchangeEndsAt'] as const).map((field) => (
                      <td key={field}>
                        <input
                          type="datetime-local"
                          step="1"
                          value={row[field]}
                          disabled={!canPublish}
                          onChange={(event) => {
                            const next = [...scheduleRows];
                            next[index] = { ...row, [field]: event.target.value };
                            setScheduleRows(next);
                            setScheduleErrors((prev) => {
                              if (!(index in prev)) return prev;
                              const copy = [...prev];
                              copy[index] = null;
                              return copy;
                            });
                          }}
                        />
                      </td>
                    ))}
                    <td>
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        disabled={!canPublish}
                        onChange={(event) => {
                          const next = [...scheduleRows];
                          next[index] = { ...row, enabled: event.target.checked };
                          setScheduleRows(next);
                        }}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="danger"
                        disabled={!canPublish}
                        onClick={() => {
                          setScheduleRows(scheduleRows.filter((_, at) => at !== index));
                          setScheduleErrors([]);
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                  {scheduleErrors[index] === null || scheduleErrors[index] === undefined ? null : (
                    <tr>
                      <td colSpan={5} className="field-error">
                        {scheduleErrors[index]}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          <div className="row-actions">
            <button
              type="button"
              disabled={!canPublish}
              onClick={() => {
                setScheduleRows([
                  ...scheduleRows,
                  { startsAt: '', endsAt: '', exchangeEndsAt: '', enabled: true },
                ]);
                setScheduleErrors([]);
              }}
            >
              Add window
            </button>
            <button
              type="button"
              disabled={!canPublish || busy}
              onClick={() => void handleSaveSchedule()}
            >
              Save schedule
            </button>
            {canPublish ? null : <span className="muted">Saving a schedule requires the publisher role.</span>}
          </div>
          {errorAt(issues, 'schedule') === null ? null : (
            <p className="field-error">{errorAt(issues, 'schedule')}</p>
          )}
        </div>
      ) : null}

      {tab === 'stages' ? (
        <div className="panel">
          <p className="muted">
            Assign an existing NPC roster (and optional level offset) to each marathon quest.{' '}
            <a href="#/rosters">Manage rosters</a>
          </p>
          {stagesLoaded ? null : <p className="loading">Loading quests and rosters…</p>}
          {errorAt(issues, 'npcRosters') === null ? null : (
            <p className="field-error">{errorAt(issues, 'npcRosters')}</p>
          )}
          <table>
            <thead>
              <tr>
                <th>Quest</th>
                <th>NPC roster</th>
                <th>Level rule</th>
                <th>Level</th>
              </tr>
            </thead>
            <tbody>
              {stageQuests.map((quest) => {
                const current = draft.npcRosters[quest.id];
                const mode = stageModeOf(current);
                const rosterId = rosterIdOf(current);
                return (
                  <tr key={quest.id}>
                    <td>
                      <code>{quest.id}</code>
                      {quest.nameEn == null ? null : (
                        <div>{quest.nameEn}</div>
                      )}
                      {quest.name === null ? null : (
                        <div className={quest.nameEn == null ? undefined : 'muted'}>
                          {quest.name}
                        </div>
                      )}
                    </td>
                    <td>
                      <select
                        value={rosterId}
                        disabled={!canEdit}
                        onChange={(event) => {
                          const nextRosterId = event.target.value;
                          const npcRosters = { ...draft.npcRosters };
                          if (nextRosterId === '') delete npcRosters[quest.id];
                          else {
                            npcRosters[quest.id] = stageAssignment(
                              nextRosterId,
                              mode,
                              stageLevelOf(current, mode),
                            );
                          }
                          stagesEdited.current = true;
                          changeDraft(withDraftValue(draft, 'npcRosters', npcRosters));
                        }}
                      >
                        <option value="">— none —</option>
                        {rosters.map((roster) => (
                          <option key={roster.id} value={roster.id}>
                            {roster.id} · {roster.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={mode}
                        disabled={!canEdit || rosterId === ''}
                        onChange={(event) => {
                          if (rosterId === '') return;
                          const nextMode = event.target.value as StageMode;
                          const npcRosters = { ...draft.npcRosters };
                          npcRosters[quest.id] = stageAssignment(
                            rosterId,
                            nextMode,
                            stageLevelOf(current, mode),
                          );
                          stagesEdited.current = true;
                          changeDraft(withDraftValue(draft, 'npcRosters', npcRosters));
                        }}
                      >
                        <option value="none">none</option>
                        <option value="fixed">fixed level</option>
                        <option value="offset">level offset</option>
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        aria-label={`${quest.id} level`}
                        value={stageLevelOf(current, mode)}
                        disabled={!canEdit || rosterId === '' || mode === 'none'}
                        placeholder="0"
                        onChange={(event) => {
                          if (rosterId === '') return;
                          const npcRosters = { ...draft.npcRosters };
                          npcRosters[quest.id] = stageAssignment(rosterId, mode, event.target.value);
                          stagesEdited.current = true;
                          changeDraft(withDraftValue(draft, 'npcRosters', npcRosters));
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === 'boxes' ? (
        <div className="panel">
          <div className="box-rate-row">
            <label className="field">
              <span>Box infinite rate</span>
              <input
                type="number"
                min="0"
                max="1"
                step="0.01"
                disabled={!canEdit}
                value={
                  boxRateText ??
                  (draft.boxInfiniteRate === undefined ? '' : String(draft.boxInfiniteRate))
                }
                onChange={(event) => changeBoxInfiniteRate(event.target.value)}
                onBlur={() => {
                  if (boxRateError === null) setBoxRateText(null);
                }}
              />
            </label>
            {draft.boxInfiniteRate === undefined ? (
              <p className="muted rate-hint">Unset: each box uses its own stock ratio</p>
            ) : null}
            {boxRateError === null ? null : <p className="field-error">{boxRateError}</p>}
          </div>
          <p className="muted">
            Item keys are the stable draw identity: existing keys are read-only, and every new item
            gets a fresh random key.
          </p>
          {errorAt(issues, 'boxGachas') === null ? null : (
            <p className="field-error">{errorAt(issues, 'boxGachas')}</p>
          )}
          {Object.entries(draft.boxGachas).map(([boxId, box]) => (
            <div className="box-card" key={boxId}>
              <div className="box-head">
                <h3>
                  Box <code>{boxId}</code>
                </h3>
                <div className="row-actions">
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() => changeBox(boxId, addBoxItem(box))}
                  >
                    Add item
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={!canEdit}
                    onClick={() => {
                      setPendingConfirm({ kind: 'delete-box', boxId });
                    }}
                  >
                    Delete box
                  </button>
                </div>
              </div>
              {(() => {
                const budget = boxRateBudget(box.items, draft.boxInfiniteRate);
                const over = budget.available < -1e-9;
                const rated = box.items.some((item) => item.rate !== undefined);
                return (
                  <>
                    <p className={`rate-budget${over ? ' rate-budget-over' : ''}`}>
                      Infinite rate{' '}
                      {draft.boxInfiniteRate === undefined
                        ? `≈${formatRate(budget.pInf)} (stock ratio)`
                        : formatRate(budget.pInf)}{' '}
                      · Limited items {formatRate(budget.finiteBudget)} · Assigned{' '}
                      {formatRate(budget.assigned)} · Available {formatRate(budget.available)}
                      {over ? ` (over by ${formatRate(-budget.available)})` : ''}
                    </p>
                    {rated && boxHasInfiniteItems(box.items) ? (
                      <p className="muted rate-hint">
                        When a rated item runs out, its rate goes to the infinite items.
                      </p>
                    ) : null}
                  </>
                );
              })()}
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>itemKey</th>
                    <th>Type</th>
                    <th>Reward / live bonus</th>
                    <th>Stock</th>
                    <th>Rate</th>
                    <th>Limited</th>
                    <th>Pickup</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {box.items.map((item, index) => (
                    <tr key={item.itemKey}>
                      <td>{item.order}</td>
                      <td>
                        <code>{item.itemKey}</code>
                      </td>
                      <td>
                        <select
                          value={item.itemType}
                          disabled={!canEdit}
                          onChange={(event) =>
                            changeItem(boxId, index, { itemType: Number(event.target.value) })
                          }
                        >
                          <option value={1}>1 Reward</option>
                          <option value={2}>2 Live bonus</option>
                        </select>
                      </td>
                      <td>
                        <ResourceLookupPicker
                          kind={item.itemType === 2 ? 'live-bonus-groups' : 'rewards'}
                          value={
                            item.itemType === 2
                              ? (item.liveBonusGroupId ?? '')
                              : (item.rewardId ?? '')
                          }
                          disabled={!canEdit}
                          ariaLabel={
                            item.itemType === 2
                              ? `Live bonus group for box ${boxId} item ${item.itemKey}`
                              : `Reward for box ${boxId} item ${item.itemKey}`
                          }
                          onChange={(next) =>
                            changeItem(
                              boxId,
                              index,
                              item.itemType === 2
                                ? { liveBonusGroupId: next }
                                : { rewardId: next },
                            )
                          }
                        />
                        {item.itemType === 2
                          ? (item.liveBonusGroupId ?? '') === ''
                            ? null
                            : (
                                <LiveBonusGroupSummary
                                  group={
                                    liveBonusRows?.[item.liveBonusGroupId ?? ''] ??
                                    previousLiveBonusRows?.[item.liveBonusGroupId ?? '']
                                  }
                                  loading={liveBonusRows === null}
                                />
                              )
                          : (item.rewardId ?? '') === ''
                            ? null
                            : (
                                <RewardSummary
                                  reward={
                                    rewardRows?.[item.rewardId ?? ''] ??
                                    previousRewardRows?.[item.rewardId ?? '']
                                  }
                                  loading={rewardRows === null}
                                />
                              )}
                      </td>
                      <td>
                        <input
                          type="number"
                          value={displayedNumber(
                            numberKeyForStock(boxId, item.itemKey),
                            item.initialStock,
                          )}
                          disabled={!canEdit}
                          onChange={(event) =>
                            changeNumberText(numberKeyForStock(boxId, item.itemKey), event.target.value)
                          }
                          onBlur={(event) =>
                            blurNumber(
                              numberKeyForStock(boxId, item.itemKey),
                              event.target.value,
                              (stock) => changeItem(boxId, index, { initialStock: stock }),
                            )
                          }
                        />
                        {numberErrors[numberKeyForStock(boxId, item.itemKey)] === undefined ? null : (
                          <span className="field-error">
                            {numberErrors[numberKeyForStock(boxId, item.itemKey)]}
                          </span>
                        )}
                      </td>
                      <td>
                        {item.isLimited === true ? (
                          <>
                            <input
                              type="number"
                              min="0"
                              max="1"
                              step="0.001"
                              placeholder="by stock"
                              aria-label={`Rate for box ${boxId} item ${item.itemKey}`}
                              disabled={!canEdit}
                              value={displayedNumber(
                                rateKeyFor(boxId, item.itemKey),
                                item.rate,
                              )}
                              onChange={(event) =>
                                changeRate(boxId, index, event.target.value)
                              }
                              onBlur={() => {
                                if (numberErrors[rateKeyFor(boxId, item.itemKey)] === undefined) {
                                  clearPendingNumber(rateKeyFor(boxId, item.itemKey));
                                }
                              }}
                            />
                            {numberErrors[rateKeyFor(boxId, item.itemKey)] === undefined ? null : (
                              <span className="field-error">
                                {numberErrors[rateKeyFor(boxId, item.itemKey)]}
                              </span>
                            )}
                            {item.rate === undefined ? (
                              <span
                                className="muted rate-hint"
                                title="Estimate at full stock; it changes as stock is drawn"
                              >
                                ≈
                                {formatRate(
                                  impliedItemRate(item, box.items, draft.boxInfiniteRate),
                                )}{' '}
                                at full stock
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={item.isLimited === true}
                          disabled={!canEdit}
                          onChange={(event) =>
                            setItemLimited(boxId, index, event.target.checked)
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={item.isPickup === true}
                          disabled={!canEdit}
                          onChange={(event) =>
                            changeItem(boxId, index, { isPickup: event.target.checked })
                          }
                        />
                      </td>
                      <td className="item-actions">
                        <button
                          type="button"
                          disabled={!canEdit || index === 0}
                          onClick={() => changeBox(boxId, moveBoxItem(box, index, index - 1))}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={!canEdit || index === box.items.length - 1}
                          onClick={() => changeBox(boxId, moveBoxItem(box, index, index + 1))}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="danger"
                          disabled={!canEdit}
                          onClick={() => changeBox(boxId, removeBoxItem(box, index))}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {canEdit ? (
            <AddBox
              existing={Object.keys(draft.boxGachas)}
              onAdd={(boxId) => changeBox(boxId, { items: [] })}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function AddBox({ existing, onAdd }: { existing: string[]; onAdd: (boxId: string) => void }) {
  const [boxId, setBoxId] = useState('');
  const trimmed = boxId.trim();
  const duplicate = existing.includes(trimmed);
  return (
    <form
      className="row-actions"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed === '' || duplicate) return;
        onAdd(trimmed);
        setBoxId('');
      }}
    >
      <input
        type="text"
        value={boxId}
        placeholder="new box id"
        onChange={(event) => setBoxId(event.target.value)}
      />
      <button type="submit" disabled={trimmed === '' || duplicate}>
        Add box
      </button>
      {duplicate ? <span className="field-error">box already exists</span> : null}
    </form>
  );
}

/** Warning for a new-event id: unknown, or already claimed by an event. */
function newMarathonWarning(
  value: string,
  marathons: LookupMarathon[] | null,
): string | null {
  const id = value.trim();
  if (id === '' || marathons === null) return null;
  const match = marathons.find((marathon) => marathon.id === id);
  if (match === undefined) {
    return 'Not a marathon id in master data. The game will have no quests for it.';
  }
  return match.eventDefined ? 'An event with this id already exists.' : null;
}

/** The list screen: summaries, create (no draft) and import from master. */
export function EventListPage({ user }: { user: AdminSessionUser }) {
  const canEdit = roleAtLeast(user.role, 'editor');
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newId, setNewId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newKind, setNewKind] = useState<EventCreateKind>('marathon');
  const [importKind, setImportKind] = useState<EventCreateKind>('marathon');
  const [importId, setImportId] = useState('');
  const [busy, setBusy] = useState(false);
  const [marathons, setMarathons] = useState<LookupMarathon[] | null>(null);
  const [browseTarget, setBrowseTarget] = useState<'new' | 'import' | null>(null);
  const browseOpenerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    get<EventSummary[]>('/events')
      .then((rows) => {
        if (!cancelled) setEvents(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Master marathon ids power the id warnings. A failed load only disables the
  // warnings; it must never block creating or importing an event.
  useEffect(() => {
    if (!canEdit) return;
    let cancelled = false;
    get<LookupMarathon[]>('/lookup/marathons')
      .then((rows) => {
        if (!cancelled) setMarathons(rows);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [canEdit]);

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const detail = await post<EventDetail>('/events', {
        id: newId.trim(),
        kind: newKind,
        title: newTitle,
      });
      navigate(`/events/${encodeURIComponent(detail.id)}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleImport(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const detail = await post<EventDetail>('/events/import-from-master', {
        kind: importKind,
        eventId: importId.trim(),
      });
      navigate(`/events/${encodeURIComponent(detail.id)}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  // A moshikoi id is not a marathon id, so the master-data hint does not apply.
  const newWarning = newKind === 'marathon' ? newMarathonWarning(newId, marathons) : null;
  const importWarning = newMarathonWarning(importId, marathons);

  /** Permanent events sort after scheduled ones, then by id. */
  const sortedEvents =
    events === null
      ? null
      : [...events].sort((a, b) => {
          const lifecycle =
            (a.lifecycle === 'permanent' ? 1 : 0) - (b.lifecycle === 'permanent' ? 1 : 0);
          return lifecycle === 0 ? a.id.localeCompare(b.id) : lifecycle;
        });

  return (
    <section>
      <div className="editor-head">
        <h2>Events</h2>
        <div className="editor-actions">
          <button type="button" disabled={!canEdit} onClick={() => setCreateOpen(!createOpen)}>
            New event
          </button>
        </div>
      </div>
      {error === null ? null : <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {createOpen ? (
        <form className="inline-form" onSubmit={(event) => void handleCreate(event)}>
          <div className="field-stack">
            <label htmlFor="new-event-id">Id</label>
            <span className="resource-picker-row">
              <input
                id="new-event-id"
                type="text"
                value={newId}
                onChange={(event) => setNewId(event.target.value)}
                placeholder="marathon-2026-11"
                required
                aria-describedby={newWarning === null ? undefined : 'new-event-id-warning'}
              />
              {newKind === 'marathon' ? (
                <button
                  type="button"
                  className="resource-picker-browse"
                  aria-label="Browse new event id"
                  onClick={(event) => {
                    browseOpenerRef.current = event.currentTarget;
                    setBrowseTarget('new');
                  }}
                >
                  Browse
                </button>
              ) : null}
            </span>
            {newWarning === null ? null : (
              <span id="new-event-id-warning" className="field-warning">{newWarning}</span>
            )}
          </div>
          <label>
            Title
            <input
              type="text"
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              required
            />
          </label>
          <label>
            Kind
            <select
              value={newKind}
              onChange={(event) => setNewKind(event.target.value as EventCreateKind)}
            >
              <option value="marathon">marathon</option>
              <option value="moshikoi">moshikoi (permanent)</option>
              <option value="race">Race (レース)</option>
            </select>
          </label>
          <span className="muted">
            {newKind === 'marathon'
              ? 'The server seeds a default draft.'
              : 'A moshikoi love event is permanent: it has no schedule and is live once published.'}
          </span>
          <button type="submit" disabled={busy || newId.trim() === ''}>
            Create
          </button>
        </form>
      ) : null}

      {canEdit ? (
        <form className="inline-form" onSubmit={(event) => void handleImport(event)}>
          <div className="field-stack">
            <label htmlFor="import-event-id">Import {importKind} event id</label>
            <span className="resource-picker-row">
              <input
                id="import-event-id"
                type="text"
                value={importId}
                onChange={(event) => setImportId(event.target.value)}
                placeholder="event id in master data"
                required
                aria-describedby={importWarning === null ? undefined : 'import-event-id-warning'}
              />
              <button
                type="button"
                className="resource-picker-browse"
                aria-label="Browse import event id"
                onClick={(event) => {
                  browseOpenerRef.current = event.currentTarget;
                  setBrowseTarget('import');
                }}
              >
                Browse
              </button>
            </span>
            {importWarning === null ? null : (
              <span id="import-event-id-warning" className="field-warning">{importWarning}</span>
            )}
          </div>
          <label>
            Import kind
            <select
              value={importKind}
              onChange={(event) => setImportKind(event.target.value as EventCreateKind)}
            >
              <option value="marathon">marathon</option>
              <option value="moshikoi">moshikoi (permanent)</option>
              <option value="race">Race (レース)</option>
            </select>
          </label>
          <button type="submit" disabled={busy || importId.trim() === ''}>
            Import from master
          </button>
        </form>
      ) : null}

      <MarathonIdBrowser
        open={browseTarget !== null}
        title="Pick a master marathon id"
        disableDefined
        returnFocusRef={browseOpenerRef}
        onClose={() => setBrowseTarget(null)}
        onPick={(id) => {
          if (browseTarget === 'new') setNewId(id);
          else setImportId(id);
        }}
      />

      {sortedEvents === null ? (
        <p className="loading">Loading events…</p>
      ) : sortedEvents.length === 0 ? (
        <p>No event definitions yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Id</th>
              <th>Title</th>
              <th>Kind</th>
              <th>Published</th>
              <th>Draft</th>
              <th>Schedule</th>
              <th>Updated</th>
              <th>Export</th>
            </tr>
          </thead>
          <tbody>
            {sortedEvents.map((row) => (
              <tr key={row.id}>
                <td>
                  <a href={`#/events/${encodeURIComponent(row.id)}`}>{row.id}</a>{' '}
                  {row.kind === 'race' && row.publishedVersion > 0 ? (
                    <a href={`#/events/${encodeURIComponent(row.id)}/players`}>players</a>
                  ) : null}
                </td>
                <td>
                  {row.titleEn ?? row.title}
                  {row.titleEn == null ? null : <div className="muted">{row.title}</div>}
                </td>
                <td>{row.kind}</td>
                <td>{row.publishedVersion === 0 ? 'unpublished' : `v${row.publishedVersion}`}</td>
                <td>{row.draftDiffersFromPublished ? 'differs' : 'in sync'}</td>
                <td>
                  {row.lifecycle === 'permanent'
                    ? `Permanent · ${row.publishedVersion === 0 ? 'Draft' : 'Live'}`
                    : row.schedule.length === 0
                      ? 'none'
                      : `${row.schedule.length} window${row.schedule.length === 1 ? '' : 's'}`}
                </td>
                <td>
                  {row.updatedAt}{' '}
                  {row.updatedByName === null && row.updatedBy === null
                    ? ''
                    : `· ${row.updatedByName ?? row.updatedBy ?? ''}`}
                </td>
                <td>
                  <a
                    href={`/sumire/admin/events/${encodeURIComponent(row.id)}/export?which=draft`}
                  >
                    draft
                  </a>{' '}
                  {row.publishedVersion === 0 ? null : (
                    <a
                      href={`/sumire/admin/events/${encodeURIComponent(row.id)}/export?which=published`}
                    >
                      published
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
