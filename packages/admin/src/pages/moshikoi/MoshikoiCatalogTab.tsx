/**
 * Catalog tab: the scalar fields of a moshikoi catalog document, with a JSON
 * textarea for every nested value.
 *
 * Only keys already present in the draft are shown, so an event that carries no
 * `mainCharacters` (or any other optional key) never grows one by being opened.
 */
import { JsonField, NumberField, TabIssueList, fieldClass } from './fields.tsx';
import { datetimeLocalToMs, msToUtcDatetimeLocal, withCatalog } from './moshikoi.ts';
import type { MoshikoiDraftShape } from './moshikoi.ts';
import type { ValidationIssue } from '../../types.ts';

/** Human labels for the catalog keys the server documents. */
const CATALOG_LABELS: Record<string, string> = {
  loveId: 'Love event id',
  name: 'Name',
  description: 'Description',
  simpleName: 'Simple name',
  startTime: 'Start time',
  unlockConditionId: 'Unlock condition id',
  bannerAssetId: 'Banner asset id',
  characterId: 'Character id',
  costumeId: 'Costume id',
  characterAssetId: 'Character asset id',
  color: 'Color',
  storyReadItemId: 'Story read item id',
  presentItemId: 'Present item id',
  promoteItemId: 'Promote item id',
  lessonMaxHours: 'Lesson max hours',
  assetId: 'Asset id',
  titleAssetId: 'Title asset id',
  expAssetId: 'Exp asset id',
  baseType: 'Base type',
  hideManagerVoiceSwitch: 'Hide manager voice switch',
};

const CATALOG_ORDER = Object.keys(CATALOG_LABELS);

/** Known keys first in their documented order, then anything else authored. */
function catalogKeys(catalog: Record<string, unknown>): string[] {
  const known = CATALOG_ORDER.filter((key) => Object.hasOwn(catalog, key));
  const extra = Object.keys(catalog).filter((key) => !CATALOG_ORDER.includes(key));
  return [...known, ...extra];
}

function catalogLabel(key: string): string {
  return CATALOG_LABELS[key] ?? key;
}

export function MoshikoiCatalogTab({
  draft,
  issues,
  canEdit,
  onChange,
}: {
  draft: MoshikoiDraftShape;
  issues: ValidationIssue[];
  canEdit: boolean;
  onChange: (next: MoshikoiDraftShape) => void;
}) {
  const catalog = draft.catalog;
  const setField = (key: string, value: unknown): void => {
    onChange(withCatalog(draft, { ...catalog, [key]: value }));
  };

  return (
    <div className="panel">
      <TabIssueList issues={issues} prefixes={['catalog']} />
      <p className="muted">
        Scalar fields edit in place. Nested values (missions, unlock levels, main characters) are
        JSON and apply when the field loses focus.
      </p>
      <div className="field-grid">
        {catalogKeys(catalog).map((key) => (
          <CatalogField
            key={key}
            fieldKey={key}
            value={catalog[key]}
            canEdit={canEdit}
            onChange={setField}
          />
        ))}
      </div>
    </div>
  );
}

function CatalogField({
  fieldKey,
  value,
  canEdit,
  onChange,
}: {
  fieldKey: string;
  value: unknown;
  canEdit: boolean;
  onChange: (key: string, next: unknown) => void;
}) {
  const label = catalogLabel(fieldKey);

  if (typeof value === 'boolean') {
    return (
      <label className="field">
        <span>{label}</span>
        <input
          type="checkbox"
          checked={value}
          disabled={!canEdit}
          className={fieldClass(!canEdit)}
          onChange={(event) => onChange(fieldKey, event.target.checked)}
        />
      </label>
    );
  }

  if (typeof value === 'number') {
    return (
      <div className="field">
        <span>{label}</span>
        {fieldKey === 'startTime' ? (
          <StartTimeField
            value={value}
            disabled={!canEdit}
            onChange={(ms) => onChange(fieldKey, ms)}
          />
        ) : (
          <NumberField
            ariaLabel={label}
            value={value}
            disabled={!canEdit}
            onChange={(next) => {
              if (next !== null) onChange(fieldKey, next);
            }}
          />
        )}
      </div>
    );
  }

  if (typeof value === 'string') {
    const readOnly = fieldKey === 'loveId';
    return (
      <label className="field">
        <span>
          {label}
          {readOnly ? <span className="readonly-tag">read-only</span> : null}
        </span>
        <input
          type="text"
          value={value}
          readOnly={readOnly}
          disabled={!canEdit || readOnly}
          className={fieldClass(!canEdit || readOnly)}
          onChange={(event) => onChange(fieldKey, event.target.value)}
        />
      </label>
    );
  }

  return (
    <JsonField
      label={`${label} (JSON)`}
      value={value}
      disabled={!canEdit}
      onApply={(next) => onChange(fieldKey, next)}
    />
  );
}

/** `startTime` as a UTC datetime-local next to the raw epoch-ms input. */
function StartTimeField({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (ms: number) => void;
}) {
  return (
    <span className="moshikoi-datetime">
      <input
        type="datetime-local"
        step="1"
        aria-label="Start time (UTC)"
        value={msToUtcDatetimeLocal(value)}
        disabled={disabled}
        className={fieldClass(disabled)}
        onChange={(event) => {
          const ms = datetimeLocalToMs(event.target.value);
          if (ms !== null) onChange(ms);
        }}
      />
      <NumberField
        ariaLabel="Start time (ms)"
        value={value}
        disabled={disabled}
        onChange={(next) => {
          if (next !== null) onChange(next);
        }}
      />
    </span>
  );
}
