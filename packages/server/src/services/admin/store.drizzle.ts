import { and, count, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { adminSessions, adminUsers } from '../../db/schema.ts';
import { isUniqueViolation } from '../db/uniqueViolation.ts';
import {
  type AdminSessionRow,
  type AdminStore,
  type AdminUserRow,
  type NewAdminSession,
  type NewAdminUser,
  LastOwnerError,
  UsernameTakenError,
  normalizeAdminUsername,
} from './store.ts';

type Database = typeof db;

/** Drizzle executor: the root db handle or an open transaction (shared subset). */
type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

/**
 * Serialises every owner-count-sensitive admin write. Transaction-scoped, so
 * it is released automatically on commit or rollback.
 */
const ADMIN_USERS_LOCK = sql`select pg_advisory_xact_lock(hashtext('sumire_admin_users'))`;

async function enabledOwnersExcept(database: Executor, userId: string): Promise<number> {
  const [row] = await database
    .select({ value: count() })
    .from(adminUsers)
    .where(
      and(eq(adminUsers.role, 'owner'), eq(adminUsers.disabled, false), ne(adminUsers.id, userId)),
    );
  return Number(row?.value ?? 0);
}

function insertValues(user: NewAdminUser, role = user.role): NewAdminUser {
  return {
    id: user.id,
    username: normalizeAdminUsername(user.username),
    passwordHash: user.passwordHash,
    role,
    disabled: user.disabled ?? false,
  };
}

/** Drizzle-backed admin store; defaults to the shared `db` handle. */
export function drizzleAdminStore(database: Database = db): AdminStore {
  return {
    async count(): Promise<number> {
      const [row] = await database.select({ value: count() }).from(adminUsers);
      return Number(row?.value ?? 0);
    },
    async getById(id: string): Promise<AdminUserRow | undefined> {
      const rows = await database.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
      return rows[0];
    },
    async getByUsername(username: string): Promise<AdminUserRow | undefined> {
      const rows = await database
        .select()
        .from(adminUsers)
        .where(eq(adminUsers.username, normalizeAdminUsername(username)))
        .limit(1);
      return rows[0];
    },
    async listByIds(ids: readonly string[]): Promise<AdminUserRow[]> {
      if (ids.length === 0) return [];
      return database.select().from(adminUsers).where(inArray(adminUsers.id, [...ids]));
    },
    async list(): Promise<AdminUserRow[]> {
      return database.select().from(adminUsers);
    },
    async create(user: NewAdminUser): Promise<AdminUserRow> {
      try {
        const [row] = await database.insert(adminUsers).values(insertValues(user)).returning();
        return row;
      } catch (error) {
        if (isUniqueViolation(error)) throw new UsernameTakenError();
        throw error;
      }
    },
    async createFirstOwner(user: NewAdminUser): Promise<AdminUserRow | null> {
      try {
        return await database.transaction(async (tx) => {
          await tx.execute(ADMIN_USERS_LOCK);
          const [row] = await tx.select({ value: count() }).from(adminUsers);
          if (Number(row?.value ?? 0) > 0) return null;
          const [created] = await tx
            .insert(adminUsers)
            .values(insertValues(user, 'owner'))
            .returning();
          return created;
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new UsernameTakenError();
        throw error;
      }
    },
    async setRole(id: string, role: string): Promise<boolean> {
      return database.transaction(async (tx) => {
        await tx.execute(ADMIN_USERS_LOCK);
        const rows = await tx.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
        const target = rows[0];
        if (!target) return false;
        if (
          target.role === 'owner' &&
          !target.disabled &&
          role !== 'owner' &&
          (await enabledOwnersExcept(tx, id)) === 0
        ) {
          throw new LastOwnerError();
        }
        await tx.update(adminUsers).set({ role }).where(eq(adminUsers.id, id));
        return true;
      });
    },
    async setDisabled(id: string, disabled: boolean): Promise<boolean> {
      return database.transaction(async (tx) => {
        await tx.execute(ADMIN_USERS_LOCK);
        const rows = await tx.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
        const target = rows[0];
        if (!target) return false;
        if (
          disabled &&
          target.role === 'owner' &&
          !target.disabled &&
          (await enabledOwnersExcept(tx, id)) === 0
        ) {
          throw new LastOwnerError();
        }
        await tx.update(adminUsers).set({ disabled }).where(eq(adminUsers.id, id));
        return true;
      });
    },
    async setPasswordHash(id: string, passwordHash: string): Promise<boolean> {
      const rows = await database
        .update(adminUsers)
        .set({ passwordHash })
        .where(eq(adminUsers.id, id))
        .returning({ id: adminUsers.id });
      return rows.length > 0;
    },
    async touchLogin(id: string, at: Date): Promise<void> {
      await database.update(adminUsers).set({ lastLoginAt: at }).where(eq(adminUsers.id, id));
    },
    async createSession(session: NewAdminSession): Promise<void> {
      await database.insert(adminSessions).values(session);
    },
    async getSessionByTokenHash(tokenHash: string): Promise<AdminSessionRow | undefined> {
      const rows = await database
        .select()
        .from(adminSessions)
        .where(eq(adminSessions.tokenHash, tokenHash))
        .limit(1);
      return rows[0];
    },
    async touchSession(tokenHash: string, lastSeenAt: Date): Promise<void> {
      await database
        .update(adminSessions)
        .set({ lastSeenAt })
        .where(eq(adminSessions.tokenHash, tokenHash));
    },
    async deleteSession(tokenHash: string): Promise<void> {
      await database.delete(adminSessions).where(eq(adminSessions.tokenHash, tokenHash));
    },
    async deleteSessionsForUser(userId: string): Promise<void> {
      await database.delete(adminSessions).where(eq(adminSessions.userId, userId));
    },
    async deleteExpiredSessions(now: Date): Promise<void> {
      await database.delete(adminSessions).where(lte(adminSessions.expiresAt, now));
    },
  };
}
