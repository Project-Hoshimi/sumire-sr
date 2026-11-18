/**
 * Searchable card select for roster slots. Filtering is client-side over the
 * lookup payload (`GET /lookup/cards`), matching English and Japanese names,
 * id and character id.
 */
import { useMemo, useState } from 'react';
import type { LookupCard } from '../types.ts';

function labelOf(card: LookupCard): string {
  const name = card.nameEn ?? card.name ?? card.id;
  const character = card.characterNameEn ?? card.characterId ?? '—';
  return `${name} · rarity ${card.rarity ?? '?'} · ${character}`;
}

export function CardPicker({
  position,
  cards,
  value,
  disabled,
  onChange,
}: {
  position: number;
  cards: readonly LookupCard[];
  value: string;
  disabled?: boolean;
  onChange: (cardId: string) => void;
}) {
  const [query, setQuery] = useState('');

  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches =
      needle === ''
        ? [...cards]
        : cards.filter((card) =>
            [
              card.name ?? '',
              card.nameEn ?? '',
              card.id,
              card.characterId ?? '',
              card.characterNameEn ?? '',
            ].some((field) => field.toLowerCase().includes(needle)),
          );
    // Keep the current selection visible even when the filter hides it.
    if (value !== '' && !matches.some((card) => card.id === value)) {
      const selected = cards.find((card) => card.id === value);
      if (selected !== undefined) matches.unshift(selected);
    }
    return matches;
  }, [cards, query, value]);

  return (
    <div className="card-picker">
      <input
        type="search"
        aria-label={`Search cards for position ${position}`}
        placeholder="Search cards by name"
        value={query}
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
      />
      <select
        aria-label={`Card for position ${position}`}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose a card…</option>
        {options.map((card) => (
          <option key={card.id} value={card.id}>
            {labelOf(card)}
          </option>
        ))}
      </select>
    </div>
  );
}
