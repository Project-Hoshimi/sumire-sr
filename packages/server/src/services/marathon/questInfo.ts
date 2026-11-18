/**
 * Builds the `MarathonQuestInfo` a `Marathon:Top` / `Marathon:UnlockQuest`
 * response carries for one master marathon quest.
 */
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import type { Executor } from '../../db/tx.ts';
import { db } from '../../db/client.ts';
import { listMarathonQuestDifficulties } from '../../master/index.ts';
import type { ConditionEvaluator } from '../conditions.ts';
import { marathonOpponentInfo } from '../opponent.ts';
import type { MarathonConfig } from './catalog.ts';
import { npcLevelFor } from './plugin.ts';
import { n } from './numeric.ts';
import type { MarathonState } from './state.ts';
import { marathonDifficultyConditionMet, marathonQuestAccess, type MarathonQuestAccessRow } from './unlock.ts';

const MARATHON_QUEST_INFO_MSG = 'Solis.Common.Proto.Api.MarathonQuestInfo';
const MARATHON_QUEST_DIFFICULTY_INFO_MSG = 'Solis.Common.Proto.Api.MarathonQuestDifficultyLevelInfo';

/**
 * The quest-level `Unlocked` / `IsPlayable` / `IsUnlockable` flags come from
 * `marathonQuestAccess`; difficulty-level unlocks keep evaluating their own
 * master conditions.
 */
export async function buildMarathonQuestInfo(
  playerId: string,
  config: Pick<MarathonConfig, 'questUnlockItemId' | 'npcRosters' | 'npcLevelRules'>,
  quest: MarathonQuestAccessRow,
  state: MarathonState,
  exec: Executor = db,
  evaluator?: ConditionEvaluator,
): Promise<Decoded> {
  const questId = String(quest.Id ?? '');
  const access = await marathonQuestAccess(playerId, quest, config, state, exec, evaluator);
  const difficulties = await listMarathonQuestDifficulties(questId);
  const difficultyNumbers = difficulties.map((difficulty) => Number(difficulty.DifficultyNumber ?? 0));
  const difficultyUnlocked = new Map<number, boolean>();
  for (const difficulty of difficulties) {
    difficultyUnlocked.set(
      Number(difficulty.DifficultyNumber ?? 0),
      await marathonDifficultyConditionMet(
        playerId,
        questId,
        String(difficulty.UnlockConditionId ?? ''),
        state,
        exec,
        evaluator,
      ),
    );
  }
  const questState = state.quests[questId];
  const lastChallengeFields =
    questState !== undefined
      ? { LastChallengeDifficultyNumber: questState.last }
      : difficultyNumbers.length > 0
        ? { LastChallengeDifficultyNumber: Math.min(...difficultyNumbers) }
        : {};
  return {
    __msg: MARATHON_QUEST_INFO_MSG,
    MarathonQuestId: questId,
    Unlocked: access.unlocked,
    IsPlayable: access.unlocked,
    IsUnlockable: access.unlockable,
    ...lastChallengeFields,
    DifficultyLevelInfos: difficulties.map((difficulty) => {
      const number = Number(difficulty.DifficultyNumber ?? 0);
      const diffState = questState?.diffs[String(number)];
      const npcLevel = npcLevelFor(config, questId, n(difficulty.DifficultyLevel));
      return {
        __msg: MARATHON_QUEST_DIFFICULTY_INFO_MSG,
        MarathonQuestDifficultyNumber: number,
        Cleared: diffState?.cleared === true,
        RankType: diffState?.rankType ?? 0,
        Plus: diffState?.plus ?? 0,
        Unlocked: difficultyUnlocked.get(number) ?? false,
        HighestScore: diffState?.highestScore ?? 0,
        OpponentInfo: marathonOpponentInfo(
          questId,
          difficulty as unknown as Decoded,
          config.npcRosters,
          npcLevel,
        ),
      } as Decoded;
    }),
  } as Decoded;
}
