// Deck:Save position validation. Pure unit tests of `validateDeckPositions`; no database.
//
//   node --test src/services/deck.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDeckPositions } from './deck.ts';

const MSG = 'Deck:Save: deck positions and cards must be unique, with positions in 1..5';

test('five distinct positions and cards: valid', () => {
  const positions = [1, 2, 3, 4, 5].map((p) => ({ Position: p, CardId: `card-${p}` }));
  assert.equal(validateDeckPositions(positions as never), null);
});

test('partial deck with two entries: valid', () => {
  const positions = [
    { Position: 1, CardId: 'card-a' },
    { Position: 3, CardId: 'card-b' },
  ];
  assert.equal(validateDeckPositions(positions as never), null);
});

test('duplicate CardId: rejected', () => {
  const positions = [
    { Position: 1, CardId: 'card-a' },
    { Position: 2, CardId: 'card-a' },
  ];
  assert.equal(validateDeckPositions(positions as never), MSG);
});

test('duplicate Position: rejected', () => {
  const positions = [
    { Position: 2, CardId: 'card-a' },
    { Position: 2, CardId: 'card-b' },
  ];
  assert.equal(validateDeckPositions(positions as never), MSG);
});

test('Position 0 and Position 6: rejected', () => {
  assert.equal(validateDeckPositions([{ Position: 0, CardId: 'card-a' }] as never), MSG);
  assert.equal(validateDeckPositions([{ Position: 6, CardId: 'card-a' }] as never), MSG);
});

test('six entries: rejected', () => {
  const positions = [1, 2, 3, 4, 5, 1].map((p, i) => ({ Position: p, CardId: `card-${i}` }));
  assert.equal(validateDeckPositions(positions as never), MSG);
});

test('empty CardId with valid Position: valid', () => {
  assert.equal(validateDeckPositions([{ Position: 4, CardId: '' }] as never), null);
  assert.equal(validateDeckPositions([{ Position: 4 }] as never), null);
});
