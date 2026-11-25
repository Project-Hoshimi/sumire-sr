// Runtime lookup of published race events. Race has no authored catalogue
// directory, so unlike marathon these reads only consult the event registry
// (published, enabled definitions with an event_schedule row).
import { compiledEvent, eventWindowAt, openEvents, registryLoaded } from '../events/registry.ts';
import type { RaceConfig } from './types.ts';

export interface RaceWindow {
  startTime: number;
  endTime: number;
  exchangeEndTime: number;
}

export interface OpenRace {
  id: string;
  config: RaceConfig;
  window: RaceWindow;
}

/** Compiled runtime of race `raceId`, or undefined when it is not published. */
export function raceConfigFor(raceId: string): RaceConfig | undefined {
  if (!registryLoaded()) return undefined;
  return compiledEvent<RaceConfig>('race', raceId);
}

/** Schedule window of race `raceId` covering `now`, or undefined when closed. */
export function raceWindowFor(raceId: string, now: number): RaceWindow | undefined {
  if (!registryLoaded()) return undefined;
  return eventWindowAt('race', raceId, now);
}

/** Every published race with a window at `now`, ordered by start then id. */
export function openRaces(now: number): OpenRace[] {
  if (!registryLoaded()) return [];
  return openEvents<RaceConfig>('race', now).map((event) => ({
    id: event.id,
    config: event.runtime,
    window: event.window,
  }));
}
