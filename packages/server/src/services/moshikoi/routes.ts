/**
 * Pure route engine for もし恋 (MoshiKoi).
 *
 * Ported from solis-server `internal/makino/moshikoi/routes.go` (AGPL-3.0).
 * Every function takes plain data — a loaded `Routes` object plus episode IDs,
 * saved selections, hint level, or unlocked ending IDs — so the engine has no
 * database or RPC dependencies. Choice and branch info results use the same
 * `__msg` convention as `services/love.ts`.
 */
import {
  MoshikoiError,
  type EpisodeRoute,
  type RouteCondition,
  type Routes,
} from './catalog.ts';

const MAX_INT = Number.MAX_SAFE_INTEGER;

const LOVE_STORY_CHOICE_GROUP_INFO_MSG = 'Solis.Common.Proto.Api.LoveStoryChoiceGroupInfo';
const LOVE_STORY_CHOICE_INFO_MSG = 'Solis.Common.Proto.Api.LoveStoryChoiceInfo';
const LOVE_ADV_BRANCH_INFO_MSG = 'Solis.Common.Proto.Api.LoveAdvBranchInfo';

/** One saved route choice (solis `umodel.LoveStorySelection`). */
export interface LoveStorySelection {
  storyEpisodeId: string;
  /** 1-based group index from the route data. */
  groupIndex: number;
  /** 1-based choice index from the route data. */
  index: number;
}

/** One entry of the client's `LoveSelectStoryChoiceInfo` list. */
export interface StoryChoiceSelection {
  groupIndex: number;
  index: number;
  /**
   * False entries echo previously seen alternatives; they are history and
   * cannot unlock a branch or count as a current route choice.
   */
  isValid: boolean;
}

/** `Solis.Common.Proto.Api.LoveStoryChoiceInfo` with the `__msg` marker. */
export interface StoryChoiceInfo {
  __msg: string;
  Index: number;
  IsBestObtainableFavorability: boolean;
  IsPastSelected: boolean;
}

/** `Solis.Common.Proto.Api.LoveStoryChoiceGroupInfo` with the `__msg` marker. */
export interface StoryChoiceGroupInfo {
  __msg: string;
  GroupIndex: number;
  StoryChoiceInfos: StoryChoiceInfo[];
  ExistsObtainableFavorabilityDifference: boolean;
}

/** `Solis.Common.Proto.Api.LoveAdvBranchInfo` with the `__msg` marker. */
export interface AdvBranchInfo {
  __msg: string;
  GroupIndex: number;
  Index: number;
}

function episodeOf(routes: Routes, episodeId: string): EpisodeRoute {
  const episode = routes.episodes[episodeId];
  if (episode === undefined) {
    throw new MoshikoiError('unknown-love-story-episode', 'unknown love story episode');
  }
  return episode;
}

/**
 * True when every condition matched a saved selection. An empty condition list
 * matches; an empty `episode` refers to the episode currently being resolved.
 */
export function routeConditionsMatch(
  currentEpisode: string,
  conditions: readonly RouteCondition[],
  selections: readonly LoveStorySelection[],
): boolean {
  for (const condition of conditions) {
    const episode = condition.episode === '' ? currentEpisode : condition.episode;
    if (
      !selections.some(
        (selection) =>
          selection.storyEpisodeId === episode &&
          selection.groupIndex === condition.group &&
          selection.index === condition.choice,
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Accept the current valid alternative in each reachable group.
 *
 * The client also echoes previously seen alternatives with `isValid=false`;
 * those are history, not current route choices, and cannot unlock a branch.
 */
export function selectChoices(
  routes: Routes,
  episodeId: string,
  choices: ReadonlyArray<StoryChoiceSelection | null | undefined>,
): LoveStorySelection[] {
  const episode = episodeOf(routes, episodeId);
  const selected: LoveStorySelection[] = [];

  for (const choice of choices) {
    if (choice === null || choice === undefined) {
      throw new MoshikoiError('missing-story-choice', 'missing story choice');
    }
    const group = episode.groups.find((candidate) => candidate.index === choice.groupIndex);
    if (group === undefined || choice.index < 1 || choice.index > group.count) {
      throw new MoshikoiError('invalid-story-choice', 'invalid story choice');
    }
    if (!choice.isValid) continue;
    if (selected.some((selection) => selection.groupIndex === choice.groupIndex)) {
      throw new MoshikoiError(
        'multiple-active-choices-for-one-group',
        'multiple active choices for one group',
      );
    }
    selected.push({
      storyEpisodeId: episodeId,
      groupIndex: choice.groupIndex,
      index: choice.index,
    });
  }

  for (const group of episode.groups) {
    const reachable = routeConditionsMatch(episodeId, group.requires, selected);
    const present = selected.some((selection) => selection.groupIndex === group.index);
    if (reachable !== present) {
      throw new MoshikoiError(
        'missing-or-unreachable-story-choice',
        'missing or unreachable story choice',
      );
    }
  }

  return selected;
}

/**
 * Sum the route threshold points of `selections`. Points live in the route data
 * and are independent of persistent favorability. Unknown episodes and choices
 * without a point entry contribute nothing; negative or overflowing totals are
 * rejected.
 */
export function routePoints(routes: Routes, selections: readonly LoveStorySelection[]): number {
  let total = 0;
  for (const selection of selections) {
    const episode = routes.episodes[selection.storyEpisodeId];
    if (episode === undefined) continue;
    for (const group of episode.groups) {
      if (
        group.index === selection.groupIndex &&
        selection.index > 0 &&
        selection.index <= group.points.length
      ) {
        const points = group.points[selection.index - 1]!;
        if (points < 0 || total > MAX_INT - points) {
          throw new MoshikoiError(
            'invalid-or-overflowing-route-points',
            'invalid or overflowing love route points',
          );
        }
        total += points;
      }
    }
  }
  return total;
}

/**
 * Resolve the next episode and/or ending for `selections`.
 *
 * Outcomes are checked in file order against their point interval and
 * conditions; the first match wins. With no matching outcome, a non-empty
 * `next` fallback is used, otherwise the route is invalid.
 */
export function resolve(
  routes: Routes,
  episodeId: string,
  selections: readonly LoveStorySelection[],
): { nextEpisodeId: string; endingId: string } {
  const episode = episodeOf(routes, episodeId);
  const points = routePoints(routes, selections);

  for (const outcome of episode.outcomes) {
    if (outcome.minPoints !== undefined && points < outcome.minPoints) continue;
    if (outcome.maxPoints !== undefined && points > outcome.maxPoints) continue;
    if (routeConditionsMatch(episodeId, outcome.all, selections)) {
      return { nextEpisodeId: outcome.next, endingId: outcome.ending };
    }
  }

  if (episode.next === '') {
    throw new MoshikoiError('love-route-has-no-matching-outcome', 'love route has no matching outcome');
  }
  return { nextEpisodeId: episode.next, endingId: '' };
}

/**
 * Persistent favorability awarded by `selections`. Unknown episodes and choices
 * without a score entry contribute nothing (solis `Favorability`).
 */
export function favorability(routes: Routes, selections: readonly LoveStorySelection[]): number {
  let total = 0;
  for (const selection of selections) {
    const episode = routes.episodes[selection.storyEpisodeId];
    if (episode === undefined) continue;
    for (const group of episode.groups) {
      if (
        group.index === selection.groupIndex &&
        selection.index > 0 &&
        selection.index <= group.scores.length
      ) {
        total += group.scores[selection.index - 1]!;
      }
    }
  }
  return total;
}

/**
 * Choice-group display data for an episode. Hint levels follow solis:
 * >=1 reveals that a group has a better alternative, >=2 marks the best one.
 */
export function choiceInfos(
  routes: Routes,
  episodeId: string,
  past: readonly LoveStorySelection[],
  hintLevel: number,
): StoryChoiceGroupInfo[] {
  const episode = episodeOf(routes, episodeId);
  const infos: StoryChoiceGroupInfo[] = [];

  for (const group of episode.groups) {
    const info: StoryChoiceGroupInfo = {
      __msg: LOVE_STORY_CHOICE_GROUP_INFO_MSG,
      GroupIndex: group.index,
      StoryChoiceInfos: [],
      ExistsObtainableFavorabilityDifference: hintLevel >= 1 && group.best > 0,
    };
    for (let index = 1; index <= group.count; index++) {
      info.StoryChoiceInfos.push({
        __msg: LOVE_STORY_CHOICE_INFO_MSG,
        Index: index,
        IsBestObtainableFavorability: hintLevel >= 2 && group.best === index,
        IsPastSelected: past.some(
          (selection) =>
            selection.storyEpisodeId === episodeId &&
            selection.groupIndex === group.index &&
            selection.index === index,
        ),
      });
    }
    infos.push(info);
  }

  return infos;
}

/**
 * Story branch indices for an episode: `match` when all conditions hold,
 * otherwise `otherwise`.
 */
export function branchInfos(
  routes: Routes,
  episodeId: string,
  selections: readonly LoveStorySelection[],
): AdvBranchInfo[] {
  const episode = episodeOf(routes, episodeId);
  return episode.branches.map((branch) => ({
    __msg: LOVE_ADV_BRANCH_INFO_MSG,
    GroupIndex: branch.group,
    Index: routeConditionsMatch(episodeId, branch.all, selections)
      ? branch.match
      : branch.otherwise,
  }));
}

/** True when every ending in the route data appears in `unlockedEndingIds`. */
export function allEndingsUnlocked(routes: Routes, unlockedEndingIds: readonly string[]): boolean {
  for (const ending of routes.endings) {
    if (!unlockedEndingIds.includes(ending.id)) return false;
  }
  return routes.endings.length !== 0;
}
