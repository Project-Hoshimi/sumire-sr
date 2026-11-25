/**
 * Small shared inputs for the moshikoi editor.
 *
 * Every text-like input keeps its own in-progress text so a partially typed
 * value never lands in the draft: numbers commit on each parseable keystroke,
 * JSON textareas commit on blur when they parse to the expected type.
 */
import { useState } from 'react';
import { groupIssuesByPath } from '../../draft.ts';
import type { ValidationIssue } from '../../types.ts';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The console's yellow marker class for a control: `field-readonly` when the
 * control is locked (readOnly or disabled), otherwise `field-editable`. An
 * optional extra class (e.g. `ref-invalid`, `json-input`) comes first.
 */
export function fieldClass(locked: boolean, extra?: string | false): string {
  const base = locked ? 'field-readonly' : 'field-editable';
  return extra ? `${extra} ${base}` : base;
}

/** Render an arbitrary JSON value the way the textareas show it. */
export function jsonText(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return typeof text === 'string' ? text : '';
}

type JsonParse =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

function parseJsonAs(text: string, expect: 'object' | 'array'): JsonParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: 'Invalid JSON.' };
  }
  if (expect === 'array') {
    if (!Array.isArray(parsed)) return { ok: false, message: 'Must be a JSON array.' };
    return { ok: true, value: parsed };
  }
  if (!isPlainRecord(parsed)) return { ok: false, message: 'Must be a JSON object.' };
  return { ok: true, value: parsed };
}

/**
 * A numeric input whose raw text stays local until it parses. `onChange(null)`
 * is only called for an emptied field when `blankMeansNull`.
 */
export function NumberField({
  ariaLabel,
  value,
  disabled,
  onChange,
  placeholder,
  blankMeansNull = false,
  step,
}: {
  ariaLabel: string;
  value: number | undefined;
  disabled: boolean;
  onChange: (value: number | null) => void;
  placeholder?: string;
  blankMeansNull?: boolean;
  step?: number;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (typeof value === 'number' ? String(value) : '');
  return (
    <input
      type="number"
      aria-label={ariaLabel}
      value={shown}
      placeholder={placeholder}
      disabled={disabled}
      className={fieldClass(disabled)}
      step={step}
      onChange={(event) => {
        const raw = event.target.value;
        setText(raw);
        if (raw.trim() === '') {
          if (blankMeansNull) onChange(null);
          return;
        }
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
      onBlur={() => setText(null)}
    />
  );
}

/**
 * A JSON textarea applying its text on blur. The expected type follows the
 * current value: an array stays an array, anything else must be an object.
 */
export function JsonField({
  label,
  value,
  disabled,
  onApply,
  rows = 6,
  className,
}: {
  label: string;
  value: unknown;
  disabled: boolean;
  onApply: (next: unknown) => void;
  rows?: number;
  className?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const expect = Array.isArray(value) ? 'array' : 'object';
  return (
    <label className="field moshikoi-json-field">
      <span>{label}</span>
      <textarea
        aria-label={label}
        className={fieldClass(disabled, className)}
        rows={rows}
        spellCheck={false}
        value={text ?? jsonText(value)}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        onBlur={() => {
          if (text === null) return;
          const parsed = parseJsonAs(text, expect);
          if (!parsed.ok) {
            setError(parsed.message);
            return;
          }
          setText(null);
          setError(null);
          onApply(parsed.value);
        }}
      />
      {error === null ? null : <span className="field-error">{error}</span>}
    </label>
  );
}

/** The validation issues a tab owns, shown at the tab's top. */
export function TabIssueList({
  issues,
  prefixes,
  exclude = [],
}: {
  issues: readonly ValidationIssue[];
  prefixes: readonly string[];
  /** Paths another tab already owns, so an issue is listed once. */
  exclude?: readonly string[];
}) {
  const relevant = issues.filter(
    (issue) =>
      prefixes.some((prefix) => issue.path === prefix || issue.path.startsWith(`${prefix}.`)) &&
      !exclude.some((prefix) => issue.path === prefix || issue.path.startsWith(`${prefix}.`)),
  );
  if (relevant.length === 0) return null;
  return (
    <div className="issues" role="status">
      <strong>{relevant.length} issue(s)</strong>
      <ul>
        {groupIssuesByPath(relevant).map((group) => (
          <li key={group.path}>
            <code>{group.path}</code>
            <ul>
              {group.issues.map((issue) => (
                <li key={`${issue.path}:${issue.message}`} className={issue.severity}>
                  {issue.message}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
