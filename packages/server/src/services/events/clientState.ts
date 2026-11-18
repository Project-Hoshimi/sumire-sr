/**
 * Fingerprint of the event state a game client can observe.
 *
 * The forced-relog check compares this against the fingerprint stamped on a
 * session when it first made a request: any change to a published event
 * definition, its enabled schedule windows, or the phase a window is in sends
 * the client back to the title screen so it re-logs in and re-reads event
 * information. Draft-only edits are invisible here.
 *
 * The static part (identity, published version, schedule rows) is cached per
 * registry revision; only the per-event phase is recomputed per call. Hashing a
 * handful of small objects per request is cheap, and the cache keeps the
 * projection from walking the schedule rows on every request.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonicalJson.ts';
import {
  clientStateEvents,
  eventRegistryRevision,
  type ClientStateEvent,
  type ClientStateSchedule,
} from './registry.ts';

/**
 * Where an event's schedule sits relative to `now`:
 * - `before`: no enabled window has started yet
 * - `running`: a window's playable part is open (`startsAt <= now < endsAt`)
 * - `exchange`: the playable part ended but the exchange part is open
 *   (`endsAt <= now < exchangeEndsAt`)
 * - `ended`: every enabled window is over
 * - `disabled`: no enabled schedule rows at all
 *
 * `running`/`exchange` use the same covering-row rule as `eventWindowAt` (the
 * earliest-starting enabled row with `startsAt <= now < exchangeEndsAt`), so the
 * phase always agrees with whether the event is considered open.
 */
export type EventClientPhase = 'before' | 'running' | 'exchange' | 'ended' | 'disabled';

/**
 * Phase of one event's schedule rows at `now` (epoch milliseconds). `undefined`
 * means the event has no schedule rows at all; the caller treats that as
 * `before` (nothing is authored, so nothing is running).
 */
export function clientStatePhase(
  schedule: readonly ClientStateSchedule[],
  now: number,
): EventClientPhase {
  const enabled = schedule.filter((row) => row.enabled);
  if (enabled.length === 0) return 'disabled';
  let covering: ClientStateSchedule | undefined;
  for (const row of enabled) {
    if (!(row.startsAt <= now && now < row.exchangeEndsAt)) continue;
    if (!covering || row.startsAt < covering.startsAt) covering = row;
  }
  if (covering) return now < covering.endsAt ? 'running' : 'exchange';
  // No window covers now: a not-yet-started window means we are before the
  // event, otherwise every window is over.
  return enabled.some((row) => row.startsAt > now) ? 'before' : 'ended';
}

interface CachedProjection {
  revision: number;
  events: ClientStateEvent[];
}

let cache: CachedProjection | undefined;

/** The static projection for the current registry revision. */
function projection(): ClientStateEvent[] {
  const revision = eventRegistryRevision();
  if (!cache || cache.revision !== revision) {
    cache = { revision, events: clientStateEvents() };
  }
  return cache.events;
}

/**
 * SHA-256 hex of the canonical JSON of every published event, sorted by id:
 * id, kind, published version, schedule fields/enabled flags and the phase at
 * `now`. Deleted events disappear (changing the hash) and drafts never appear.
 */
export function clientStateFingerprint(now: Date): string {
  const at = now.getTime();
  const state = projection().map((event) => ({
    ...event,
    phase: clientStatePhase(event.schedule, at),
  }));
  return createHash('sha256').update(canonicalJson(state), 'utf8').digest('hex');
}

/** Drop the cached projection (tests only). */
export function resetClientStateCacheForTests(): void {
  cache = undefined;
}
