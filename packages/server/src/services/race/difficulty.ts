// Per-player VENUS live-panel difficulty. A race draws each player's difficulty
// from their VENUS grade (master `HierarchyGrade`) once, the first time they
// open the race, and freezes it into their race state. Players who open the
// race before they have a standing are Challenger (the lowest grade), so the
// mapping is only re-read for players who had no race state yet.
import { db } from '../../db/client.ts';
import type { Executor } from '../../db/tx.ts';
import { loadHierarchyStanding } from '../hierarchy.ts';
import {
  RACE_DEFAULT_GRADE_DIFFICULTY,
  RACE_DEFAULT_LIVE_PANEL_DIFFICULTY_NUMBER,
  type RaceConfig,
  type RaceGradeDifficultyConfig,
} from './types.ts';
import type { RaceState } from './state.ts';

/**
 * Master `HierarchyGrade.Id` → the `gradeDifficulty` leaf it plays at.
 * hie-001 is BIG4, hie-007 is Challenger.
 */
export const RACE_GRADE_DIFFICULTY_KEYS: Record<string, keyof RaceGradeDifficultyConfig> = {
  'hie-001': 'big4',
  'hie-002': 'diamond',
  'hie-003': 'platinum',
  'hie-004': 'gold',
  'hie-005': 'silver',
  'hie-006': 'bronze',
  'hie-007': 'challenger',
};

/** The race's grade mapping, with defaults for fields a draft predates. */
function gradeDifficultyOf(config: RaceConfig): RaceGradeDifficultyConfig {
  const raw = config.gradeDifficulty as
    | Partial<Record<keyof RaceGradeDifficultyConfig, unknown>>
    | undefined;
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const out = { ...RACE_DEFAULT_GRADE_DIFFICULTY };
  for (const key of Object.keys(RACE_DEFAULT_GRADE_DIFFICULTY) as (keyof RaceGradeDifficultyConfig)[]) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** The race-wide difficulty used when no per-player value applies. */
function fallbackDifficulty(config: RaceConfig): number {
  const value = config.livePanelDifficultyNumber;
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : RACE_DEFAULT_LIVE_PANEL_DIFFICULTY_NUMBER;
}

/** Difficulty tier played at a VENUS grade; unknown grade → race fallback. */
export function difficultyForGrade(config: RaceConfig, gradeId: string | null | undefined): number {
  const key = gradeId ? RACE_GRADE_DIFFICULTY_KEYS[gradeId] : undefined;
  if (key === undefined) return fallbackDifficulty(config);
  return gradeDifficultyOf(config)[key];
}

/** The player's frozen difficulty, or the race fallback before the first open. */
export function raceDifficultyNumber(state: RaceState, config: RaceConfig): number {
  return state.difficultyNumber ?? fallbackDifficulty(config);
}

/**
 * Freeze the player's VENUS-grade difficulty into `state` when it is not set
 * yet. Returns true when the state changed (and must be saved), false once a
 * difficulty is already stored — a stored value is never re-derived.
 */
export async function ensureRaceDifficulty(
  playerId: string,
  state: RaceState,
  config: RaceConfig,
  exec: Executor = db,
): Promise<boolean> {
  if (state.difficultyNumber !== null) return false;
  const standing = await loadHierarchyStanding(playerId, exec);
  state.difficultyNumber = difficultyForGrade(config, standing.gradeId);
  return true;
}
