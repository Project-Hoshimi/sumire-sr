// node --test src/env.test.ts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { findEnvFile, loadEnv } from './env.ts';

// A workspace checkout: root/{.git,package.json,.env}, root/packages/server.
function checkout(t: TestContext): { root: string; pkg: string } {
  const root = mkdtempSync(join(tmpdir(), 'sumire-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'packages', 'server');
  mkdirSync(pkg, { recursive: true });
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, '.env'), 'SUMIRE_DATA_DIR=./data\nJWT_PRIVATE_KEY_PATH=/abs/key.pem\nPORT=8080\n');
  return { root, pkg };
}

test('a workspace package finds the root .env and paths resolve against it', (t) => {
  const { root, pkg } = checkout(t);
  const env: NodeJS.ProcessEnv = {};
  loadEnv(pkg, env);
  assert.equal(env.SUMIRE_DATA_DIR, join(root, 'data'));
  assert.equal(env.JWT_PRIVATE_KEY_PATH, '/abs/key.pem');
  assert.equal(env.PORT, '8080');
});

test('variables already set win over .env', (t) => {
  const { pkg } = checkout(t);
  const env: NodeJS.ProcessEnv = { SUMIRE_DATA_DIR: 'kept', PORT: '1' };
  loadEnv(pkg, env);
  assert.equal(env.SUMIRE_DATA_DIR, 'kept');
  assert.equal(env.PORT, '1');
});

test('a .env in the working directory comes first', (t) => {
  const { pkg } = checkout(t);
  writeFileSync(join(pkg, '.env'), 'PORT=9\n');
  const env: NodeJS.ProcessEnv = {};
  loadEnv(pkg, env);
  assert.deepEqual(env, { PORT: '9' });
});

test('the search stops at the checkout root', (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'sumire-env-outer-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  writeFileSync(join(outer, 'package.json'), '{}');
  writeFileSync(join(outer, '.env'), 'PORT=1\n');
  const repo = join(outer, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  assert.equal(findEnvFile(repo), null);
});
