import { describe, expect, it } from 'vitest';
import { normalizeUsername, validateNewUser } from './users.ts';

describe('normalizeUsername', () => {
  it('lowercases without trimming', () => {
    expect(normalizeUsername('Admin.User')).toBe('admin.user');
    expect(normalizeUsername(' padded ')).toBe(' padded ');
  });
});

describe('validateNewUser', () => {
  it('accepts a lowercase username and a 12+ character password', () => {
    expect(validateNewUser('new.user-1', 'twelve chars!')).toEqual({});
  });

  it('lowercases before applying the username pattern', () => {
    expect(validateNewUser('NEW.USER', 'twelve chars!')).toEqual({});
  });

  it('rejects short or illegal usernames', () => {
    expect(validateNewUser('ab', 'twelve chars!').username).toBeDefined();
    expect(validateNewUser('bad user', 'twelve chars!').username).toBeDefined();
    expect(validateNewUser('x'.repeat(33), 'twelve chars!').username).toBeDefined();
  });

  it('rejects passwords under 12 characters', () => {
    expect(validateNewUser('good-name', 'short').password).toBe(
      'Password must be at least 12 characters.',
    );
  });
});
