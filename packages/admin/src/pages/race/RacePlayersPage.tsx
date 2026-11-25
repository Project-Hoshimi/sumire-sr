/**
 * Race live-ops screen (`#/events/:id/players`): pick a published race, search
 * its players with the same competition rank `Race:Ranking` serves, open one
 * player's board state in an edit panel, set race-point/medal balances, clear
 * card cool times and reset the state behind a confirmation.
 *
 * Every write goes through `/sumire/admin/races/*`; the server re-validates the
 * board position against the race's areas and panel counts, so this screen only
 * sends the values the operator typed.
 */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { get, patch, post } from '../../api.ts';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { ErrorBanner } from '../../components/ErrorBanner.tsx';
import { describeError } from '../../errors.ts';
import { roleAtLeast } from '../../role.ts';
import type { AdminSessionUser } from '../../types.ts';

interface RaceRow {
  id: string;
  title: string;
  publishedVersion: number;
  lifecycle: string;
  schedule: { startsAt: string | Date; endsAt: string | Date; enabled: boolean }[];
}

interface PlayerRow {
  playerId: string;
  userId: string;
  name: string;
  level: number;
  areaIndex: number;
  areaId: string;
  panelNumber: number;
  totalClearPanelCount: number;
  rank: number;
  racePoints: number;
  medals: number;
  pendingVenus: boolean;
  difficultyNumber: number | null;
  effectiveDifficultyNumber: number;
  lastUpdated: string;
}

interface PlayerList {
  total: number;
  offset: number;
  limit: number;
  players: PlayerRow[];
}

interface RaceArea {
  index: number;
  areaId: string;
  panelCount: number;
}

interface RaceState {
  initialized: boolean;
  areaIndex: number;
  panelNumber: number;
  totalClearPanelCount: number;
  pendingVenus: boolean;
  currentLivePanelScore: number;
  cardCoolTimes: Record<string, number>;
  lastActivityReceiveMs: number;
}

interface PlayerDetail {
  raceId: string;
  player: { playerId: string; userId: string; name: string; level: number };
  state: RaceState;
  lessonTiers: { pt: number; medal: number } | null;
  nextTallyAt: number | null;
  racePoints: number;
  medals: number;
  cardCoolTimes: { cardId: string; endsAt: number }[];
  difficultyNumber: number | null;
  effectiveDifficultyNumber: number;
  lastUpdated: string;
  areas: RaceArea[];
}

interface RankingRow {
  playerId: string;
  userId: string;
  name: string;
  managerLevel: number;
  clearPanelCount: number;
  rank: number;
  emblemId: string;
}

interface EditForm {
  areaIndex: string;
  panelNumber: string;
  totalClearPanelCount: string;
  currentLivePanelScore: string;
  racePointAmount: string;
  medalAmount: string;
  difficultyNumber: string;
  pendingVenus: boolean;
}

function difficultyText(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function formOf(detail: PlayerDetail): EditForm {
  return {
    areaIndex: String(detail.state.areaIndex),
    panelNumber: String(detail.state.panelNumber),
    totalClearPanelCount: String(detail.state.totalClearPanelCount),
    currentLivePanelScore: String(detail.state.currentLivePanelScore),
    racePointAmount: String(detail.racePoints),
    medalAmount: String(detail.medals),
    difficultyNumber: difficultyText(detail.difficultyNumber),
    pendingVenus: detail.state.pendingVenus,
  };
}

function displayTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function racePath(raceId: string, suffix = ''): string {
  return `/races/${encodeURIComponent(raceId)}${suffix}`;
}

function playerPath(raceId: string, playerId: string): string {
  return racePath(raceId, `/players/${encodeURIComponent(playerId)}`);
}

export function RacePlayersPage({ id, user }: { id: string; user: AdminSessionUser }) {
  const canWrite = roleAtLeast(user.role, 'editor');
  const [races, setRaces] = useState<RaceRow[] | null>(null);
  const [raceId, setRaceId] = useState(id);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [list, setList] = useState<PlayerList | null>(null);
  const [ranking, setRanking] = useState<RankingRow[] | null>(null);
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [form, setForm] = useState<EditForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    let cancelled = false;
    get<{ races: RaceRow[] }>('/races')
      .then((res) => {
        if (!cancelled) setRaces(res.races);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const suffix = query === '' ? '' : `?q=${encodeURIComponent(query)}`;
    setList(null);
    setRanking(null);
    Promise.all([
      get<PlayerList>(racePath(raceId, `/players${suffix}`)),
      get<{ ranking: RankingRow[] }>(racePath(raceId, '/ranking?limit=100')),
    ])
      .then(([players, ranks]) => {
        if (cancelled) return;
        setList(players);
        setRanking(ranks.ranking);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [raceId, query]);

  async function reloadPlayers(): Promise<void> {
    const suffix = query === '' ? '' : `?q=${encodeURIComponent(query)}`;
    const [players, ranks] = await Promise.all([
      get<PlayerList>(racePath(raceId, `/players${suffix}`)),
      get<{ ranking: RankingRow[] }>(racePath(raceId, '/ranking?limit=100')),
    ]);
    setList(players);
    setRanking(ranks.ranking);
  }

  function handleSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setQuery(search.trim());
  }

  function selectRace(next: string): void {
    setRaceId(next);
    setDetail(null);
    setForm(null);
    setMessage(null);
  }

  async function openPlayer(playerId: string): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await get<PlayerDetail>(playerPath(raceId, playerId));
      setDetail(next);
      setForm(formOf(next));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  function update<K extends keyof EditForm>(key: K, value: EditForm[K]): void {
    setForm((current) => (current === null ? current : { ...current, [key]: value }));
  }

  /** Parse the numeric fields; `null` means "not a non-negative integer". */
  function patchBody(current: EditForm): Record<string, unknown> | null {
    const fields = [
      'areaIndex',
      'panelNumber',
      'totalClearPanelCount',
      'currentLivePanelScore',
      'racePointAmount',
      'medalAmount',
    ] as const;
    const body: Record<string, unknown> = { pendingVenus: current.pendingVenus };
    for (const field of fields) {
      const raw = current[field].trim();
      const value = Number(raw);
      if (raw === '' || !Number.isSafeInteger(value) || value < 0) {
        setError(`${field} must be a non-negative integer`);
        return null;
      }
      body[field] = value;
    }
    return body;
  }

  async function save(): Promise<void> {
    if (detail === null || form === null) return;
    const body = patchBody(form);
    if (body === null) return;
    // The frozen per-player number is only sent when the operator changed it;
    // an untouched field leaves the stored value (and its VENUS derivation) alone.
    if (form.difficultyNumber.trim() !== difficultyText(detail.difficultyNumber)) {
      const raw = form.difficultyNumber.trim();
      if (raw === '') {
        body.difficultyNumber = null;
      } else {
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > 7) {
          setError('Difficulty must be an integer from 1 to 7');
          return;
        }
        body.difficultyNumber = value;
      }
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await patch<PlayerDetail>(
        playerPath(raceId, detail.player.playerId),
        body,
      );
      setDetail(next);
      setForm(formOf(next));
      setMessage(`Saved ${next.player.name}.`);
      await reloadPlayers();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearCoolTimes(): Promise<void> {
    if (detail === null) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await patch<PlayerDetail>(playerPath(raceId, detail.player.playerId), {
        clearCardCoolTimes: true,
      });
      setDetail(next);
      setForm((current) => (current === null ? formOf(next) : { ...current, ...formOf(next) }));
      setMessage(`Cleared card cool times for ${next.player.name}.`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  /** Drop the frozen number so the next Race:Top re-derives it from the VENUS grade. */
  async function clearDifficulty(): Promise<void> {
    if (detail === null) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await patch<PlayerDetail>(playerPath(raceId, detail.player.playerId), {
        difficultyNumber: null,
      });
      setDetail(next);
      setForm((current) =>
        current === null
          ? formOf(next)
          : { ...current, difficultyNumber: difficultyText(next.difficultyNumber) },
      );
      setMessage(`Cleared the fixed difficulty for ${next.player.name}.`);
      await reloadPlayers();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function reset(): Promise<void> {
    if (detail === null) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await post<PlayerDetail>(
        playerPath(raceId, detail.player.playerId) + '/reset',
        {},
      );
      setDetail(next);
      setForm(formOf(next));
      setMessage(`Reset the race state of ${next.player.name}.`);
      setConfirmReset(false);
      await reloadPlayers();
    } catch (err) {
      setError(describeError(err));
      setConfirmReset(false);
    } finally {
      setBusy(false);
    }
  }

  const selectedArea =
    detail === null || form === null
      ? undefined
      : detail.areas.find((area) => String(area.index) === form.areaIndex);

  return (
    <section>
      <h2>Race live-ops</h2>
      <p className="muted">
        Player board state, race points, medals and ranking for{' '}
        <code>{raceId}</code>.
      </p>
      {error === null ? null : <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {message === null ? null : <p className="notice">{message}</p>}

      <div className="inline-form">
        <label>
          Race
          <select aria-label="Race" value={raceId} onChange={(event) => selectRace(event.target.value)}>
            {raceId === '' ? <option value="">Pick a race…</option> : null}
            {(races ?? []).some((row) => row.id === raceId) ? null : (
              <option value={raceId}>{raceId}</option>
            )}
            {(races ?? []).map((row) => (
              <option key={row.id} value={row.id}>
                {row.title} ({row.id}, v{row.publishedVersion})
              </option>
            ))}
          </select>
        </label>
        <form onSubmit={handleSearch}>
          <label>
            Search players
            <input
              type="text"
              aria-label="Search players"
              value={search}
              placeholder="user id or name"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <button type="submit">Search</button>
        </form>
        <button
          type="button"
          disabled={busy || raceId === ''}
          onClick={() => {
            setBusy(true);
            setError(null);
            reloadPlayers()
              .catch((err: unknown) => setError(describeError(err)))
              .finally(() => setBusy(false));
          }}
        >
          Refresh
        </button>
      </div>

      <h3>Players{list === null ? '' : ` (${list.total})`}</h3>
      {list === null ? (
        error === null ? <p className="loading">Loading players…</p> : null
      ) : list.players.length === 0 ? (
        <p className="muted">No player has a state for this race{query === '' ? '' : ` matching “${query}”`}.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Player</th>
              <th>User ID</th>
              <th>Area</th>
              <th>Panel</th>
              <th>Panels cleared</th>
              <th>Race pt</th>
              <th>Medals</th>
              <th>VENUS</th>
              <th>Difficulty</th>
              <th>Last updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.players.map((row) => (
              <tr key={row.playerId}>
                <td>{row.rank === 0 ? '—' : row.rank}</td>
                <td>{row.name}</td>
                <td>
                  <code>{row.userId}</code>
                </td>
                <td>
                  {row.areaIndex} <span className="muted">{row.areaId}</span>
                </td>
                <td>{row.panelNumber}</td>
                <td>{row.totalClearPanelCount}</td>
                <td>{row.racePoints}</td>
                <td>{row.medals}</td>
                <td>{row.pendingVenus ? 'pending' : '—'}</td>
                <td>
                  {row.difficultyNumber == null
                    ? `— (fallback ${row.effectiveDifficultyNumber})`
                    : row.difficultyNumber}
                </td>
                <td>{displayTime(row.lastUpdated)}</td>
                <td className="row-actions">
                  <button type="button" disabled={busy} onClick={() => void openPlayer(row.playerId)}>
                    Edit {row.name}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Ranking</h3>
      {ranking === null ? (
        error === null ? <p className="loading">Loading ranking…</p> : null
      ) : ranking.length === 0 ? (
        <p className="muted">Nobody has cleared a panel yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Player</th>
              <th>Level</th>
              <th>Panels cleared</th>
            </tr>
          </thead>
          <tbody>
            {ranking.map((row) => (
              <tr key={row.playerId}>
                <td>{row.rank}</td>
                <td>
                  {row.name} <span className="muted">{row.userId}</span>
                </td>
                <td>{row.managerLevel}</td>
                <td>{row.clearPanelCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail === null || form === null ? null : (
        <section className="detail-panel">
          <h3>
            {detail.player.name} <span className="muted">{detail.player.userId}</span>
          </h3>
          <p className="muted">
            Player state, race points and medals. The server validates the area and panel against
            the published race; card cool times and a full reset are separate actions.
          </p>
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label>
              Area
              <select
                aria-label="Area"
                value={form.areaIndex}
                disabled={busy || !canWrite}
                onChange={(event) => update('areaIndex', event.target.value)}
              >
                {detail.areas.map((area) => (
                  <option key={area.areaId} value={String(area.index)}>
                    {area.index} — {area.areaId} ({area.panelCount} panels)
                  </option>
                ))}
              </select>
            </label>
            <label>
              Panel
              <input
                type="number"
                min={0}
                max={selectedArea?.panelCount}
                aria-label="Panel"
                value={form.panelNumber}
                disabled={busy || !canWrite}
                onChange={(event) => update('panelNumber', event.target.value)}
              />
            </label>
            <label>
              Panels cleared
              <input
                type="number"
                min={0}
                aria-label="Panels cleared"
                value={form.totalClearPanelCount}
                disabled={busy || !canWrite}
                onChange={(event) => update('totalClearPanelCount', event.target.value)}
              />
            </label>
            <label>
              Live panel score
              <input
                type="number"
                min={0}
                aria-label="Live panel score"
                value={form.currentLivePanelScore}
                disabled={busy || !canWrite}
                onChange={(event) => update('currentLivePanelScore', event.target.value)}
              />
            </label>
            <label>
              Race points
              <input
                type="number"
                min={0}
                aria-label="Race points"
                value={form.racePointAmount}
                disabled={busy || !canWrite}
                onChange={(event) => update('racePointAmount', event.target.value)}
              />
            </label>
            <label>
              Medals
              <input
                type="number"
                min={0}
                aria-label="Medals"
                value={form.medalAmount}
                disabled={busy || !canWrite}
                onChange={(event) => update('medalAmount', event.target.value)}
              />
            </label>
            <label>
              Difficulty (1–7)
              <input
                type="number"
                min={1}
                max={7}
                step={1}
                aria-label="Difficulty"
                value={form.difficultyNumber}
                placeholder={
                  detail.difficultyNumber == null
                    ? `fallback ${detail.effectiveDifficultyNumber}`
                    : undefined
                }
                disabled={busy || !canWrite}
                onChange={(event) => update('difficultyNumber', event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !canWrite || detail.difficultyNumber == null}
              onClick={() => void clearDifficulty()}
            >
              Clear
            </button>
            <label>
              <input
                type="checkbox"
                checked={form.pendingVenus}
                disabled={busy || !canWrite}
                onChange={(event) => update('pendingVenus', event.target.checked)}
              />
              Pending VENUS
            </label>
            <button type="submit" disabled={busy || !canWrite}>
              Save player
            </button>
          </form>

          <p className="muted">
            Card cool times:{' '}
            {detail.cardCoolTimes.length === 0
              ? 'none'
              : detail.cardCoolTimes
                  .map((row) => `${row.cardId} until ${displayTime(new Date(row.endsAt))}`)
                  .join(', ')}
          </p>
          <p className="muted">
            Activity lesson efficiency (2-day tally):{' '}
            {detail.lessonTiers == null
              ? 'unknown'
              : `pt tier ${detail.lessonTiers.pt}, medal tier ${detail.lessonTiers.medal}`}
            ; next tally{' '}
            {detail.nextTallyAt == null ? '—' : displayTime(new Date(detail.nextTallyAt))}
          </p>
          <div className="row-actions">
            <button type="button" disabled={busy || !canWrite} onClick={() => void clearCoolTimes()}>
              Clear cool times
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy || !canWrite}
              onClick={() => setConfirmReset(true)}
            >
              Reset race state
            </button>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirmReset}
        title={`Reset ${detail?.player.name ?? 'player'}?`}
        message="The board position, panel count, VENUS flag and card cool times go back to a fresh state. Race points and medals are an item balance and are kept."
        confirmLabel="Reset state"
        danger
        busy={busy}
        onConfirm={() => void reset()}
        onCancel={() => setConfirmReset(false)}
      />
    </section>
  );
}
