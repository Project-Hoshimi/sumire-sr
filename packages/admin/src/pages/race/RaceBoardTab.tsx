// Race Board tab: a preview of the master board (areas → panels) with the
// per-VENUS-panel NPC roster overrides and the per-reward-panel reward overrides
// the draft authors. The preview comes from `GET /lookup/race-board`, which reads
// the same master rows the race board service walks at runtime, so the editor
// cannot drift from the game.
//
// Roster overrides live in `draft.npcRosterByQuest`; an empty selection removes
// the key so the panel inherits `draft.npcRosterId`. Reward overrides live in
// `draft.panelRewards`, keyed `<areaId>:<panelNumber>`; a panel without a key
// grants its master `RacePanelReward`.
import { useEffect, useState, type ReactNode } from 'react';
import { get } from '../../api.ts';
import { RewardSummary } from '../../components/ResourceBadge.tsx';
import { draftValue, withDraftValue, type MarathonDraftShape } from '../../draft.ts';
import type {
  LookupReward,
  RaceBoardArea,
  RaceBoardPanel,
  RaceBoardPreview,
  RosterSummary,
} from '../../types.ts';
import { PanelRewardsModal } from './PanelRewardsModal.tsx';

export interface RaceBoardTabProps {
  draft: MarathonDraftShape;
  canEdit: boolean;
  rosters: RosterSummary[];
  onChange: (next: MarathonDraftShape) => void;
}

/** The reward panel currently open in the edit modal. */
interface PanelEdit {
  areaId: string;
  panelNumber: number;
  /** References the modal opens with (the override, else the master reward). */
  rewards: string[];
  override: boolean;
}

/** `master_RacePanel.Type` values, mirrored from the race service. */
const PANEL_REWARD = 2;
const PANEL_STORY = 4;

function stringIn(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberIn(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringsIn(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/** Per-quest overrides as a plain string map (the server drops empty values). */
function rosterOverrides(draft: MarathonDraftShape): Record<string, string> {
  const raw = draftValue(draft, 'npcRosterByQuest');
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const overrides: Record<string, string> = {};
  for (const [questId, rosterId] of Object.entries(raw as Record<string, unknown>)) {
    const id = stringIn(rosterId);
    if (questId !== '' && id !== '') overrides[questId] = id;
  }
  return overrides;
}

/** Lookup path of one board preview; the area order follows the draft. */
function boardPath(raceId: string, areaIds: readonly string[], difficulty: number): string {
  const params = new URLSearchParams({ eventId: raceId, difficulty: String(difficulty) });
  if (areaIds.length > 0) params.set('areas', areaIds.join(','));
  return `/lookup/race-board?${params.toString()}`;
}

/** Draft key of one panel's reward override. */
function panelOverrideKey(areaId: string, panelNumber: number): string {
  return `${areaId}:${panelNumber}`;
}

/** Reward overrides keyed `<areaId>:<panelNumber>`; empty lists are dropped. */
function panelRewardOverrides(draft: MarathonDraftShape): Record<string, string[]> {
  const raw = draftValue(draft, 'panelRewards');
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const overrides: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const rewards = stringsIn(value);
    if (key !== '' && rewards.length > 0) overrides[key] = rewards;
  }
  return overrides;
}

/** `master` / `edited` marker of one reward panel. */
function rewardMarker(override: readonly string[] | undefined): ReactNode {
  return (
    <span className={`badge ${override === undefined ? 'badge-master' : 'badge-edited'}`}>
      {override === undefined ? 'master' : 'edited'}
    </span>
  );
}

/** The master reward a panel grants when the draft has no override. */
function masterRewardContents(panel: RaceBoardPanel): ReactNode {
  if (panel.reward === null) {
    return (
      <span className="muted">reward {panel.rewardId ?? '(none)'} (missing from master)</span>
    );
  }
  if (panel.reward.resources.length === 0) {
    return <span className="muted">{panel.reward.id} (no grants)</span>;
  }
  return (
    <ul className="board-reward">
      {panel.reward.resources.map((resource, index) => (
        <li key={`${resource.resourceType}:${resource.resourceId}:${index}`}>
          {resource.amount} × {resource.name ?? resource.nameEn ?? resource.resourceId}{' '}
          <span className="muted">
            ({resource.typeLabel} · {resource.nameEn ?? resource.resourceId})
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The draft's own rewards for a panel, resolved one reference at a time.
 * `resolved` is null while the batch lookup is in flight.
 */
function overrideRewardContents(
  rewards: readonly string[],
  resolved: Record<string, LookupReward> | null,
): ReactNode {
  return (
    <ul className="board-reward">
      {rewards.map((reward, index) => (
        <li key={`${reward}:${index}`}>
          <code>{reward}</code>{' '}
          <RewardSummary reward={resolved?.[reward]} loading={resolved === null} />
        </li>
      ))}
    </ul>
  );
}

/** Story / VENUS / empty contents of one panel row. */
function panelContents(panel: RaceBoardPanel): ReactNode {
  if (panel.venus !== null) {
    return (
      <div className="board-contents">
        <div>
          <code>{panel.venus.questId}</code>
          {panel.venus.questName === null ? null : ` · ${panel.venus.questName}`}
        </div>
        <div className="muted">
          ClearScore {panel.venus.clearScore ?? '—'} · difficulty {panel.venus.difficultyNumber}
          {panel.venus.difficultyLevel === null ? '' : ` (level ${panel.venus.difficultyLevel})`}
        </div>
        {panel.venus.difficultyFound ? null : (
          <div className="field-error">
            no difficulty {panel.venus.difficultyNumber} row for this quest
          </div>
        )}
      </div>
    );
  }
  if (panel.type === PANEL_STORY) {
    return (
      <span>
        story <code>{panel.storyId ?? '(none)'}</code> #{panel.storyEpisode ?? '?'}
      </span>
    );
  }
  return <span className="muted">—</span>;
}

export function RaceBoardTab(props: RaceBoardTabProps) {
  const { draft, canEdit, rosters, onChange } = props;
  const raceId = stringIn(draftValue(draft, 'raceId'));
  const areaIds = stringsIn(draftValue(draft, 'areaIds'));
  const areaIdsKey = areaIds.join(',');
  const difficulty = numberIn(draftValue(draft, 'livePanelDifficultyNumber'), 1);
  const defaultRosterId = stringIn(draftValue(draft, 'npcRosterId'));
  const overrides = rosterOverrides(draft);
  const rewardOverrides = panelRewardOverrides(draft);
  // One batch lookup for every override reference on the board; the key keeps
  // the effect from re-running on each render's fresh array.
  const overrideRewardIds = [...new Set(Object.values(rewardOverrides).flat())];
  const overrideRewardIdsKey = overrideRewardIds.join(',');

  const [board, setBoard] = useState<{ path: string; preview: RaceBoardPreview } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resolvedRewards, setResolvedRewards] = useState<Record<string, LookupReward> | null>(
    null,
  );
  const [editing, setEditing] = useState<PanelEdit | null>(null);

  useEffect(() => {
    if (raceId === '') {
      setBoard(null);
      setLoadError(null);
      return;
    }
    const path = boardPath(
      raceId,
      areaIdsKey === '' ? [] : areaIdsKey.split(','),
      difficulty,
    );
    let cancelled = false;
    setLoadError(null);
    void (async () => {
      try {
        const preview = await get<RaceBoardPreview>(path);
        if (!cancelled) setBoard({ path, preview });
      } catch (cause) {
        if (!cancelled) {
          setLoadError(cause instanceof Error ? cause.message : 'Failed to load the race board');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [raceId, areaIdsKey, difficulty]);

  useEffect(() => {
    if (overrideRewardIdsKey === '') {
      setResolvedRewards(null);
      return;
    }
    let cancelled = false;
    setResolvedRewards(null);
    void (async () => {
      try {
        const rewards = await get<LookupReward[]>(
          `/lookup/rewards?ids=${encodeURIComponent(overrideRewardIdsKey)}`,
        );
        if (cancelled) return;
        const byId: Record<string, LookupReward> = {};
        for (const reward of rewards) byId[reward.id] = reward;
        setResolvedRewards(byId);
      } catch {
        // Keep the references visible; only the resolved names are missing.
        if (!cancelled) setResolvedRewards({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [overrideRewardIdsKey]);

  const setRoster = (questId: string, rosterId: string): void => {
    const next = { ...overrides };
    if (rosterId === '') delete next[questId];
    else next[questId] = rosterId;
    onChange(withDraftValue(draft, 'npcRosterByQuest', next));
  };

  const startEdit = (areaId: string, panel: RaceBoardPanel): void => {
    const override = rewardOverrides[panelOverrideKey(areaId, panel.number)];
    setEditing({
      areaId,
      panelNumber: panel.number,
      rewards: override ?? (panel.rewardId === null ? [] : [panel.rewardId]),
      override: override !== undefined,
    });
  };

  /** Save an empty list as "no override", so the panel grants its master row. */
  const writePanelRewards = (
    areaId: string,
    panelNumber: number,
    rewards: readonly string[],
  ): void => {
    const next = { ...rewardOverrides };
    const key = panelOverrideKey(areaId, panelNumber);
    const cleaned = rewards.map((reward) => reward.trim()).filter((reward) => reward !== '');
    if (cleaned.length === 0) delete next[key];
    else next[key] = cleaned;
    setEditing(null);
    onChange(withDraftValue(draft, 'panelRewards', next));
  };

  const rosterCell = (panel: RaceBoardPanel): ReactNode => {
    if (panel.venus === null) return <span className="muted">—</span>;
    const questId = panel.venus.questId;
    const current = overrides[questId] ?? '';
    const known = rosters.some((roster) => roster.id === current);
    return (
      <select
        aria-label={`NPC roster for ${questId}`}
        value={current}
        disabled={!canEdit}
        onChange={(event) => setRoster(questId, event.target.value)}
      >
        <option value="">
          {defaultRosterId === '' ? 'default' : `default (${defaultRosterId})`}
        </option>
        {current !== '' && !known ? (
          <option value={current}>{current} (unknown roster)</option>
        ) : null}
        {rosters.map((roster) => (
          <option key={roster.id} value={roster.id}>
            {roster.id} · {roster.name}
          </option>
        ))}
      </select>
    );
  };

  /** Contents of one panel; reward panels also carry their override editor. */
  const contentsCell = (area: RaceBoardArea, panel: RaceBoardPanel): ReactNode => {
    if (panel.type !== PANEL_REWARD) return panelContents(panel);
    const override = rewardOverrides[panelOverrideKey(area.areaId, panel.number)];
    return (
      <div className="board-contents">
        <div className="board-reward-meta">
          {rewardMarker(override)}
          {canEdit ? (
            <button
              type="button"
              className="board-reward-edit"
              aria-label={`Edit rewards for ${area.areaId} panel ${panel.number}`}
              onClick={() => startEdit(area.areaId, panel)}
            >
              Edit
            </button>
          ) : null}
        </div>
        {override === undefined
          ? masterRewardContents(panel)
          : overrideRewardContents(override, resolvedRewards)}
      </div>
    );
  };

  if (raceId === '') {
    return (
      <div className="panel">
        <p className="muted">Import the race from master data to preview its board.</p>
      </div>
    );
  }

  const preview = board === null ? null : board.preview;
  const totalPanels =
    preview === null ? 0 : preview.areas.reduce((sum, area) => sum + area.panelCount, 0);
  const totalCost =
    preview === null ? 0 : preview.areas.reduce((sum, area) => sum + area.totalRacePointCost, 0);

  return (
    <div className="panel">
      <p className="muted">
        Master board. Each VENUS panel can override the NPC roster; an empty selection inherits
        the race roster. Each reward panel can override its rewards; an edited panel grants the
        drafted list instead of the master row.
      </p>
      {loadError === null ? null : <p className="field-error">{loadError}</p>}
      {loadError !== null || preview !== null ? null : <p className="loading">Loading board…</p>}
      {preview === null ? null : preview.areas.length === 0 ? (
        <p className="muted">No board areas are imported for this race.</p>
      ) : (
        <>
          <p className="muted">
            {preview.areas.length} areas · {totalPanels} panels · {totalCost} race points total
          </p>
          {preview.areas.map((area: RaceBoardArea) => (
            <details className="board-area" key={area.areaId} open={area.index === 0}>
              <summary>
                Area {area.index + 1} · <code>{area.areaId}</code> · {area.panelCount} panels ·{' '}
                {area.totalRacePointCost} pt
              </summary>
              <table className="board-panels">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Type</th>
                    <th>Cost</th>
                    <th>Contents</th>
                    <th>NPC roster</th>
                  </tr>
                </thead>
                <tbody>
                  {area.panels.map((panel) => (
                    <tr key={panel.number} data-panel-type={panel.type}>
                      <td>{panel.number}</td>
                      <td>
                        <span className={`badge badge-${panel.type}`}>{panel.typeLabel}</span>
                      </td>
                      <td>{panel.requiredRacePointAmount}</td>
                      <td>{contentsCell(area, panel)}</td>
                      <td>{rosterCell(panel)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))}
        </>
      )}
      {preview === null ||
      (Object.keys(overrides).length === 0 && Object.keys(rewardOverrides).length === 0) ? null : (
        <p className="muted">
          {Object.keys(overrides).length === 0
            ? ''
            : `${Object.keys(overrides).length} per-panel roster override(s) on this board. `}
          {Object.keys(rewardOverrides).length === 0
            ? ''
            : `${Object.keys(rewardOverrides).length} per-panel reward override(s) on this board.`}
        </p>
      )}
      <PanelRewardsModal
        open={editing !== null}
        label={editing === null ? '' : `area ${editing.areaId} panel ${editing.panelNumber}`}
        rewards={editing?.rewards ?? []}
        override={editing?.override ?? false}
        onSave={(rewards) => {
          if (editing === null) return;
          writePanelRewards(editing.areaId, editing.panelNumber, rewards);
        }}
        onReset={() => {
          if (editing === null) return;
          writePanelRewards(editing.areaId, editing.panelNumber, []);
        }}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}
