// Capture-name portability tests. Data-free: synthetic capture bytes in a temp SUMIRE_DATA_DIR.
// `Service:Method` file names cannot exist on NTFS, so `Service@Method` must work everywhere.
//
//   node src/services/replay/corpus.test.ts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const base = mkdtempSync(join(tmpdir(), 'sumire-corpus-'));
process.env.SUMIRE_DATA_DIR = base;
const corpusDir = join(base, 'captures', '2026-09-14_a12r', 'raw');
const freshDir = join(base, 'captures', '2026-10-25_fresh_official', 'raw');
mkdirSync(corpusDir, { recursive: true });
mkdirSync(freshDir, { recursive: true });
writeFileSync(join(corpusDir, '00001.req-plain.Home@Enter.bin'), Buffer.from([1]));
writeFileSync(join(corpusDir, '00002.resp-plain.Home@Enter.bin'), Buffer.from([2, 2]));
writeFileSync(join(corpusDir, '00003.resp-plain.Home@Weird-name.bin'), Buffer.from([9]));
writeFileSync(join(freshDir, '00005.resp-plain.User@Get.bin'), Buffer.from([5, 5, 5]));

// Import after SUMIRE_DATA_DIR is set: config.ts resolves DATA_DIR at load time.
const corpus = await import('./corpus.ts');

after(() => rmSync(base, { recursive: true, force: true }));

test('portableCaptureName replaces only the service/method separator', () => {
  assert.equal(corpus.portableCaptureName('00005.resp-plain.User:Get.bin'), '00005.resp-plain.User@Get.bin');
  assert.equal(corpus.portableCaptureName('00005.resp-plain.User@Get.bin'), '00005.resp-plain.User@Get.bin');
  assert.equal(corpus.portableCaptureName('notes:txt'), 'notes:txt');
});

test('the corpus listing accepts the portable spelling and pairs requests', () => {
  corpus.loadCorpus();
  assert.deepEqual(corpus.getCorpusResponse('Home:Enter'), Buffer.from([2, 2]));
  assert.ok(corpus.listCorpusNames().includes('Home:Enter'));
  assert.ok(!corpus.listCorpusNames().some((n) => n.includes('Weird')));
});

test('fresh captures resolve by the original and the portable name', () => {
  assert.deepEqual(corpus.getFreshCapture('00005.resp-plain.User:Get.bin'), Buffer.from([5, 5, 5]));
  assert.deepEqual(corpus.getFreshCapture('00005.resp-plain.User@Get.bin'), Buffer.from([5, 5, 5]));
  assert.deepEqual(corpus.getFreshCaptureByName('User:Get'), Buffer.from([5, 5, 5]));
  assert.equal(corpus.getFreshCapture('00099.resp-plain.Missing:Call.bin'), null);
});
