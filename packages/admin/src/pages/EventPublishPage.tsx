/**
 * Publish screen (`#/events/:id/publish`): the server-computed preview of the
 * stored draft, the state impacts it would cause, publish itself, and the
 * published-version history with rollback.
 *
 * The preview is version-less: the server always compares the current draft
 * against the current published version. A rollback first fetches the stored
 * version and shows its top-level diff against the current published payload,
 * then asks for confirmation before republishing it as a new version.
 */
import { useEffect, useState } from 'react';
import { ApiError, get, post } from '../api.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { ErrorBanner } from '../components/ErrorBanner.tsx';
import { describeError } from '../errors.ts';
import { draftHash } from '../hash.ts';
import { savePublishNotice } from '../publishNotice.ts';
import { navigate } from '../router.ts';
import { roleAtLeast } from '../role.ts';
import type {
  AdminSessionUser,
  EventDetail,
  EventHistoryVersion,
  PublishPreview,
  PublishResult,
  PreviewImpact,
  EventHistoryEntry,
} from '../types.ts';

/** Pretty JSON for a `<pre>`; server payloads are plain JSON by construction. */
export function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

/** `published` is `null` (or the legacy `false`) when nothing is published yet. */
export function publishedValue(detail: Pick<EventDetail, 'published'>): unknown {
  return detail.published === false ? null : detail.published;
}

function historyNewestFirst(history: readonly EventHistoryEntry[]): EventHistoryEntry[] {
  return [...history].sort((a, b) => b.version - a.version);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Top-level keys whose JSON differs, mirroring the server's preview diff. */
export function changedTopLevelKeys(left: unknown, right: unknown): string[] {
  const leftRecord = isRecord(left) ? left : {};
  const rightRecord = isRecord(right) ? right : {};
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  return [...keys].filter(
    (key) => JSON.stringify(leftRecord[key]) !== JSON.stringify(rightRecord[key]),
  );
}

/**
 * Side-by-side JSON for changed top-level keys. The publish preview and the
 * rollback preview share it so both diffs read the same way.
 */
function ChangedKeysDiff({
  changedKeys,
  left,
  right,
  leftLabel,
  rightLabel,
  emptyMessage,
}: {
  changedKeys: readonly string[];
  left: unknown;
  right: unknown;
  leftLabel: string;
  rightLabel: string;
  emptyMessage: string;
}) {
  if (changedKeys.length === 0) return <p className="muted">{emptyMessage}</p>;
  const leftRecord = isRecord(left) ? left : {};
  const rightRecord = isRecord(right) ? right : {};
  return (
    <>
      {changedKeys.map((key) => (
        <div className="box-card" key={key}>
          <h4>
            <code>{key}</code>
          </h4>
          <div className="change-grid">
            <div>
              <h5>{leftLabel}</h5>
              <pre>{jsonText(leftRecord[key])}</pre>
            </div>
            <div>
              <h5>{rightLabel}</h5>
              <pre>{jsonText(rightRecord[key])}</pre>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

export function EventPublishPage({ id, user }: { id: string; user: AdminSessionUser }) {
  const canPublish = roleAtLeast(user.role, 'publisher');
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [blockedImpacts, setBlockedImpacts] = useState<PreviewImpact[] | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<EventHistoryVersion | null>(null);
  /** In-page confirmations, since native window.confirm can be suppressed. */
  const [publishOpen, setPublishOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBlockedImpacts(null);
    setRollbackTarget(null);
    setPublishOpen(false);
    setRollbackOpen(false);

    /** Detail first, then the preview; both reads see the same draft in the common case. */
    async function loadPair(): Promise<{ nextDetail: EventDetail; nextPreview: PublishPreview }> {
      const nextDetail = await get<EventDetail>(`/events/${encodeURIComponent(id)}`);
      const nextPreview = await get<PublishPreview>(`/events/${encodeURIComponent(id)}/preview`);
      return { nextDetail, nextPreview };
    }

    void (async () => {
      try {
        let pair = await loadPair();
        let hash = await draftHash(pair.nextDetail.draft);
        if (hash !== pair.nextPreview.draftHash) {
          // One retry covers a draft saved between the detail and preview reads.
          pair = await loadPair();
          hash = await draftHash(pair.nextDetail.draft);
        }
        if (cancelled) return;
        setDetail(pair.nextDetail);
        setPreview(pair.nextPreview);
        if (hash !== pair.nextPreview.draftHash) {
          setError('Draft changed while loading, reload');
        }
      } catch (err: unknown) {
        if (!cancelled) setError(describeError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, reloadToken]);

  /** A publish is only offerable when every guard passes. */
  function publishReady(): boolean {
    return (
      canPublish &&
      preview !== null &&
      !preview.blocking &&
      preview.changedKeys.length > 0 &&
      !busy
    );
  }

  /** Ask before publishing; the guards are re-checked once the dialog confirms. */
  function requestPublish(): void {
    if (!publishReady()) return;
    setPublishOpen(true);
  }

  async function handlePublish(): Promise<void> {
    setPublishOpen(false);
    if (!publishReady() || preview === null) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    setBlockedImpacts(null);
    try {
      const result = await post<PublishResult>(`/events/${encodeURIComponent(id)}/publish`, {
        expectedDraftHash: preview.draftHash,
      });
      savePublishNotice(id, { version: result.version, warnings: result.warnings });
      navigate(`/events/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as {
          code?: unknown;
          impacts?: unknown;
          error?: unknown;
        } | null;
        if (body !== null && typeof body === 'object') {
          if (body.code === 'stale-preview') {
            setError('The draft changed since this preview. Reload the preview.');
            return;
          }
          if (Array.isArray(body.impacts)) {
            setBlockedImpacts(body.impacts as PreviewImpact[]);
            setError('Publish blocked');
            return;
          }
          if (typeof body.error === 'string') {
            setError(body.error);
            return;
          }
        }
        setError('Publish conflict — reload the preview and try again.');
      } else {
        setError(describeError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRollback(version: number): Promise<void> {
    if (!canPublish) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    setRollbackTarget(null);
    try {
      const target = await get<EventHistoryVersion>(
        `/events/${encodeURIComponent(id)}/history/${version}`,
      );
      setRollbackTarget(target);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  /** Ask before republishing the previewed version. */
  function requestRollback(): void {
    if (!canPublish || rollbackTarget === null || busy) return;
    setRollbackOpen(true);
  }

  /** Confirm a previewed rollback, then republish the fetched version. */
  async function confirmRollback(): Promise<void> {
    setRollbackOpen(false);
    if (!canPublish || rollbackTarget === null) return;
    const { version } = rollbackTarget;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await post(`/events/${encodeURIComponent(id)}/rollback`, { version });
      setMessage(`Rolled back to version ${version}.`);
      setRollbackTarget(null);
      setReloadToken((value) => value + 1);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (error !== null && detail === null) {
    return (
      <section>
        <button
          type="button"
          className="link-button"
          onClick={() => navigate(`/events/${encodeURIComponent(id)}`)}
        >
          ← Editor
        </button>
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      </section>
    );
  }

  if (loading && detail === null) return <p className="loading">Loading preview…</p>;
  if (detail === null || preview === null) return <p className="loading">Loading preview…</p>;

  const published = publishedValue(detail);
  const history = historyNewestFirst(detail.history);
  const nothingToPublish = preview.changedKeys.length === 0;

  return (
    <section className="editor">
      <div className="editor-head">
        <button
          type="button"
          className="link-button"
          onClick={() => navigate(`/events/${encodeURIComponent(id)}`)}
        >
          ← Editor
        </button>
        <h2>
          Publish <code>{detail.id}</code>
        </h2>
        <span className="muted">
          {detail.title} · publishing from v{preview.fromVersion}
        </span>
        <div className="editor-actions">
          <button type="button" disabled={loading} onClick={() => setReloadToken((value) => value + 1)}>
            Reload preview
          </button>
          <button
            type="button"
            disabled={!canPublish || nothingToPublish || preview.blocking || busy}
            title={
              !canPublish
                ? 'Requires the publisher role'
                : nothingToPublish
                  ? 'Nothing to publish'
                  : preview.blocking
                    ? 'Resolve blocking impacts before publishing'
                    : 'Publish this draft'
            }
            onClick={() => void requestPublish()}
          >
            {nothingToPublish ? 'Nothing to publish' : `Publish version ${preview.fromVersion + 1}`}
          </button>
        </div>
      </div>

      {error === null ? null : <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {message === null ? null : <p className="notice">{message}</p>}

      <h3>Changes</h3>
      <ChangedKeysDiff
        changedKeys={preview.changedKeys}
        left={published}
        right={detail.draft}
        leftLabel="Published"
        rightLabel="Draft"
        emptyMessage="The draft matches the published definition."
      />

      <h3>Impacts</h3>
      {(blockedImpacts ?? preview.impacts).length === 0 ? (
        <p className="muted">No state impacts.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Severity</th>
              <th>Code</th>
              <th>Message</th>
              <th>Box</th>
              <th>Item</th>
              <th>Quest</th>
              <th>Affected players</th>
            </tr>
          </thead>
          <tbody>
            {(blockedImpacts ?? preview.impacts).map((impact, index) => (
              <tr key={`${impact.code}-${index}`}>
                <td className={impact.severity === 'block' ? 'error' : 'warning'}>{impact.severity}</td>
                <td>
                  <code>{impact.code}</code>
                </td>
                <td>{impact.message}</td>
                <td>{impact.boxId ?? '—'}</td>
                <td>{impact.itemKey ?? '—'}</td>
                <td>{impact.questId ?? '—'}</td>
                <td>{impact.affectedPlayers ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>History</h3>
      {history.length === 0 ? (
        <p className="muted">Nothing has been published yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Published by</th>
              <th>Published at</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {history.map((entry) => {
              const current = entry.version === detail.publishedVersion;
              return (
                <tr key={entry.version}>
                  <td>
                    v{entry.version}
                    {current ? ' (current)' : ''}
                  </td>
                  <td>{entry.publishedByName ?? entry.publishedBy ?? '—'}</td>
                  <td>{entry.publishedAt}</td>
                  <td>
                    {current ? null : (
                      <button
                        type="button"
                        disabled={!canPublish || busy}
                        title={
                          canPublish
                            ? 'Review this version before rolling back'
                            : 'Requires the publisher role'
                        }
                        onClick={() => void handleRollback(entry.version)}
                      >
                        Rollback to v{entry.version}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {rollbackTarget === null ? null : (
        <>
          <div className="panel">
            <h3>Rollback to v{rollbackTarget.version}</h3>
            <p className="muted">
              Published by{' '}
              {rollbackTarget.publishedByName ?? rollbackTarget.publishedBy ?? 'unknown'} at{' '}
              {rollbackTarget.publishedAt}. These top-level keys differ from the current published
              definition.
            </p>
            <ChangedKeysDiff
              changedKeys={changedTopLevelKeys(published, rollbackTarget.published)}
              left={published}
              right={rollbackTarget.published}
              leftLabel="Current published"
              rightLabel={`v${rollbackTarget.version}`}
              emptyMessage="This version matches the current published definition."
            />
            <div className="editor-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setRollbackTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canPublish || busy}
                onClick={() => requestRollback()}
              >
                Confirm rollback to v{rollbackTarget.version}
              </button>
            </div>
          </div>
          <ConfirmDialog
            open={rollbackOpen}
            title={`Roll back to version ${rollbackTarget.version}?`}
            message="This republishes that stored definition as a new version."
            confirmLabel={`Roll back to v${rollbackTarget.version}`}
            busy={busy}
            onConfirm={() => void confirmRollback()}
            onCancel={() => setRollbackOpen(false)}
          />
        </>
      )}

      <ConfirmDialog
        open={publishOpen}
        title={`Publish version ${preview.fromVersion + 1}?`}
        message="The previewed draft replaces the current published definition."
        confirmLabel={`Publish version ${preview.fromVersion + 1}`}
        busy={busy}
        onConfirm={() => void handlePublish()}
        onCancel={() => setPublishOpen(false)}
      />
    </section>
  );
}
