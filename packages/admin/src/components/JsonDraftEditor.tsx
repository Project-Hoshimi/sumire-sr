import { useEffect, useState } from 'react';

/**
 * Whole-document JSON editor for a draft that has no structured tabs. The text
 * is parsed on every change: a parseable JSON object is handed to `onValid`, and
 * a parse error is shown inline and reported through `onError` so the page can
 * block saving. Leaving the editor reports no error, because the draft then
 * still holds the last valid object.
 */
export function JsonDraftEditor({
  value,
  disabled,
  onValid,
  onError,
}: {
  value: unknown;
  disabled: boolean;
  onValid: (next: Record<string, unknown>) => void;
  onError: (message: string | null) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => onError(null), [onError]);

  return (
    <label className="field json-draft-field">
      <span>Draft JSON</span>
      <textarea
        aria-label="Draft JSON"
        className={disabled ? 'json-input field-readonly' : 'json-input field-editable'}
        rows={28}
        spellCheck={false}
        value={text}
        disabled={disabled}
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (err) {
            const message = `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
            setError(message);
            onError(message);
            return;
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            const message = 'The draft must be a JSON object.';
            setError(message);
            onError(message);
            return;
          }
          setError(null);
          onError(null);
          onValid(parsed as Record<string, unknown>);
        }}
      />
      {error === null ? null : <span className="field-error">{error}</span>}
    </label>
  );
}
