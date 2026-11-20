/**
 * Hand-off for publish warnings from the publish screen to the editor.
 *
 * Publish navigates to `#/events/:id`; the server response's non-blocking
 * validation warnings would otherwise be lost. The publish screen stores them
 * under a per-event sessionStorage key right before navigating, and the editor
 * takes (reads and clears) them on load so a later visit does not repeat them.
 */
import type { ValidationIssue } from './types.ts';

export interface PublishNotice {
  version: number;
  warnings: ValidationIssue[];
}

function storageKey(id: string): string {
  return `sumire:publish-warnings:${id}`;
}

export function savePublishNotice(id: string, notice: PublishNotice): void {
  try {
    window.sessionStorage.setItem(storageKey(id), JSON.stringify(notice));
  } catch {
    // sessionStorage can be unavailable (privacy modes); warnings are optional.
  }
}

export function takePublishNotice(id: string): PublishNotice | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(id));
    if (raw === null) return null;
    window.sessionStorage.removeItem(storageKey(id));
    const parsed = JSON.parse(raw) as Partial<PublishNotice> | null;
    if (
      parsed === null ||
      typeof parsed.version !== 'number' ||
      !Array.isArray(parsed.warnings)
    ) {
      return null;
    }
    return { version: parsed.version, warnings: parsed.warnings as ValidationIssue[] };
  } catch {
    return null;
  }
}
