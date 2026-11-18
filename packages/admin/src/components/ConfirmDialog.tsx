/**
 * In-page replacement for `window.confirm`. Native dialogs are silently
 * suppressed in some browsers (embedded webviews, or once the user ticks
 * "prevent additional dialogs"), where `confirm()` returns false without ever
 * asking; this modal always renders.
 *
 * Markup and accessibility follow the event-delete dialog: an `alertdialog`
 * with a labelled title, Escape to cancel, focus moved to the confirm button on
 * open and returned to the previously focused element on close.
 */
import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /** Renders the confirm button with `button.danger`. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Disables both buttons while an action is in flight. */
  busy?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
  busy = false,
}: ConfirmDialogProps) {
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    restoreFocusRef.current = active instanceof HTMLElement ? active : null;
    confirmRef.current?.focus();
    return () => {
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          if (!busy) onCancel();
        }
      }}
    >
      <h3 id={titleId}>{title}</h3>
      <p>{message}</p>
      <div className="row-actions">
        <button
          type="button"
          ref={confirmRef}
          className={danger ? 'danger' : undefined}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
