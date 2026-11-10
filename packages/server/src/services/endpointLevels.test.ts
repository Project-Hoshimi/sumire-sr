// Recorded endpoint levels: every entry names a real protocol endpoint, uses a
// valid level, and stays sorted for the docs generator.
//
//   node --test src/services/endpointLevels.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { endpoints } from '@sumire-sr/protocol/gen/endpoints.ts';
import { ENDPOINT_LEVELS } from './endpointLevels.ts';

const VALID_LEVELS = new Set(['stub', 'sandbox-ok', 'parity']);
const endpointMap = endpoints as unknown as Record<string, Record<string, unknown>>;

test('every recorded endpoint has the form Service:Method and exists in the protocol', () => {
  for (const name of Object.keys(ENDPOINT_LEVELS)) {
    const parts = name.split(':');
    assert.equal(parts.length, 2, `${name} is not Service:Method`);
    const [service, method] = parts;
    assert.ok(endpointMap[service]?.[method], `${name} is not in the protocol endpoint map`);
  }
});

test('every recorded level is valid', () => {
  for (const [name, level] of Object.entries(ENDPOINT_LEVELS)) {
    assert.ok(VALID_LEVELS.has(level), `${name} has invalid level ${level}`);
  }
});

test('recorded endpoints are sorted by name', () => {
  const names = Object.keys(ENDPOINT_LEVELS);
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(names, sorted);
});
