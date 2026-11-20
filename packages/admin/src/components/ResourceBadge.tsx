/**
 * Read-only renderers for resolved lookup data: one reward grant, a whole
 * reward, a live bonus group or an item id. They never invent names: an id the
 * server does not know is labelled "unknown id" instead of echoing as if it
 * were resolved.
 */
import type {
  LookupItem,
  LookupLiveBonusGroup,
  LookupReward,
  LookupRewardResource,
} from '../types.ts';

/**
 * One fixed colour per resource type. The colours themselves are CSS variables
 * so the light and dark themes can tune contrast independently.
 */
const TYPE_COLORS: Record<number, string> = {
  0: 'var(--res-other)',
  1: 'var(--res-item)',
  2: 'var(--res-card)',
  3: 'var(--res-accessory)',
  4: 'var(--res-character)',
  5: 'var(--res-costume)',
  6: 'var(--res-photo)',
  7: 'var(--res-photo)',
  8: 'var(--res-currency)',
  9: 'var(--res-medal)',
  10: 'var(--res-story)',
  11: 'var(--res-medal)',
  12: 'var(--res-story)',
  13: 'var(--res-story)',
  14: 'var(--res-exp)',
  15: 'var(--res-currency)',
  16: 'var(--res-currency)',
  17: 'var(--res-medal)',
  18: 'var(--res-story)',
  19: 'var(--res-story)',
  20: 'var(--res-story)',
  21: 'var(--res-photo)',
  22: 'var(--res-exp)',
  23: 'var(--res-exp)',
  24: 'var(--res-card)',
  25: 'var(--res-card)',
  26: 'var(--res-accessory)',
  27: 'var(--res-photo)',
  28: 'var(--res-costume)',
  29: 'var(--res-photo)',
  30: 'var(--res-exp)',
  31: 'var(--res-exp)',
  32: 'var(--res-toy)',
  33: 'var(--res-toy)',
  34: 'var(--res-photo)',
  999: 'var(--res-other)',
};

function firstNonEmpty(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function resourceColor(resourceType: number): string {
  return TYPE_COLORS[resourceType] ?? 'var(--res-other)';
}

/** One grant: coloured type pill, English name, muted Japanese, ×amount. */
export function ResourceBadge({ resource }: { resource: LookupRewardResource }) {
  const primary = firstNonEmpty(resource.nameEn, resource.name);
  const japanese =
    firstNonEmpty(resource.nameEn) === null ? null : firstNonEmpty(resource.name);
  return (
    <span className="resource-badge">
      <span
        className="resource-type"
        style={{ color: resourceColor(resource.resourceType), borderColor: resourceColor(resource.resourceType) }}
      >
        {resource.typeLabel}
      </span>
      {primary === null ? (
        resource.resourceId === '' ? null : (
          <code className="resource-id">{resource.resourceId}</code>
        )
      ) : (
        <span className="resource-label">
          <span className="resource-name">{primary}</span>
          {japanese === null ? null : <span className="resource-name-jp">{japanese}</span>}
        </span>
      )}
      <span className="resource-amount">×{resource.amount}</span>
    </span>
  );
}

/** All grants of one reward; unknown ids stay visible without an error. */
export function RewardSummary({
  reward,
  loading,
}: {
  reward: LookupReward | undefined;
  loading: boolean;
}) {
  // While a new lookup is in flight keep the previous badge; only a cell with
  // no prior row falls back to the muted "resolving…" note.
  if (loading && reward === undefined) {
    return <span className="resource-muted">resolving…</span>;
  }
  if (reward === undefined || !reward.found) {
    return <span className="resource-unknown">unknown id</span>;
  }
  if (reward.resources.length === 0) {
    return <span className="resource-muted">no resources</span>;
  }
  return (
    <span className="resource-list">
      {reward.resources.map((resource, index) => (
        <ResourceBadge key={`${resource.resourceType}:${resource.resourceId}:${index}`} resource={resource} />
      ))}
    </span>
  );
}

/** Every live bonus of a group: level plus English/Japanese description. */
export function LiveBonusGroupSummary({
  group,
  loading,
}: {
  group: LookupLiveBonusGroup | undefined;
  loading: boolean;
}) {
  if (loading && group === undefined) {
    return <span className="resource-muted">resolving…</span>;
  }
  if (group === undefined || !group.found) {
    return <span className="resource-unknown">unknown id</span>;
  }
  if (group.bonuses.length === 0) {
    return <span className="resource-muted">no live bonuses</span>;
  }
  return (
    <span className="resource-list">
      {group.bonuses.map((bonus) => {
        const primary =
          firstNonEmpty(bonus.descriptionEn, bonus.description) ??
          firstNonEmpty(bonus.liveAbilityId);
        const japanese =
          firstNonEmpty(bonus.descriptionEn) === null
            ? null
            : firstNonEmpty(bonus.description);
        return (
          <span className="resource-bonus" key={bonus.liveBonusId}>
            <span className="resource-badge">
              <span
                className="resource-type"
                style={{ color: 'var(--res-live)', borderColor: 'var(--res-live)' }}
              >
                Live bonus
              </span>
              {bonus.level === null ? null : (
                <span className="resource-level">Lv&nbsp;{bonus.level}</span>
              )}
              {primary === null ? null : (
                <span className="resource-label">
                  <span className="resource-name">{primary}</span>
                  {japanese === null ? null : <span className="resource-name-jp">{japanese}</span>}
                </span>
              )}
            </span>
            {bonus.skills.map((skill) => {
              const skillName = firstNonEmpty(skill.nameEn, skill.name) ?? skill.skillId;
              const skillNameJp =
                firstNonEmpty(skill.nameEn) === null
                  ? null
                  : firstNonEmpty(skill.name);
              const skillDescription = firstNonEmpty(
                skill.descriptionEn,
                skill.description,
              );
              const skillDescriptionJp =
                firstNonEmpty(skill.descriptionEn) === null
                  ? null
                  : firstNonEmpty(skill.description);
              return (
                <span className="resource-skill" key={skill.skillId}>
                  <span className="resource-skill-name">
                    <span className="resource-name">{skillName}</span>
                    {skillNameJp === null ? null : (
                      <span className="resource-name-jp">{skillNameJp}</span>
                    )}
                  </span>
                  {skillDescription === null ? null : (
                    <span className="resource-skill-desc">
                      {skillDescription}
                      {skillDescriptionJp === null ? null : (
                        <span className="resource-name-jp">{skillDescriptionJp}</span>
                      )}
                    </span>
                  )}
                </span>
              );
            })}
          </span>
        );
      })}
    </span>
  );
}

/** Resolved item name for the stamina/quest-unlock settings ids. */
export function ItemNameHint({ id, items }: { id: string; items: LookupItem[] | null }) {
  if (id === '') return null;
  if (items === null) return null;
  const item = items.find((entry) => entry.id === id);
  if (item === undefined) return <span className="resource-unknown">unknown id</span>;
  const primary = firstNonEmpty(item.nameEn, item.name);
  const japanese =
    firstNonEmpty(item.nameEn) === null ? null : firstNonEmpty(item.name);
  return (
    <span className="resource-label resource-inline">
      <span className="resource-name">{primary ?? item.id}</span>
      {japanese === null ? null : <span className="resource-name-jp">{japanese}</span>}
    </span>
  );
}
