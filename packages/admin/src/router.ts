/**
 * Tiny hash router. Hash routing keeps the UI reload-safe behind the static
 * server and needs no server-side rewrite rules.
 *
 * Routes:
 *   #/events          #/events/:id          #/events/:id/publish
 *   #/events/:id/players                  (race live-ops)
 *   #/rosters         #/rosters/new         #/rosters/:id
 *   #/users           #/login
 */
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'events' }
  | { name: 'event'; id: string }
  | { name: 'publish'; id: string }
  | { name: 'racePlayers'; id: string }
  | { name: 'rosters' }
  | { name: 'rosterNew' }
  | { name: 'roster'; id: string }
  | { name: 'users' }
  | { name: 'login' }
  | { name: 'notFound'; path: string };

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Parse `location.hash` (with or without the leading `#`). */
export function parseHash(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const path = (raw.split('?')[0] ?? '').split('#')[0] ?? '';
  const parts = path.split('/').filter((part) => part !== '');
  const head = parts[0];

  if (head === undefined) return { name: 'events' };
  if (head === 'login' && parts.length === 1) return { name: 'login' };
  if (head === 'users' && parts.length === 1) return { name: 'users' };
  if (head === 'rosters' && parts.length === 2 && parts[1] === 'new') {
    return { name: 'rosterNew' };
  }

  if (head === 'events' || head === 'rosters') {
    if (parts.length === 1) return { name: head };
    if (parts.length === 2) {
      const id = decode(parts[1] as string);
      return { name: head === 'events' ? 'event' : 'roster', id };
    }
    if (head === 'events' && parts.length === 3 && parts[2] === 'publish') {
      return { name: 'publish', id: decode(parts[1] as string) };
    }
    if (head === 'events' && parts.length === 3 && parts[2] === 'players') {
      return { name: 'racePlayers', id: decode(parts[1] as string) };
    }
  }

  return { name: 'notFound', path };
}

/** Navigate to a hash route; `path` may be given with or without `#`. */
export function navigate(path: string): void {
  window.location.hash = path.startsWith('#') ? path : `#${path}`;
}

/** The current route, re-rendering the caller on every `hashchange`. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);

  return route;
}
