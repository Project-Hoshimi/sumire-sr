// Small helpers that reproduce Go's zero-value and string semantics for the
// proto-shaped records the simulator reads.

/** Proto/drizzle scalar default: absent and null both mean the proto zero value. */
export function n(value: number | null | undefined): number {
  return value ?? 0;
}

/** Proto/drizzle string default. */
export function s(value: string | null | undefined): string {
  return value ?? '';
}

/** go: strings.TrimPrefix */
export function trimPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** go: strings.TrimSuffix */
export function trimSuffix(value: string, suffix: string): string {
  return value.endsWith(suffix) ? value.slice(0, value.length - suffix.length) : value;
}

/** go: strings.TrimSpace */
export function trimSpace(value: string): string {
  return value.trim();
}

/** go: strings.HasPrefix */
export function hasPrefix(value: string, prefix: string): boolean {
  return value.startsWith(prefix);
}

/** go: strings.Split (keeps empty trailing fields, like Go). */
export function split(value: string, sep: string): string[] {
  return value.split(sep);
}

/** go: strings.SplitN(value, sep, 2) */
export function splitN2(value: string, sep: string): string[] {
  const index = value.indexOf(sep);
  if (index < 0) return [value];
  return [value.slice(0, index), value.slice(index + sep.length)];
}

/** go: strings.Join */
export function join(values: string[], sep: string): string {
  return values.join(sep);
}

/**
 * go: snakeName — insert '_' before every uppercase rune except the first and
 * lowercase the rune. Digits and '_' pass through unchanged.
 */
export function snakeName(name: string): string {
  let out = '';
  let index = 0;
  for (const ch of name) {
    if (ch !== ch.toLowerCase() && ch === ch.toUpperCase()) {
      if (index > 0) out += '_';
    }
    out += ch.toLowerCase();
    index++;
  }
  return out;
}

/**
 * go: (*strconv.NumError) ParseInt(raw, 10, 32) restricted to non-negative
 * values. Returns undefined when the text is not a valid int32.
 */
export function nonnegativeInt32(raw: string): number | undefined {
  if (!/^[+-]?[0-9]+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 2147483647) return undefined;
  return value;
}

/**
 * JS cannot represent int64 exactly, so overflow guards use 2^53-1 instead of
 * math.MaxInt64. Every reachable live score is many orders of magnitude below
 * it, which keeps the guards equivalent for real inputs while staying exact.
 */
export const maxScoreSafe = Number.MAX_SAFE_INTEGER;
