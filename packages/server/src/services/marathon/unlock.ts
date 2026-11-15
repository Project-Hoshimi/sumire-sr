/**
 * Marathon unlock flags come from the master unlock condition, evaluated with
 * the same evaluator quests and stories use (`../conditions.ts`).
 *
 * A quest has two gates: the master condition (`UnlockConditionId`) and, when
 * `RequiredUnlockItemAmount` is positive, an item gate the player pays once
 * through `Marathon:UnlockQuest`. The payment is remembered in `state.ts`.
 */
import { db } from '../../db/client.ts';
import type { Executor } from '../../db/tx.ts';
import { getMarathonQuest } from '../../master/index.ts';
import { ConditionEvaluator } from '../conditions.ts';
import { getItemAmount } from '../inventory.ts';
import type { MarathonConfig } from './catalog.ts';
import type { MarathonState } from './state.ts';

/** Pattern of a master condition that means "cleared marathon quest `target`". */
const MARATHON_QUEST_CLEAR_CONDITION = /^cd-(.+)-(\d{1,3})$/;

/**
 * Quest id and difficulty a `cd-<marathonQuestId>-<NN>` condition id refers to,
 * else `null`. `NN` is parsed as a base-10 integer. Pure.
 */
export function marathonQuestClearConditionDifficulty(
  conditionId: string,
): { questId: string; difficulty: number } | null {
  const match = MARATHON_QUEST_CLEAR_CONDITION.exec(conditionId);
  if (match === null) return null;
  return { questId: match[1], difficulty: Number.parseInt(match[2], 10) };
}

/**
 * The master `MarathonQuest` id a condition id refers to when it is the
 * `cd-<marathonQuestId>-<difficulty>` shape, else `null`. Pure.
 */
export function marathonQuestClearConditionTarget(conditionId: string): string | null {
  return marathonQuestClearConditionDifficulty(conditionId)?.questId ?? null;
}

/**
 * True when `conditionId` is empty (no gate) or the master condition is
 * satisfied. A missing condition row, or a setting kind the evaluator does not
 * support, is not satisfied, so the gate stays closed.
 *
 * Pass one `evaluator` to every call in the same request: results are cached
 * per condition id, so each distinct id is evaluated once.
 *
 * `state` opts into the marathon-quest-clear conditions (`cd-<questId>-<n>`):
 * when the evaluator cannot satisfy the id directly, it counts as satisfied if
 * the player has cleared at least one difficulty of that marathon quest.
 */
export async function marathonConditionMet(
  playerId: string,
  conditionId: string,
  exec: Executor = db,
  evaluator?: ConditionEvaluator,
  state?: MarathonState,
): Promise<boolean> {
  if (conditionId === '') return true;
  const evaluate = evaluator ?? new ConditionEvaluator(playerId, Date.now(), exec);
  if (await evaluate.satisfied(conditionId)) return true;
  if (state === undefined) return false;

  const target = marathonQuestClearConditionTarget(conditionId);
  if (target === null) return false;
  const row = await getMarathonQuest(target);
  if (!row) return false;
  const diffs = state.quests?.[target]?.diffs;
  if (!diffs) return false;
  for (const diff of Object.values(diffs)) {
    if (diff.cleared === true) return true;
  }
  return false;
}

/**
 * True when a difficulty gate is open. An empty id is open; otherwise the
 * evaluator is consulted first. When the evaluator cannot satisfy a
 * `cd-<questId>-<NN>` condition (unknown setting, INDETERMINATE), difficulty
 * `NN >= 2` counts as open once the player has cleared difficulty `NN - 1` of
 * the same quest. `state.quests[questId].diffs` is keyed by the difficulty
 * number as a string.
 */
export async function marathonDifficultyConditionMet(
  playerId: string,
  questId: string,
  conditionId: string,
  state: MarathonState,
  exec: Executor = db,
  evaluator?: ConditionEvaluator,
): Promise<boolean> {
  if (conditionId === '') return true;
  const evaluate = evaluator ?? new ConditionEvaluator(playerId, Date.now(), exec);
  if (await evaluate.satisfied(conditionId)) return true;

  const parsed = marathonQuestClearConditionDifficulty(conditionId);
  if (parsed === null) return false;
  if (parsed.questId !== questId) return false;
  if (parsed.difficulty < 2) return false;
  const previous = state.quests?.[questId]?.diffs?.[String(parsed.difficulty - 1)];
  return previous?.cleared === true;
}

/** Structural view of a master `MarathonQuest` row used by the unlock rules. */
export interface MarathonQuestAccessRow {
  [key: string]: unknown;
  Id?: unknown;
  UnlockConditionId?: unknown;
  RequiredUnlockItemAmount?: unknown;
}

export interface MarathonQuestAccess {
  conditionMet: boolean;
  requiredAmount: number;
  unlocked: boolean;
  unlockable: boolean;
}

/**
 * Resolve both quest gates for `quest`:
 *
 * - `conditionMet`: the master unlock condition holds.
 * - `requiredAmount`: unlock items the quest costs (0 when it has no item gate).
 * - `unlocked`: the condition holds and the item gate is paid (or absent).
 * - `unlockable`: the condition holds, the item gate is unpaid, an unlock item
 *   is configured and the player owns enough of it.
 */
export async function marathonQuestAccess(
  playerId: string,
  quest: MarathonQuestAccessRow,
  config: Pick<MarathonConfig, 'questUnlockItemId'>,
  state: MarathonState,
  exec: Executor = db,
  evaluator?: ConditionEvaluator,
): Promise<MarathonQuestAccess> {
  const questId = String(quest.Id ?? '');
  const conditionMet = await marathonConditionMet(
    playerId,
    String(quest.UnlockConditionId ?? ''),
    exec,
    evaluator,
    state,
  );

  const rawRequired = Number(quest.RequiredUnlockItemAmount ?? 0);
  const requiredAmount = Number.isFinite(rawRequired) ? rawRequired : 0;
  const paid = requiredAmount <= 0 || state.unlockedQuests?.[questId] === true;
  const unlocked = conditionMet && paid;

  const unlockable =
    conditionMet &&
    !paid &&
    config.questUnlockItemId !== '' &&
    (await getItemAmount(playerId, config.questUnlockItemId, exec)) >= requiredAmount;

  return { conditionMet, requiredAmount, unlocked, unlockable };
}
