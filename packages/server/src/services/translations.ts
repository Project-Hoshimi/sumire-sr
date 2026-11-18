/**
 * English names from an external translation-data checkout
 * (`Project-Hoshimi/ipr-translation-data-en`).
 *
 * The checkout is optional and read-only: `SUMIRE_TRANSLATION_DIR` points at
 * the repository root that contains `local-files/`. When it is unset or cannot
 * be read, every lookup returns undefined and the admin API keeps serving the
 * Japanese master names. Loading happens at most once per process and
 * concurrent callers share the same in-flight read.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Last-resort generic translations that are not (yet) in the checkout. */
export const FALLBACK_TEXT: Readonly<Record<string, string>> = Object.freeze({
  '対戦アイドル': 'Rival Idol',
});

/** Generic-translation keys that look like table columns, not display text. */
const SPLIT_KEY_PREFIX = '[__split__]';
/** This file is loaded first so its master names win over generic files. */
const MASTER_NAMES_FILE = 'zz-master-names.json';

interface TranslationData {
  /** Master table name -> `"<id>|<field>"` -> English text. */
  master: Map<string, Map<string, string>>;
  /** Japanese text -> English text. */
  text: Map<string, string>;
}

const EMPTY_DATA: TranslationData = { master: new Map(), text: new Map() };

let data: TranslationData | null = null;
let inFlight: Promise<TranslationData> | null = null;
let warned = false;

function warnOnce(message: string, error?: unknown): void {
  if (warned) return;
  warned = true;
  if (error === undefined) console.warn(`[translations] ${message}`);
  else console.warn(`[translations] ${message}:`, error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read and parse one JSON file, or null when it is missing or malformed. */
async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    console.warn(`[translations] skipping unreadable translation file ${path}:`, error);
    return null;
  }
}

function stringEntries(value: unknown): Map<string, string> {
  const entries = new Map<string, string>();
  if (!isRecord(value)) return entries;
  for (const [key, text] of Object.entries(value)) {
    if (typeof text === 'string') entries.set(key, text);
  }
  return entries;
}

function jsonFiles(files: readonly string[]): string[] {
  return files.filter((file) => file.endsWith('.json')).sort();
}

async function loadMasterTables(localFiles: string): Promise<Map<string, Map<string, string>>> {
  const dir = join(localFiles, 'masterTrans');
  const files = jsonFiles(await readdir(dir));
  const tables = new Map<string, Map<string, string>>();
  for (const file of files) {
    const parsed = await readJson(join(dir, file));
    if (parsed === null) continue;
    const table = file.slice(0, -'.json'.length);
    tables.set(table, stringEntries(isRecord(parsed) ? parsed.data : null));
  }
  return tables;
}

async function loadGenericText(localFiles: string): Promise<Map<string, string>> {
  const dir = join(localFiles, 'genericTrans');
  const files = jsonFiles(await readdir(dir));
  // zz-master-names.json first, then the rest; an existing key is never
  // replaced, so the first file that defines a text wins.
  const ordered = [
    ...files.filter((file) => file === MASTER_NAMES_FILE),
    ...files.filter((file) => file !== MASTER_NAMES_FILE),
  ];
  const text = new Map<string, string>();
  for (const file of ordered) {
    const parsed = await readJson(join(dir, file));
    if (parsed === null) continue;
    const entries = stringEntries(parsed);
    for (const [key, value] of entries) {
      if (key.startsWith(SPLIT_KEY_PREFIX) || text.has(key)) continue;
      text.set(key, value);
    }
  }
  return text;
}

async function load(): Promise<TranslationData> {
  const root = process.env.SUMIRE_TRANSLATION_DIR?.trim() ?? '';
  if (root === '') {
    warnOnce('SUMIRE_TRANSLATION_DIR is not set; English names are unavailable');
    return EMPTY_DATA;
  }
  try {
    const localFiles = join(root, 'local-files');
    const [master, text] = await Promise.all([
      loadMasterTables(localFiles),
      loadGenericText(localFiles),
    ]);
    return { master, text };
  } catch (error) {
    warnOnce('translation data could not be read; English names are unavailable', error);
    return EMPTY_DATA;
  }
}

/**
 * Load the translation data once (single-flight). Routes await this before
 * calling the synchronous lookups below.
 */
export async function ensureTranslationsLoaded(): Promise<void> {
  if (data !== null) return;
  if (inFlight === null) {
    inFlight = (async () => {
      const loaded = await load();
      data = loaded;
      inFlight = null;
      return loaded;
    })();
  }
  await inFlight;
}

/** English name for one master-data row field, or undefined when unknown. */
export function masterName(table: string, id: string, field = 'name'): string | undefined {
  return data?.master.get(table)?.get(`${id}|${field}`);
}

/** English text for an exact Japanese string, or undefined when unknown. */
export function textName(japanese: string): string | undefined {
  const text = data?.text.get(japanese);
  if (text !== undefined) return text;
  // hasOwn keeps prototype keys such as 'constructor' from leaking through.
  return Object.hasOwn(FALLBACK_TEXT, japanese) ? FALLBACK_TEXT[japanese] : undefined;
}

/** Drop the cached data so tests can point the service at a fixture dir. */
export function resetTranslationsForTests(): void {
  data = null;
  inFlight = null;
  warned = false;
}
