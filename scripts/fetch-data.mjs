#!/usr/bin/env node
// Fetch the published game-data repo into ./data at the tag in DATA_VERSION.
//
//   npm run data:fetch
//
// SUMIRE_DATA_REPO overrides the repository URL (useful for a local checkout):
//   SUMIRE_DATA_REPO=/path/to/sumire-sr-data npm run data:fetch
//
// Re-running is safe: an existing checkout at the requested tag is left alone.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'data');
const REPO = process.env.SUMIRE_DATA_REPO || 'https://github.com/project-hoshimi/sumire-sr-data';

function die(msg) {
  console.error(`fetch-data: ${msg}`);
  process.exit(1);
}

function git(args, opts = {}) {
  const res = spawnSync('git', args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    die(`git ${args.join(' ')} failed with exit code ${res.status}`);
  }
}

const versionFile = join(ROOT, 'DATA_VERSION');
if (!existsSync(versionFile)) die('DATA_VERSION is missing');
const tag = (process.env.SUMIRE_DATA_TAG || readFileSync(versionFile, 'utf8')).replace(/\s+/g, '');
if (!tag) die('DATA_VERSION is empty');

if (existsSync(join(DEST, '.git'))) {
  const desc = spawnSync('git', ['-C', DEST, 'describe', '--tags', '--exact-match'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const current = desc.status === 0 ? desc.stdout.trim() : '';
  if (current === tag) {
    console.log(`fetch-data: ${DEST} already at ${tag}`);
  } else {
    console.log(`fetch-data: updating ${DEST} to ${tag}`);
    git(['-C', DEST, 'fetch', '--depth', '1', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
    git(['-C', DEST, 'checkout', '-q', `tags/${tag}`]);
  }
} else {
  if (existsSync(DEST) && readdirSync(DEST).length > 0) {
    die(`${DEST} exists and is not a git checkout; move it away first`);
  }
  console.log(`fetch-data: cloning ${REPO} at ${tag} into ${DEST}`);
  git(['clone', '--depth', '1', '--branch', tag, REPO, DEST]);
}

const requiredFiles = ['phaseA2/out/manifest.json', 'captures/identity.json', 'diaries.json'];
for (const rel of requiredFiles) {
  if (!existsSync(join(DEST, ...rel.split('/')))) {
    die(`${DEST} is missing ${rel}`);
  }
}

console.log(`fetch-data: ready at ${DEST}`);
