/**
 * JSON tab: both documents in full, for anything the structured tabs do not
 * cover. Each textarea applies on blur only, and only when the text parses to
 * an object, so a half-typed edit can never reach the draft.
 */
import { JsonField, TabIssueList } from './fields.tsx';
import type { MoshikoiDraftShape } from './moshikoi.ts';
import type { ValidationIssue } from '../../types.ts';

export function MoshikoiJsonTab({
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
  return (
    <div className="panel">
      <TabIssueList issues={issues} prefixes={['routes', 'catalog']} />
      <p className="muted">
        Both documents are stored verbatim. Edits apply when the textarea loses focus, and only
        when the text parses to a JSON object.
      </p>
      <JsonField
        label="routes"
        value={draft.routes}
        disabled={!canEdit}
        rows={22}
        className="json-input"
        onApply={(next) => onChange({ ...draft, routes: next as Record<string, unknown> })}
      />
      <JsonField
        label="catalog"
        value={draft.catalog}
        disabled={!canEdit}
        rows={22}
        className="json-input"
        onApply={(next) => onChange({ ...draft, catalog: next as Record<string, unknown> })}
      />
    </div>
  );
}
