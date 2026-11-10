// Status-name helpers shared by compile.ts and status.ts.
//
// In Go these live in compile.go as package-level tables; the TS port needs them
// from more than one module, so they are isolated here to avoid an import cycle
// between the compiler and the status runtime.

import { SkillEfficacyType, StatusEffectType, enumName } from './enums.ts';
import { hasPrefix, snakeName, trimPrefix, trimSpace } from './util.ts';

/**
 * statusNames maps the snake_cased master status label to its enum value,
 * built from the generated enum names exactly like compile.go does.
 */
const table = new Map<string, number>();
for (const [name, value] of Object.entries(StatusEffectType)) {
  table.set(snakeName(name), value);
}
// Old target IDs use this generic label for A-skill score up.
table.set('skill_score_up', StatusEffectType.ActiveSkillScoreUp);
table.set('vocal', StatusEffectType.VocalUp);

export const statusNames: ReadonlyMap<string, number> = table;

/** Wire value -> generated member name (penum.StatusEffectType_name lookup). */
const nameByValue = new Map<number, string>();
for (const [name, value] of Object.entries(StatusEffectType)) {
  if (!nameByValue.has(value)) nameByValue.set(value, name);
}

export function statusName(value: number): string | undefined {
  return nameByValue.get(value);
}

/** go: statusID — reject unknown labels and the Unknown member. */
export function statusID(id: string): number {
  const value = statusNames.get(trimSpace(id));
  if (value === undefined || value === StatusEffectType.Unknown) {
    throw new Error(`unknown status name: ${id}`);
  }
  return value;
}

/** go: statusEfficacy — the efficacy whose generated name matches the status. */
export function statusEfficacy(status: number): number {
  const name = statusName(status);
  if (name === undefined) return SkillEfficacyType.Unknown;
  const value = (SkillEfficacyType as Record<string, number>)[name];
  return value ?? SkillEfficacyType.Unknown;
}

/** go: relatedStatuses — map base status -> its prefixed variant. */
export function relatedStatuses(prefix: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const [name, value] of statusNames) {
    if (!hasPrefix(name, prefix)) continue;
    const base = statusNames.get(trimPrefix(name, prefix));
    if (base !== undefined) out.set(base, value);
  }
  return out;
}

/** go: enum String() text, e.g. 'StatusEffectType_ScoreUp', for log messages. */
export function enumString(table: Record<string, number>, prefix: string, value: number): string {
  const name = enumName(table, value);
  return name === undefined ? String(value) : prefix + name;
}
