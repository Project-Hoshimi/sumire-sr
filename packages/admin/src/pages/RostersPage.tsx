/**
 * NPC rosters: `#/rosters` lists usage counts, `#/rosters/:id` edits one roster
 * in the fixed five-slot form. A shared roster (used by a main-story quest or
 * more than one marathon quest) asks for confirmation before saving.
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError, get, post, put } from '../api.ts';
import { CardPicker } from '../components/CardPicker.tsx';
import { ErrorBanner } from '../components/ErrorBanner.tsx';
import { describeError } from '../errors.ts';
import { navigate } from '../router.ts';
import { roleAtLeast } from '../role.ts';
import {
  duplicateRosterId,
  filledRosterCards,
  isValidRosterId,
  normalizeRosterCards,
  ROSTER_SLOT_COUNT,
  ROSTER_VISUAL_ORDER,
  validateRosterForm,
} from '../roster.ts';
import type {
  AdminSessionUser,
  LookupCard,
  NpcRosterCard,
  RosterDetail,
  RosterSummary,
  RosterUsage,
} from '../types.ts';

function numberOrZero(raw: string): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `#/rosters` — id, name, usage count and last update. */
function RosterListPage({ user }: { user: AdminSessionUser }) {
  const [rows, setRows] = useState<RosterSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    get<RosterSummary[]>('/rosters')
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

  return (
    <section>
      <h2>Rosters</h2>
      <p className="muted">Signed in as {user.username}. {roleAtLeast(user.role, 'editor') ? 'Editor access.' : 'Read-only access.'}</p>
      {roleAtLeast(user.role, 'editor') ? (
        <div className="editor-actions">
          <button type="button" onClick={() => navigate('/rosters/new')}>
            New roster
          </button>
        </div>
      ) : null}
      {error === null ? null : <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {rows === null ? (
        error === null ? <p className="loading">Loading rosters…</p> : null
      ) : rows.length === 0 ? (
        <p className="muted">No rosters.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Id</th>
              <th>Name</th>
              <th>Manager level</th>
              <th>Used by</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <code>{row.id}</code>
                </td>
                <td>
                  {row.nameEn ?? row.name}
                  {row.nameEn == null ? null : <div className="muted">{row.name}</div>}
                </td>
                <td>{row.managerLevel}</td>
                <td>{row.usageCount}</td>
                <td>{row.updatedAt}</td>
                <td>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => navigate(`/rosters/${encodeURIComponent(row.id)}`)}
                  >
                    Edit
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

function RosterEditorPage({
  id,
  user,
  newRoster = false,
}: {
  id?: string;
  user: AdminSessionUser;
  newRoster?: boolean;
}) {
  const isNew = newRoster;
  const canEdit = roleAtLeast(user.role, 'editor');
  const [detail, setDetail] = useState<RosterDetail | null>(null);
  const [rosterId, setRosterId] = useState(id ?? '');
  const [rosterChoices, setRosterChoices] = useState<RosterSummary[]>([]);
  const [startFrom, setStartFrom] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [idConflict, setIdConflict] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [managerLevel, setManagerLevel] = useState(1);
  const [cards, setCards] = useState<NpcRosterCard[]>([]);
  const [lookupCards, setLookupCards] = useState<LookupCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [conflict, setConflict] = useState<RosterUsage | null>(null);
  const [newRosterId, setNewRosterId] = useState('');
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogWasOpen = useRef(false);

  useEffect(() => {
    if (conflict !== null) {
      if (!dialogWasOpen.current) {
        dialogWasOpen.current = true;
        dialogRef.current?.focus();
      }
    } else if (dialogWasOpen.current) {
      dialogWasOpen.current = false;
      saveButtonRef.current?.focus();
    }
  }, [conflict]);

  function closeConflict(): void {
    setConflict(null);
    setDuplicateError(null);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (isNew) {
      Promise.all([get<RosterSummary[]>('/rosters'), get<LookupCard[]>('/lookup/cards')])
        .then(([choices, allCards]) => {
          if (cancelled) return;
          setRosterChoices(choices);
          setLookupCards(allCards);
          setName('');
          setManagerLevel(1);
          setCards(normalizeRosterCards([]));
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(describeError(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    Promise.all([get<RosterDetail>(`/rosters/${encodeURIComponent(id ?? '')}`), get<LookupCard[]>('/lookup/cards')])
      .then(([roster, allCards]) => {
        if (cancelled) return;
        setDetail(roster);
        setName(roster.name);
        setManagerLevel(roster.managerLevel);
        setCards(normalizeRosterCards(roster.cards));
        setLookupCards(allCards);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, isNew]);

  function changeCard(position: number, patch: Partial<NpcRosterCard>): void {
    setCards((prev) =>
      prev.map((card) => (card.Position === position ? { ...card, ...patch } : card)),
    );
  }

  /** Fill the form from a "Start from" choice; empty string is the blank layout. */
  async function applyStartFrom(sourceId: string): Promise<void> {
    setStartFrom(sourceId);
    setFormErrors([]);
    setIdConflict(null);
    if (sourceId === '') {
      setName('');
      setManagerLevel(1);
      setCards(normalizeRosterCards([]));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const source = await get<RosterDetail>(`/rosters/${encodeURIComponent(sourceId)}`);
      setName(source.name);
      setManagerLevel(source.managerLevel);
      setCards(normalizeRosterCards(source.cards));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function save(confirmShared: boolean): Promise<void> {
    if (!canEdit) return;
    if (isNew) {
      setIdTouched(true);
      if (!isValidRosterId(rosterId)) return;
    }
    const issues = validateRosterForm(name, managerLevel, cards);
    setFormErrors(issues);
    if (issues.length > 0) return;
    // Empty slots are editing placeholders; only filled cards are persisted.
    const savedCards = filledRosterCards(cards);
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (isNew) {
        const created = await post<RosterDetail>('/rosters', {
          id: rosterId,
          name,
          managerLevel,
          cards: savedCards,
        });
        navigate(`/rosters/${encodeURIComponent(created.id)}`);
        return;
      }
      const saved = await put<RosterDetail>(`/rosters/${encodeURIComponent(id ?? '')}`, {
        name,
        managerLevel,
        cards: savedCards,
        ...(confirmShared ? { confirmShared: true } : {}),
      });
      setDetail((current) => (current === null ? current : { ...current, ...saved }));
      setCards(normalizeRosterCards(saved.cards));
      closeConflict();
      setMessage(confirmShared ? 'Roster saved for all events.' : 'Roster saved.');
    } catch (err) {
      if (isNew) {
        if (err instanceof ApiError && err.status === 409) {
          setIdConflict('A roster with this id already exists');
          return;
        }
        setError(describeError(err));
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { code?: unknown; usage?: unknown } | null;
        if (body !== null && typeof body === 'object' && body.code === 'shared-roster') {
          const usage = body.usage as RosterUsage | undefined;
          setConflict(usage ?? { quests: [], events: [] });
          setNewRosterId(duplicateRosterId(id ?? ''));
          setDuplicateError(null);
          return;
        }
      }
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function duplicate(): Promise<void> {
    if (!canEdit) return;
    if (!isValidRosterId(newRosterId)) {
      setDuplicateError(
        'Invalid roster id. Use letters, digits, ".", "-" or "_", starting with a letter or digit (max 100 characters).',
      );
      return;
    }
    setDuplicateError(null);
    setBusy(true);
    setError(null);
    try {
      await post(`/rosters/${encodeURIComponent(id ?? '')}/duplicate`, { newId: newRosterId });
      navigate(`/rosters/${encodeURIComponent(newRosterId)}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!isNew && error !== null && detail === null) {
    return (
      <section>
        <button type="button" className="link-button" onClick={() => navigate('/rosters')}>
          ← Rosters
        </button>
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      </section>
    );
  }

  if (!isNew && detail === null && loading) return <p className="loading">Loading roster…</p>;
  if (!isNew && detail === null) return <p className="loading">Loading roster…</p>;

  const dirty =
    detail !== null &&
    (name !== detail.name ||
      managerLevel !== detail.managerLevel ||
      JSON.stringify(normalizeRosterCards(detail.cards)) !== JSON.stringify(cards));

  const idRuleError =
    isNew && (idTouched || rosterId !== '') && !isValidRosterId(rosterId)
      ? 'Invalid roster id. Use letters, digits, ".", "-" or "_", starting with a letter or digit (max 100 characters).'
      : null;

  return (
    <section className="editor">
      <div className="editor-head">
        <button type="button" className="link-button" onClick={() => navigate('/rosters')}>
          ← Rosters
        </button>
        <h2>
          {detail === null ? (
            'New roster'
          ) : (
            <>
              {detail.nameEn ?? detail.name} <code>{detail.id}</code>
            </>
          )}
        </h2>
        {detail === null || detail.nameEn == null ? null : <div className="muted">{detail.name}</div>}
        <div className="editor-actions">
          {canEdit ? (
            <button ref={saveButtonRef} type="button" disabled={busy} onClick={() => void save(false)}>
              {isNew ? 'Create roster' : 'Save roster'}
            </button>
          ) : (
            <span className="muted">Editing requires the editor role.</span>
          )}
        </div>
      </div>

      {error === null ? null : <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {message === null ? null : <p className="notice">{message}</p>}
      {formErrors.length === 0 ? null : (
        <div className="issues">
          <ul>
            {formErrors.map((entry) => (
              <li key={entry} className="error">
                {entry}
              </li>
            ))}
          </ul>
        </div>
      )}

      {isNew ? (
        <div className="field-grid">
          <label className="field">
            Id
            <input
              type="text"
              aria-label="Roster id"
              value={rosterId}
              disabled={!canEdit}
              onChange={(event) => {
                setRosterId(event.target.value);
                setIdTouched(true);
                setIdConflict(null);
              }}
            />
            {idRuleError === null ? null : <span className="field-error">{idRuleError}</span>}
            {idConflict === null ? null : <span className="field-error">{idConflict}</span>}
          </label>
          <label className="field">
            Start from
            <select
              aria-label="Start from"
              value={startFrom}
              disabled={!canEdit || busy}
              onChange={(event) => void applyStartFrom(event.target.value)}
            >
              <option value="">Blank</option>
              {rosterChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {`${choice.nameEn ?? choice.name} (${choice.id})`}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      <div className="field-grid">
        <label className="field">
          Name
          <input
            type="text"
            value={name}
            disabled={!canEdit}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          Manager level
          <input
            type="number"
            min={1}
            step={1}
            value={managerLevel}
            disabled={!canEdit}
            onChange={(event) => setManagerLevel(numberOrZero(event.target.value))}
          />
        </label>
      </div>

      <h3>Cards</h3>
      <p className="muted">Empty slots are not saved.</p>
      <p className="muted">Listed in the in-game lane order, left to right (position 1 is the center).</p>
      {ROSTER_VISUAL_ORDER.map((p) => {
        const card = cards.slice(0, ROSTER_SLOT_COUNT).find((candidate) => candidate.Position === p);
        if (card === undefined) return null;
        return (
        <fieldset className="box-card" key={card.Position}>
          <legend>Position {p}{p === 1 ? ' · Center' : ''}</legend>
          <CardPicker
            position={card.Position}
            cards={lookupCards}
            value={card.CardId}
            disabled={!canEdit}
            onChange={(cardId) => changeCard(card.Position, { CardId: cardId })}
          />
          <div className="field-grid">
            <label className="field">
              Level
              <input
                type="number"
                min={1}
                step={1}
                aria-label={`Level position ${card.Position}`}
                value={card.Level}
                disabled={!canEdit}
                onChange={(event) => changeCard(card.Position, { Level: numberOrZero(event.target.value) })}
              />
            </label>
            <label className="field">
              Rarity
              <input
                type="number"
                min={1}
                max={10}
                step={1}
                aria-label={`Rarity position ${card.Position}`}
                value={card.Rarity}
                disabled={!canEdit}
                onChange={(event) => changeCard(card.Position, { Rarity: numberOrZero(event.target.value) })}
              />
            </label>
            <label className="field">
              Evolution level
              <input
                type="number"
                min={0}
                step={1}
                aria-label={`Evolution level position ${card.Position}`}
                value={card.EvolutionLevel}
                disabled={!canEdit}
                onChange={(event) =>
                  changeCard(card.Position, { EvolutionLevel: numberOrZero(event.target.value) })
                }
              />
            </label>
            <label className="field">
              Light fans
              <input
                type="number"
                min={0}
                aria-label={`Light fans position ${card.Position}`}
                value={card.LightFanAmount}
                disabled={!canEdit}
                onChange={(event) =>
                  changeCard(card.Position, { LightFanAmount: numberOrZero(event.target.value) })
                }
              />
            </label>
            <label className="field">
              Middle fans
              <input
                type="number"
                min={0}
                aria-label={`Middle fans position ${card.Position}`}
                value={card.MiddleFanAmount}
                disabled={!canEdit}
                onChange={(event) =>
                  changeCard(card.Position, { MiddleFanAmount: numberOrZero(event.target.value) })
                }
              />
            </label>
            <label className="field">
              Heavy fans
              <input
                type="number"
                min={0}
                aria-label={`Heavy fans position ${card.Position}`}
                value={card.HeavyFanAmount}
                disabled={!canEdit}
                onChange={(event) =>
                  changeCard(card.Position, { HeavyFanAmount: numberOrZero(event.target.value) })
                }
              />
            </label>
          </div>
        </fieldset>
        );
      })}

      {detail === null ? null : (
        <>
          <h3>Usage</h3>
          {detail.usage.quests.length === 0 && detail.usage.events.length === 0 ? (
            <p className="muted">Not used by any quest or event.</p>
          ) : (
            <>
              {detail.usage.quests.length === 0 ? null : (
                <p>
                  Main-story quests: {detail.usage.quests.map((questId) => <code key={questId}>{questId} </code>)}
                </p>
              )}
              {detail.usage.events.length === 0 ? null : (
                <ul>
                  {detail.usage.events.map((usage) => (
                    <li key={`${usage.eventId}-${usage.questId}`}>
                      <code>{usage.eventId}</code> quest <code>{usage.questId}</code>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}

      {conflict === null ? null : (
        <div
          className="dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Shared roster"
          ref={dialogRef}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              closeConflict();
            }
          }}
        >
          <h3>Shared roster</h3>
          <p>This roster is used by more than one quest or event.</p>
          {dirty ? <p className="muted">Unsaved edits will be discarded.</p> : null}
          {conflict.quests.length === 0 ? null : (
            <p>
              Quests: {conflict.quests.map((questId) => <code key={questId}>{questId} </code>)}
            </p>
          )}
          {conflict.events.length === 0 ? null : (
            <ul>
              {conflict.events.map((usage) => (
                <li key={`${usage.eventId}-${usage.questId}`}>
                  <code>{usage.eventId}</code> quest <code>{usage.questId}</code>
                </li>
              ))}
            </ul>
          )}
          <div className="row-actions">
            <button type="button" disabled={busy} onClick={() => void save(true)}>
              Save for all events
            </button>
            <label className="field">
              New roster id
              <input
                type="text"
                aria-label="New roster id"
                value={newRosterId}
                onChange={(event) => {
                  setNewRosterId(event.target.value);
                  setDuplicateError(null);
                }}
              />
            </label>
            {duplicateError === null ? null : <p className="error">{duplicateError}</p>}
            <button type="button" disabled={busy} onClick={() => void duplicate()}>
              Duplicate as event-only copy
            </button>
            <button type="button" disabled={busy} onClick={closeConflict}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function RostersPage({
  id,
  user,
  newRoster = false,
}: {
  id?: string;
  user: AdminSessionUser;
  newRoster?: boolean;
}) {
  if (newRoster) return <RosterEditorPage key="new" newRoster user={user} />;
  if (id === undefined) return <RosterListPage user={user} />;
  return <RosterEditorPage key={id} id={id} user={user} />;
}
