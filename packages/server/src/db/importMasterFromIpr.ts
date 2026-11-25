// Convert IPR master partitions (github.com/MalitsPlus/ipr-master-diff) into the
// PascalCase structured rows that seedMaster.ts reads. IPR files are
// game-native camelCase JSON with no decode metadata, so the conversion is a
// mechanical `upperFirst` remap (nested messages included) plus the per-row
// `__msg`/`__unknown` bookkeeping keys our structured files carry.
//
// Only RaidQuest is converted: it is the single partition the client has no
// master for and that we need server-side (MarathonInfo.RaidQuest). The other
// IPR-only partitions (PvpQuest/LeagueQuest/GvgQuest) have no consumer yet.
//
// Re-runnable: each run overwrites phaseA2/out/structured/<Type>.json.
//
// Usage: node src/db/importMasterFromIpr.ts
//   IPR_MASTER_DIR      source directory (default ~/ipr-master-diff)
//   MASTER_STRUCTURED_DIR output directory (same override as seedMaster.ts)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Same default as `DATA_DIR` in config.ts, computed here so the converter stays
// a dependency-free CLI (no .env / dotenv load).
const DATA_DIR = process.env.SUMIRE_DATA_DIR
  ? resolve(process.env.SUMIRE_DATA_DIR)
  : resolve(import.meta.dirname, '..', '..', '..');

const IPR_DIR = resolve(process.env.IPR_MASTER_DIR ?? join(homedir(), 'ipr-master-diff'));
const STRUCTURED_DIR =
  process.env.MASTER_STRUCTURED_DIR ??
  join(DATA_DIR, 'phaseA2', 'out', 'structured');

/** Partitions sourced from IPR. RaidQuest only (see the file header). */
const TYPES = ['RaidQuest'] as const;

function upperFirst(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * PascalCase every object key, recursively: nested messages (the RaidQuest
 * `difficulties` array lands in a jsonb column) follow the same convention as
 * the decoded structured rows.
 */
function pascalCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pascalCase);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[upperFirst(key)] = pascalCase(child);
  }
  return out;
}

function convert(type: string): number {
  const source = join(IPR_DIR, `${type}.json`);
  const raw: unknown = JSON.parse(readFileSync(source, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${source}: expected a JSON array of rows`);

  const rows = raw.map((row) => ({
    __msg: `Solis.Common.Proto.Master.${type}`,
    __unknown: [],
    ...(pascalCase(row) as Record<string, unknown>),
  }));

  mkdirSync(STRUCTURED_DIR, { recursive: true });
  writeFileSync(join(STRUCTURED_DIR, `${type}.json`), JSON.stringify(rows) + '\n');
  return rows.length;
}

let total = 0;
for (const type of TYPES) {
  const count = convert(type);
  total += count;
  console.log(`  ${type.padEnd(18)} ${count} rows`);
}
console.log(`wrote ${total} rows from ${IPR_DIR} into ${STRUCTURED_DIR}`);
