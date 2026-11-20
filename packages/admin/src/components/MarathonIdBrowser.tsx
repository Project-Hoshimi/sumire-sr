/**
 * Full-screen browser for the marathon event ids that exist in master data.
 *
 * The game only has quests for ids seeded into `master_MarathonQuest` /
 * `master_MarathonBoxGachaSetting`, so both the "New event" and "Import from
 * master" forms let editors pick a real id instead of typing one from memory.
 * The list and its event-defined flags come from `GET /lookup/marathons`.
 */
import { useEffect, useState, type RefObject } from 'react';
import { get } from '../api.ts';
import type { LookupMarathon, LookupMarathonVariant } from '../types.ts';
import { BrowseModal } from './BrowseModal.tsx';

type MarathonTab = 'all' | Exclude<LookupMarathonVariant, 'other'>;

/** Variant filter tabs, in display order. */
export const MARATHON_TABS: { id: MarathonTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'marathon', label: 'Marathon' },
  { id: 'marathon-raid', label: 'Raid' },
  { id: 'mini-marathon', label: 'Mini' },
  { id: 'mini-marathon-raid', label: 'Mini raid' },
];

/** Short human label for a variant. */
export function marathonVariantLabel(variant: LookupMarathonVariant): string {
  switch (variant) {
    case 'marathon':
      return 'marathon';
    case 'marathon-raid':
      return 'raid';
    case 'mini-marathon':
      return 'mini marathon';
    case 'mini-marathon-raid':
      return 'mini marathon raid';
    default:
      return 'other';
  }
}

interface MarathonIdBrowserProps {
  open: boolean;
  onClose: () => void;
  onPick: (id: string) => void;
  /** When true, ids that already have an event definition cannot be picked. */
  disableDefined: boolean;
  /** Visible header title and dialog accessible name. */
  title: string;
  /** Element that gets focus back when the modal closes. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function MarathonIdBrowser({
  open,
  onClose,
  onPick,
  disableDefined,
  title,
  returnFocusRef,
}: MarathonIdBrowserProps) {
  const [marathons, setMarathons] = useState<LookupMarathon[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<MarathonTab>('all');

  // One master-data read per opening; master ids do not change at runtime.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    get<LookupMarathon[]>('/lookup/marathons')
      .then((rows) => {
        if (!cancelled) setMarathons(rows);
      })
      .catch(() => {
        if (cancelled) return;
        setMarathons([]);
        setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const needle = query.trim().toLowerCase();
  const visible = marathons.filter(
    (marathon) =>
      (tab === 'all' || marathon.variant === tab) &&
      (needle === '' || marathon.id.toLowerCase().includes(needle)),
  );

  return (
    <BrowseModal
      open={open}
      title={title}
      onClose={onClose}
      ariaLabel={title}
      returnFocusRef={returnFocusRef}
    >
      <div className="resource-browse-tabs" role="tablist" aria-label="Marathon variant">
        {MARATHON_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="resource-browse-body">
        <div className="resource-browse-filters">
          <input
            type="search"
            className="resource-browse-search"
            aria-label={`${title} search`}
            placeholder="Search marathon ids"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ul className="resource-browse-list" aria-label={`${title} results`}>
          {visible.map((marathon) => {
            const disabled = disableDefined && marathon.eventDefined;
            return (
              <li key={marathon.id}>
                <button
                  type="button"
                  className="resource-browse-row"
                  disabled={disabled}
                  aria-disabled={disabled ? true : undefined}
                  title={disabled ? 'An event already uses this id' : undefined}
                  onClick={() => {
                    onPick(marathon.id);
                    onClose();
                  }}
                >
                  <code className="resource-browse-id">{marathon.id}</code>
                  <span className="resource-muted">
                    {marathonVariantLabel(marathon.variant)} · {marathon.questCount} quests ·{' '}
                    {marathon.boxGachaCount} box gachas
                  </span>
                  {marathon.eventDefined ? (
                    <span className="resource-badge">Event exists</span>
                  ) : null}
                </button>
              </li>
            );
          })}
          {loading ? <li className="resource-muted">Loading marathon ids…</li> : null}
          {!loading && failed ? (
            <li className="resource-muted">Could not load marathon ids</li>
          ) : null}
          {!loading && !failed && visible.length === 0 ? (
            <li className="resource-muted">No matching marathon ids</li>
          ) : null}
        </ul>
        <div className="resource-browse-footer">
          <span className="resource-muted">
            {visible.length} of {marathons.length}
          </span>
          <button type="button" className="resource-browse-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </BrowseModal>
  );
}
