/**
 * Turn a failed admin API call into one human-readable line. Server routes use
 * `{ error }` for single problems and `{ errors: string[] }` for validation.
 */
import { ApiError } from './api.ts';

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body;
    if (body !== null && typeof body === 'object') {
      const errors = (body as { errors?: unknown }).errors;
      if (Array.isArray(errors) && errors.length > 0) {
        return errors.map((entry) => String(entry)).join('; ');
      }
      const message = (body as { error?: unknown }).error;
      if (typeof message === 'string' && message !== '') return message;
    }
    return `request failed (${error.status})`;
  }
  return error instanceof Error ? error.message : String(error);
}
