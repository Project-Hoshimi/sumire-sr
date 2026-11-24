// Per-player Race state. The whole slice is a JSON singleton in
// `player_entities` (`RaceState:<raceId>`), so a new field needs no migration;
// race decks saved by older builds live in a second singleton
// (`RaceDecks:<raceId>`). New `Race:SaveDeck` calls write the account-wide
// `Decks`/`DeckPositions` store, and the legacy rows are only read.
import { db } from '../../db/client.ts';
import type { Executor } from '../../db/tx.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { getSingleton, putSingleton } from '../playerState.ts';

/** pt / medal area quest: difficulty number → epoch ms when it was cleared. */
export interface RaceAreaQuestTierReachedAt {
  pt: Record<string, number>;
  medal: Record<string, number>;
}

export interface RaceState {
  /** False until the race is initialised by `Home:Enter` (or `Race:Top`). */
  initialized: boolean;
  /** Index into `RaceConfig.areaIds`. */
  areaIndex: number;
  /** Current panel number inside the area; 0 means "not moved yet". */
  panelNumber: number;
  /**
   * Completed laps of the last area. The board loops: after the last area's
   * VENUS panel the next walk starts again at that area's panel 1. 0 means the
   * first pass, so `loopCount > 0` marks a loop lap.
   */
  loopCount: number;
  totalClearPanelCount: number;
  /** A VENUS (live) panel was reached and its quest is pending. */
  pendingVenus: boolean;
  currentLivePanelScore: number;
  /** liveBonusId → highest purchased level. */
  liveBonuses: Record<string, number>;
  /** Race medals spent on live bonuses so far; refunded by `Race:ResetLiveBonus`. */
  medalsSpentOnBonuses: number;
  /** cardId → cool-time end (epoch ms). */
  cardCoolTimes: Record<string, number>;
  /** raceQuestId → highest cleared difficulty number. */
  areaQuestClear: Record<string, number>;
  /**
   * pt / medal area quest: difficulty number → epoch ms when the tier was
   * first cleared. The activity-lesson rate only picks a clear up at the next
   * 2-day tally boundary (see `tally.ts`), so the clear times are kept here.
   */
  areaQuestTierReachedAt: RaceAreaQuestTierReachedAt;
  /** raceQuestId → difficultyNumber → highest score. */
  areaQuestHighScore: Record<string, Record<string, number>>;
  /** Last `Race:ReceiveActivityLesson` (epoch ms); 0 before the first call. */
  lastActivityReceiveMs: number;
  /**
   * VENUS live-panel difficulty frozen when the player first opened the race,
   * derived from their VENUS grade then. `null` until that first open; once set
   * it never changes, so a later grade move does not re-scale the race.
   */
  difficultyNumber: number | null;
  /** Board story episodes of this race the player has reached (1-based). */
  readStoryEpisodes: number[];
  /**
   * StoryIds of the race's event story read during this run. The client's
   * `Stories` collection is account-wide, so a row read in a previous run would
   * otherwise suppress this run's "play the story" prompt; rows for an episode
   * not listed here are served as Unread while the race is open.
   */
  playedStoryIds: string[];
}

export interface RaceDeckPosition {
  Number: number;
  Position: number;
  CardId: string;
  /** Accessory ids used by the deck-stat path (`RaceDeckCardDetailInfo`). */
  Part1AccessoryId?: string;
  Part2AccessoryId?: string;
  PhotoIds?: string[];
  /** Appearance ids, needed to list the deck's live assets. */
  CostumeId?: string;
  HairId?: string;
}

export interface RaceDeckRow {
  Number: number;
  Name: string;
}

export interface RaceDecks {
  decks: RaceDeckRow[];
  positions: RaceDeckPosition[];
}

export function raceStateField(raceId: string): string {
  return `RaceState:${raceId}`;
}

export function raceDecksField(raceId: string): string {
  return `RaceDecks:${raceId}`;
}

export function emptyRaceState(): RaceState {
  return {
    initialized: false,
    areaIndex: 0,
    panelNumber: 0,
    loopCount: 0,
    totalClearPanelCount: 0,
    pendingVenus: false,
    currentLivePanelScore: 0,
    liveBonuses: {},
    medalsSpentOnBonuses: 0,
    cardCoolTimes: {},
    areaQuestClear: {},
    areaQuestTierReachedAt: { pt: {}, medal: {} },
    areaQuestHighScore: {},
    lastActivityReceiveMs: 0,
    difficultyNumber: null,
    readStoryEpisodes: [],
    playedStoryIds: [],
  };
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

/** Coerce a stored blob into the current shape (older saves may miss fields). */
export function normalizeRaceState(raw: Decoded | null): RaceState {
  const state = emptyRaceState();
  if (!raw) return state;
  state.initialized = raw.initialized === true;
  state.areaIndex = num(raw.areaIndex);
  state.panelNumber = num(raw.panelNumber);
  state.loopCount = num(raw.loopCount);
  state.totalClearPanelCount = num(raw.totalClearPanelCount);
  state.pendingVenus = raw.pendingVenus === true;
  state.currentLivePanelScore = num(raw.currentLivePanelScore);
  state.liveBonuses = numRecord(raw.liveBonuses);
  state.medalsSpentOnBonuses = num(raw.medalsSpentOnBonuses);
  state.cardCoolTimes = numRecord(raw.cardCoolTimes);
  state.areaQuestClear = numRecord(raw.areaQuestClear);
  const reachedAt = raw.areaQuestTierReachedAt;
  if (reachedAt && typeof reachedAt === 'object' && !Array.isArray(reachedAt)) {
    const record = reachedAt as Record<string, unknown>;
    state.areaQuestTierReachedAt = {
      pt: numRecord(record.pt),
      medal: numRecord(record.medal),
    };
  }
  state.lastActivityReceiveMs = num(raw.lastActivityReceiveMs);
  const difficulty = raw.difficultyNumber;
  state.difficultyNumber =
    typeof difficulty === 'number' && Number.isInteger(difficulty) && difficulty >= 1 && difficulty <= 7
      ? difficulty
      : null;
  state.readStoryEpisodes = Array.isArray(raw.readStoryEpisodes)
    ? raw.readStoryEpisodes.map((entry: unknown) => num(entry)).filter((entry) => entry > 0)
    : [];
  state.playedStoryIds = Array.isArray(raw.playedStoryIds)
    ? [
        ...new Set(
          (raw.playedStoryIds as unknown[])
            .map((entry) => String(entry ?? ''))
            .filter((entry) => entry !== ''),
        ),
      ]
    : [];
  if (raw.areaQuestHighScore && typeof raw.areaQuestHighScore === 'object') {
    for (const [questId, scores] of Object.entries(
      raw.areaQuestHighScore as Record<string, unknown>,
    )) {
      state.areaQuestHighScore[questId] = numRecord(scores);
    }
  }
  return state;
}

export async function loadRaceState(
  playerId: string,
  raceId: string,
  exec: Executor = db,
): Promise<RaceState> {
  return normalizeRaceState(await getSingleton(playerId, raceStateField(raceId), exec));
}

/**
 * Mark the state as visited. Returns true exactly once per player and race,
 * which is what `Race:Top.IsInitialLogin` reports.
 *
 * `Home:Enter` runs this for every open race it advertises (see
 * `applyActiveRaceToHomeEnter`), so by the time the client opens the race the
 * state usually exists and the starting points have already been granted
 * through the home payload's `UpdatedData`. The activity-lesson clock starts
 * with the state: an unset `lastActivityReceiveMs` is stamped with `now` on the
 * first initialisation so the lesson accrues from the moment the player sees the
 * race. Every handler that owns the state calls this before saving it.
 */
export function markRaceInitialLogin(state: RaceState, now: number = Date.now()): boolean {
  const firstLogin = !state.initialized;
  state.initialized = true;
  if (!(state.lastActivityReceiveMs > 0)) state.lastActivityReceiveMs = now;
  return firstLogin;
}

export async function saveRaceState(
  playerId: string,
  raceId: string,
  state: RaceState,
  exec: Executor = db,
): Promise<void> {
  await putSingleton(playerId, raceStateField(raceId), state as unknown as Decoded, exec);
}

/**
 * Record that the area-quest tiers in `(previousClear, highestClear]` were
 * reached at `now`. The tallied lesson rate only picks the new highest tier up
 * at the next boundary.
 *
 * A state saved before the tally existed has clears but no `reachedAt` history;
 * its previous highest tier is stamped at time 0 first, so the player keeps the
 * rate they already had (the tallied tier treats time 0 as "effective at once").
 */
export function recordAreaQuestTierReached(
  state: RaceState,
  type: keyof RaceAreaQuestTierReachedAt,
  previousClear: number,
  highestClear: number,
  now: number,
): void {
  const reached = state.areaQuestTierReachedAt[type];
  if (previousClear > 0 && Object.keys(reached).length === 0) {
    reached[String(previousClear)] = 0;
  }
  for (let tier = Math.max(1, previousClear + 1); tier <= highestClear; tier += 1) {
    if (reached[String(tier)] === undefined) reached[String(tier)] = now;
  }
}

function normalizeDecks(raw: Decoded | null): RaceDecks {
  const decks: RaceDeckRow[] = [];
  const positions: RaceDeckPosition[] = [];
  if (!raw) return { decks, positions };
  if (Array.isArray(raw.decks)) {
    for (const entry of raw.decks as Decoded[]) {
      decks.push({ Number: num(entry.Number), Name: typeof entry.Name === 'string' ? entry.Name : '' });
    }
  }
  if (Array.isArray(raw.positions)) {
    for (const entry of raw.positions as Decoded[]) {
      positions.push({
        Number: num(entry.Number),
        Position: num(entry.Position),
        CardId: typeof entry.CardId === 'string' ? entry.CardId : '',
        Part1AccessoryId: typeof entry.Part1AccessoryId === 'string' ? entry.Part1AccessoryId : '',
        Part2AccessoryId: typeof entry.Part2AccessoryId === 'string' ? entry.Part2AccessoryId : '',
        PhotoIds: Array.isArray(entry.PhotoIds)
          ? (entry.PhotoIds as unknown[]).map((id) => String(id ?? '')).filter((id) => id !== '')
          : [],
        CostumeId: typeof entry.CostumeId === 'string' ? entry.CostumeId : '',
        HairId: typeof entry.HairId === 'string' ? entry.HairId : '',
      });
    }
  }
  return { decks, positions };
}

export async function loadRaceDecks(
  playerId: string,
  raceId: string,
  exec: Executor = db,
): Promise<RaceDecks> {
  return normalizeDecks(await getSingleton(playerId, raceDecksField(raceId), exec));
}

/**
 * Replace one race deck (matched by `Number`) and its positions. Positions for
 * the deck that the request omits are dropped, mirroring `User:SaveDeck`.
 */
export async function saveRaceDeck(
  playerId: string,
  raceId: string,
  deck: { Number: number; Name: string; Positions: readonly RaceDeckPosition[] },
  exec: Executor = db,
): Promise<RaceDecks> {
  const current = await loadRaceDecks(playerId, raceId, exec);
  const decks = current.decks.filter((row) => row.Number !== deck.Number);
  decks.push({ Number: deck.Number, Name: deck.Name });
  decks.sort((a, b) => a.Number - b.Number);
  const positions = [
    ...current.positions.filter((row) => row.Number !== deck.Number),
    ...deck.Positions.filter((row) => row.Number === deck.Number && row.CardId !== ''),
  ].sort((a, b) => a.Number - b.Number || a.Position - b.Position);
  const next: RaceDecks = { decks, positions };
  await putSingleton(playerId, raceDecksField(raceId), next as unknown as Decoded, exec);
  return next;
}
