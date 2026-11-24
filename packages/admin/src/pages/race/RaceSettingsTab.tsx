// Race Settings form. The race plugin schema supplies field labels and the
// read-only markers; the grouping below is race-specific (the same way the
// marathon kind has bespoke Stages/Boxes tabs), because rank grades, the
// activity lesson and the area quest reward are structured editors rather than
// a flat list of scalar fields.
import { useState } from 'react';
import { draftValue, errorAt, withDraftValue, type MarathonDraftShape } from '../../draft.ts';
import type { EditorSchema, RosterSummary, ValidationIssue } from '../../types.ts';
import { normalizeLessonTier, raceLessonRates } from './lessonRates.ts';

interface RaceRankGrade {
  id: string;
  name: string;
  hierarchyPointFrom: number;
  topColorCode: string;
  bottomColorCode: string;
}

interface RaceActivityLesson {
  racePointPerStepBase: number;
  racePointPerStepPerTier: number;
  raceMedalPerStepBase: number;
  raceMedalPerStepPerTier: number;
  maxHours: number;
}

interface RaceAreaQuestReward {
  racePointPerTier: number;
  raceMedalPerTier: number;
}

/** Synthetic race players; generated on read, never stored. */
interface RaceBots {
  enabled: boolean;
  count: number;
  minPanelsPerDay: number;
  maxPanelsPerDay: number;
  names: string[];
}

/**
 * Per-VENUS-grade stage difficulty. The server freezes the number on a player's
 * first Race:Top, so a change here only reaches players who have not started.
 */
interface RaceGradeDifficulty {
  challenger: number;
  bronze: number;
  silver: number;
  gold: number;
  platinum: number;
  diamond: number;
  big4: number;
}

export interface RaceSettingsTabProps {
  draft: MarathonDraftShape;
  schema: EditorSchema | null;
  issues: readonly ValidationIssue[];
  canEdit: boolean;
  rosters: RosterSummary[];
  onChange: (next: MarathonDraftShape) => void;
}

/** Master data copied by the import; the admin never edits these. */
const MASTER_PATHS = [
  'raceId',
  'name',
  'assetId',
  'bannerAssetId',
  'racePointItemId',
  'raceMedalItemId',
  'raceLiveBonusResetItemId',
  'eventMissionId',
  'eventStoryId',
  'areaIds',
  'raceLiveBonusGroupId',
  'areaQuestIds.pt',
  'areaQuestIds.medal',
];

/** Flat authored numbers rendered in the tuning grid. */
const TUNING_PATHS = [
  'livePanelDifficultyNumber',
  'cardCoolTimeMinutes',
  'requiredCardCoolTimeRacePointAmount',
  'initialRacePointAmount',
  'rivals',
];

const LESSON_PATHS = [
  'activityLesson.racePointPerStepBase',
  'activityLesson.racePointPerStepPerTier',
  'activityLesson.raceMedalPerStepBase',
  'activityLesson.raceMedalPerStepPerTier',
  'activityLesson.maxHours',
];

const REWARD_PATHS = [
  'areaQuestReward.racePointPerTier',
  'areaQuestReward.raceMedalPerTier',
];

/** Ordered lowest to highest VENUS grade; labels come from the plugin schema. */
const DIFFICULTY_PATHS = [
  'gradeDifficulty.challenger',
  'gradeDifficulty.bronze',
  'gradeDifficulty.silver',
  'gradeDifficulty.gold',
  'gradeDifficulty.platinum',
  'gradeDifficulty.diamond',
  'gradeDifficulty.big4',
];

// Mirrors RACE_ACTIVITY_LESSON_DEFAULTS / RACE_AREA_QUEST_REWARD_DEFAULTS on the
// server so a draft authored before those fields existed still previews what
// the server will actually use.
const LESSON_FALLBACK: RaceActivityLesson = {
  racePointPerStepBase: 34,
  racePointPerStepPerTier: 4.5,
  raceMedalPerStepBase: 17,
  raceMedalPerStepPerTier: 3.3,
  maxHours: 36,
};

const REWARD_FALLBACK: RaceAreaQuestReward = { racePointPerTier: 2000, raceMedalPerTier: 100 };

// Mirrors RACE_BOT_* defaults in the server race plugin, so an old draft (no
// `bots` block) previews what the server falls back to: disabled.
const BOTS_FALLBACK: RaceBots = {
  enabled: false,
  count: 30,
  minPanelsPerDay: 20,
  maxPanelsPerDay: 120,
  names: [],
};

// Mirrors the race plugin's grade-difficulty defaults so a draft authored before
// the field existed still previews the values the server will use.
const DIFFICULTY_FALLBACK: RaceGradeDifficulty = {
  challenger: 1,
  bronze: 2,
  silver: 3,
  gold: 4,
  platinum: 5,
  diamond: 6,
  big4: 7,
};

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberIn(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringIn(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function displayValue(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}: ${String(entry)}`)
      .join(', ');
  }
  return String(value);
}

function hexColor(value: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';
}

function readGrades(draft: MarathonDraftShape): RaceRankGrade[] {
  return Array.isArray(draft.rankGrades)
    ? draft.rankGrades.map((entry) => {
        const grade = recordOf(entry);
        return {
          id: stringIn(grade.id),
          name: stringIn(grade.name),
          hierarchyPointFrom: numberIn(grade.hierarchyPointFrom, 0),
          topColorCode: stringIn(grade.topColorCode, '#000000'),
          bottomColorCode: stringIn(grade.bottomColorCode, '#000000'),
        };
      })
    : [];
}

function readLesson(draft: MarathonDraftShape): RaceActivityLesson {
  const lesson = recordOf(draft.activityLesson);
  return {
    racePointPerStepBase: numberIn(
      lesson.racePointPerStepBase,
      LESSON_FALLBACK.racePointPerStepBase,
    ),
    racePointPerStepPerTier: numberIn(
      lesson.racePointPerStepPerTier,
      LESSON_FALLBACK.racePointPerStepPerTier,
    ),
    raceMedalPerStepBase: numberIn(
      lesson.raceMedalPerStepBase,
      LESSON_FALLBACK.raceMedalPerStepBase,
    ),
    raceMedalPerStepPerTier: numberIn(
      lesson.raceMedalPerStepPerTier,
      LESSON_FALLBACK.raceMedalPerStepPerTier,
    ),
    maxHours: numberIn(lesson.maxHours, LESSON_FALLBACK.maxHours),
  };
}

function readReward(draft: MarathonDraftShape): RaceAreaQuestReward {
  const reward = recordOf(draft.areaQuestReward);
  return {
    racePointPerTier: numberIn(reward.racePointPerTier, REWARD_FALLBACK.racePointPerTier),
    raceMedalPerTier: numberIn(reward.raceMedalPerTier, REWARD_FALLBACK.raceMedalPerTier),
  };
}

function readBots(draft: MarathonDraftShape): RaceBots {
  const bots = recordOf(draft.bots);
  const names = Array.isArray(bots.names)
    ? bots.names.map((entry) => stringIn(entry).trim()).filter((entry) => entry !== '')
    : [];
  return {
    enabled: bots.enabled === true,
    count: numberIn(bots.count, BOTS_FALLBACK.count),
    minPanelsPerDay: numberIn(bots.minPanelsPerDay, BOTS_FALLBACK.minPanelsPerDay),
    maxPanelsPerDay: numberIn(bots.maxPanelsPerDay, BOTS_FALLBACK.maxPanelsPerDay),
    names,
  };
}

function readDifficulty(draft: MarathonDraftShape): RaceGradeDifficulty {
  const difficulty = recordOf(draft.gradeDifficulty);
  return {
    challenger: numberIn(difficulty.challenger, DIFFICULTY_FALLBACK.challenger),
    bronze: numberIn(difficulty.bronze, DIFFICULTY_FALLBACK.bronze),
    silver: numberIn(difficulty.silver, DIFFICULTY_FALLBACK.silver),
    gold: numberIn(difficulty.gold, DIFFICULTY_FALLBACK.gold),
    platinum: numberIn(difficulty.platinum, DIFFICULTY_FALLBACK.platinum),
    diamond: numberIn(difficulty.diamond, DIFFICULTY_FALLBACK.diamond),
    big4: numberIn(difficulty.big4, DIFFICULTY_FALLBACK.big4),
  };
}

function uniqueGradeId(grades: readonly RaceRankGrade[]): string {
  let counter = grades.length + 1;
  while (grades.some((grade) => grade.id === `race_rank_grade-custom-${counter}`)) counter += 1;
  return `race_rank_grade-custom-${counter}`;
}

interface NumberInputProps {
  label: string;
  value: unknown;
  disabled: boolean;
  step?: string;
  min?: number;
  max?: number;
  error?: string | null;
  onChange: (value: number) => void;
}

function NumberInput({
  label,
  value,
  disabled,
  step,
  min,
  max,
  error,
  onChange,
}: NumberInputProps) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={typeof value === 'number' && Number.isFinite(value) ? String(value) : ''}
        disabled={disabled}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === '') {
            onChange(0);
            return;
          }
          const parsed = Number(raw);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
      />
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}

export function RaceSettingsTab({
  draft,
  schema,
  issues,
  canEdit,
  rosters,
  onChange,
}: RaceSettingsTabProps) {
  const [tierText, setTierText] = useState('1');
  const labels = new Map((schema?.fields ?? []).map((field) => [field.path, field.label ?? field.path]));
  const label = (path: string): string => labels.get(path) ?? path;
  const setField = (path: string, value: unknown): void => {
    onChange(withDraftValue(draft, path, value));
  };

  const grades = readGrades(draft);
  const lesson = readLesson(draft);
  const reward = readReward(draft);
  const difficulty = readDifficulty(draft);
  const bots = readBots(draft);
  const npcRosterId = stringIn(draft.npcRosterId);
  const knownRoster = rosters.some((roster) => roster.id === npcRosterId);

  const setLesson = (patch: Partial<RaceActivityLesson>): void => {
    setField('activityLesson', { ...lesson, ...patch });
  };
  const setReward = (patch: Partial<RaceAreaQuestReward>): void => {
    setField('areaQuestReward', { ...reward, ...patch });
  };
  const setDifficulty = (patch: Partial<RaceGradeDifficulty>): void => {
    setField('gradeDifficulty', { ...difficulty, ...patch });
  };
  const setBots = (patch: Partial<RaceBots>): void => {
    setField('bots', { ...bots, ...patch });
  };
  const setGrades = (next: RaceRankGrade[]): void => setField('rankGrades', next);
  const setGrade = (index: number, patch: Partial<RaceRankGrade>): void => {
    setGrades(grades.map((grade, at) => (at === index ? { ...grade, ...patch } : grade)));
  };
  const moveGrade = (index: number, offset: number): void => {
    const target = index + offset;
    if (target < 0 || target >= grades.length) return;
    const next = [...grades];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    setGrades(next);
  };
  const addGrade = (): void => {
    const highest = grades.reduce(
      (max, grade) => Math.max(max, grade.hierarchyPointFrom),
      0,
    );
    setGrades([
      ...grades,
      {
        id: uniqueGradeId(grades),
        name: 'New grade',
        hierarchyPointFrom: grades.length === 0 ? 0 : highest + 100,
        topColorCode: '#C08A5A',
        bottomColorCode: '#7A4E2A',
      },
    ]);
  };

  const tierInput = Number.isFinite(Number(tierText)) ? Number(tierText) : 1;
  const preview = [
    raceLessonRates(lesson, tierInput),
    raceLessonRates(lesson, normalizeLessonTier(55)),
  ];

  return (
    <div className="panel">
      <section>
        <h3>From master data</h3>
        <p className="muted">Imported with the race and published as-is; edit the race in master data instead.</p>
        <div className="field-grid">
          {MASTER_PATHS.map((path) => (
            <label className="field" key={path}>
              <span>{label(path)}</span>
              <input
                className="field-readonly"
                readOnly
                value={displayValue(draftValue(draft, path))}
                aria-label={label(path)}
              />
              <span className="readonly-tag">read-only</span>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h3>Race tuning</h3>
        <div className="field-grid">
          {TUNING_PATHS.map((path) => (
            <NumberInput
              key={path}
              label={label(path)}
              value={draftValue(draft, path)}
              disabled={!canEdit}
              min={0}
              error={errorAt(issues, path)}
              onChange={(value) => setField(path, value)}
            />
          ))}
          <label className="field">
            <span>{label('npcRosterId')}</span>
            <select
              value={npcRosterId}
              disabled={!canEdit}
              onChange={(event) => setField('npcRosterId', event.target.value)}
              aria-label={label('npcRosterId')}
            >
              {knownRoster || npcRosterId === '' ? null : (
                <option value={npcRosterId}>{npcRosterId} (unknown roster)</option>
              )}
              {rosters.map((roster) => (
                <option key={roster.id} value={roster.id}>
                  {roster.id} · {roster.name}
                </option>
              ))}
            </select>
            {errorAt(issues, 'npcRosterId') ? (
              <span className="field-error">{errorAt(issues, 'npcRosterId')}</span>
            ) : null}
          </label>
        </div>
        <p className="muted">
          Live panel difficulty is the fallback for players without a fixed VENUS-grade difficulty.
        </p>
      </section>

      <section>
        <h3>Bots</h3>
        <p className="muted">
          Synthetic players padded into the race ranking and the board rival list, so a small
          server looks populated. They are generated on read from the schedule, never stored in the
          database and never rewarded.
        </p>
        <div className="field-grid">
          <label className="field">
            <span>{label('bots.enabled')}</span>
            <input
              type="checkbox"
              checked={bots.enabled}
              disabled={!canEdit}
              aria-label={label('bots.enabled')}
              onChange={(event) => setBots({ enabled: event.target.checked })}
            />
            {errorAt(issues, 'bots.enabled') ? (
              <span className="field-error">{errorAt(issues, 'bots.enabled')}</span>
            ) : null}
          </label>
          <NumberInput
            label={label('bots.count')}
            value={bots.count}
            disabled={!canEdit}
            step="1"
            min={0}
            max={500}
            error={errorAt(issues, 'bots.count')}
            onChange={(value) => setBots({ count: value })}
          />
          <NumberInput
            label={label('bots.minPanelsPerDay')}
            value={bots.minPanelsPerDay}
            disabled={!canEdit}
            min={0}
            error={errorAt(issues, 'bots.minPanelsPerDay')}
            onChange={(value) => setBots({ minPanelsPerDay: value })}
          />
          <NumberInput
            label={label('bots.maxPanelsPerDay')}
            value={bots.maxPanelsPerDay}
            disabled={!canEdit}
            min={0}
            error={errorAt(issues, 'bots.maxPanelsPerDay')}
            onChange={(value) => setBots({ maxPanelsPerDay: value })}
          />
        </div>
        <label className="field">
          <span>{label('bots.names')}</span>
          <textarea
            className={canEdit ? 'field-editable' : undefined}
            rows={6}
            spellCheck={false}
            value={bots.names.join('\n')}
            readOnly={!canEdit}
            aria-label={label('bots.names')}
            placeholder="One name per line. Leave empty to name each bot after an idol and show that idol's icon."
            onChange={(event) =>
              setBots({
                names: event.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line !== ''),
              })
            }
          />
          {errorAt(issues, 'bots.names') ? (
            <span className="field-error">{errorAt(issues, 'bots.names')}</span>
          ) : null}
        </label>
        <p className="muted">
          Pace is cleared panels per day; each bot keeps a deterministic pace and a few run faster
          than the rest. Leave the names empty to name each bot after an idol from the game, showing
          that idol's icon. Custom names are reused with a numeric suffix when there are more bots
          than names.
        </p>
      </section>

      <section>
        <h3>VENUS grade → stage difficulty</h3>
        <div className="field-grid">
          {DIFFICULTY_PATHS.map((path) => {
            const key = path.split('.')[1] as keyof RaceGradeDifficulty;
            return (
              <NumberInput
                key={path}
                label={label(path)}
                value={difficulty[key]}
                disabled={!canEdit}
                step="1"
                min={1}
                max={7}
                error={errorAt(issues, path)}
                onChange={(value) => setDifficulty({ [key]: value })}
              />
            );
          })}
        </div>
        <p className="muted">
          Fixed per player on their first Race:Top; changing it later only affects new players.
        </p>
      </section>

      <section>
        <h3>Rank grades</h3>
        <p className="muted">
          Thresholds are total cleared panels. The first grade must start at 0 and every later
          grade must be strictly higher.
        </p>
        <table className="race-rank-grades">
          <thead>
            <tr>
              <th>Id</th>
              <th>Name</th>
              <th>Hierarchy points from</th>
              <th>Top colour</th>
              <th>Bottom colour</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {grades.map((grade, index) => (
              <tr key={index}>
                <td>
                  <input
                    className={canEdit ? 'field-editable' : undefined}
                    value={grade.id}
                    readOnly={!canEdit}
                    aria-label={`Grade ${index + 1} id`}
                    onChange={(event) => setGrade(index, { id: event.target.value })}
                  />
                  {errorAt(issues, `rankGrades.${index}.id`) ? (
                    <span className="field-error">{errorAt(issues, `rankGrades.${index}.id`)}</span>
                  ) : null}
                </td>
                <td>
                  <input
                    className={canEdit ? 'field-editable' : undefined}
                    value={grade.name}
                    readOnly={!canEdit}
                    aria-label={`Grade ${index + 1} name`}
                    onChange={(event) => setGrade(index, { name: event.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    className={canEdit ? 'field-editable' : undefined}
                    value={String(grade.hierarchyPointFrom)}
                    readOnly={!canEdit}
                    aria-label={`Grade ${index + 1} hierarchy points from`}
                    onChange={(event) => {
                      const parsed = Number(event.target.value);
                      if (Number.isFinite(parsed)) {
                        setGrade(index, { hierarchyPointFrom: parsed });
                      }
                    }}
                  />
                  {errorAt(issues, `rankGrades.${index}.hierarchyPointFrom`) ? (
                    <span className="field-error">
                      {errorAt(issues, `rankGrades.${index}.hierarchyPointFrom`)}
                    </span>
                  ) : null}
                </td>
                <td>
                  <span className="color-swatch" style={{ backgroundColor: hexColor(grade.topColorCode) }} />
                  <input
                    type="color"
                    value={hexColor(grade.topColorCode)}
                    disabled={!canEdit}
                    aria-label={`Grade ${index + 1} top colour`}
                    onChange={(event) => setGrade(index, { topColorCode: event.target.value })}
                  />
                </td>
                <td>
                  <span
                    className="color-swatch"
                    style={{ backgroundColor: hexColor(grade.bottomColorCode) }}
                  />
                  <input
                    type="color"
                    value={hexColor(grade.bottomColorCode)}
                    disabled={!canEdit}
                    aria-label={`Grade ${index + 1} bottom colour`}
                    onChange={(event) => setGrade(index, { bottomColorCode: event.target.value })}
                  />
                </td>
                <td className="item-actions">
                  <button
                    type="button"
                    disabled={!canEdit || index === 0}
                    aria-label={`Move grade ${index + 1} up`}
                    onClick={() => moveGrade(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={!canEdit || index === grades.length - 1}
                    aria-label={`Move grade ${index + 1} down`}
                    onClick={() => moveGrade(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={!canEdit}
                    aria-label={`Remove grade ${index + 1}`}
                    onClick={() => setGrades(grades.filter((_, at) => at !== index))}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" disabled={!canEdit} onClick={addGrade}>
          Add grade
        </button>
      </section>

      <section>
        <h3>Activity lesson</h3>
        <p className="muted">
          One step every 10 seconds. Players earn the rates below per step, capped at the max hours
          of unpaid time.
        </p>
        <div className="field-grid">
          {LESSON_PATHS.map((path) => {
            const key = path.split('.')[1] as keyof RaceActivityLesson;
            return (
              <NumberInput
                key={path}
                label={label(path)}
                value={lesson[key]}
                disabled={!canEdit}
                step="any"
                min={0}
                error={errorAt(issues, path)}
                onChange={(value) => setLesson({ [key]: value })}
              />
            );
          })}
        </div>
        <label className="field">
          <span>Preview tier (1–55)</span>
          <input
            type="number"
            min={1}
            max={55}
            value={tierText}
            onChange={(event) => setTierText(event.target.value)}
            aria-label="Preview tier"
          />
        </label>
        <table className="race-lesson-preview" data-testid="lesson-preview">
          <thead>
            <tr>
              <th>Tier</th>
              <th>Race points / step</th>
              <th>Medals / step</th>
              <th>Race points / hour</th>
              <th>Medals / hour</th>
              <th>Race points at max claim</th>
              <th>Medals at max claim</th>
            </tr>
          </thead>
          <tbody>
            {preview.map((rates, index) => (
              <tr key={index} data-tier={rates.tier}>
                <td>{rates.tier}</td>
                <td>{rates.racePointPerStep}</td>
                <td>{rates.raceMedalPerStep}</td>
                <td>{rates.racePointPerHour}</td>
                <td>{rates.raceMedalPerHour}</td>
                <td>{rates.racePointAtMax}</td>
                <td>{rates.raceMedalAtMax}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          The max claim is {preview[0].maxHours} hours of steps ({preview[0].maxSteps} steps).
        </p>
      </section>

      <section>
        <h3>Area quest reward</h3>
        <p className="muted">Paid once for the race point quest and once for the race medal quest.</p>
        <div className="field-grid">
          {REWARD_PATHS.map((path) => {
            const key = path.split('.')[1] as keyof RaceAreaQuestReward;
            return (
              <NumberInput
                key={path}
                label={label(path)}
                value={reward[key]}
                disabled={!canEdit}
                min={0}
                error={errorAt(issues, path)}
                onChange={(value) => setReward({ [key]: value })}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}
