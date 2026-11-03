import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from '../../config.ts';

const CAPTURES = join(DATA_DIR, 'captures');

const SESSIONS = ['2026-09-14_a12r/raw', '2026-09-13_a12'];

// Official fresh-account capture. Kept out of SESSIONS on purpose: replaying it
// globally would replace the veteran corpus defaults for every account.
const FRESH_CAPTURE = '2026-10-25_fresh_official/raw';
const freshCache = new Map<string, Buffer>();

type CorpusEntry = { response: Buffer; request: Buffer | null };
const corpus = new Map<string, CorpusEntry>();
const allResponses = new Map<string, Buffer[]>();
const METHOD_RE = /^(\d+)\.(req|resp)-plain\.([A-Za-z0-9]+):([A-Za-z0-9]+)\.bin$/;

function loadSession(dir: string) {
  let files: string[];
  try {
    files = readdirSync(join(CAPTURES, dir));
  } catch {
    return;
  }
  type Item = { kind: 'req' | 'resp'; name: string; buf: Buffer };
  const items: Item[] = files
    .map((f) => {
      const m = f.match(METHOD_RE);
      if (!m) return null;
      return { n: Number(m[1]), kind: m[2] as 'req' | 'resp', name: `${m[3]}:${m[4]}`, f };
    })
    .filter((x) => x !== null)
    .sort((a: any, b: any) => a.n - b.n)
    .map((it: any) => ({ kind: it.kind as 'req' | 'resp', name: it.name as string, buf: readFileSync(join(CAPTURES, dir, it.f as string)) }));

  const pendingReq = new Map<string, Buffer[]>();
  for (const it of items) {
    if (it.kind === 'req') {
      pendingReq.get(it.name)?.push(it.buf) ?? pendingReq.set(it.name, [it.buf]);
    } else {
      const q = pendingReq.get(it.name);
      const request = q && q.length > 0 ? q.shift()! : null;
      corpus.set(it.name, { response: it.buf, request });
      const arr = allResponses.get(it.name);
      if (arr) arr.push(it.buf);
      else allResponses.set(it.name, [it.buf]);
    }
  }
}

export function loadCorpus(): Map<string, CorpusEntry> {
  if (corpus.size > 0) return corpus;
  for (const s of SESSIONS) loadSession(s);
  return corpus;
}

export function hasCorpusEntry(name: string): boolean {
  return corpus.has(name);
}

export function getCorpusResponse(name: string): Buffer | null {
  return corpus.get(name)?.response ?? null;
}

export function listCorpusNames(): string[] {
  return [...corpus.keys()].sort();
}

/** Every captured response for an endpoint (the corpus map keeps only the last). */
export function getCorpusResponses(name: string): Buffer[] {
  return allResponses.get(name) ?? [];
}

/**
 * Read one response from the official fresh-account capture. Not part of the
 * shared corpus (see `FRESH_CAPTURE`); callers use it only for fresh-seeded
 * players.
 */
export function getFreshCapture(file: string): Buffer | null {
  const cached = freshCache.get(file);
  if (cached) return cached;
  try {
    const buf = readFileSync(join(CAPTURES, FRESH_CAPTURE, file));
    freshCache.set(file, buf);
    return buf;
  } catch {
    return null;
  }
}

let freshFirstByName: Map<string, string> | null = null;

/** The first response for `name` in the fresh-account capture, if it has one. */
export function getFreshCaptureByName(name: string): Buffer | null {
  if (!freshFirstByName) {
    freshFirstByName = new Map();
    let files: string[] = [];
    try {
      files = readdirSync(join(CAPTURES, FRESH_CAPTURE)).sort();
    } catch {
      // no fresh capture on disk
    }
    for (const f of files) {
      const m = f.match(METHOD_RE);
      const key = m ? `${m[3]}:${m[4]}` : null;
      if (m && m[2] === 'resp' && key && !freshFirstByName.has(key)) freshFirstByName.set(key, f);
    }
  }
  const file = freshFirstByName.get(name);
  return file ? getFreshCapture(file) : null;
}

export function corpusFingerprint(): string {
  const h = createHash('sha256');
  for (const [name, e] of corpus) h.update(name).update(e.response.length.toString());
  return h.digest('hex').slice(0, 16);
}
