/**
 * Users screen: owner-only rendering, create-form validation before the
 * request, username lowercasing on send, and server last-owner errors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, get, post, put } from '../api.ts';
import type { AdminSessionUser, AdminUser } from '../types.ts';
import { UsersPage } from './UsersPage.tsx';

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>();
  return { ...actual, get: vi.fn(), post: vi.fn(), put: vi.fn() };
});

function user(role: AdminSessionUser['role']): AdminSessionUser {
  return { id: `user-${role}`, username: role, role };
}

function adminUser(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: 'u1',
    username: 'alice',
    role: 'owner',
    disabled: false,
    createdAt: '2026-01-01T00:00:00Z',
    lastLoginAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(get).mockReset();
  vi.mocked(post).mockReset();
  vi.mocked(put).mockReset();
  vi.mocked(get).mockResolvedValue([adminUser()] as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('UsersPage', () => {
  it('renders no management UI for a non-owner', () => {
    render(<UsersPage user={user('publisher')} />);

    expect(screen.getByText('Only owners can manage admin users.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create user' })).toBeNull();
    expect(vi.mocked(get)).not.toHaveBeenCalled();
  });

  it('validates the username and password before creating', async () => {
    const writer = userEvent.setup();
    render(<UsersPage user={user('owner')} />);

    await writer.type(screen.getByLabelText('Username'), 'ab');
    await writer.type(screen.getByLabelText('Password'), 'short');
    await writer.click(screen.getByRole('button', { name: 'Create user' }));

    expect(await screen.findByText(/3–32 characters/)).toBeTruthy();
    expect(screen.getByText('Password must be at least 12 characters.')).toBeTruthy();
    expect(vi.mocked(post)).not.toHaveBeenCalled();
  });

  it('lowercases the username before creating', async () => {
    const writer = userEvent.setup();
    vi.mocked(post).mockResolvedValue({ user: adminUser({ id: 'u2', username: 'new.user' }) } as never);
    render(<UsersPage user={user('owner')} />);

    await writer.type(screen.getByLabelText('Username'), 'NEW.USER');
    await writer.type(screen.getByLabelText('Password'), 'twelve chars!');
    await writer.click(screen.getByRole('button', { name: 'Create user' }));

    await waitFor(() => {
      expect(vi.mocked(post)).toHaveBeenCalledWith('/users', {
        username: 'new.user',
        role: 'viewer',
        password: 'twelve chars!',
      });
    });
  });

  it('surfaces the server last-owner error', async () => {
    const writer = userEvent.setup();
    vi.mocked(post).mockRejectedValue(
      new ApiError(409, { error: 'cannot disable the last enabled owner' }),
    );
    render(<UsersPage user={user('owner')} />);

    await writer.click(await screen.findByRole('button', { name: 'Disable alice' }));

    expect(await screen.findByText('cannot disable the last enabled owner')).toBeTruthy();
  });

  it('clears a typed reset password after failure and after cancel', async () => {
    const writer = userEvent.setup();
    vi.mocked(post).mockRejectedValueOnce(new ApiError(500, { error: 'reset failed' }));
    render(<UsersPage user={user('owner')} />);

    const input = (await screen.findByLabelText('New password for alice')) as HTMLInputElement;
    await writer.type(input, 'twelve chars!');
    await writer.click(screen.getByRole('button', { name: 'Reset password' }));
    await waitFor(() => {
      expect(input.value).toBe('');
    });

    await writer.type(input, 'another password');
    await writer.click(screen.getByRole('button', { name: 'Cancel reset for alice' }));
    expect(input.value).toBe('');
  });
});
