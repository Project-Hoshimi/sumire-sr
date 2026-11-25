/**
 * Routes tab: pick an episode on the left and edit its route on the right.
 *
 * Everything the server validates most often (choice groups, `next`, outcomes)
 * is a real control; the rarer `branches` and per-group `requires` stay JSON
 * textareas that apply on blur. References to an unknown episode or ending are
 * highlighted so a broken link is visible before Validate runs.
 */
import { Fragment, useState } from 'react';
import { JsonField, NumberField, TabIssueList, fieldClass } from './fields.tsx';
import {
  addCondition,
  addOutcome,
  conditionsOf,
  countOf,
  endingIdsOf,
  episodeShortId,
  episodesOf,
  groupsOf,
  outcomesOf,
  pointsOf,
  removeCondition,
  removeOutcome,
  scoresOf,
  setConditionEpisode,
  setConditionNumber,
  setEpisodeBranches,
  setEpisodeNext,
  setGroupBest,
  setGroupCount,
  setGroupPoints,
  setGroupRequires,
  setGroupScore,
  setOutcomeBound,
  setOutcomeEnding,
  setOutcomeNext,
  updateCondition,
  updateGroup,
  updateOutcome,
  withRoutes,
} from './moshikoi.ts';
import type {
  MoshikoiBranch,
  MoshikoiCondition,
  MoshikoiDraftShape,
  MoshikoiEpisode,
} from './moshikoi.ts';
import type { ValidationIssue } from '../../types.ts';

export function MoshikoiRoutesTab({
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
  const episodes = episodesOf(routes);
  const episodeIds = Object.keys(episodes);
  const loveId =
    typeof routes.loveId === 'string' && routes.loveId !== '' ? routes.loveId : draft.id;
  const endingIds = endingIdsOf(routes);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A removed or renamed episode never leaves the pane pointing at nothing.
  const episodeId =
    selectedId !== null && episodes[selectedId] !== undefined ? selectedId : (episodeIds[0] ?? null);
  const update = (next: Record<string, unknown>): void => onChange(withRoutes(draft, next));

  return (
    <div className="panel">
      {/* Endings and endingConditions issues belong to the Endings tab. */}
      <TabIssueList
        issues={issues}
        prefixes={['routes']}
        exclude={['routes.endings', 'routes.endingConditions']}
      />
      {episodeIds.length === 0 ? <p>This route map has no episodes.</p> : null}
      <div className="moshikoi-split">
        <ul className="moshikoi-episode-list" aria-label="Episodes">
          {episodeIds.map((id) => (
            <li key={id}>
              <button
                type="button"
                title={id}
                aria-current={id === episodeId ? 'page' : undefined}
                onClick={() => setSelectedId(id)}
              >
                {episodeShortId(id, loveId)}
              </button>
            </li>
          ))}
        </ul>
        {episodeId === null ? null : (
          <EpisodeEditor
            key={episodeId}
            episodeId={episodeId}
            episode={episodes[episodeId] as MoshikoiEpisode}
            episodeIds={episodeIds}
            endingIds={endingIds}
            routes={routes}
            canEdit={canEdit}
            update={update}
          />
        )}
      </div>
    </div>
  );
}

function EpisodeEditor({
  episodeId,
  episode,
  episodeIds,
  endingIds,
  routes,
  canEdit,
  update,
}: {
  episodeId: string;
  episode: MoshikoiEpisode;
  episodeIds: string[];
  endingIds: string[];
  routes: Record<string, unknown>;
  canEdit: boolean;
  update: (next: Record<string, unknown>) => void;
}) {
  const groups = groupsOf(episode);
  const outcomes = outcomesOf(episode);
  const nextValue = typeof episode.next === 'string' ? episode.next : '';
  const nextUnknown = nextValue !== '' && !episodeIds.includes(nextValue);

  return (
    <div className="moshikoi-episode">
      <h3>
        Episode <code>{episodeId}</code>
      </h3>

      <h4>Choice groups</h4>
      {groups.length === 0 ? (
        <p className="muted">No choice groups in this episode.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Index</th>
              <th>Choices</th>
              <th>Scores</th>
              <th>Best</th>
              <th>Points</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group, position) => {
              const count = countOf(group);
              const best = typeof group.best === 'number' ? group.best : 0;
              const scores = scoresOf(group);
              const points = pointsOf(group);
              return (
                <Fragment key={position}>
                  <tr>
                    <td>{typeof group.index === 'number' ? group.index : position + 1}</td>
                    <td>
                      <NumberField
                        ariaLabel={`group ${position + 1} count`}
                        value={count}
                        disabled={!canEdit}
                        onChange={(value) => {
                          if (value === null) return;
                          update(
                            updateGroup(routes, episodeId, position, (current) =>
                              setGroupCount(current, value),
                            ),
                          );
                        }}
                      />
                    </td>
                    <td className="moshikoi-choice-cells">
                      {Array.from({ length: count }, (_, choice) => (
                        <NumberField
                          key={choice}
                          ariaLabel={`group ${position + 1} score ${choice + 1}`}
                          value={scores[choice]}
                          disabled={!canEdit}
                          onChange={(value) => {
                            if (value === null) return;
                            update(
                              updateGroup(routes, episodeId, position, (current) =>
                                setGroupScore(current, choice, value),
                              ),
                            );
                          }}
                        />
                      ))}
                    </td>
                    <td>
                      <select
                        aria-label={`group ${position + 1} best`}
                        value={String(best)}
                        disabled={!canEdit}
                        className={fieldClass(!canEdit)}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          update(
                            updateGroup(routes, episodeId, position, (current) =>
                              setGroupBest(current, value),
                            ),
                          );
                        }}
                      >
                        <option value="0">(none)</option>
                        {Array.from({ length: count }, (_, choice) => (
                          <option key={choice + 1} value={String(choice + 1)}>
                            {choice + 1}
                          </option>
                        ))}
                        {best > count ? (
                          <option value={String(best)}>{best} (out of range)</option>
                        ) : null}
                      </select>
                    </td>
                    <td className="moshikoi-choice-cells">
                      {points === null
                        ? null
                        : Array.from({ length: count }, (_, choice) => (
                            <NumberField
                              key={choice}
                              ariaLabel={`group ${position + 1} points ${choice + 1}`}
                              value={points[choice]}
                              disabled={!canEdit}
                              onChange={(value) => {
                                if (value === null) return;
                                update(
                                  updateGroup(routes, episodeId, position, (current) =>
                                    setGroupPoints(current, choice, value),
                                  ),
                                );
                              }}
                            />
                          ))}
                    </td>
                  </tr>
                  {Array.isArray(group.requires) ? (
                    <tr>
                      <td colSpan={5}>
                        <JsonField
                          label={`group ${position + 1} requires (JSON)`}
                          value={group.requires}
                          disabled={!canEdit}
                          rows={4}
                          onApply={(next) =>
                            update(
                              setGroupRequires(
                                routes,
                                episodeId,
                                position,
                                next as MoshikoiCondition[],
                              ),
                            )
                          }
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      <label className="field">
        <span>Next episode</span>
        <select
          aria-label="Next episode"
          value={nextValue}
          disabled={!canEdit}
          className={fieldClass(!canEdit, nextUnknown && 'ref-invalid')}
          onChange={(event) => update(setEpisodeNext(routes, episodeId, event.target.value))}
        >
          <option value="">(none)</option>
          {episodeIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
          {nextUnknown ? <option value={nextValue}>{nextValue} (unknown)</option> : null}
        </select>
      </label>

      <h4>Outcomes</h4>
      {outcomes.length === 0 ? <p className="muted">No outcomes in this episode.</p> : null}
      {outcomes.map((outcome, position) => (
        <OutcomeCard
          key={position}
          position={position}
          outcome={outcome}
          episodeIds={episodeIds}
          endingIds={endingIds}
          routes={routes}
          episodeId={episodeId}
          canEdit={canEdit}
          update={update}
        />
      ))}
      <div className="row-actions">
        <button
          type="button"
          disabled={!canEdit}
          onClick={() => update(addOutcome(routes, episodeId))}
        >
          Add outcome
        </button>
      </div>

      <JsonField
        label="Branches (JSON)"
        value={Array.isArray(episode.branches) ? episode.branches : []}
        disabled={!canEdit}
        rows={6}
        onApply={(next) =>
          update(setEpisodeBranches(routes, episodeId, next as MoshikoiBranch[]))
        }
      />
    </div>
  );
}

function OutcomeCard({
  position,
  outcome,
  episodeIds,
  endingIds,
  routes,
  episodeId,
  canEdit,
  update,
}: {
  position: number;
  outcome: ReturnType<typeof outcomesOf>[number];
  episodeIds: string[];
  endingIds: string[];
  routes: Record<string, unknown>;
  episodeId: string;
  canEdit: boolean;
  update: (next: Record<string, unknown>) => void;
}) {
  const conditions = conditionsOf(outcome);
  const nextValue = typeof outcome.next === 'string' ? outcome.next : '';
  const nextUnknown = nextValue !== '' && !episodeIds.includes(nextValue);
  const endingValue = typeof outcome.ending === 'string' ? outcome.ending : '';
  const endingUnknown = endingValue !== '' && !endingIds.includes(endingValue);
  const change = (modify: (current: typeof outcome) => typeof outcome) =>
    update(updateOutcome(routes, episodeId, position, modify));

  return (
    <div className="box-card moshikoi-outcome">
      <div className="box-head">
        <h4>Outcome {position + 1}</h4>
        <div className="row-actions">
          <button
            type="button"
            className="danger"
            disabled={!canEdit}
            onClick={() => update(removeOutcome(routes, episodeId, position))}
          >
            Remove outcome
          </button>
        </div>
      </div>
      <div className="moshikoi-outcome-fields">
        <label className="field">
          <span>Next</span>
          <select
            aria-label={`outcome ${position + 1} next episode`}
            value={nextValue}
            disabled={!canEdit}
            className={fieldClass(!canEdit, nextUnknown && 'ref-invalid')}
            onChange={(event) => change((current) => setOutcomeNext(current, event.target.value))}
          >
            <option value="">(none)</option>
            {episodeIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
            {nextUnknown ? <option value={nextValue}>{nextValue} (unknown)</option> : null}
          </select>
        </label>
        <label className="field">
          <span>Ending</span>
          <select
            aria-label={`outcome ${position + 1} ending`}
            value={endingValue}
            disabled={!canEdit}
            className={fieldClass(!canEdit, endingUnknown && 'ref-invalid')}
            onChange={(event) => change((current) => setOutcomeEnding(current, event.target.value))}
          >
            <option value="">(none)</option>
            {endingIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
            {endingUnknown ? <option value={endingValue}>{endingValue} (unknown)</option> : null}
          </select>
        </label>
        <label className="field">
          <span>Min points</span>
          <NumberField
            ariaLabel={`outcome ${position + 1} min points`}
            value={outcome.minPoints}
            disabled={!canEdit}
            blankMeansNull
            placeholder="(unset)"
            onChange={(value) => change((current) => setOutcomeBound(current, 'minPoints', value))}
          />
        </label>
        <label className="field">
          <span>Max points</span>
          <NumberField
            ariaLabel={`outcome ${position + 1} max points`}
            value={outcome.maxPoints}
            disabled={!canEdit}
            blankMeansNull
            placeholder="(unset)"
            onChange={(value) => change((current) => setOutcomeBound(current, 'maxPoints', value))}
          />
        </label>
      </div>

      <table>
        <thead>
          <tr>
            <th>Episode</th>
            <th>Group</th>
            <th>Choice</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {conditions.map((condition, index) => {
            const conditionEpisode = typeof condition.episode === 'string' ? condition.episode : '';
            const episodeUnknown =
              conditionEpisode !== '' && !episodeIds.includes(conditionEpisode);
            return (
              <tr key={index}>
                <td>
                  <select
                    aria-label={`outcome ${position + 1} condition ${index + 1} episode`}
                    value={conditionEpisode}
                    disabled={!canEdit}
                    className={fieldClass(!canEdit, episodeUnknown && 'ref-invalid')}
                    onChange={(event) =>
                      change((current) =>
                        updateCondition(current, index, (entry) =>
                          setConditionEpisode(entry, event.target.value),
                        ),
                      )
                    }
                  >
                    <option value="">(current)</option>
                    {episodeIds.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                    {episodeUnknown ? (
                      <option value={conditionEpisode}>{conditionEpisode} (unknown)</option>
                    ) : null}
                  </select>
                </td>
                <td>
                  <NumberField
                    ariaLabel={`outcome ${position + 1} condition ${index + 1} group`}
                    value={condition.group}
                    disabled={!canEdit}
                    onChange={(value) => {
                      if (value === null) return;
                      change((current) =>
                        updateCondition(current, index, (entry) =>
                          setConditionNumber(entry, 'group', value),
                        ),
                      );
                    }}
                  />
                </td>
                <td>
                  <NumberField
                    ariaLabel={`outcome ${position + 1} condition ${index + 1} choice`}
                    value={condition.choice}
                    disabled={!canEdit}
                    onChange={(value) => {
                      if (value === null) return;
                      change((current) =>
                        updateCondition(current, index, (entry) =>
                          setConditionNumber(entry, 'choice', value),
                        ),
                      );
                    }}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="danger"
                    disabled={!canEdit}
                    onClick={() =>
                      change((current) => removeCondition(current, index))
                    }
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
          onClick={() => change((current) => addCondition(current))}
        >
          Add condition
        </button>
      </div>
    </div>
  );
}
