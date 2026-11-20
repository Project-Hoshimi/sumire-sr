/**
 * Pure helpers for the admin user screens. The server lowercases usernames and
 * enforces the same username pattern and password length; mirroring the checks
 * here gives immediate feedback without a round trip.
 */
export const USERNAME_PATTERN = /^[a-z0-9_.-]{3,32}$/;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

/** Missing fields are reported per input so the form can place the message. */
export interface NewUserErrors {
  username?: string;
  password?: string;
}

/** Lowercase only, matching `normalizeAdminUsername` on the server. */
export function normalizeUsername(username: string): string {
  return username.toLowerCase();
}

export function validateNewUser(username: string, password: string): NewUserErrors {
  const errors: NewUserErrors = {};
  const normalized = normalizeUsername(username);
  if (!USERNAME_PATTERN.test(normalized)) {
    errors.username = 'Use 3–32 characters: lowercase letters, digits, dot, underscore or dash.';
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.password = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  } else if (password.length > PASSWORD_MAX_LENGTH) {
    errors.password = `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  return errors;
}

export function hasErrors(errors: NewUserErrors): boolean {
  return Object.keys(errors).length > 0;
}
