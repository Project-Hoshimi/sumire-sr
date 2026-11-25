// Master:Get and the opt-in unknown-partition RaidQuest probe.
// Pure unit tests: a temp DATA_DIR supplies the manifest and probe entry, no DB.
//
//   node --test src/services/master.test.ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const VERSION = 'master-version-1';
const root = mkdtempSync(join(tmpdir(), 'sumire-master-'));
after(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(join(root, 'phaseA2', 'out'), { recursive: true });
mkdirSync(join(root, 'phaseA2', 'blobs_probe'), { recursive: true });
writeFileSync(join(root, 'phaseA2', 'out', 'manifest.json'), JSON.stringify({
  version: VERSION,
  partitions: [{
    type: 'Card',
    fileName: 'aa',
    fileSize: 4096,
    cryptoKey: 'bb',
    downloadUrl: 'https://climaster.game-idolypride.jp/Card/aa',
  }],
}));
const PROBE = {
  type: 'RaidQuest',
  fileName: 'ff',
  fileSize: 45056,
  cryptoKey: 'cc',
  downloadUrl: 'https://climaster.game-idolypride.jp/RaidQuest/ff',
};
writeFileSync(join(root, 'phaseA2', 'blobs_probe', 'RaidQuest.json'), JSON.stringify(PROBE));

// Set before importing master.ts, which resolves DATA_DIR at import time.
process.env.SUMIRE_DATA_DIR = root;

const { getHandler } = await import('./handlers.ts');
await import('./master.ts');
const { config } = await import('../config.ts');

const ctx = () => ({ fastifyReq: { log: { info() {} } } }) as any;
const masterGet = async () => (await getHandler('Master:Get')(ctx())) as any;

test('Master:Get rewrites the manifest downloads and leaves Version alone', async () => {
  delete process.env.SUMIRE_MASTER_PROBE_RAIDQUEST;
  const res = await masterGet();
  assert.equal(res.MasterTag.Version, VERSION);
  assert.equal(res.MasterTag.MasterTagPacks.length, 1);
  assert.deepEqual(res.MasterTag.MasterTagPacks[0], {
    __msg: 'Solis.Common.Proto.Transaction.MasterTagPack',
    Type: 'Card',
    FileName: 'aa',
    FileSize: 4096,
    CryptoKey: 'bb',
    DownloadUrl: `${config.publicBaseUrl}/master/Card/aa`,
  });
});

test('the probe flag appends one RaidQuest pack and a fresh Version', async () => {
  process.env.SUMIRE_MASTER_PROBE_RAIDQUEST = '1';
  try {
    const res = await masterGet();
    const packs = res.MasterTag.MasterTagPacks;
    assert.equal(packs.length, 2);
    assert.equal(packs[0].Type, 'Card');
    assert.deepEqual(packs[1], {
      __msg: 'Solis.Common.Proto.Transaction.MasterTagPack',
      Type: 'RaidQuest',
      FileName: PROBE.fileName,
      FileSize: PROBE.fileSize,
      CryptoKey: PROBE.cryptoKey,
      DownloadUrl: `${config.publicBaseUrl}/master/RaidQuest/${PROBE.fileName}`,
    });
    assert.equal(
      res.MasterTag.Version,
      createHash('sha256').update(`${VERSION}:probe-raidquest`).digest('hex'),
    );
  } finally {
    delete process.env.SUMIRE_MASTER_PROBE_RAIDQUEST;
  }
});

test('a non-"1" flag value keeps the probe off', async () => {
  process.env.SUMIRE_MASTER_PROBE_RAIDQUEST = 'true';
  try {
    const res = await masterGet();
    assert.equal(res.MasterTag.MasterTagPacks.length, 1);
    assert.equal(res.MasterTag.Version, VERSION);
  } finally {
    delete process.env.SUMIRE_MASTER_PROBE_RAIDQUEST;
  }
});
