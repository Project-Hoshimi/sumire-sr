// Main-module detection must survive Windows paths, percent-encoding and
// symlinked checkouts. This test does not import server.ts (it would start a
// listener); it exercises the helper directly.
//
//   node --test src/mainModule.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { isMainModule } from './mainModule.ts';

test('undefined argv1 is not the main module', () => {
  assert.equal(isMainModule(import.meta.url, undefined), false);
});

test('POSIX plain path matches its file URL', () => {
  const path = '/opt/sumire/packages/server/src/server.ts';
  assert.equal(isMainModule(pathToFileURL(path).href, path), true);
});

test('POSIX path with a space matches a percent-encoded URL', () => {
  const path = '/opt/my projects/sumire/src/server.ts';
  const metaUrl = pathToFileURL(path).href; // contains %20
  assert.equal(isMainModule(metaUrl, path), true);
  // The old template comparison does not percent-encode and must fail here.
  assert.equal(`file://${path}` === metaUrl, false);
});

test('real symlink resolves to the module real path', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sumire-main-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'server.ts');
  const link = join(dir, 'server-link.ts');
  writeFileSync(target, '// synthetic\n');
  symlinkSync(target, link);
  assert.equal(isMainModule(pathToFileURL(target).href, link), true);
});

test('different file is not the main module', () => {
  assert.equal(
    isMainModule(pathToFileURL('/opt/sumire/src/server.ts').href, '/opt/sumire/src/other.ts'),
    false,
  );
});

test('Windows paths use drive letters and are compared case-insensitively', () => {
  const argv1: string = 'C:\\repo\\packages\\server\\src\\server.ts';
  const metaUrl: string = 'file:///C:/repo/packages/server/src/server.ts';
  assert.equal(isMainModule(metaUrl, argv1, { windows: true }), true);

  const lowerDrive = 'c:\\repo\\packages\\server\\src\\server.ts';
  assert.equal(isMainModule(metaUrl, lowerDrive, { windows: true }), true);

  assert.equal(
    isMainModule(metaUrl, 'C:\\repo\\packages\\server\\src\\other.ts', { windows: true }),
    false,
  );

  // Documents why the old template comparison was replaced: it compares a
  // backslash path against a slash/percent URL and never matches.
  assert.equal(`file://${argv1}` === metaUrl, false);
});
