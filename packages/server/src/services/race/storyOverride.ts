// Per-run story read state for races.
//
// `Stories` is an account-wide collection, so once a player reads a race's
// event story the row stays `Read` (2) forever. On a re-run of the race the
// client then sees nothing to play. While a race is open, the rows for that
// race's event story episodes are therefore served as `Unread` (1) unless the
// player read them during this run (`RaceState.playedStoryIds`).
//
// Client evidence: `Solis.Common.Proto.StoryStatusType` is Unknown 0 / Unread 1
// / Read 2, and the captured `User:Get` seeds playable-but-unread episodes as
// existing rows with StatusType 1 (docs/ARCHIVE.md:513), not as absent rows.
// The override therefore rewrites the served StatusType only; the stored rows
// are never touched.
import { getEventStory } from '../../master/index.ts';
import { db } from '../../db/client.ts';
import type { Executor } from '../../db/tx.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { openRaces } from './catalog.ts';
import { loadRaceState, saveRaceState } from './state.ts';

const STORY_STATUS_UNREAD = 1;

interface EventStoryRow {
  Id?: unknown;
  Episodes?: unknown;
}

/** StoryIds of a master `EventStory` row's episodes. */
function episodeStoryIds(story: EventStoryRow | null): Set<string> {
  const ids = new Set<string>();
  const episodes = Array.isArray(story?.Episodes) ? (story.Episodes as Decoded[]) : [];
  for (const episode of episodes) {
    const storyId = episode?.StoryId == null ? '' : String(episode.StoryId);
    if (storyId !== '') ids.add(storyId);
  }
  return ids;
}

interface OpenRaceStory {
  episodeStoryIds: Set<string>;
  playedStoryIds: Set<string>;
}

/**
 * The event-story episodes of every race open at `now`, paired with the
 * episode StoryIds the player already read in that run.
 */
async function openRaceStories(
  playerId: string,
  now: number,
  exec: Executor,
): Promise<OpenRaceStory[]> {
  const out: OpenRaceStory[] = [];
  for (const { id, config } of openRaces(now)) {
    const eventStoryId = config.eventStoryId ?? '';
    if (eventStoryId === '') continue;
    const episodeIds = episodeStoryIds((await getEventStory(eventStoryId)) as EventStoryRow | null);
    if (episodeIds.size === 0) continue;
    const state = await loadRaceState(playerId, id, exec);
    out.push({ episodeStoryIds: episodeIds, playedStoryIds: new Set(state.playedStoryIds) });
  }
  return out;
}

/**
 * Serve rows of an open race's event story episode as `Unread` unless the
 * player read them during this run. Returns a new array with copied rows when
 * something changed; otherwise the input array is returned untouched. The
 * stored `Stories` rows are never modified.
 */
export async function applyRaceStoryOverride(
  playerId: string,
  rows: readonly Decoded[],
  now: number = Date.now(),
  exec: Executor = db,
): Promise<Decoded[]> {
  const races = await openRaceStories(playerId, now, exec);
  if (races.length === 0) return rows as Decoded[];

  let changed = false;
  const out = rows.map((row) => {
    const storyId = row.StoryId == null ? '' : String(row.StoryId);
    if (storyId === '') return row;
    for (const race of races) {
      if (!race.episodeStoryIds.has(storyId)) continue;
      if (race.playedStoryIds.has(storyId)) return row;
      changed = true;
      return { ...row, StatusType: STORY_STATUS_UNREAD } as Decoded;
    }
    return row;
  });
  return changed ? out : (rows as Decoded[]);
}

/**
 * Record that `storyId` was read during the current run of any open race whose
 * event story contains it. Called from the story-read transaction: it writes
 * only `RaceState.playedStoryIds`, never the real `Stories` row.
 */
export async function recordRaceStoryPlayed(
  playerId: string,
  storyId: string,
  now: number = Date.now(),
  exec: Executor = db,
): Promise<boolean> {
  if (storyId === '') return false;
  let recorded = false;
  for (const { id, config } of openRaces(now)) {
    const eventStoryId = config.eventStoryId ?? '';
    if (eventStoryId === '') continue;
    const episodeIds = episodeStoryIds((await getEventStory(eventStoryId)) as EventStoryRow | null);
    if (!episodeIds.has(storyId)) continue;
    const state = await loadRaceState(playerId, id, exec);
    if (!state.playedStoryIds.includes(storyId)) {
      state.playedStoryIds = [...state.playedStoryIds, storyId];
      await saveRaceState(playerId, id, state, exec);
    }
    recorded = true;
  }
  return recorded;
}
