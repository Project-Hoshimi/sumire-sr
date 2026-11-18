// End-to-end forced-relog tests through the real Fastify request pipeline:
// a published event change is answered with the title-screen headers
// (`x-error-action: title`, `x-error-code: 1003`) and the dialog message.
//
//   node --test src/services/eventRelog.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { mintToken, resetKeyCache } from '../auth/jwt.ts';
import { EVENT_RELOG_MESSAGE } from './errors.ts';
import {
  initEventRegistry,
  reloadEventRegistry,
  replaceEventSchedule,
  resetEventRegistryForTests,
} from './events/registry.ts';
import { memoryEventStore, type EventStore } from './events/store.ts';
import { resetClientStateCacheForTests } from './events/clientState.ts';
import { resetSessionFreshnessForTests } from './sessionFreshness.ts';
import { catalogDrafts } from './marathon/catalog.ts';
import { marathonPlugin, type MarathonDraft } from './marathon/plugin.ts';
import { buildServer } from '../server.ts';

const EVENT_ID = 'marathon-relog-e2e';
const RPC_URL = '/api.Notice/List';

let keyDir: string;
let app: FastifyInstance;
let store: EventStore & { reset(): void };
let token: string;

const original = {
  path: config.jwtPrivateKeyPath,
  privateKeyPem: config.jwt.privateKeyPem,
  publicKeyPem: config.jwt.publicKeyPem,
  relog: process.env.SUMIRE_EVENT_RELOG,
  wireSecKey: process.env.WIRE_SEC_KEY,
};

function scheduledDraft(id: string, startsAt: string): MarathonDraft {
  const base = catalogDrafts().find((d) => d.id === 'marathon-placeholder');
  assert.ok(base);
  return {
    ...base,
    id,
    schedule: { startsAt, endsAt: '2026-11-28T00:00:00Z', exchangeEndsAt: '2026-12-05T00:00:00Z' },
  };
}

before(async () => {
  keyDir = mkdtempSync(join(tmpdir(), 'sumire-relog-'));
  // The wire crypto is lazy; any key material works for the inject pipeline.
  process.env.WIRE_SEC_KEY = 'sumire-relog-test-sec-key';
  config.jwt.privateKeyPem = '';
  config.jwt.publicKeyPem = '';
  config.jwtPrivateKeyPath = join(keyDir, 'jwt-private.pem');
  resetKeyCache();
  token = mintToken({ sub: 'acc-relog', seedId: 'seed-relog' });
  assert.equal(typeof token, 'string');

  store = memoryEventStore();
  await initEventRegistry({
    store,
    drafts: [{ kind: 'marathon', draft: scheduledDraft(EVENT_ID, '2026-11-01T00:00:00Z') }],
  });
  app = buildServer();
  await app.ready();
});

after(async () => {
  await app.close();
  resetEventRegistryForTests();
  config.jwtPrivateKeyPath = original.path;
  config.jwt.privateKeyPem = original.privateKeyPem;
  config.jwt.publicKeyPem = original.publicKeyPem;
  if (original.relog === undefined) delete process.env.SUMIRE_EVENT_RELOG;
  else process.env.SUMIRE_EVENT_RELOG = original.relog;
  if (original.wireSecKey === undefined) delete process.env.WIRE_SEC_KEY;
  else process.env.WIRE_SEC_KEY = original.wireSecKey;
  resetKeyCache();
  rmSync(keyDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetSessionFreshnessForTests();
  resetClientStateCacheForTests();
  delete process.env.SUMIRE_EVENT_RELOG;
});

function call(url = RPC_URL, authToken: string | undefined = token) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/x-protobuf',
      ...(authToken ? { 'x-auth-token': authToken } : {}),
    },
    payload: Buffer.alloc(0),
  });
}

/** Change the published state clients can see (a schedule move). */
async function moveSchedule(startsAt: string): Promise<void> {
  await replaceEventSchedule(EVENT_ID, [
    { startsAt, endsAt: '2026-11-28T00:00:00Z', exchangeEndsAt: '2026-12-05T00:00:00Z' },
  ]);
  await reloadEventRegistry();
}

test('an unchanged event state never forces a relog', async () => {
  const first = await call();
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['x-error-action'], undefined);
  const second = await call();
  assert.equal(second.headers['x-error-action'], undefined);
});

test('a published event change answers with title/1003 once, then allows again', async () => {
  const first = await call();
  assert.equal(first.headers['x-error-action'], undefined);

  await moveSchedule('2026-11-02T00:00:00Z');

  const rejected = await call();
  assert.equal(rejected.statusCode, 200);
  assert.equal(rejected.headers['grpc-status'], '0', 'Solis-style OK status with title headers');
  assert.equal(rejected.headers['x-error-action'], 'title');
  assert.equal(rejected.headers['x-error-code'], '1003');
  assert.equal(
    Buffer.from(String(rejected.headers['x-error-message-bin']), 'base64').toString('utf8'),
    EVENT_RELOG_MESSAGE,
  );
  assert.equal(rejected.body.length, 0);

  // The stamp was dropped on rejection, so the next request re-stamps and runs.
  const allowed = await call();
  assert.equal(allowed.headers['x-error-action'], undefined);
});

test('exempt RPCs are never rejected, and do not re-stamp the session', async () => {
  await call(); // stamp
  await moveSchedule('2026-11-03T00:00:00Z');

  const exempt = await call('/api.System/Check');
  assert.equal(exempt.statusCode, 200);
  assert.equal(exempt.headers['x-error-action'], undefined);

  // The non-exempt RPC still sees the stale stamp and forces the relog.
  const rejected = await call();
  assert.equal(rejected.headers['x-error-action'], 'title');
});

test('SUMIRE_EVENT_RELOG=0 disables the check', async () => {
  await call();
  await moveSchedule('2026-11-04T00:00:00Z');
  process.env.SUMIRE_EVENT_RELOG = '0';
  const allowed = await call();
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers['x-error-action'], undefined);
});
