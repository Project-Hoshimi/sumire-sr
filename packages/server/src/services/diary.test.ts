// Diary catalog loader: a missing catalog must not block boot, a malformed one
// must still fail loudly. No DB, no real game data.
//
//   node --test src/services/diary.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadDiaries } from './diary.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sumire-diary-'));
}

test('missing catalog returns an empty list', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(loadDiaries(join(dir, 'diaries.json')), []);
});

test('present catalog is parsed', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'diaries.json');
  const entries = [{ id: 'd1', year: 2024, month: 1, day: 2, assetId: 'asset-1' }];
  writeFileSync(path, JSON.stringify(entries));
  assert.deepEqual(loadDiaries(path), entries);
});

test('malformed catalog throws', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'diaries.json');
  writeFileSync(path, '{ not json');
  assert.throws(() => loadDiaries(path), SyntaxError);
});
