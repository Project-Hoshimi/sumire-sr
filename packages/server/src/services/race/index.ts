// Race event module entry point. Importing this file registers the `race` event
// builder plugin and every `Race:*` RPC handler.
import './plugin.ts';
import './top.ts';
import './deck.ts';
import './board.ts';
import './quest.ts';
import './lesson.ts';
import './liveBonus.ts';
import './coolTime.ts';
import './ranking.ts';

export { applyActiveRaceToHomeEnter, homeRaceInfo } from './home.ts';
export { openRaces, raceConfigFor, raceWindowFor } from './catalog.ts';
export type { OpenRace, RaceWindow } from './catalog.ts';
export { RACE_RANKING_DISPLAY_NUM, raceRanking, racePlayerRank } from './ranking.ts';
export { clearedTierCount, clientClearLevel, currentTier, nearestTier, tierNumbers, tierUnlocked } from './tiers.ts';
export type { RaceConfig, RaceDraft, RaceRankGrade } from './types.ts';
