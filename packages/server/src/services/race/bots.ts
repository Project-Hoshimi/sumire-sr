// Synthetic race players ("bots") that populate the ranking and the board rival
// list so a small server does not look empty. Bots are generated on read: they
// are never stored in the database, never own a player row and never receive
// rewards. Everything here is a pure function of (raceId, config, window, now),
// so every caller sees the same bots with the same counts.
import type { RaceBotConfig } from './types.ts';

/** Every bot id starts with this prefix; see `isRaceBotId`. */
export const RACE_BOT_ID_PREFIX = 'racebot:';

/** True when `id` is a generated race bot id rather than a real player id. */
export function isRaceBotId(id: string): boolean {
  return id.startsWith(RACE_BOT_ID_PREFIX);
}

/** One generated race participant. */
export interface RaceBot {
  /** Ranking id: `racebot:<raceId>:<i>`. Never written to the database. */
  id: string;
  /** Public user id the board / ranking renders. Never a real account. */
  userId: string;
  name: string;
  /**
   * Master character the bot is dressed as when it is named after an idol.
   * Absent for a custom-name bot, where the rival list picks a character with
   * `displayCharacterIndex` instead.
   */
  characterId?: string;
  managerLevel: number;
  /** Seed value; the rival list picks a playable character with it. */
  displayCharacterIndex: number;
  /** Panels cleared at the time the bot was generated. */
  clearPanelCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** FNV-1a 32-bit hash of `input` (ASCII inputs only). */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32 PRNG seeded with a 32-bit integer. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Race window the bots pace against; epoch milliseconds like the race catalog. */
export interface RaceBotWindow {
  startTime: number;
  endTime: number;
}

/**
 * The bots of race `raceId` at `now`. Empty when the config is missing or
 * disabled, or `count` is 0.
 *
 * Naming: a non-empty `bots.names` keeps the custom handles (rotated from the
 * race hash). Otherwise the bots are named after `idols` — bot `i` takes
 * `idols[(offset + i) % idols.length]` with `offset = fnv1a32(raceId) %
 * idols.length`, carries that idol's `characterId`, and repeats past the list
 * length get a ` 2`, ` 3` suffix. With no idols either, bots fall back to
 * `Bot <i+1>` handles.
 *
 * Determinism: bot `i` is seeded with the FNV-1a hash of `${raceId}:${i}` and a
 * mulberry32 PRNG. Its daily rate is
 * `min + (max - min) * r^1.5` with `r` the first PRNG draw, so most bots are
 * slow-to-mid and a few are fast. Each full day `d` before the current one adds
 * `rate * (0.6 + 0.8 * u(seed, d))`, where `u` is seeded from
 * `${raceId}:${i}:${d}`; the current partial day adds its daily amount scaled by
 * the elapsed fraction of the day. The total is floored. The count is 0 before
 * `startTime` and frozen at `endTime`. The naming mode consumes no PRNG draws,
 * so pace and levels are identical whichever names are used.
 */
export function raceBotEntries(
  raceId: string,
  bots: RaceBotConfig | undefined,
  window: RaceBotWindow,
  now: number,
  idols: readonly { id: string; name: string }[] = [],
): RaceBot[] {
  if (bots === undefined || !bots.enabled) return [];
  const count = Math.max(0, Math.floor(bots.count));
  if (count === 0) return [];

  const customNames = bots.names;
  const idolNames = customNames.length === 0 && idols.length > 0 ? idols : [];
  const duration = Math.max(0, window.endTime - window.startTime);
  const elapsed = Math.min(Math.max(now - window.startTime, 0), duration);
  const fullDays = Math.floor(elapsed / DAY_MS);
  const fractionOfDay = (elapsed % DAY_MS) / DAY_MS;

  const min = Math.max(0, bots.minPanelsPerDay);
  const max = Math.max(min, bots.maxPanelsPerDay);
  const dailyCount = (index: number, day: number): number => {
    const u = mulberry32(fnv1a32(`${raceId}:${index}:${day}`))();
    return 0.6 + 0.8 * u;
  };

  /** `name` and the character it dresses as for bot `index`. */
  const labelFor = (index: number): { name: string; characterId?: string } => {
    if (idolNames.length > 0) {
      const offset = fnv1a32(raceId) % idolNames.length;
      const idol = idolNames[(offset + index) % idolNames.length] as { id: string; name: string };
      const name =
        count > idolNames.length && index >= idolNames.length
          ? `${idol.name} ${Math.floor(index / idolNames.length) + 1}`
          : idol.name;
      return { name, characterId: idol.id };
    }
    if (customNames.length > 0) {
      const offset = fnv1a32(raceId) % customNames.length;
      const baseName = customNames[(offset + index) % customNames.length] as string;
      return {
        name:
          count > customNames.length && index >= customNames.length
            ? `${baseName} ${Math.floor(index / customNames.length) + 1}`
            : baseName,
      };
    }
    return { name: `Bot ${index + 1}` };
  };

  const entries: RaceBot[] = [];
  for (let index = 0; index < count; index += 1) {
    const random = mulberry32(fnv1a32(`${raceId}:${index}`));
    const r = random();
    const rate = min + (max - min) * r ** 1.5;

    let panels = 0;
    for (let day = 0; day < fullDays; day += 1) {
      panels += rate * dailyCount(index, day);
    }
    if (fractionOfDay > 0) {
      panels += rate * dailyCount(index, fullDays) * fractionOfDay;
    }

    const label = labelFor(index);
    const entry: RaceBot = {
      id: `${RACE_BOT_ID_PREFIX}${raceId}:${index}`,
      userId: `racebot-${index}`,
      name: label.name,
      // Level and character draws are kept in this order for every naming mode.
      managerLevel: 20 + Math.floor(random() * 181),
      displayCharacterIndex: Math.floor(random() * 1000),
      clearPanelCount: Math.floor(panels),
    };
    if (label.characterId !== undefined) entry.characterId = label.characterId;
    entries.push(entry);
  }
  return entries;
}
