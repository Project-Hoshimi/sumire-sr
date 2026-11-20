/**
 * Owner-only admin user management (`#/users`): create users, change roles,
 * disable/enable accounts and reset passwords. Every mutation is confirmed by
 * the server; its last-owner errors are surfaced verbatim.
 */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { get, post, put } from '../api.ts';
import { ErrorBanner } from '../components/ErrorBanner.tsx';
import { describeError } from '../errors.ts';
import { roleAtLeast } from '../role.ts';
import { ADMIN_ROLES, type AdminRole, type AdminSessionUser, type AdminUser } from '../types.ts';
import {
  hasErrors,
  normalizeUsername,
  PASSWORD_MIN_LENGTH,
  validateNewUser,
  type NewUserErrors,
} from '../users.ts';

function replaceUser(rows: AdminUser[], user: AdminUser): AdminUser[] {
  return rows.map((row) => (row.id === user.id ? user : row));
}

export function UsersPage({ user }: { user: AdminSessionUser }) {
  if (!roleAtLeast(user.role, 'owner')) {
    return (
      <section>
        <h2>Users</h2>
        <p className="muted">Only owners can manage admin users.</p>
      </section>
    );
  }
  return <OwnerUsersPage />;
}

function OwnerUsersPage() {
  const [rows, setRows] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<AdminRole>('viewer');
  const [password, setPassword] = useState('');
  const [newUserErrors, setNewUserErrors] = useState<NewUserErrors>({});
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({});
  const [resetErrors, setResetErrors] = useState<Record<string, string>>({});

  async function reload(): Promise<void> {
    const list = await get<AdminUser[]>('/users');
    setRows(list);
  }

  useEffect(() => {
    let cancelled = false;
    get<AdminUser[]>('/users')
      .then((list) => {
        if (!cancelled) setRows(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const issues = validateNewUser(username, password);
    setNewUserErrors(issues);
    if (hasErrors(issues)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ user: AdminUser }>('/users', {
        username: normalizeUsername(username),
        role,
        password,
      });
      setRows((current) => (current === null ? [result.user] : [...current, result.user]));
      setUsername('');
      setRole('viewer');
      setPassword('');
      setMessage(`Created ${result.user.username}.`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(row: AdminUser, nextRole: string): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await put<{ user: AdminUser }>(`/users/${encodeURIComponent(row.id)}/role`, {
        role: nextRole,
      });
      setRows((current) => (current === null ? current : replaceUser(current, result.user)));
      setMessage(`Changed ${result.user.username} to ${result.user.role}.`);
    } catch (err) {
      setError(describeError(err));
      // Re-read so the select snaps back to the server's truth.
      try {
        await reload();
      } catch {
        // The original error is the useful one.
      }
    } finally {
      setBusy(false);
    }
  }

  async function setDisabled(row: AdminUser, disabled: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await post<{ user: AdminUser }>(
        `/users/${encodeURIComponent(row.id)}/${disabled ? 'disable' : 'enable'}`,
      );
      setRows((current) => (current === null ? current : replaceUser(current, result.user)));
      setMessage(`${disabled ? 'Disabled' : 'Enabled'} ${result.user.username}.`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  function clearResetPassword(id: string): void {
    setResetPasswords((current) => ({ ...current, [id]: '' }));
    setResetErrors((current) => {
      if (!(id in current)) return current;
      const copy = { ...current };
      delete copy[id];
      return copy;
    });
  }

  async function resetPassword(row: AdminUser): Promise<void> {
    const next = resetPasswords[row.id] ?? '';
    if (next.length < PASSWORD_MIN_LENGTH) {
      setResetErrors((current) => ({
        ...current,
        [row.id]: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
      }));
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    setResetErrors((current) => {
      if (!(row.id in current)) return current;
      const copy = { ...current };
      delete copy[row.id];
      return copy;
    });
    try {
      await post(`/users/${encodeURIComponent(row.id)}/password`, { password: next });
      clearResetPassword(row.id);
      setMessage(`Reset the password for ${row.username}.`);
    } catch (err) {
      clearResetPassword(row.id);
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Users</h2>
      {error === null ? null : <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {message === null ? null : <p className="notice">{message}</p>}

      <h3>Create user</h3>
      <form className="inline-form" onSubmit={(event) => void handleCreate(event)}>
        <label>
          Username
          <input
            type="text"
            value={username}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label>
          Role
          <select aria-label="New user role" value={role} onChange={(event) => setRole(event.target.value as AdminRole)}>
            {ADMIN_ROLES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          Create user
        </button>
      </form>
      {newUserErrors.username === undefined ? null : (
        <p className="field-error">{newUserErrors.username}</p>
      )}
      {newUserErrors.password === undefined ? null : (
        <p className="field-error">{newUserErrors.password}</p>
      )}

      <h3>Accounts</h3>
      {rows === null ? (
        error === null ? <p className="loading">Loading users…</p> : null
      ) : (
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last login</th>
              <th>New password</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <code>{row.username}</code>
                </td>
                <td>
                  <select
                    aria-label={`Role for ${row.username}`}
                    value={row.role}
                    disabled={busy}
                    onChange={(event) => void changeRole(row, event.target.value)}
                  >
                    {ADMIN_ROLES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{row.disabled ? 'disabled' : 'enabled'}</td>
                <td>{row.lastLoginAt ?? '—'}</td>
                <td>
                  <input
                    type="password"
                    aria-label={`New password for ${row.username}`}
                    autoComplete="new-password"
                    value={resetPasswords[row.id] ?? ''}
                    onChange={(event) =>
                      setResetPasswords((current) => ({ ...current, [row.id]: event.target.value }))
                    }
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void resetPassword(row)}
                  >
                    Reset password
                  </button>
                  <button
                    type="button"
                    aria-label={`Cancel reset for ${row.username}`}
                    disabled={busy || (resetPasswords[row.id] ?? '') === ''}
                    onClick={() => clearResetPassword(row.id)}
                  >
                    Cancel
                  </button>
                  {resetErrors[row.id] === undefined ? null : (
                    <p className="field-error">{resetErrors[row.id]}</p>
                  )}
                </td>
                <td className="row-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void setDisabled(row, !row.disabled)}
                  >
                    {row.disabled ? `Enable ${row.username}` : `Disable ${row.username}`}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
