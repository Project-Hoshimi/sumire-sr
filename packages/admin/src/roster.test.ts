import { describe, expect, it } from 'vitest';
import { emptyRosterCard, normalizeRosterCards, validateRosterForm } from './roster.ts';
import type { NpcRosterCard } from './types.ts';

function card(position: number, cardId: string): NpcRosterCard {
  return { ...emptyRosterCard(position), CardId: cardId };
}

function fiveCards(): NpcRosterCard[] {
  return [1, 2, 3, 4, 5].map((position) => card(position, `card-${position}`));
}

describe('normalizeRosterCards', () => {
  it('pads a short roster to five blank slots', () => {
    const result = normalizeRosterCards([card(1, 'a')]);
    expect(result).toHaveLength(5);
    expect(result[0]?.CardId).toBe('a');
    expect(result[4]).toEqual(emptyRosterCard(5));
  });

  it('orders by Position, renumbers 1–5 and trims extras', () => {
    const result = normalizeRosterCards([
      card(3, 'c'),
      card(1, 'a'),
      card(2, 'b'),
      card(4, 'd'),
      card(5, 'e'),
      card(6, 'f'),
    ]);
    expect(result.map((entry) => entry.CardId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result.map((entry) => entry.Position)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('validateRosterForm', () => {
  it('accepts a complete five-card roster', () => {
    expect(validateRosterForm('Roster', 10, fiveCards())).toEqual([]);
  });

  it('accepts a three-card roster and ignores the empty trailing slots', () => {
    const cards = normalizeRosterCards(fiveCards().slice(0, 3));
    expect(validateRosterForm('Roster', 1, cards)).toEqual([]);
  });

  it('reports blank names, bad manager levels and bad rarities in filled slots', () => {
    const cards = fiveCards();
    cards[0] = { ...(cards[0] as NpcRosterCard), CardId: '' };
    cards[1] = { ...(cards[1] as NpcRosterCard), Rarity: 11 };
    const errors = validateRosterForm('  ', 0, cards);
    expect(errors).toContain('Name must not be empty.');
    expect(errors).toContain('Manager level must be an integer >= 1.');
    expect(errors).not.toContain('Position 1: choose a card.');
    expect(errors).toContain('Position 2: rarity must be an integer 1–10.');
  });

  it('requires at least one filled card', () => {
    expect(validateRosterForm('Roster', 1, normalizeRosterCards([]))).toContain(
      'At least one card is required.',
    );
  });
});
