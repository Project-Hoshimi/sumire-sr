/**
 * Birthday feature logic, ported from solis-server (AGPL),
 * internal/makino/birthday.
 *
 * Pure functions only (no DB, no master imports) so they can be unit tested
 * without a database. All times are epoch milliseconds and every calendar date
 * is JST (UTC+9, no DST).
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

let clockOverride: (() => number) | null = null;

/** Current time in epoch ms. Overridable from tests. */
export function birthdayClock(): number {
  return clockOverride ? clockOverride() : Date.now();
}

/** Override the birthday clock for tests; pass null to restore the default. */
export function setBirthdayClockForTest(fn: (() => number) | null): void {
  clockOverride = fn;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** The JST calendar year containing `ms`. */
function jstYear(ms: number): number {
  return new Date(ms + JST_OFFSET_MS).getUTCFullYear();
}

/** True when month/day is a real calendar date (leap year 2000 allows 2/29). */
export function isValidBirthDate(month: number, day: number): boolean {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(2000, month - 1, day));
  return (
    d.getUTCFullYear() === 2000 &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/**
 * Epoch ms of 00:00 JST on the given date. Feb 29 collapses to Feb 28 in a
 * non-leap year.
 */
export function birthdayDateMs(year: number, month: number, day: number): number {
  const effectiveDay = month === 2 && day === 29 && !isLeapYear(year) ? 28 : day;
  return Date.UTC(year, month - 1, effectiveDay) - JST_OFFSET_MS;
}

export type BirthdayPeriod = {
  active: boolean;
  startMs: number;
  endMs: number;
  year: number;
};

/**
 * The 7-day birthday window that contains `nowMs` (or the most recent one).
 * The window starts at 00:00 JST on the birthday and ends 7 days later,
 * start-inclusive and end-exclusive.
 */
export function birthdayPeriod(month: number, day: number, nowMs: number): BirthdayPeriod {
  if (!isValidBirthDate(month, day)) {
    return { active: false, startMs: 0, endMs: 0, year: 0 };
  }
  const currentYear = jstYear(nowMs);
  let year = currentYear;
  let start = birthdayDateMs(year, month, day);
  if (nowMs < start) {
    year = currentYear - 1;
    start = birthdayDateMs(year, month, day);
  }
  const end = start + 7 * DAY_MS;
  return {
    active: start <= nowMs && nowMs < end,
    startMs: start,
    endMs: end,
    year,
  };
}

/**
 * The year of the upcoming birthday whose 7-day reminder window contains
 * `nowMs`, or 0 when no reminder window is open.
 */
export function reminderYear(month: number, day: number, nowMs: number): number {
  if (!isValidBirthDate(month, day)) return 0;
  const currentYear = jstYear(nowMs);
  let next = birthdayDateMs(currentYear, month, day);
  if (nowMs >= next) next = birthdayDateMs(currentYear + 1, month, day);
  const start = next - 7 * DAY_MS;
  if (start <= nowMs && nowMs < next) return jstYear(next);
  return 0;
}

export const BIRTHDAY_CODES = {
  ai: '全力でお祝い\nしますねっ！',
  aoi: 'やぁやぁ\nおめでとう',
  chs: 'いっぱいお祝い\nしないとです！',
  hrk: '君も立派に\nなったわね～',
  kan: '一緒に\n写真撮ろ～！',
  kkr: 'こころがお祝い\nしてあげま～す',
  kor: 'お祝いのお返し\n期待してますよ',
  ktn: 'お、おめでとう\nございます…！',
  mei: 'おめでとーー\nーーーーー！',
  mhk: '私だってお祝い\nくらいしますよ',
  ngs: '自分のことのよ\nうに嬉しいです',
  rei: 'ちゃんとお祝い\nさせて下さいね',
  rio: '一応、気持ちを\n込めたのよ',
  rui: '私にとっても\n特別な日です',
  ski: '良い一年を過ご\nせますように',
  skr: 'あなたに～～！\n届け～～～～！',
  smr: 'お兄ちゃん\nおめでと～！',
  suz: 'お、お祝いして\n差し上げますわ',
  szk: 'お誕生日…\nめでたい…！',
  yu: 'ふふ、何が\nほしいん？',
} as const;

export type BirthdayCode = keyof typeof BIRTHDAY_CODES;

export const BIRTHDAY_CODES_LIST = Object.keys(BIRTHDAY_CODES) as BirthdayCode[];

/** Default greeting used only when a catalogue code has no text. */
export const DEFAULT_BIRTHDAY_TEXT = 'お誕生日\nおめでとうございます！';

export const BANNER_L_ASSET = 'img_banner_l_user-birthday';
export const HOME_ORDER = 1000;

export const BIRTHDAY_REMINDER = {
  assetId: 'user-birthday-advance-notice',
  description: 'ご案内',
  linkTitle: '注力アイドルを設定する',
  linkType: 109,
} as const;

export function characterIdOf(code: string): string {
  return `char-${code}`;
}

export function birthdayIdOf(code: string): string {
  return `birthday-01-${code}-01`;
}

export function advAssetIdOf(code: string): string {
  return `userhbd_01_${code}`;
}

export function decorationIdOf(code: string): string {
  return `deco-user-birthday-${code}-01`;
}

/** The catalogue code named by a birthday id, or null when unknown. */
export function codeOfBirthdayId(id: string): BirthdayCode | null {
  for (const code of BIRTHDAY_CODES_LIST) {
    if (birthdayIdOf(code) === id) return code;
  }
  return null;
}

function codeOfCharacterId(id: string): BirthdayCode | null {
  const code = id.startsWith('char-') ? id.slice('char-'.length) : id;
  return Object.prototype.hasOwnProperty.call(BIRTHDAY_CODES, code) ? (code as BirthdayCode) : null;
}

/**
 * Pick the three birthday participants: favourite catalogue characters first
 * (deduped, in order, at most three), then the remaining catalogue codes in a
 * Fisher-Yates shuffle driven by `rand`.
 */
export function selectParticipants(
  favoriteCharacterIds: readonly string[],
  rand: () => number = Math.random,
): string[] {
  const chosen: BirthdayCode[] = [];
  const seen = new Set<BirthdayCode>();
  for (const id of favoriteCharacterIds) {
    const code = codeOfCharacterId(id);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    chosen.push(code);
    if (chosen.length === 3) break;
  }

  const remaining = BIRTHDAY_CODES_LIST.filter((code) => !seen.has(code));
  for (let i = remaining.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = remaining[i]!;
    remaining[i] = remaining[j]!;
    remaining[j] = tmp;
  }
  for (const code of remaining) {
    if (chosen.length === 3) break;
    chosen.push(code);
  }

  return chosen.map(birthdayIdOf);
}

export type BirthdayState = {
  eventYear: number;
  birthdayIds: string[];
  watchedIds: string[];
  claimedIds: string[];
  remindedYear: number;
};

export type ReconcileResult = {
  state: BirthdayState;
  changed: boolean;
};

function emptyState(): BirthdayState {
  return {
    eventYear: 0,
    birthdayIds: [],
    watchedIds: [],
    claimedIds: [],
    remindedYear: 0,
  };
}

/**
 * Bring the stored state in line with the current birthday window. A new event
 * year rerolls the participants and clears watched/claimed, but keeps the
 * reminder suppression year.
 */
export function reconcileState(
  state: BirthdayState | null,
  month: number,
  day: number,
  favoriteCharacterIds: readonly string[],
  nowMs: number,
  rand: () => number = Math.random,
): ReconcileResult {
  const period = birthdayPeriod(month, day, nowMs);
  if (state === null) {
    if (!period.active) return { state: emptyState(), changed: false };
    return {
      state: {
        eventYear: period.year,
        birthdayIds: selectParticipants(favoriteCharacterIds, rand),
        watchedIds: [],
        claimedIds: [],
        remindedYear: 0,
      },
      changed: true,
    };
  }
  if (!period.active || state.eventYear === period.year) {
    return { state, changed: false };
  }
  return {
    state: {
      ...state,
      eventYear: period.year,
      birthdayIds: selectParticipants(favoriteCharacterIds, rand),
      watchedIds: [],
      claimedIds: [],
    },
    changed: true,
  };
}

function isCurrentEvent(state: BirthdayState, month: number, day: number, nowMs: number): boolean {
  const period = birthdayPeriod(month, day, nowMs);
  return period.active && state.eventYear === period.year;
}

/** Participant ids still waiting to be watched, in participant order. */
export function unwatchedIds(
  state: BirthdayState,
  month: number,
  day: number,
  nowMs: number,
): string[] {
  if (!isCurrentEvent(state, month, day, nowMs)) return [];
  return state.birthdayIds.filter((id) => !state.watchedIds.includes(id));
}

/** Watched participant ids whose decoration reward is still unclaimed. */
export function receivableIds(
  state: BirthdayState,
  month: number,
  day: number,
  nowMs: number,
): string[] {
  if (!isCurrentEvent(state, month, day, nowMs)) return [];
  return state.birthdayIds.filter(
    (id) => state.watchedIds.includes(id) && !state.claimedIds.includes(id),
  );
}

export type BirthdayAdv = {
  BirthdayId: string;
  AdvAssetId: string;
};

/** The next unwatched participant's adventure, or undefined. */
export function nextAdv(
  state: BirthdayState,
  month: number,
  day: number,
  nowMs: number,
): BirthdayAdv | undefined {
  if (!isCurrentEvent(state, month, day, nowMs)) return undefined;
  const id = state.birthdayIds.find((bid) => !state.watchedIds.includes(bid));
  if (!id) return undefined;
  const code = codeOfBirthdayId(id);
  if (!code) return undefined;
  return { BirthdayId: id, AdvAssetId: advAssetIdOf(code) };
}

export type HomeBirthdayInfoView = {
  BannerAssetId: string;
  Order: number;
  IsRemainingUnwatched: boolean;
  IsRemainingReceivableReward: boolean;
};

/** Home lobby birthday block, or undefined outside the current event window. */
export function homeInfo(
  state: BirthdayState,
  month: number,
  day: number,
  nowMs: number,
): HomeBirthdayInfoView | undefined {
  if (!isCurrentEvent(state, month, day, nowMs)) return undefined;
  // Field names and the two IsRemaining flags are not verified against the
  // official server.
  return {
    BannerAssetId: BANNER_L_ASSET,
    Order: HOME_ORDER,
    IsRemainingUnwatched: unwatchedIds(state, month, day, nowMs).length > 0,
    IsRemainingReceivableReward: receivableIds(state, month, day, nowMs).length > 0,
  };
}

export type BirthdayRemindView = {
  AssetId: string;
  Description: string;
  LinkTitle: string;
  LinkType: number;
};

/**
 * Reminder shown in the week before the next birthday, unless the current
 * event window is active or the reminder year was already dismissed.
 * LinkDetail is intentionally absent. Not verified against the official server.
 */
export function reminder(
  state: BirthdayState,
  month: number,
  day: number,
  nowMs: number,
): BirthdayRemindView | undefined {
  if (birthdayPeriod(month, day, nowMs).active) return undefined;
  const year = reminderYear(month, day, nowMs);
  if (year === 0 || year === state.remindedYear) return undefined;
  return {
    AssetId: BIRTHDAY_REMINDER.assetId,
    Description: BIRTHDAY_REMINDER.description,
    LinkTitle: BIRTHDAY_REMINDER.linkTitle,
    LinkType: BIRTHDAY_REMINDER.linkType,
  };
}
