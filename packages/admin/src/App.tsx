import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, login, logout, onUnauthorized, session, takePostLoginHash } from './api.ts';
import { ErrorBanner } from './components/ErrorBanner.tsx';
import { EventPublishPage } from './pages/EventPublishPage.tsx';
import { EventsPage } from './pages/EventsPage.tsx';
import { RacePlayersPage } from './pages/race/RacePlayersPage.tsx';
import { RostersPage } from './pages/RostersPage.tsx';
import { UsersPage } from './pages/UsersPage.tsx';
import { roleAtLeast } from './role.ts';
import { navigate, useHashRoute, type Route } from './router.ts';
import type { AdminSessionUser } from './types.ts';

/** Pull the server's `{ error }` message out of a failed request. */
function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body;
    if (body && typeof body === 'object' && 'error' in body) {
      const value = (body as { error: unknown }).error;
      if (typeof value === 'string' && value !== '') return value;
    }
    return `request failed (${error.status})`;
  }
  return error instanceof Error ? error.message : String(error);
}

function LoginScreen({ onLogin }: { onLogin: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onLogin(username, password);
      setPassword('');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-screen">
      <h1>Sumire SR Admin</h1>
      {error === null ? null : <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <form className="login-form" onSubmit={handleSubmit}>
        <label>
          Username
          <input
            type="text"
            value={username}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

function routeView(route: Route, user: AdminSessionUser) {
  switch (route.name) {
    case 'events':
      return <EventsPage user={user} />;
    case 'event':
      return <EventsPage id={route.id} user={user} />;
    case 'publish':
      return <EventPublishPage id={route.id} user={user} />;
    case 'racePlayers':
      return <RacePlayersPage id={route.id} user={user} />;
    case 'rosters':
      return <RostersPage user={user} />;
    case 'rosterNew':
      return <RostersPage newRoster user={user} />;
    case 'roster':
      return <RostersPage id={route.id} user={user} />;
    case 'users':
      return <UsersPage user={user} />;
    case 'login':
      return <EventsPage user={user} />;
    case 'notFound':
      return (
        <section>
          <h2>Not found</h2>
          <p>
            No screen for <code>#{route.path}</code>.
          </p>
        </section>
      );
  }
}

export default function App() {
  const route = useHashRoute();
  const [user, setUser] = useState<AdminSessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onUnauthorized(() => {
      if (!cancelled) setUser(null);
    });
    session()
      .then((res) => {
        if (!cancelled) setUser(res.user);
      })
      .catch((err: unknown) => {
        // A 401 is the normal "not signed in" path; api() already reset state.
        if (!cancelled && !(err instanceof ApiError && err.status === 401)) {
          setError(messageOf(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  async function handleLogin(username: string, password: string): Promise<void> {
    const res = await login(username, password);
    setUser(res.user);
    setError(null);
    // Return to the deep link a 401 interrupted, or the events list by default.
    navigate(takePostLoginHash());
  }

  async function handleLogout(): Promise<void> {
    setError(null);
    try {
      await logout();
    } catch (err) {
      // A 401 means the session was already gone; every other failure is shown.
      if (!(err instanceof ApiError && err.status === 401)) setError(messageOf(err));
    } finally {
      setUser(null);
      navigate('/login');
    }
  }

  if (loading) return <main className="loading">Loading…</main>;

  if (user === null) {
    return (
      <>
        {error === null ? null : (
          <div className="global-error">
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          </div>
        )}
        <LoginScreen onLogin={handleLogin} />
      </>
    );
  }

  const current: Route = route.name === 'login' ? { name: 'events' } : route;

  return (
    <div className="app">
      <header className="session-bar">
        <span className="brand">Sumire SR Admin</span>
        <nav className="nav">
          <a href="#/events">Events</a>
          <a href="#/rosters">Rosters</a>
          {roleAtLeast(user.role, 'owner') ? <a href="#/users">Users</a> : null}
        </nav>
        <span className="session-user">
          {user.username} <span className="role-badge">{user.role}</span>
        </span>
        <button type="button" className="logout" onClick={() => void handleLogout()}>
          Log out
        </button>
      </header>
      <main className="content">
        {error === null ? null : <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        {routeView(current, user)}
      </main>
    </div>
  );
}
