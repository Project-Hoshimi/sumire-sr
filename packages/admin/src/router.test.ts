import { describe, expect, it } from 'vitest';
import { navigate, parseHash } from './router.ts';

describe('parseHash', () => {
  it('defaults to the events list for an empty hash', () => {
    expect(parseHash('')).toEqual({ name: 'events' });
    expect(parseHash('#')).toEqual({ name: 'events' });
    expect(parseHash('#/')).toEqual({ name: 'events' });
  });

  it('parses the top-level routes', () => {
    expect(parseHash('#/events')).toEqual({ name: 'events' });
    expect(parseHash('#/rosters')).toEqual({ name: 'rosters' });
    expect(parseHash('#/users')).toEqual({ name: 'users' });
    expect(parseHash('#/login')).toEqual({ name: 'login' });
  });

  it('parses detail routes and decodes the id', () => {
    expect(parseHash('#/events/marathon-1')).toEqual({ name: 'event', id: 'marathon-1' });
    expect(parseHash('#/rosters/qt-main-1-007-04')).toEqual({
      name: 'roster',
      id: 'qt-main-1-007-04',
    });
    expect(parseHash('#/events/a%20b')).toEqual({ name: 'event', id: 'a b' });
    expect(parseHash('#/events/marathon-1/publish')).toEqual({
      name: 'publish',
      id: 'marathon-1',
    });
    expect(parseHash('#/events/a%20b/publish')).toEqual({ name: 'publish', id: 'a b' });
  });

  it('accepts hashes without the leading # and ignores queries/trailing slashes', () => {
    expect(parseHash('/events')).toEqual({ name: 'events' });
    expect(parseHash('#/events/?tab=draft')).toEqual({ name: 'events' });
    expect(parseHash('#/events/e1?tab=preview')).toEqual({ name: 'event', id: 'e1' });
    expect(parseHash('#/rosters/')).toEqual({ name: 'rosters' });
    expect(parseHash('#/rosters/new')).toEqual({ name: 'rosterNew' });
  });

  it('reports unknown routes', () => {
    expect(parseHash('#/nope')).toEqual({ name: 'notFound', path: '/nope' });
    expect(parseHash('#/events/a/b')).toEqual({ name: 'notFound', path: '/events/a/b' });
    expect(parseHash('#/users/x')).toEqual({ name: 'notFound', path: '/users/x' });
  });

  it('keeps a malformed percent escape instead of throwing', () => {
    expect(parseHash('#/events/%E0%A4%A')).toEqual({ name: 'event', id: '%E0%A4%A' });
  });
});

describe('navigate', () => {
  it('sets location.hash with or without a leading #', () => {
    navigate('/events');
    expect(window.location.hash).toBe('#/events');
    navigate('#/rosters');
    expect(window.location.hash).toBe('#/rosters');
  });
});
