/**
 * Full-screen browse dialog shell shared by the resource picker and the
 * marathon-id browser.
 *
 * It owns the mechanics that are easy to get subtly wrong: rendering in a
 * body-level portal, the aria-modal dialog, Escape, the Tab focus trap, the
 * press-and-release backdrop rule, the body scroll lock, focusing the search
 * box on open and returning focus to the opener on close. Consumers only
 * provide the header title and the panel body.
 */
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface BrowseModalProps {
  open: boolean;
  /** Visible header title. */
  title: string;
  /** Accessible name of the dialog; defaults to `title`. */
  ariaLabel?: string;
  onClose: () => void;
  /**
   * Element that opened the dialog. Focus returns here on close; when omitted,
   * the element focused at open time is used.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function BrowseModal({
  open,
  title,
  ariaLabel,
  onClose,
  returnFocusRef,
  children,
}: BrowseModalProps) {
  const modalRef = useRef<HTMLDivElement | null>(null);
  // True only when the pointer went down on the backdrop itself. A drag that
  // starts inside the panel and releases over the backdrop must not close it.
  const backdropPressed = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  // Keep the latest callback without re-registering the document listener.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Remember what had focus before the panel took it, so closing can hand it
  // back. Captured during the open commit, before the search box is focused.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
  }, [open]);

  // The panel is rendered in a portal, outside the picker subtree, so key
  // events must be handled on the document while it is open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = modalRef.current;
      if (panel === null) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      const active = document.activeElement;
      const inside = active !== null && panel.contains(active);
      // aria-modal hides the page behind the panel, so Tab must wrap here
      // instead of moving focus (or, from an untrapped position, escaping).
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // Lock the page behind the modal, restoring whatever value was there before.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Every opening puts focus in the browse search box, so browsing needs no
  // extra click. Consumers must render exactly one `input[type="search"]`.
  useEffect(() => {
    if (!open) return;
    const input = modalRef.current?.querySelector<HTMLInputElement>('input[type="search"]');
    input?.focus();
  }, [open]);

  // Closing (Escape, backdrop, footer Close or a selection) returns focus to
  // the element that opened the panel.
  useEffect(() => {
    if (wasOpen.current && !open) {
      const target = returnFocusRef?.current ?? openerRef.current;
      target?.focus();
      openerRef.current = null;
    }
    wasOpen.current = open;
  }, [open, returnFocusRef]);

  if (!open) return null;

  return createPortal(
    <div
      className="resource-modal-backdrop"
      onMouseDown={(event) => {
        // Only a press that starts on the backdrop itself can close;
        // a drag from inside the panel ending here must not.
        backdropPressed.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        // Require both press and release on the backdrop: clicks inside the
        // panel bubble up here with a different target.
        const pressed = backdropPressed.current;
        backdropPressed.current = false;
        if (pressed && event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={modalRef}
        className="resource-browse"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title}
      >
        <div className="resource-browse-header">
          <span className="resource-browse-title">{title}</span>
          <button
            type="button"
            className="resource-browse-header-close"
            aria-label="Close browser"
            onClick={() => onCloseRef.current()}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
