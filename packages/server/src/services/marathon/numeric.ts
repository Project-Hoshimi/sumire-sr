/**
 * Numeric coercion shared by the marathon play path (`quest.ts`) and the
 * quest-info builder (`questInfo.ts`), so both derive a difficulty level the
 * same way.
 */

/** Coerce an authored/runtime value to a finite number; anything else becomes 0. */
export function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
