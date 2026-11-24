/**
 * An id input with a browse dialog. The input stays editable, so any id can
 * still be typed by hand; only the Browse button opens the dialog, which lists
 * everything the lookup API knows: rewards (existing rows or a custom
 * `rd_auto;...` composition) and live-bonus groups.
 */
import { useEffect, useRef, useState } from 'react';
import { get } from '../api.ts';
import type {
  LookupBrowsePage,
  LookupLiveBonusGroup,
  LookupResource,
  LookupReward,
  LookupRewardType,
} from '../types.ts';
import { BrowseModal } from './BrowseModal.tsx';
import { LiveBonusGroupSummary, ResourceBadge } from './ResourceBadge.tsx';

const SEARCH_DEBOUNCE_MS = 250;
const PAGE_SIZE = 50;
const RESOURCE_PAGE_SIZE = 100;

export type ResourceLookupKind = 'rewards' | 'live-bonus-groups';

type RewardTab = 'existing' | 'custom';

function firstNonEmpty(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** The text shown for one reward row in the picker. */
export function rewardOptionLabel(reward: LookupReward): string {
  const parts = reward.resources.map((resource) => {
    const name = firstNonEmpty(resource.nameEn, resource.name);
    const named = name === null ? resource.resourceId : name;
    return `${resource.typeLabel} ${named} ×${resource.amount}`;
  });
  return parts.length === 0 ? reward.id : `${reward.id} · ${parts.join(', ')}`;
}

/** The text shown for one live-bonus group in the picker. */
export function liveBonusGroupOptionLabel(group: LookupLiveBonusGroup): string {
  const bonus = group.bonuses[0];
  if (bonus === undefined) return group.groupId;
  const description = firstNonEmpty(bonus.descriptionEn, bonus.description);
  if (description === null) return group.groupId;
  const level = bonus.level === null ? '' : ` Lv${bonus.level}`;
  return `${group.groupId} ·${level} ${description}`;
}

/**
 * Build the inline reward reference the server's `parseInlineRewardRef`
 * understands: `rd_auto;<snake_type>;<resourceId>;<amount>`.
 */
export function composeInlineRewardId(
  snakeName: string,
  resourceId: string,
  amount: number,
): string | null {
  // `rd_auto` is semicolon-delimited, so an id containing ';' would parse as
  // extra fields and resolve to the wrong grant. Refuse to compose it.
  if (resourceId.includes(';')) return null;
  return `rd_auto;${snakeName};${resourceId};${amount}`;
}

interface ResourceLookupPickerProps {
  kind: ResourceLookupKind;
  value: string;
  onChange: (value: string) => void;
  /** Accessible name for the id input; the browse dialog appends " browse". */
  ariaLabel: string;
  disabled?: boolean;
}

export function ResourceLookupPicker({
  kind,
  value,
  onChange,
  ariaLabel,
  disabled = false,
}: ResourceLookupPickerProps) {
  const [open, setOpen] = useState(false);
  const [rewardTab, setRewardTab] = useState<RewardTab>('existing');

  const [types, setTypes] = useState<LookupRewardType[] | null>(null);
  // Bumped whenever the existing-reward browse query changes, so a Load-more
  // response that arrives late is discarded instead of appended.
  const rewardsGeneration = useRef(0);
  const [rewardType, setRewardType] = useState<number | ''>('');
  const [rewardQuery, setRewardQuery] = useState('');
  const [rewards, setRewards] = useState<LookupReward[]>([]);
  const [rewardTotal, setRewardTotal] = useState(0);
  const [rewardsLoading, setRewardsLoading] = useState(false);

  const [customType, setCustomType] = useState<number | ''>('');
  const [customQuery, setCustomQuery] = useState('');
  const [resources, setResources] = useState<LookupResource[]>([]);
  const [resourceTotal, setResourceTotal] = useState(0);
  const [customLoading, setCustomLoading] = useState(false);
  const [customResourceId, setCustomResourceId] = useState('');
  const [customAmount, setCustomAmount] = useState('1');

  const [liveQuery, setLiveQuery] = useState('');
  // Same guard as rewardsGeneration, for the live-bonus group browse query.
  const groupsGeneration = useRef(0);
  const [groups, setGroups] = useState<LookupLiveBonusGroup[]>([]);
  const [groupTotal, setGroupTotal] = useState(0);
  const [groupsLoading, setGroupsLoading] = useState(false);

  const browseButtonRef = useRef<HTMLButtonElement | null>(null);

  const close = (): void => {
    setOpen(false);
  };

  const select = (next: string): void => {
    onChange(next);
    setOpen(false);
  };

  // The type palette only changes when rewards change, so load it once per
  // opening of the panel. It is what makes id-free browsing possible.
  useEffect(() => {
    if (!open || kind !== 'rewards' || types !== null) return;
    let cancelled = false;
    get<LookupRewardType[]>('/lookup/resource-types')
      .then((rows) => {
        if (!cancelled) setTypes(rows);
      })
      .catch(() => {
        if (!cancelled) setTypes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, kind, types]);

  // Default the custom form to the first composable type once types arrive.
  useEffect(() => {
    if (rewardTab !== 'custom' || customType !== '' || types === null) return;
    const first =
      types.find((type) => type.grantable && type.snakeName !== null) ??
      types.find((type) => type.grantable);
    if (first !== undefined) setCustomType(first.resourceType);
  }, [rewardTab, customType, types]);

  // Existing-reward browse: no query needed, the first page loads on open.
  useEffect(() => {
    if (!open || kind !== 'rewards' || rewardTab !== 'existing') return;
    const generation = ++rewardsGeneration.current;
    let cancelled = false;
    setRewardsLoading(true);
    const timer = setTimeout(
      () => {
        const params = new URLSearchParams();
        if (rewardType !== '') params.set('type', String(rewardType));
        if (rewardQuery.trim() !== '') params.set('q', rewardQuery.trim());
        params.set('offset', '0');
        params.set('limit', String(PAGE_SIZE));
        get<LookupBrowsePage<LookupReward>>(`/lookup/rewards?${params.toString()}`)
          .then((page) => {
            if (cancelled || generation !== rewardsGeneration.current) return;
            setRewards(page.items);
            setRewardTotal(page.total);
          })
          .catch(() => {
            if (cancelled || generation !== rewardsGeneration.current) return;
            setRewards([]);
            setRewardTotal(0);
          })
          .finally(() => {
            if (!cancelled && generation === rewardsGeneration.current) {
              setRewardsLoading(false);
            }
          });
      },
      rewardQuery.trim() === '' ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, kind, rewardTab, rewardType, rewardQuery]);

  // Custom-reward resource browse, once a type is selected. Idless types have
  // no name-table rows, so there is nothing to browse for them.
  useEffect(() => {
    if (!open || kind !== 'rewards' || rewardTab !== 'custom' || customType === '') {
      return;
    }
    const type = types?.find((row) => row.resourceType === customType);
    if (type?.idless === true) return;
    let cancelled = false;
    setCustomLoading(true);
    const timer = setTimeout(
      () => {
        const params = new URLSearchParams();
        params.set('type', String(customType));
        if (customQuery.trim() !== '') params.set('q', customQuery.trim());
        params.set('offset', '0');
        params.set('limit', String(RESOURCE_PAGE_SIZE));
        get<LookupBrowsePage<LookupResource>>(`/lookup/resources?${params.toString()}`)
          .then((page) => {
            if (cancelled) return;
            setResources(page.items);
            setResourceTotal(page.total);
          })
          .catch(() => {
            if (cancelled) return;
            setResources([]);
            setResourceTotal(0);
          })
          .finally(() => {
            if (!cancelled) setCustomLoading(false);
          });
      },
      customQuery.trim() === '' ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, kind, rewardTab, customType, customQuery, types]);

  // Live-bonus groups: an empty query is the browse mode (all groups, paged).
  useEffect(() => {
    if (!open || kind !== 'live-bonus-groups') return;
    const generation = ++groupsGeneration.current;
    let cancelled = false;
    setGroupsLoading(true);
    const timer = setTimeout(
      () => {
        const params = new URLSearchParams();
        params.set('q', liveQuery.trim());
        params.set('offset', '0');
        params.set('limit', String(PAGE_SIZE));
        get<LookupBrowsePage<LookupLiveBonusGroup>>(
          `/lookup/live-bonus-groups?${params.toString()}`,
        )
          .then((page) => {
            if (cancelled || generation !== groupsGeneration.current) return;
            setGroups(page.items);
            setGroupTotal(page.total);
          })
          .catch(() => {
            if (cancelled || generation !== groupsGeneration.current) return;
            setGroups([]);
            setGroupTotal(0);
          })
          .finally(() => {
            if (!cancelled && generation === groupsGeneration.current) {
              setGroupsLoading(false);
            }
          });
      },
      liveQuery.trim() === '' ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, kind, liveQuery]);

  const loadMoreRewards = (): void => {
    const generation = rewardsGeneration.current;
    const params = new URLSearchParams();
    if (rewardType !== '') params.set('type', String(rewardType));
    if (rewardQuery.trim() !== '') params.set('q', rewardQuery.trim());
    params.set('offset', String(rewards.length));
    params.set('limit', String(PAGE_SIZE));
    setRewardsLoading(true);
    get<LookupBrowsePage<LookupReward>>(`/lookup/rewards?${params.toString()}`)
      .then((page) => {
        // The type or search text changed while this page was in flight.
        if (generation !== rewardsGeneration.current) return;
        setRewards((current) => [...current, ...page.items]);
        setRewardTotal(page.total);
      })
      .catch(() => undefined)
      .finally(() => {
        if (generation === rewardsGeneration.current) setRewardsLoading(false);
      });
  };

  const loadMoreGroups = (): void => {
    const generation = groupsGeneration.current;
    const params = new URLSearchParams();
    params.set('q', liveQuery.trim());
    params.set('offset', String(groups.length));
    params.set('limit', String(PAGE_SIZE));
    setGroupsLoading(true);
    get<LookupBrowsePage<LookupLiveBonusGroup>>(
      `/lookup/live-bonus-groups?${params.toString()}`,
    )
      .then((page) => {
        // The search text changed while this page was in flight.
        if (generation !== groupsGeneration.current) return;
        setGroups((current) => [...current, ...page.items]);
        setGroupTotal(page.total);
      })
      .catch(() => undefined)
      .finally(() => {
        if (generation === groupsGeneration.current) setGroupsLoading(false);
      });
  };

  const selectedType = types?.find((type) => type.resourceType === customType);
  const selectedIdless = selectedType?.idless === true;
  const amountValue = Number(customAmount);
  const amountValid = Number.isInteger(amountValue) && amountValue >= 1;
  const composedId =
    selectedType !== undefined &&
    selectedType.snakeName !== null &&
    (selectedIdless || customResourceId !== '') &&
    amountValid
      ? composeInlineRewardId(
          selectedType.snakeName,
          selectedIdless ? '' : customResourceId,
          amountValue,
        )
      : null;

  return (
    <div className="resource-picker">
      <div className="resource-picker-row">
        <input
          type="text"
          className="resource-picker-input"
          value={value}
          disabled={disabled}
          aria-label={ariaLabel}
          placeholder={kind === 'rewards' ? 'reward id or browse' : 'live bonus group id or browse'}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          ref={browseButtonRef}
          type="button"
          className="resource-picker-browse"
          aria-label={`Browse ${ariaLabel}`}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          Browse…
        </button>
      </div>

      <BrowseModal
        open={open}
        title={ariaLabel}
        ariaLabel={`${ariaLabel} browse`}
        onClose={close}
        returnFocusRef={browseButtonRef}
      >
        {kind === 'rewards' ? (
          <div className="resource-browse-tabs" role="tablist" aria-label="Reward source">
            <button
              type="button"
              role="tab"
              aria-selected={rewardTab === 'existing'}
              onClick={() => setRewardTab('existing')}
            >
              Existing reward
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rewardTab === 'custom'}
              onClick={() => setRewardTab('custom')}
            >
              Custom
            </button>
          </div>
        ) : null}

        {kind === 'rewards' && rewardTab === 'existing' ? (
          <div className="resource-browse-body">
            <div className="resource-browse-filters">
              <label className="resource-browse-filter">
                Type
                <select
                  aria-label={`${ariaLabel} type filter`}
                  value={rewardType}
                  onChange={(event) => {
                    setRewardType(
                      event.target.value === '' ? '' : Number(event.target.value),
                    );
                  }}
                >
                  <option value="">All types</option>
                  {(types ?? []).map((type) => (
                    <option key={type.resourceType} value={type.resourceType}>
                      {type.typeLabel} ({type.count})
                    </option>
                  ))}
                </select>
              </label>
              <input
                type="search"
                className="resource-browse-search"
                aria-label={`${ariaLabel} search`}
                placeholder="Search rewards"
                value={rewardQuery}
                onChange={(event) => setRewardQuery(event.target.value)}
              />
            </div>
            <ul className="resource-browse-list" aria-label={`${ariaLabel} results`}>
              {rewards.map((reward) => (
                <li key={reward.id}>
                  <button
                    type="button"
                    className="resource-browse-row"
                    onClick={() => select(reward.id)}
                  >
                    <code className="resource-browse-id">{reward.id}</code>
                    <span className="resource-list">
                      {reward.resources.length === 0 ? (
                        <span className="resource-muted">no resources</span>
                      ) : (
                        reward.resources.map((resource, index) => (
                          <ResourceBadge
                            key={`${resource.resourceType}:${resource.resourceId}:${index}`}
                            resource={resource}
                          />
                        ))
                      )}
                    </span>
                  </button>
                </li>
              ))}
              {rewards.length === 0 && !rewardsLoading ? (
                <li className="resource-muted">No matching rewards</li>
              ) : null}
            </ul>
            <div className="resource-browse-footer">
              <span className="resource-muted">
                {rewards.length} of {rewardTotal}
              </span>
              {rewards.length < rewardTotal ? (
                <button
                  type="button"
                  className="resource-browse-more"
                  disabled={rewardsLoading}
                  onClick={loadMoreRewards}
                >
                  Load more
                </button>
              ) : null}
              <button type="button" className="resource-browse-close" onClick={close}>
                Close
              </button>
            </div>
          </div>
        ) : null}

        {kind === 'rewards' && rewardTab === 'custom' ? (
          <div className="resource-browse-body">
            <div className="resource-browse-filters">
              <label className="resource-browse-filter">
                Type
                <select
                  aria-label={`${ariaLabel} custom type`}
                  value={customType}
                  onChange={(event) => {
                    setCustomType(
                      event.target.value === '' ? '' : Number(event.target.value),
                    );
                    setCustomResourceId('');
                  }}
                >
                  {(types ?? [])
                    .filter((type) => type.grantable)
                    .map((type) => (
                      <option key={type.resourceType} value={type.resourceType}>
                        {type.typeLabel}
                      </option>
                    ))}
                </select>
              </label>
              {selectedIdless ? null : (
                <input
                  type="search"
                  className="resource-browse-search"
                  aria-label={`${ariaLabel} resource search`}
                  placeholder="Search resources"
                  value={customQuery}
                  onChange={(event) => setCustomQuery(event.target.value)}
                />
              )}
            </div>
            {selectedIdless ? (
              <p className="resource-muted" role="note">
                No item to pick — set the amount only.
              </p>
            ) : (
              <ul className="resource-browse-list" aria-label={`${ariaLabel} resources`}>
                {resources.map((resource) => {
                  const name =
                    firstNonEmpty(resource.nameEn, resource.name) ?? resource.resourceId;
                  const japanese =
                    firstNonEmpty(resource.nameEn) === null
                      ? null
                      : firstNonEmpty(resource.name);
                  const selected = resource.resourceId === customResourceId;
                  return (
                    <li key={resource.resourceId}>
                      <button
                        type="button"
                        className={`resource-browse-row${selected ? ' resource-browse-row-selected' : ''}`}
                        aria-pressed={selected}
                        onClick={() => setCustomResourceId(resource.resourceId)}
                      >
                        <span className="resource-label">
                          <span className="resource-name">{name}</span>
                          {japanese === null ? null : (
                            <span className="resource-name-jp">{japanese}</span>
                          )}
                        </span>
                        <code className="resource-browse-id">{resource.resourceId}</code>
                      </button>
                    </li>
                  );
                })}
                {resources.length === 0 && !customLoading ? (
                  <li className="resource-muted">No matching resources</li>
                ) : null}
              </ul>
            )}
            <div className="resource-browse-footer">
              {selectedIdless ? null : (
                <span className="resource-muted">
                  {resources.length} of {resourceTotal}
                </span>
              )}
              <label className="resource-browse-filter">
                Amount
                <input
                  type="number"
                  min={1}
                  step={1}
                  aria-label={`${ariaLabel} amount`}
                  value={customAmount}
                  onChange={(event) => setCustomAmount(event.target.value)}
                />
              </label>
              {customResourceId.includes(';') ? (
                <span className="resource-muted" role="note">
                  Resource id contains “;”, cannot compose
                </span>
              ) : null}
              <button
                type="button"
                className="resource-browse-use"
                aria-label={`Use custom ${ariaLabel}`}
                disabled={composedId === null}
                onClick={() => {
                  if (composedId !== null) select(composedId);
                }}
              >
                Use
              </button>
              <button type="button" className="resource-browse-close" onClick={close}>
                Close
              </button>
            </div>
            {composedId === null ? null : (
              <code className="resource-browse-preview">{composedId}</code>
            )}
          </div>
        ) : null}

        {kind === 'live-bonus-groups' ? (
          <div className="resource-browse-body">
            <div className="resource-browse-filters">
              <input
                type="search"
                className="resource-browse-search"
                aria-label={`${ariaLabel} search`}
                placeholder="Search live bonus groups"
                value={liveQuery}
                onChange={(event) => setLiveQuery(event.target.value)}
              />
            </div>
            <ul className="resource-browse-list" aria-label={`${ariaLabel} results`}>
              {groups.map((group) => (
                <li key={group.groupId}>
                  <button
                    type="button"
                    className="resource-browse-row"
                    onClick={() => select(group.groupId)}
                  >
                    <code className="resource-browse-id">{group.groupId}</code>
                    <LiveBonusGroupSummary group={group} loading={false} />
                  </button>
                </li>
              ))}
              {groups.length === 0 && !groupsLoading ? (
                <li className="resource-muted">No matching live bonus groups</li>
              ) : null}
            </ul>
            <div className="resource-browse-footer">
              <span className="resource-muted">
                {groups.length} of {groupTotal}
              </span>
              {groups.length < groupTotal ? (
                <button
                  type="button"
                  className="resource-browse-more"
                  disabled={groupsLoading}
                  onClick={loadMoreGroups}
                >
                  Load more
                </button>
              ) : null}
              <button type="button" className="resource-browse-close" onClick={close}>
                Close
              </button>
            </div>
          </div>
        ) : null}
      </BrowseModal>
    </div>
  );
}
