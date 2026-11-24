/**
 * Endings tab: the `endings` table plus the `endingConditions` map.
 *
 * An existing ending keeps its id (route outcomes point at it); a row added in
 * this session starts with a blank id so it can be named before saving. Blank
 * `endRollAssetId` means the field is omitted, matching the authored files.
 */
import { useState } from 'react';
import { NumberField, TabIssueList, fieldClass } from './fields.tsx';
import {
  addEnding,
  endingConditionsOf,
  endingIdsOf,
  endingListOf,
  removeEndingAt,
  removeEndingCondition,
  renameEndingCondition,
  setEndingCondition,
  updateEndingAt,
  withRoutes,
} from './moshikoi.ts';
import type { MoshikoiDraftShape, MoshikoiEnding } from './moshikoi.ts';
import type { ValidationIssue } from '../../types.ts';

export function MoshikoiEndingsTab({
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
  const routes = draft.routes;
  const endings = endingListOf(routes);
  const endingIds = endingIdsOf(routes);
  const conditions = Object.entries(endingConditionsOf(routes));
  const update = (next: Record<string, unknown>): void => onChange(withRoutes(draft, next));

  const nextConditionId = (): string => {
    let index = 1;
    while (Object.hasOwn(endingConditionsOf(routes), `new-condition-${index}`)) index += 1;
    return `new-condition-${index}`;
  };

  return (
    <div className="panel">
      <TabIssueList issues={issues} prefixes={['routes.endings', 'routes.endingConditions']} />

      <h3>Endings</h3>
      {endings.length === 0 ? <p className="muted">No endings yet.</p> : null}
      <table>
        <thead>
          <tr>
            <th>Id</th>
            <th>Name</th>
            <th>Favorability</th>
            <th>End roll asset id</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {endings.map((ending, position) => (
            <tr key={position}>
              <td>
                <input
                  type="text"
                  aria-label={`ending ${position + 1} id`}
                  value={typeof ending.id === 'string' ? ending.id : ''}
                  readOnly={typeof ending.id === 'string' && ending.id !== ''}
                  disabled={!canEdit}
                  className={fieldClass((typeof ending.id === 'string' && ending.id !== '') || !canEdit)}
                  onChange={(event) =>
                    update(
                      updateEndingAt(routes, position, (current) => ({
                        ...current,
                        id: event.target.value,
                      })),
                    )
                  }
                />
              </td>
              <td>
                <input
                  type="text"
                  aria-label={`ending ${position + 1} name`}
                  value={typeof ending.name === 'string' ? ending.name : ''}
                  disabled={!canEdit}
                  className={fieldClass(!canEdit)}
                  onChange={(event) =>
                    update(
                      updateEndingAt(routes, position, (current) => ({
                        ...current,
                        name: event.target.value,
                      })),
                    )
                  }
                />
              </td>
              <td>
                <NumberField
                  ariaLabel={`ending ${position + 1} favorability`}
                  value={ending.favorability}
                  disabled={!canEdit}
                  onChange={(value) => {
                    if (value === null) return;
                    update(
                      updateEndingAt(routes, position, (current) => ({
                        ...current,
                        favorability: value,
                      })),
                    );
                  }}
                />
              </td>
              <td>
                <input
                  type="text"
                  aria-label={`ending ${position + 1} end roll asset id`}
                  value={typeof ending.endRollAssetId === 'string' ? ending.endRollAssetId : ''}
                  disabled={!canEdit}
                  placeholder="(none)"
                  className={fieldClass(!canEdit)}
                  onChange={(event) => {
                    const value = event.target.value;
                    update(
                      updateEndingAt(routes, position, (current) => {
                        const copy: MoshikoiEnding = { ...current };
                        if (value === '') delete copy.endRollAssetId;
                        else copy.endRollAssetId = value;
                        return copy;
                      }),
                    );
                  }}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="danger"
                  disabled={!canEdit}
                  onClick={() => update(removeEndingAt(routes, position))}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row-actions">
        <button
          type="button"
          disabled={!canEdit}
          onClick={() =>
            update(
              addEnding(routes, { id: '', name: '', favorability: 0 } as MoshikoiEnding),
            )
          }
        >
          Add ending
        </button>
      </div>

      <h3>Ending conditions</h3>
      {conditions.length === 0 ? <p className="muted">No ending conditions yet.</p> : null}
      <table>
        <thead>
          <tr>
            <th>Condition id</th>
            <th>Ending</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {conditions.map(([conditionId, endingId], position) => {
            const unknown = endingId !== '' && !endingIds.includes(endingId);
            return (
              <tr key={conditionId}>
                <td>
                  <ConditionIdField
                    key={conditionId}
                    ariaLabel={`condition ${position + 1} id`}
                    value={conditionId}
                    disabled={!canEdit}
                    onRename={(nextId) => update(renameEndingCondition(routes, conditionId, nextId))}
                  />
                </td>
                <td>
                  <select
                    aria-label={`condition ${position + 1} ending`}
                    value={endingId}
                    disabled={!canEdit}
                    className={fieldClass(!canEdit, unknown && 'ref-invalid')}
                    onChange={(event) =>
                      update(setEndingCondition(routes, conditionId, event.target.value))
                    }
                  >
                    <option value="">(none)</option>
                    {endingIds.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                    {unknown ? <option value={endingId}>{endingId} (unknown)</option> : null}
                  </select>
                </td>
                <td>
                  <button
                    type="button"
                    className="danger"
                    disabled={!canEdit}
                    onClick={() => update(removeEndingCondition(routes, conditionId))}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row-actions">
        <button
          type="button"
          disabled={!canEdit}
          onClick={() => update(setEndingCondition(routes, nextConditionId(), ''))}
        >
          Add condition
        </button>
      </div>
    </div>
  );
}

/** Condition ids are object keys, so a rename commits on blur rather than per keystroke. */
function ConditionIdField({
  ariaLabel,
  value,
  disabled,
  onRename,
}: {
  ariaLabel: string;
  value: string;
  disabled: boolean;
  onRename: (nextId: string) => void;
}) {
  const [text, setText] = useState(value);
  return (
    <input
      type="text"
      aria-label={ariaLabel}
      value={text}
      disabled={disabled}
      className={fieldClass(disabled)}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (text === value || text === '') {
          setText(value);
          return;
        }
        onRename(text);
      }}
    />
  );
}
