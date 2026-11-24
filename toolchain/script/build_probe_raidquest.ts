// Phase A2 probe — encode RaidQuest rows as master protobuf bytes.
//
// The client has no `Solis.Common.Proto.Master.RaidQuest` type, so this probe
// borrows `Solis.Common.Proto.Api.MarathonRaidQuest` (+ its Difficulty child) as
// the stand-in schema: the field numbers and names are identical to the shard's
// `papi.proto` definition. The generated registry shape is used verbatim, so the
// bytes are produced by the same encoder the server uses for every RPC.
//
// Reads the camelCase JSON rows (`[{id, ..., difficulties:[...]}]`), maps each
// key to the registry field of the same name (case-insensitive first letter),
// and writes `{rows:[{Id, data(base64)}], unmapped:{quest:[], difficulty:[]}}`.
// Keys with no matching field are dropped and reported, never guessed.
//
// Usage: node script/build_probe_raidquest.ts <in.json> <out.json>
import fs from 'node:fs';
import { Writer, encodeMessage, msgRegistry } from '../../fastify-api/runtime/proto.ts';
import '../../fastify-api/src/gen/registry.ts';
import type { MessageShape } from '../../fastify-api/runtime/proto.ts';

const QUEST = 'Solis.Common.Proto.Api.MarathonRaidQuest';
const DIFFICULTY = 'Solis.Common.Proto.Api.MarathonRaidQuestDifficulty';

const questShape = msgRegistry.get(QUEST);
const difficultyShape = msgRegistry.get(DIFFICULTY);
if (!questShape) throw new Error(`${QUEST} not registered`);
if (!difficultyShape) throw new Error(`${DIFFICULTY} not registered`);

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) throw new Error('usage: build_probe_raidquest.ts <in.json> <out.json>');

/** Registry field names keyed by lowercase, so camelCase JSON finds them. */
function fieldIndex(shape: MessageShape): Map<string, string> {
  return new Map(shape.fields.map((f) => [f.name!.toLowerCase(), f.name!]));
}

/**
 * Rename JSON keys to registry field names. `difficulties` is the repeated
 * child message, mapped against the Difficulty shape. Unmapped keys in `report`.
 */
function mapRow(
  row: Record<string, unknown>,
  shape: MessageShape,
  report: Set<string>,
): Record<string, unknown> {
  const index = fieldIndex(shape);
  const out: Record<string, unknown> = {};
  const nested = shape.fields.find((f) => f.repeated && f.element?.label === 'message');
  for (const [key, value] of Object.entries(row)) {
    const field = index.get(key.toLowerCase());
    if (!field) { report.add(key); continue; }
    if (nested && field === nested.name && Array.isArray(value)) {
      out[field] = value.map((child) =>
        mapRow(child as Record<string, unknown>, difficultyShape, diffReport));
      continue;
    }
    out[field] = value;
  }
  return out;
}

const diffReport = new Set<string>();
const questReport = new Set<string>();
const input = JSON.parse(fs.readFileSync(inPath, 'utf8')) as Record<string, unknown>[];

const rows = input.map((raw) => {
  const mapped = mapRow(raw, questShape, questReport);
  const w = new Writer();
  encodeMessage(questShape, mapped, w);
  const id = mapped.Id;
  if (typeof id !== 'string' || id === '') throw new Error(`row without an id: ${JSON.stringify(raw).slice(0, 120)}`);
  return { Id: id, data: Buffer.from(w.toBytes()).toString('base64') };
});

fs.writeFileSync(outPath, JSON.stringify({
  rows,
  unmapped: { quest: [...questReport], difficulty: [...diffReport] },
}));
console.log(`encoded ${rows.length} ${QUEST} rows; unmapped quest keys: ${questReport.size}, difficulty keys: ${diffReport.size}`);
