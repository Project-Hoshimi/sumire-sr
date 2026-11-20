/**
 * Publish screen behaviour: blocking impacts disable publishing, the publish
 * request has the route's (empty) body, conflicts ask for a preview reload and
 * rollback confirms before republishing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, get, post } from '../api.ts';
import type { AdminSessionUser, EventDetail, PublishPreview } from '../types.ts';
import { EventPublishPage } from './EventPublishPage.tsx';

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>();
  return { ...actual, get: vi.fn(), post: vi.fn(), put: vi.fn() };
});

const EVENT_ID = 'evt-1';

function detail(): EventDetail {
  return {
    id: EVENT_ID,
    kind: 'marathon',
    title: 'Test event',
    titleEn: null,
    draft: { name: 'Draft name', initialStamina: 20 },
    published: { name: 'Published name', initialStamina: 10 },
    publishedVersion: 2,
    updatedBy: 'alice',
    updatedByName: 'alice',
    updatedAt: '2026-01-01T00:00:00Z',
    schedule: [],
    schema: null,
    history: [
      {
        version: 2,
        publishedBy: 'alice',
        publishedByName: 'alice',
        publishedAt: '2026-01-02T00:00:00Z',
      },
      {
        version: 1,
        publishedBy: 'bob',
        publishedByName: 'bob',
        publishedAt: '2026-01-01T00:00:00Z',
      },
    ],
  };
}

function preview(overrides: Partial<PublishPreview> = {}): PublishPreview {
  return {
    eventId: EVENT_ID,
    fromVersion: 2,
    // sha256 of the canonical JSON of detail().draft: {"initialStamina":20,"name":"Draft name"}
    draftHash: '317582cfdbe2cd8defaf4823f12299dabace8f360a10fb385f87883fe435c265',
    changedKeys: ['name'],
    impacts: [],
    blocking: false,
    ...overrides,
  };
}

function user(role: AdminSessionUser['role']): AdminSessionUser {
  return { id: `user-${role}`, username: role, role };
}

function stubGet(nextPreview: PublishPreview): void {
  vi.mocked(get).mockImplementation(((path: string) => {
    if (path === `/events/${EVENT_ID}`) return Promise.resolve(detail());
    if (path === `/events/${EVENT_ID}/preview`) return Promise.resolve(nextPreview);
    if (path === `/events/${EVENT_ID}/history/1`) {
      return Promise.resolve({
        version: 1,
        published: { name: 'Original name', initialStamina: 10 },
        publishedBy: 'bob',
        publishedByName: 'bob',
        publishedAt: '2026-01-01T00:00:00Z',
      });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }) as never);
}

beforeEach(() => {
  window.location.hash = `#/events/${EVENT_ID}`;
  vi.mocked(get).mockReset();
  vi.mocked(post).mockReset();
  vi.mocked(post).mockResolvedValue(undefined as never);
  stubGet(preview());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EventPublishPage', () => {
  it('disables publishing while an impact blocks', async () => {
    stubGet(
      preview({
        blocking: true,
        impacts: [
          {
            code: 'stock-shrink',
            severity: 'block',
            message: 'Players already own this item',
            requiresPlayerCheck: true,
            affectedPlayers: 3,
          },
        ],
      }),
    );
    render(<EventPublishPage id={EVENT_ID} user={user('publisher')} />);

    const publish = (await screen.findByRole('button', {
      name: /Publish version/,
    })) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    expect(await screen.findByText('Players already own this item')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('confirms and posts the publish request with the previewed draft hash', async () => {
    const writer = userEvent.setup();
    const nativeConfirm = vi.spyOn(window, 'confirm');
    render(<EventPublishPage id={EVENT_ID} user={user('publisher')} />);

    await writer.click(await screen.findByRole('button', { name: 'Publish version 3' }));

    // Nothing is sent until the in-page dialog is confirmed.
    expect(vi.mocked(post)).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog', { name: 'Publish version 3?' });
    await writer.click(within(dialog).getByRole('button', { name: 'Publish version 3' }));

    await waitFor(() => {
      expect(vi.mocked(post)).toHaveBeenCalledWith(`/events/${EVENT_ID}/publish`, {
        expectedDraftHash: '317582cfdbe2cd8defaf4823f12299dabace8f360a10fb385f87883fe435c265',
      });
    });
    expect(nativeConfirm).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/events/${EVENT_ID}`);
    });
  });

  it('sends nothing when the publish dialog is cancelled', async () => {
    const writer = userEvent.setup();
    const nativeConfirm = vi.spyOn(window, 'confirm');
    render(<EventPublishPage id={EVENT_ID} user={user('publisher')} />);

    await writer.click(await screen.findByRole('button', { name: 'Publish version 3' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Publish version 3?' });
    await writer.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(vi.mocked(post)).not.toHaveBeenCalled();
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(`#/events/${EVENT_ID}`);
  });

  it('reports a stale-preview conflict', async () => {
    const writer = userEvent.setup();
    vi.mocked(post).mockRejectedValue(
      new ApiError(409, { error: 'draft changed since preview', code: 'stale-preview' }),
    );
    render(<EventPublishPage id={EVENT_ID} user={user('publisher')} />);

    await writer.click(await screen.findByRole('button', { name: 'Publish version 3' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Publish version 3?' });
    await writer.click(within(dialog).getByRole('button', { name: 'Publish version 3' }));

    expect(
      await screen.findByText('The draft changed since this preview. Reload the preview.'),
    ).toBeTruthy();
  });

  it('renders the impacts of a blocked publish', async () => {
    const writer = userEvent.setup();
    vi.mocked(post).mockRejectedValue(
      new ApiError(409, {
        error: 'publish blocked',
        impacts: [
          {
            code: 'item-key-missing',
            severity: 'block',
            message: 'Box item has no itemKey',
            requiresPlayerCheck: false,
          },
        ],
      }),
    );
    render(<EventPublishPage id={EVENT_ID} user={user('publisher')} />);

    await writer.click(await screen.findByRole('button', { name: 'Publish version 3' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Publish version 3?' });
    await writer.click(within(dialog).getByRole('button', { name: 'Publish version 3' }));

    expect(await screen.findByText('Publish blocked')).toBeTruthy();
    expect(screen.getByText('Box item has no itemKey')).toBeTruthy();
    expect(screen.getByText('item-key-missing')).toBeTruthy();
  });

  it('confirms a rollback and posts its version', async () => {
    const writer = userEvent.setup();
    const nativeConfirm = vi.spyOn(window, 'confirm');
    render(<EventPublishPage id={EVENT_ID} user={user('publisher')} />);

    await writer.click(await screen.findByRole('button', { name: 'Rollback to v1' }));

    // The stored version is fetched and diffed before the confirmation.
    const heading = await screen.findByRole('heading', { name: 'Rollback to v1' });
    expect(vi.mocked(get)).toHaveBeenCalledWith(`/events/${EVENT_ID}/history/1`);
    const panel = heading.closest('.panel') as HTMLElement;
    expect(within(panel).getByText('name')).toBeTruthy();
    expect(vi.mocked(post)).not.toHaveBeenCalled();

    await writer.click(screen.getByRole('button', { name: 'Confirm rollback to v1' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Roll back to version 1?' });
    expect(within(dialog).getByText('This republishes that stored definition as a new version.')).toBeTruthy();
    await writer.click(within(dialog).getByRole('button', { name: 'Roll back to v1' }));

    await waitFor(() => {
      expect(vi.mocked(post)).toHaveBeenCalledWith(`/events/${EVENT_ID}/rollback`, { version: 1 });
    });
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Rollback to v2' })).toBeNull();
  });

  it('disables publishing with an explicit label when nothing changed', async () => {
    stubGet(preview({ changedKeys: [] }));
    render(<EventPublishPage id={EVENT_ID} user={user('publisher')} />);

    const publish = (await screen.findByRole('button', {
      name: 'Nothing to publish',
    })) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    expect(publish.title).toBe('Nothing to publish');
    expect(screen.queryByRole('button', { name: /Publish version/ })).toBeNull();
  });
});
