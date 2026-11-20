// Translation-data lookup tests: a temporary fixture checkout stands in for
// `Project-Hoshimi/ipr-translation-data-en`, so the real data is never read.
//
//   node --test src/services/translations.test.ts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import {
  ensureTranslationsLoaded,
  masterName,
  resetTranslationsForTests,
  textName,
} from './translations.ts';

const MASTER = {
  Card: { 'card-ai-02-eve-00|name': 'Eve', 'card-ai-02-eve-00|nickname': 'Evie' },
  Item: { 'item-1|name': 'Item One' },
  MarathonQuest: { 'quest-1|name': 'Quest One' },
  Character: { 'char-ai|name': 'Ai' },
};

const GENERIC: Record<string, Record<string, string>> = {
  'zz-master-names.json': {
    '導きのファンファーレ': 'Fanfare of Guidance',
    '共通の名前': 'Master name wins',
  },
  'generic.json': {
    '共通の名前': 'Generic loses',
    ライブ: 'Live',
    '[__split__]位': '[__split__]Rank',
    'duplicate': 'from generic',
  },
  'generic.tier3.json': { duplicate: 'from tier3' },
};

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

/** Build a fixture checkout whose root contains `local-files/`. */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'sumire-translations-'));
  const masterDir = join(root, 'local-files', 'masterTrans');
  const genericDir = join(root, 'local-files', 'genericTrans');
  mkdirSync(masterDir, { recursive: true });
  mkdirSync(genericDir, { recursive: true });
  for (const [table, data] of Object.entries(MASTER)) {
    writeJson(join(masterDir, `${table}.json`), { rule: [], data });
  }
  for (const [file, data] of Object.entries(GENERIC)) {
    writeJson(join(genericDir, file), data);
  }
  return root;
}

let previousDir: string | undefined;
let fixture: string | undefined;

beforeEach(() => {
  previousDir = process.env.SUMIRE_TRANSLATION_DIR;
  resetTranslationsForTests();
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.SUMIRE_TRANSLATION_DIR;
  else process.env.SUMIRE_TRANSLATION_DIR = previousDir;
  resetTranslationsForTests();
  if (fixture !== undefined) {
    rmSync(fixture, { recursive: true, force: true });
    fixture = undefined;
  }
});

test('master names come from masterTrans/<Table>.json id|field keys', async () => {
  fixture = makeFixture();
  process.env.SUMIRE_TRANSLATION_DIR = fixture;
  await ensureTranslationsLoaded();

  assert.equal(masterName('Card', 'card-ai-02-eve-00'), 'Eve');
  assert.equal(masterName('Card', 'card-ai-02-eve-00', 'nickname'), 'Evie');
  assert.equal(masterName('Item', 'item-1'), 'Item One');
  assert.equal(masterName('MarathonQuest', 'quest-1'), 'Quest One');
  assert.equal(masterName('Character', 'char-ai'), 'Ai');
  assert.equal(masterName('Card', 'missing'), undefined);
  assert.equal(masterName('MissingTable', 'card-ai-02-eve-00'), undefined);
});

test('generic text matches exactly and zz-master-names.json wins', async () => {
  fixture = makeFixture();
  process.env.SUMIRE_TRANSLATION_DIR = fixture;
  await ensureTranslationsLoaded();

  assert.equal(textName('導きのファンファーレ'), 'Fanfare of Guidance');
  assert.equal(textName('共通の名前'), 'Master name wins');
  assert.equal(textName('ライブ'), 'Live');
  // The alphabetically earlier generic file wins over a later one.
  assert.equal(textName('duplicate'), 'from generic');
  assert.equal(textName('missing text'), undefined);
});

test('[__split__] keys are not treated as display text', async () => {
  fixture = makeFixture();
  process.env.SUMIRE_TRANSLATION_DIR = fixture;
  await ensureTranslationsLoaded();

  assert.equal(textName('[__split__]位'), undefined);
});

test('the built-in fallback is used only when nothing matches', async () => {
  fixture = makeFixture();
  process.env.SUMIRE_TRANSLATION_DIR = fixture;
  await ensureTranslationsLoaded();
  // Not present in the fixture.
  assert.equal(textName('対戦アイドル'), 'Rival Idol');
});

test('an unset directory makes every lookup undefined', async () => {
  delete process.env.SUMIRE_TRANSLATION_DIR;
  await ensureTranslationsLoaded();

  assert.equal(masterName('Card', 'card-ai-02-eve-00'), undefined);
  assert.equal(textName('導きのファンファーレ'), undefined);
  assert.equal(textName('対戦アイドル'), 'Rival Idol');
});

test('an unreadable directory makes every lookup undefined', async () => {
  fixture = makeFixture();
  // Point at a child that does not exist: the event templates under a mistyped
  // checkout path should degrade to Japanese instead of failing the server.
  process.env.SUMIRE_TRANSLATION_DIR = join(fixture, 'does-not-exist');
  await ensureTranslationsLoaded();

  assert.equal(masterName('Card', 'card-ai-02-eve-00'), undefined);
  assert.equal(textName('導きのファンファーレ'), undefined);
});

test('a malformed master file is skipped without losing the others', async () => {
  fixture = makeFixture();
  writeFileSync(join(fixture, 'local-files', 'masterTrans', 'Card.json'), '{ not json', 'utf8');
  process.env.SUMIRE_TRANSLATION_DIR = fixture;
  await ensureTranslationsLoaded();

  assert.equal(masterName('Character', 'char-ai'), 'Ai');
  assert.equal(masterName('Card', 'card-ai-02-eve-00'), undefined);
});

test('a malformed generic file is skipped without losing the others', async () => {
  fixture = makeFixture();
  writeFileSync(join(fixture, 'local-files', 'genericTrans', 'broken.json'), '{ not json', 'utf8');
  process.env.SUMIRE_TRANSLATION_DIR = fixture;
  await ensureTranslationsLoaded();

  assert.equal(textName('導きのファンファーレ'), 'Fanfare of Guidance');
  assert.equal(textName('ライブ'), 'Live');
});

test('prototype keys are never returned as translations', async () => {
  fixture = makeFixture();
  process.env.SUMIRE_TRANSLATION_DIR = fixture;
  await ensureTranslationsLoaded();

  assert.equal(textName('constructor'), undefined);
  assert.equal(textName('toString'), undefined);
  assert.equal(textName('__proto__'), undefined);
});

test('concurrent first lookups share one load', async () => {
  process.env.SUMIRE_TRANSLATION_DIR = fixture = makeFixture();
  await Promise.all([ensureTranslationsLoaded(), ensureTranslationsLoaded()]);

  assert.equal(masterName('Card', 'card-ai-02-eve-00'), 'Eve');
});
