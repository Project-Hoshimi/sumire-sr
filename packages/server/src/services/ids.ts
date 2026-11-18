/**
 * Rules for admin-authored ids. They become DB text keys, URL path segments and
 * export filenames, so keep them short and limited to safe characters. Shared
 * by event and roster ids so both APIs reject the same shapes.
 */
export const ADMIN_ID_MAX_LENGTH = 100;

const ADMIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidAdminId(id: string): boolean {
  return id.length > 0 && id.length <= ADMIN_ID_MAX_LENGTH && ADMIN_ID_PATTERN.test(id);
}
