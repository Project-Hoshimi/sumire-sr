/**
 * Admin user/session store interfaces plus an in-memory implementation for
 * tests. The Drizzle-backed implementation lives in `./store.drizzle.ts` so
 * importing this module never opens a database connection.
 *
 * Usernames are compared case-insensitively: both implementations lowercase
 * before every read and write. The external format is
 * `/^[a-z0-9_.-]{3,32}$/` after lowercasing.
 */

export const ADMIN_ROLES = ['viewer', 'editor', 'publisher', 'owner'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}

const ADMIN_USERNAME = /^[a-z0-9_.-]{3,32}$/;

/** Lowercase a username for storage/lookup (no trimming: input is validated). */
export function normalizeAdminUsername(username: string): string {
  return username.toLowerCase();
}

/** Valid after `normalizeAdminUsername`. */
export function isValidAdminUsername(username: unknown): username is string {
  return typeof username === 'string' && ADMIN_USERNAME.test(username);
}

export interface AdminUserRow {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  disabled: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface AdminSessionRow {
  tokenHash: string;
  userId: string;
  csrfToken: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export interface NewAdminUser {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  disabled?: boolean;
}

export interface NewAdminSession {
  tokenHash: string;
  userId: string;
  csrfToken: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

/** The username is already used by another admin account. */
export class UsernameTakenError extends Error {
  constructor(message = 'admin username already exists') {
    super(message);
    this.name = 'UsernameTakenError';
  }
}

/** The change would leave no enabled owner account. */
export class LastOwnerError extends Error {
  constructor(message = 'cannot remove the last enabled owner') {
    super(message);
    this.name = 'LastOwnerError';
  }
}

export interface AdminStore {
  // Users
  count(): Promise<number>;
  getById(id: string): Promise<AdminUserRow | undefined>;
  getByUsername(username: string): Promise<AdminUserRow | undefined>;
  list(): Promise<AdminUserRow[]>;
  /** Users whose id is in `ids`; unknown ids are absent, so callers can tell stored ids from system values. */
  listByIds(ids: readonly string[]): Promise<AdminUserRow[]>;
  create(user: NewAdminUser): Promise<AdminUserRow>;
  /**
   * Create the first owner only when no admin user exists. Returns `null` when
   * the table is not empty; the check and insert are atomic.
   */
  createFirstOwner(user: NewAdminUser): Promise<AdminUserRow | null>;
  /** Throws `LastOwnerError` when the change would leave zero enabled owners. */
  setRole(id: string, role: string): Promise<boolean>;
  /** Throws `LastOwnerError` when disabling would leave zero enabled owners. */
  setDisabled(id: string, disabled: boolean): Promise<boolean>;
  setPasswordHash(id: string, passwordHash: string): Promise<boolean>;
  touchLogin(id: string, at: Date): Promise<void>;

  // Sessions
  createSession(session: NewAdminSession): Promise<void>;
  getSessionByTokenHash(tokenHash: string): Promise<AdminSessionRow | undefined>;
  touchSession(tokenHash: string, lastSeenAt: Date): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteSessionsForUser(userId: string): Promise<void>;
  deleteExpiredSessions(now: Date): Promise<void>;
}

/** In-memory implementation with the same semantics, for tests. */
export function memoryAdminStore(): AdminStore {
  const users = new Map<string, AdminUserRow>();
  const sessions = new Map<string, AdminSessionRow>();

  const copyUser = (row: AdminUserRow): AdminUserRow => ({ ...row });

  const enabledOwnersExcept = (userId: string): number => {
    let total = 0;
    for (const row of users.values()) {
      if (row.role === 'owner' && !row.disabled && row.id !== userId) total += 1;
    }
    return total;
  };

  return {
    async count() {
      return users.size;
    },
    async getById(id) {
      const row = users.get(id);
      return row ? copyUser(row) : undefined;
    },
    async getByUsername(username) {
      const wanted = normalizeAdminUsername(username);
      for (const row of users.values()) {
        if (row.username === wanted) return copyUser(row);
      }
      return undefined;
    },
    async listByIds(ids) {
      return ids.flatMap((id) => {
        const row = users.get(id);
        return row ? [copyUser(row)] : [];
      });
    },
    async list() {
      return [...users.values()]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.username.localeCompare(b.username))
        .map(copyUser);
    },
    async create(user) {
      const username = normalizeAdminUsername(user.username);
      if (users.has(user.id)) throw new Error(`admin user already exists: ${user.id}`);
      for (const row of users.values()) {
        if (row.username === username) throw new UsernameTakenError();
      }
      const row: AdminUserRow = {
        id: user.id,
        username,
        passwordHash: user.passwordHash,
        role: user.role,
        disabled: user.disabled ?? false,
        createdAt: new Date(),
        lastLoginAt: null,
      };
      users.set(row.id, row);
      return copyUser(row);
    },
    async createFirstOwner(user) {
      // Check + insert are synchronous, so this is already atomic.
      if (users.size > 0) return null;
      const row: AdminUserRow = {
        id: user.id,
        username: normalizeAdminUsername(user.username),
        passwordHash: user.passwordHash,
        role: 'owner',
        disabled: user.disabled ?? false,
        createdAt: new Date(),
        lastLoginAt: null,
      };
      users.set(row.id, row);
      return copyUser(row);
    },
    async setRole(id, role) {
      const row = users.get(id);
      if (!row) return false;
      if (row.role === 'owner' && !row.disabled && role !== 'owner' && enabledOwnersExcept(id) === 0) {
        throw new LastOwnerError();
      }
      row.role = role;
      return true;
    },
    async setDisabled(id, disabled) {
      const row = users.get(id);
      if (!row) return false;
      if (disabled && row.role === 'owner' && !row.disabled && enabledOwnersExcept(id) === 0) {
        throw new LastOwnerError();
      }
      row.disabled = disabled;
      return true;
    },
    async setPasswordHash(id, passwordHash) {
      const row = users.get(id);
      if (!row) return false;
      row.passwordHash = passwordHash;
      return true;
    },
    async touchLogin(id, at) {
      const row = users.get(id);
      if (row) row.lastLoginAt = new Date(at);
    },
    async createSession(session) {
      if (sessions.has(session.tokenHash)) {
        throw new Error(`admin session already exists: ${session.tokenHash}`);
      }
      sessions.set(session.tokenHash, { ...session });
    },
    async getSessionByTokenHash(tokenHash) {
      const row = sessions.get(tokenHash);
      return row ? { ...row } : undefined;
    },
    async touchSession(tokenHash, lastSeenAt) {
      const row = sessions.get(tokenHash);
      if (row) row.lastSeenAt = new Date(lastSeenAt);
    },
    async deleteSession(tokenHash) {
      sessions.delete(tokenHash);
    },
    async deleteSessionsForUser(userId) {
      for (const [hash, row] of sessions) {
        if (row.userId === userId) sessions.delete(hash);
      }
    },
    async deleteExpiredSessions(now) {
      for (const [hash, row] of sessions) {
        if (row.expiresAt.getTime() <= now.getTime()) sessions.delete(hash);
      }
    },
  };
}
