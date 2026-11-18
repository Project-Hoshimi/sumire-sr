/**
 * Pure helpers for the NPC roster editor. The server accepts 1–5 cards with
 * arbitrary slot positions; the admin UI edits five slots in Position order and
 * drops empty slots when saving, so a three-card roster loads, validates and
 * saves as three cards with their slot positions preserved.
 */
import type { NpcRosterCard } from './types.ts';

export const ROSTER_SLOT_COUNT = 5;

/** In-game lane order, left to right: Position 1 is the center. */
export const ROSTER_VISUAL_ORDER = [4, 2, 1, 3, 5] as const;
export const RARITY_MIN = 1;
export const RARITY_MAX = 10;

/**
 * Mirror of `isValidAdminId` from
 * `fastify-api/src/services/ids.ts` (used by the server's roster-id check),
 * so the duplicate dialog rejects a bad id before the request.
 */
export const ROSTER_ID_MAX_LENGTH = 100;
const ROSTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidRosterId(id: string): boolean {
  return id.length > 0 && id.length <= ROSTER_ID_MAX_LENGTH && ROSTER_ID_PATTERN.test(id);
}

/** A blank slot; `CardId` must be filled before the roster can be saved. */
export function emptyRosterCard(position: number): NpcRosterCard {
  return {
    CardId: '',
    Position: position,
    Level: 1,
    Rarity: 1,
    LightFanAmount: 0,
    MiddleFanAmount: 0,
    HeavyFanAmount: 0,
    EvolutionLevel: 0,
  };
}

/**
 * Pad or trim a roster's cards to exactly five slots, ordered by Position and
 * renumbered 1–5. Existing values are preserved.
 */
export function normalizeRosterCards(cards: readonly NpcRosterCard[]): NpcRosterCard[] {
  const ordered = [...cards].sort((a, b) => a.Position - b.Position);
  return Array.from({ length: ROSTER_SLOT_COUNT }, (_, index) => {
    const card = ordered[index];
    if (card === undefined) return emptyRosterCard(index + 1);
    return { ...card, Position: index + 1 };
  });
}

/** Cards that fill a slot; empty slots are dropped rather than saved. */
export function filledRosterCards(cards: readonly NpcRosterCard[]): NpcRosterCard[] {
  return cards.filter((card) => card.CardId.trim() !== '');
}

function isInteger(value: number): boolean {
  return Number.isInteger(value);
}

function isNonNegativeNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Client-side mirror of `validateNpcRoster` for the five-slot form. Empty
 * slots are ignored; at least one filled slot is required. The returned cards
 * keep their slot Position when saved.
 */
export function validateRosterForm(
  name: string,
  managerLevel: number,
  cards: readonly NpcRosterCard[],
): string[] {
  const errors: string[] = [];
  if (name.trim() === '') errors.push('Name must not be empty.');
  if (!isInteger(managerLevel) || managerLevel < 1) {
    errors.push('Manager level must be an integer >= 1.');
  }
  const filled = filledRosterCards(cards);
  if (filled.length === 0) {
    errors.push('At least one card is required.');
    return errors;
  }
  if (filled.length > ROSTER_SLOT_COUNT) {
    errors.push(`At most ${ROSTER_SLOT_COUNT} cards are allowed.`);
  }
  const positions = new Set<number>();
  for (const card of filled) {
    const label = `Position ${card.Position}`;
    if (!isInteger(card.Position) || card.Position < 1 || card.Position > ROSTER_SLOT_COUNT) {
      errors.push(`${label} must be an integer 1–${ROSTER_SLOT_COUNT}.`);
    } else if (positions.has(card.Position)) {
      errors.push(`${label} is used more than once.`);
    } else {
      positions.add(card.Position);
    }
    if (!isInteger(card.Level) || card.Level < 1) errors.push(`${label}: level must be an integer >= 1.`);
    if (!isInteger(card.Rarity) || card.Rarity < RARITY_MIN || card.Rarity > RARITY_MAX) {
      errors.push(`${label}: rarity must be an integer ${RARITY_MIN}–${RARITY_MAX}.`);
    }
    if (!isInteger(card.EvolutionLevel) || card.EvolutionLevel < 0) {
      errors.push(`${label}: evolution level must be an integer >= 0.`);
    }
    if (!isNonNegativeNumber(card.LightFanAmount)) errors.push(`${label}: light fans must be >= 0.`);
    if (!isNonNegativeNumber(card.MiddleFanAmount)) errors.push(`${label}: middle fans must be >= 0.`);
    if (!isNonNegativeNumber(card.HeavyFanAmount)) errors.push(`${label}: heavy fans must be >= 0.`);
  }
  return errors;
}

/** Default id offered when duplicating a shared roster as an event-only copy. */
export function duplicateRosterId(id: string): string {
  return `${id}-copy`;
}
