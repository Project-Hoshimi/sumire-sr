// Router unhandled-RPC policy: unmapped names fail loudly unless tolerated.
// No DB, network or game data is needed; the tolerated name returns before any
// handler or database access.
//
//   node --test src/services/router.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { endpoints } from '@sumire-sr/protocol/gen/endpoints.ts';
import { dispatchRpc, TOLERATED_UNMAPPED_RPCS } from './router.ts';
import { NotImplementedError } from './errors.ts';

test('RPC name absent from the endpoint map throws NotImplementedError', async () => {
  await assert.rejects(
    dispatchRpc('Bogus:Nope', Buffer.alloc(0), {} as any),
    NotImplementedError,
  );
});

test('tolerated unmapped User:Title replies with an empty protobuf', async () => {
  // The tolerance is only meaningful while the name stays unmapped.
  assert.equal(endpoints.User?.Title, undefined);
  const bytes = await dispatchRpc('User:Title', Buffer.alloc(0), {} as any);
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes.length, 0);
});

test('TOLERATED_UNMAPPED_RPCS contains exactly User:Title', () => {
  assert.deepEqual([...TOLERATED_UNMAPPED_RPCS].sort(), ['User:Title']);
});
