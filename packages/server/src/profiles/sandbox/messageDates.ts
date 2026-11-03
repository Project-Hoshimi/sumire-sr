/**
 * Deterministic release timestamps for sandbox-seeded narrative content.
 *
 * The function is pure: all master data it needs (card release dates, resolved
 * message times and the message that owns each embedded call) is supplied by
 * the caller. That keeps the date rules unit-testable without a database.
 *
 * Rules, in order:
 *  1. `message-card-*` / `tel-card-*` use the linked Card's `ReleaseDate`.
 *  2. `tel-message-*` uses the owning message's time plus one minute.
 *  3. A `-YY-MMDD` fragment in the id means 20YY-MM-DD 12:00 JST.
 *  4. A year-only event id (`message-event-vlnt-25-01`) uses the event's
 *     month/day in 20YY.
 *  5. Everything else starts at the game launch date plus the item's 1-based
 *     index within its MessageGroup, in minutes.
 *
 * Every resolved time is clamped to `now`.
 */

/** 2021-06-28 12:00 JST (03:00 UTC), the game's launch. */
export const SANDBOX_LAUNCH_TIME = Date.UTC(2021, 5, 28, 3, 0, 0);

/** A call embedded in a message is one minute after that message. */
export const CALL_DELAY_MS = 60_000;

const DATE_IN_ID = /-(\d{2})-(\d{2})(\d{2})(?=-|$)/;
const YEAR_ONLY_EVENT = /^(?:message-event|tel)-([a-z]+)-(\d{2})(?:-\d+)?$/;

const EVENT_MONTH_DAY: Readonly<Record<string, readonly [number, number]>> = {
  vlnt: [2, 14],
  wd: [3, 14],
  xmas: [12, 25],
  hlwn: [10, 31],
  nyr: [1, 1],
  newyear: [1, 1],
};

export interface MessageDateContext {
  /** Time the seed runs; no resolved time may be later than this. */
  now: number;
  /** `card-*` id -> Card.ReleaseDate (epoch ms). */
  cardReleaseDates?: ReadonlyMap<string, number>;
  /** Message id -> already-resolved release time (epoch ms). */
  messageTimes?: ReadonlyMap<string, number>;
  /** Telephone id -> id of the message whose detail embeds it. */
  telephoneParents?: ReadonlyMap<string, string>;
  /** 1-based index within the item's MessageGroup, for the launch fallback. */
  groupIndex?: number;
}

/** 12:00 JST on the given date, expressed as epoch milliseconds. */
function jstNoon(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day, 3, 0, 0);
}

/** Card id linked by a `message-card-*` or `tel-card-*` id, if any. */
export function linkedCardId(id: string): string | null {
  if (id.startsWith('message-card-')) return `card-${id.slice('message-card-'.length)}`;
  if (id.startsWith('tel-card-')) return `card-${id.slice('tel-card-'.length)}`;
  return null;
}

/** Resolve a `-YY-MMDD` fragment to 12:00 JST, or null when absent/invalid. */
export function parseDateInId(id: string): number | null {
  const match = DATE_IN_ID.exec(id);
  if (!match) return null;
  const year = 2000 + Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return jstNoon(year, month, day);
}

/** Resolve a year-only event id to its event date in 20YY, or null. */
export function parseYearOnlyEvent(id: string): number | null {
  const match = YEAR_ONLY_EVENT.exec(id);
  if (!match) return null;
  const monthDay = EVENT_MONTH_DAY[match[1] ?? ''];
  if (!monthDay) return null;
  return jstNoon(2000 + Number(match[2]), monthDay[0], monthDay[1]);
}

/** Deterministic release time for one sandbox message or telephone id. */
export function messageReleaseTime(id: string, context: MessageDateContext): number {
  const clamp = (time: number): number => Math.min(time, context.now);

  const cardId = linkedCardId(id);
  if (cardId) {
    const release = context.cardReleaseDates?.get(cardId);
    if (release !== undefined && release > 0) return clamp(release);
  }

  if (id.startsWith('tel-message-')) {
    const parentId = context.telephoneParents?.get(id) ?? id.slice('tel-'.length);
    const parentTime = context.messageTimes?.get(parentId);
    if (parentTime !== undefined) return clamp(parentTime + CALL_DELAY_MS);
  }

  const dated = parseDateInId(id);
  if (dated !== null) return clamp(dated);

  const event = parseYearOnlyEvent(id);
  if (event !== null) return clamp(event);

  return clamp(SANDBOX_LAUNCH_TIME + (context.groupIndex ?? 0) * CALL_DELAY_MS);
}
