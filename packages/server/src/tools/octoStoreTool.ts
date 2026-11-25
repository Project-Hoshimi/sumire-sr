// Operator tool for the experimental local Octo store (`src/octoStore.ts`,
// docs/ASSET_MIRROR.md §0): build the store's database file, fill the store from
// files you already have, and check the store. Offline only: it never downloads.
//
//   npm run -w packages/server octo -- decrypt <list.bin> <out.plain> [--force]
//   npm run -w packages/server octo -- import [--db <db>] --to <dir> [--apply]
//       [--prefix <name prefix>]… [--max-bytes <n[K|M|G|T]>] <source dir>…
//   npm run -w packages/server octo -- verify [--db <db>] [--assets <dirs>]
//       [--quick] [--orphans] [--report <file.json>]
//
// `--db` defaults to SUMIRE_OCTO_DATABASE and `--assets` to SUMIRE_OCTO_ASSETS
// (several directories separated by the platform path delimiter, as for the
// server). `decrypt` reads SUMIRE_OCTO_AES_KEY / SUMIRE_OCTO_AES_IV (hex) from the
// environment or .env; keys are never taken from the command line or source.
//
// Exit codes: 0 done and clean; 1 problems found (verify) or files rejected
// (import); 2 usage or fatal error.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainModule } from '../mainModule.ts';
import {
  OCTO_STATE_LATEST,
  decryptOctoList,
  indexOctoDatabase,
  octoFileCandidates,
  type OctoEntry,
} from '../octoStore.ts';

const MD5_NAME_RE = /^[0-9a-fA-F]{32}$/;

type Log = (line: string) => void;

// --- shared helpers -----------------------------------------------------------

/** MD5 of a file, streamed. */
export async function md5File(path: string): Promise<string> {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Parse `123`, `64K`, `1.5G` … (binary units) into bytes. */
export function parseSize(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:i?B)?$/i.exec(text.trim());
  if (!m) throw new Error(`not a size: ${text}`);
  const unit = { '': 0, K: 1, M: 2, G: 3, T: 4 }[m[2].toUpperCase() as '' | 'K' | 'M' | 'G' | 'T'];
  return Math.floor(Number(m[1]) * 1024 ** unit);
}

export function formatBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${v.toFixed(2)} ${units[i]}`;
}

/** Short group key for reports: the first two `_` segments of an asset name. */
export function namePrefix(name: string): string {
  return name.split('_').slice(0, 2).join('_') || '(unnamed)';
}

/**
 * Every regular file below `dir`. Symlinks and junctions are not followed, so a
 * walk never leaves the directories it was given. A missing directory (ENOENT) yields
 * nothing: an empty or not-yet-created store is not an error, but any other problem is.
 */
async function* walkFiles(dir: string): AsyncGenerator<{ path: string; size: number }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`cannot read directory ${dir}: ${(err as Error).message}`);
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* walkFiles(path);
    else if (e.isFile()) {
      const st = await lstat(path);
      if (st.isFile()) yield { path, size: st.size };
    }
  }
}

/** Unique files the database lists, keyed by MD5, with every entry that uses each. */
function filesByMd5(entries: Iterable<OctoEntry>): Map<string, { size: number; entries: OctoEntry[] }> {
  const files = new Map<string, { size: number; entries: OctoEntry[] }>();
  for (const e of entries) {
    const f = files.get(e.md5);
    if (f) f.entries.push(e);
    else files.set(e.md5, { size: e.size, entries: [e] });
  }
  return files;
}

async function regularSize(path: string): Promise<number | null> {
  try {
    const st = await stat(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// --- decrypt ------------------------------------------------------------------

export type DecryptResult = {
  database: Buffer;
  revision: number;
  assetbundles: number;
  resources: number;
  /** Entries whose state is not LATEST: present only in a diff list. */
  notLatest: number;
};

/** Decrypt a saved list response body and check that it is a usable database. */
export function decryptList(body: Uint8Array, key: Buffer, iv: Buffer): DecryptResult {
  if (key.length !== 32) throw new Error('AES key must be 32 bytes (64 hex chars)');
  if (iv.length !== 16) throw new Error('AES IV must be 16 bytes (32 hex chars)');
  let database: Buffer;
  try {
    database = decryptOctoList(body, key, iv);
  } catch (err) {
    throw new Error(`cannot decrypt the list (wrong key or IV, or not an Octo list body): ${(err as Error).message}`);
  }
  let index;
  try {
    index = indexOctoDatabase(database);
  } catch (err) {
    throw new Error(`decrypted data is not an Octo database: ${(err as Error).message}`);
  }
  if (index.entries.size === 0) throw new Error('decrypted data has no entries; wrong key or not an Octo list body');
  let assetbundles = 0;
  let notLatest = 0;
  for (const e of index.entries.values()) {
    if (e.kind === 'assetbundle') assetbundles++;
    if (e.state !== OCTO_STATE_LATEST) notLatest++;
  }
  return {
    database,
    revision: index.revision,
    assetbundles,
    resources: index.entries.size - assetbundles,
    notLatest,
  };
}

async function writeAtomic(path: string, data: Uint8Array, force: boolean): Promise<void> {
  if (!force && (await regularSize(path)) !== null) throw new Error(`${path} exists; pass --force to replace it`);
  await mkdir(dirname(resolve(path)), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

// --- import -------------------------------------------------------------------

export type ImportOptions = {
  database: Uint8Array;
  /** Store directory to write into, as `<md5[0:2]>/<md5>`. */
  to: string;
  sources: string[];
  /** Write files. Without it nothing is written and MD5s are not checked. */
  apply: boolean;
  /** Only files used by an entry whose name starts with one of these. */
  prefixes?: string[];
  /** Upper bound on bytes copied (or planned) in this run. */
  maxBytes?: number;
  log?: Log;
};

export type ImportResult = {
  applied: boolean;
  /** Unique files selected (after the prefix filter). */
  selected: number;
  /** Selected files already in the store at the manifest size. */
  present: number;
  copied: { files: number; bytes: number };
  /** Selected files left out because of `maxBytes`. */
  overBudget: { files: number; bytes: number };
  /** Selected files not found in any source (or only as rejected copies). */
  notFound: { files: number; bytes: number };
  rejected: { path: string; md5: string; reason: string }[];
};

/** Copy `src` to `dest` through a temp file, only if it has the expected size and MD5. */
async function copyVerified(src: string, dest: string, size: number, md5: string): Promise<string | null> {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${randomBytes(6).toString('hex')}`;
  const hash = createHash('md5');
  let written = 0;
  const out = await open(tmp, 'wx');
  let committed = false;
  try {
    try {
      for await (const chunk of createReadStream(src)) {
        const b = chunk as Buffer;
        hash.update(b);
        written += b.length;
        // write() may write fewer bytes than asked; keep going until the chunk is out.
        for (let offset = 0; offset < b.length; ) {
          offset += (await out.write(b, offset, b.length - offset)).bytesWritten;
        }
      }
    } catch (err) {
      return `read failed: ${(err as Error).message}`;
    }
    const digest = hash.digest('hex');
    const reason = written !== size ? `size ${written}, manifest ${size}` : digest !== md5 ? 'md5 mismatch' : null;
    if (reason !== null) return reason;
    await rename(tmp, dest);
    committed = true;
    return null;
  } finally {
    await out.close().catch(() => {});
    // Never leak the temp file, whatever failed above (rename included); a failed
    // unlink is ignored because the copy already failed for a more useful reason.
    if (!committed) await unlink(tmp).catch(() => {});
  }
}

export async function importStore(opts: ImportOptions): Promise<ImportResult> {
  const log = opts.log ?? (() => {});
  const to = resolve(opts.to);
  const prefixes = opts.prefixes ?? [];
  const maxBytes = opts.maxBytes ?? Infinity;
  const { entries } = indexOctoDatabase(opts.database);
  const all = filesByMd5(entries.values());
  const result: ImportResult = {
    applied: opts.apply,
    selected: 0,
    present: 0,
    copied: { files: 0, bytes: 0 },
    overBudget: { files: 0, bytes: 0 },
    notFound: { files: 0, bytes: 0 },
    rejected: [],
  };

  // Files still needed: selected by prefix and not already in the store.
  const needed = new Map<string, number>();
  for (const [md5, f] of all) {
    if (prefixes.length > 0 && !f.entries.some((e) => prefixes.some((p) => e.name.startsWith(p)))) continue;
    result.selected++;
    let present = false;
    for (const path of octoFileCandidates(to, md5)) {
      if ((await regularSize(path)) === f.size) {
        present = true;
        break;
      }
    }
    if (present) result.present++;
    else needed.set(md5, f.size);
  }

  // Candidate source files, named by an MD5 that is still needed.
  const candidates = new Map<string, { path: string; size: number }[]>();
  for (const source of opts.sources) {
    let seen = 0;
    for await (const file of walkFiles(resolve(source))) {
      const name = basename(file.path);
      if (!MD5_NAME_RE.test(name)) continue;
      const md5 = name.toLowerCase();
      if (!needed.has(md5)) continue;
      const list = candidates.get(md5);
      if (list) list.push(file);
      else candidates.set(md5, [file]);
      if (++seen % 5000 === 0) log(`  scanned ${seen} candidate files in ${source}`);
    }
  }

  const order = [...needed.keys()].sort();
  let done = 0;
  for (const md5 of order) {
    const size = needed.get(md5)!;
    const files = candidates.get(md5) ?? [];
    if (files.length === 0) {
      result.notFound.files++;
      result.notFound.bytes += size;
      continue;
    }
    if (result.copied.bytes + size > maxBytes) {
      result.overBudget.files++;
      result.overBudget.bytes += size;
      continue;
    }
    const dest = octoFileCandidates(to, md5)[0];
    let ok = false;
    for (const file of files) {
      if (file.size !== size) {
        result.rejected.push({ path: file.path, md5, reason: `size ${file.size}, manifest ${size}` });
        continue;
      }
      if (resolve(file.path) === dest) continue;
      if (!opts.apply) {
        ok = true;
        break;
      }
      const reason = await copyVerified(file.path, dest, size, md5);
      if (reason === null) {
        ok = true;
        break;
      }
      result.rejected.push({ path: file.path, md5, reason });
    }
    if (ok) {
      result.copied.files++;
      result.copied.bytes += size;
      if (opts.apply && ++done % 1000 === 0) log(`  copied ${done} files (${formatBytes(result.copied.bytes)})`);
    } else {
      result.notFound.files++;
      result.notFound.bytes += size;
    }
  }
  return result;
}

// --- verify -------------------------------------------------------------------

export type VerifyProblem = {
  objectName: string;
  name: string;
  md5: string;
  size: number;
  /** missing: no file; size: only wrong-sized files; md5: the file the server would serve has the wrong content. */
  problem: 'missing' | 'size' | 'md5';
  path?: string;
  actualSize?: number;
};

export type VerifyOptions = {
  database: Uint8Array;
  assetDirs: string[];
  /** Check sizes only; skip MD5 hashing. */
  quick?: boolean;
  /** Also list files in the asset directories that the database does not know. */
  orphans?: boolean;
  log?: Log;
};

export type VerifyResult = {
  revision: number;
  entries: number;
  files: number;
  quick: boolean;
  ok: { entries: number; files: number; bytes: number };
  problems: VerifyProblem[];
  /** Problem counts per name prefix. */
  byPrefix: Record<string, { missing: number; size: number; md5: number; bytes: number }>;
  orphans?: string[];
};

export async function verifyStore(opts: VerifyOptions): Promise<VerifyResult> {
  const log = opts.log ?? (() => {});
  const dirs = opts.assetDirs.map((d) => resolve(d));
  if (dirs.length === 0) throw new Error('at least one asset directory is required');
  const { revision, entries } = indexOctoDatabase(opts.database);
  const files = filesByMd5(entries.values());

  type Status = { problem: VerifyProblem['problem'] | null; path?: string; actualSize?: number };
  const status = new Map<string, Status>();
  let checked = 0;
  await pool([...files], 4, async ([md5, f]) => {
    // Same rule as OctoStore.open(): the first regular file of the manifest size is served.
    let served: string | undefined;
    let wrongSized: { path: string; size: number } | undefined;
    for (const dir of dirs) {
      for (const path of octoFileCandidates(dir, md5)) {
        const size = await regularSize(path);
        if (size === null) continue;
        if (size === f.size) {
          served = path;
          break;
        }
        wrongSized ??= { path, size };
      }
      if (served) break;
    }
    let s: Status;
    if (served) {
      s = opts.quick || (await md5File(served)) === md5 ? { problem: null } : { problem: 'md5', path: served };
    } else if (wrongSized) {
      s = { problem: 'size', path: wrongSized.path, actualSize: wrongSized.size };
    } else s = { problem: 'missing' };
    status.set(md5, s);
    if (++checked % 5000 === 0) log(`  checked ${checked}/${files.size} files`);
  });

  const result: VerifyResult = {
    revision,
    entries: entries.size,
    files: files.size,
    quick: opts.quick === true,
    ok: { entries: 0, files: 0, bytes: 0 },
    problems: [],
    byPrefix: {},
  };
  for (const [md5, f] of files) {
    const s = status.get(md5)!;
    if (s.problem === null) {
      result.ok.files++;
      result.ok.bytes += f.size;
      result.ok.entries += f.entries.length;
      continue;
    }
    for (const e of f.entries) {
      result.problems.push({
        objectName: e.objectName,
        name: e.name,
        md5,
        size: f.size,
        problem: s.problem,
        ...(s.path ? { path: s.path } : {}),
        ...(s.actualSize !== undefined ? { actualSize: s.actualSize } : {}),
      });
      const g = (result.byPrefix[namePrefix(e.name)] ??= { missing: 0, size: 0, md5: 0, bytes: 0 });
      g[s.problem]++;
      g.bytes += f.size;
    }
  }
  result.problems.sort((a, b) => a.name.localeCompare(b.name));

  if (opts.orphans) {
    result.orphans = [];
    for (const dir of dirs) {
      for await (const file of walkFiles(dir)) {
        const name = basename(file.path);
        if (!(MD5_NAME_RE.test(name) && files.has(name.toLowerCase()))) result.orphans.push(file.path);
      }
    }
    result.orphans.sort();
  }
  return result;
}

// --- command line -------------------------------------------------------------

const USAGE = `usage:
  octo decrypt <list.bin> <out.plain> [--force]
  octo import [--db <db>] --to <dir> [--apply] [--prefix <p>]... [--max-bytes <n>] <source dir>...
  octo verify [--db <db>] [--assets <dirs>] [--quick] [--orphans] [--report <file.json>]
(--db defaults to SUMIRE_OCTO_DATABASE, --assets to SUMIRE_OCTO_ASSETS; decrypt reads
SUMIRE_OCTO_AES_KEY and SUMIRE_OCTO_AES_IV from the environment.)`;

class UsageError extends Error {}

function hexEnv(env: NodeJS.ProcessEnv, name: string): Buffer {
  const v = (env[name] ?? '').trim();
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(v)) throw new UsageError(`${name} must be set to a hex string`);
  return Buffer.from(v, 'hex');
}

async function readDatabase(path: string | undefined): Promise<Buffer> {
  if (!path) throw new UsageError('no database: pass --db or set SUMIRE_OCTO_DATABASE');
  return readFile(resolve(path));
}

function splitDirs(values: string[]): string[] {
  return values.flatMap((v) => v.split(delimiter)).filter(Boolean);
}

function topPrefixes(byPrefix: VerifyResult['byPrefix'], limit: number): string[] {
  return Object.entries(byPrefix)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, limit)
    .map(([p, c]) => {
      const kinds = (['missing', 'size', 'md5'] as const).filter((k) => c[k] > 0).map((k) => `${c[k]} ${k}`);
      return `  ${p.padEnd(24)} ${kinds.join(', ')} (${formatBytes(c.bytes)})`;
    });
}

/** Run one command. Returns the process exit code. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, out: Log = console.log): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'decrypt') {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { force: { type: 'boolean' } } });
      if (positionals.length !== 2) throw new UsageError('decrypt needs <list.bin> <out.plain>');
      const key = hexEnv(env, 'SUMIRE_OCTO_AES_KEY');
      const iv = hexEnv(env, 'SUMIRE_OCTO_AES_IV');
      const r = decryptList(await readFile(resolve(positionals[0])), key, iv);
      await writeAtomic(positionals[1], r.database, values.force === true);
      out(`revision ${r.revision}: ${r.assetbundles} asset bundles, ${r.resources} resources -> ${positionals[1]}`);
      if (r.notLatest > 0) {
        out(`warning: ${r.notLatest} entries are not LATEST. This looks like a diff list; the store needs the full list (rev 0).`);
      }
      return 0;
    }

    if (command === 'import') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          db: { type: 'string' },
          to: { type: 'string' },
          apply: { type: 'boolean' },
          prefix: { type: 'string', multiple: true },
          'max-bytes': { type: 'string' },
        },
      });
      if (!values.to) throw new UsageError('import needs --to <store dir>');
      if (positionals.length === 0) throw new UsageError('import needs at least one source directory');
      let maxBytes: number | undefined;
      if (values['max-bytes'] !== undefined) {
        try {
          maxBytes = parseSize(values['max-bytes']);
        } catch (err) {
          throw new UsageError((err as Error).message);
        }
      }
      const r = await importStore({
        database: await readDatabase(values.db ?? env.SUMIRE_OCTO_DATABASE),
        to: values.to,
        sources: positionals,
        apply: values.apply === true,
        prefixes: values.prefix,
        maxBytes,
        log: out,
      });
      const row = (label: string, text: string) => out(`  ${label.padEnd(12)}${text}`);
      out(r.applied ? 'import:' : 'import preview (nothing written; pass --apply to copy):');
      row('selected', `${r.selected} files`);
      row('present', `${r.present} files already in the store`);
      row(r.applied ? 'copied' : 'to copy', `${r.copied.files} files, ${formatBytes(r.copied.bytes)}`);
      if (r.overBudget.files > 0) row('over budget', `${r.overBudget.files} files, ${formatBytes(r.overBudget.bytes)} (--max-bytes)`);
      row('not found', `${r.notFound.files} files, ${formatBytes(r.notFound.bytes)}`);
      if (!r.applied && r.copied.files > 0) out('  MD5s are checked while copying, with --apply.');
      if (r.rejected.length > 0) {
        row('rejected', `${r.rejected.length} source files:`);
        for (const x of r.rejected.slice(0, 20)) out(`    ${x.path}: ${x.reason}`);
        if (r.rejected.length > 20) out(`    ... and ${r.rejected.length - 20} more`);
        return 1;
      }
      return 0;
    }

    if (command === 'verify') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          db: { type: 'string' },
          assets: { type: 'string', multiple: true },
          quick: { type: 'boolean' },
          orphans: { type: 'boolean' },
          report: { type: 'string' },
        },
      });
      if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
      const assetDirs = splitDirs(values.assets ?? [env.SUMIRE_OCTO_ASSETS ?? '']);
      if (assetDirs.length === 0) throw new UsageError('no asset directories: pass --assets or set SUMIRE_OCTO_ASSETS');
      const r = await verifyStore({
        database: await readDatabase(values.db ?? env.SUMIRE_OCTO_DATABASE),
        assetDirs,
        quick: values.quick === true,
        orphans: values.orphans === true,
        log: out,
      });
      const count = (p: VerifyProblem['problem']) => r.problems.filter((x) => x.problem === p).length;
      out(`verify revision ${r.revision}: ${r.entries} entries, ${r.files} unique files${r.quick ? ' (sizes only)' : ''}`);
      out(`  ok         ${r.ok.entries} entries, ${r.ok.files} files, ${formatBytes(r.ok.bytes)}`);
      out(`  missing    ${count('missing')} entries`);
      out(`  wrong size ${count('size')} entries`);
      if (!r.quick) out(`  wrong md5  ${count('md5')} entries (served as-is by the store: replace these files)`);
      if (r.problems.length > 0) {
        out('  by prefix (largest first):');
        for (const line of topPrefixes(r.byPrefix, 15)) out(line);
      }
      if (r.orphans) {
        out(`  orphans    ${r.orphans.length} files the database does not list`);
        for (const p of r.orphans.slice(0, 20)) out(`    ${p}`);
        if (r.orphans.length > 20) out(`    ... and ${r.orphans.length - 20} more`);
      }
      if (values.report) {
        await writeAtomic(values.report, Buffer.from(JSON.stringify(r, null, 2) + '\n'), true);
        out(`  report     ${values.report}`);
      }
      return r.problems.length > 0 || (r.orphans?.length ?? 0) > 0 ? 1 : 0;
    }

    throw new UsageError(command ? `unknown command: ${command}` : 'no command');
  } catch (err) {
    if (err instanceof UsageError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      out(`error: ${(err as Error).message}\n${USAGE}`);
    } else {
      out(`error: ${(err as Error).message}`);
    }
    return 2;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await import('../env.ts');
  process.exitCode = await main(process.argv.slice(2));
}
