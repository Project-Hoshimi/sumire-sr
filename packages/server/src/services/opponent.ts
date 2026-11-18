/**
 * Shared helpers for battle (versus) quest opponent previews.
 *
 * A versus stage is a difficulty row with no `ClearScore`. Its opponent comes
 * from `live/data/npcRosters.ts`, keyed by the quest id for normal quests, or by
 * a marathon catalog override (`MarathonConfig.npcRosters`).
 */
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { NPCRoster } from '../live/preparation.ts';

const QUEST_OPPONENT_INFO_MSG = 'Solis.Common.Proto.Api.QuestOpponentInfo';

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The roster key for a quest id; an explicit override (marathon catalog) wins. */
export function npcRosterQuestId(questId: string, override?: string): string {
  return override ?? questId;
}

/**
 * A fresh `NPCRoster`, or undefined when the roster is missing or invalid.
 * Callers that must not fail on an unknown opponent use this best-effort form.
 */
export function opponentInfoForRoster(rosterId: string): Decoded | undefined {
  try {
    return NPCRoster(rosterId) as unknown as Decoded;
  } catch {
    return undefined;
  }
}

/** Empty `QuestOpponentInfo`, what non-versus difficulties keep sending. */
export function emptyOpponentInfo(): Decoded {
  return { __msg: QUEST_OPPONENT_INFO_MSG } as Decoded;
}

/**
 * Deep copy of a `QuestOpponentInfo` with `ManagerLevel` and every roster card's
 * `Level` set to `level`. Card ids, rarities, positions, fan amounts, evolution
 * levels, and the name are preserved. A missing, non-positive, or non-finite
 * level returns an untouched copy.
 */
export function scaleOpponentToLevel(opponent: Decoded, level: unknown): Decoded {
  const copy = structuredClone(opponent) as Decoded;
  if (typeof level !== 'number' || !Number.isFinite(level) || level <= 0) return copy;
  copy.ManagerLevel = level;
  const cards = Array.isArray(copy.CardInfos) ? (copy.CardInfos as Decoded[]) : [];
  for (const card of cards) card.Level = level;
  return copy;
}

/**
 * Opponent preview for one marathon difficulty. Only versus stages (`ClearScore`
 * 0) whose quest maps to a configured roster carry one. The roster's authored
 * levels are scaled to `npcLevel`, or the difficulty's `DifficultyLevel` when
 * no level rule applies.
 */
export function marathonOpponentInfo(
  questId: string,
  difficulty: Decoded,
  npcRosters: Record<string, string> | undefined,
  npcLevel?: number,
): Decoded {
  if (n(difficulty.ClearScore) !== 0) return emptyOpponentInfo();
  const rosterId = npcRosters?.[questId];
  if (rosterId === undefined) return emptyOpponentInfo();
  const roster = opponentInfoForRoster(rosterId);
  if (roster === undefined) return emptyOpponentInfo();
  return scaleOpponentToLevel(roster, npcLevel ?? n(difficulty.DifficultyLevel));
}
