import { getCard as getMasterCard, listCardLevelReleases } from '../master/index.ts';
import { collectionElementMsg, listElements, putElements } from './playerState.ts';
import type { Executor } from '../db/tx.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Card-story unlock by card level (PLANS §1.7).
 *
 * A card's episodes are listed in order in `Card.Stories`; which episodes are
 * visible at a given level comes from `CardLevelRelease`: every row with
 * `Level <= cardLevel` whose `Targets[]` has `Type === 4` (Story) unlocks
 * `Card.Stories[Number - 1].StoryId`. The Lv1 row carries the Type-4/Number-1
 * target, so episode #1 is always unlocked for an owned card.
 */

const STORIES = 'Stories';
const CARD_LEVEL_RELEASE_TYPE_STORY = 4;
const STORY_STATUS_UNREAD = 1;
const STORY_STATUS_READ = 2;

function userStoryMsg(): string {
  return collectionElementMsg(STORIES) ?? 'Solis.Common.Proto.Transaction.UserStory';
}

/** StoryIds a card has unlocked at the given level from prefetched release rows. */
export function cardStoryIdsFromRelease(
  card: Decoded,
  level: number,
  releases: readonly { Level?: unknown; Targets?: unknown }[],
): string[] {
  const stories = ((card.Stories as Decoded[] | null) ?? []).filter(
    (s) => s && s.StoryId != null,
  );
  const ids = new Set<string>();
  for (const row of releases) {
    if (Number(row.Level) > level) continue;
    const targets = ((row.Targets as Decoded[] | null) ?? []);
    for (const t of targets) {
      if (Number(t.Type) !== CARD_LEVEL_RELEASE_TYPE_STORY) continue;
      const story = stories[Number(t.Number) - 1];
      if (story) ids.add(String(story.StoryId));
    }
  }
  return [...ids];
}

/** StoryIds a card has unlocked at the given level (master-derived). */
export async function cardStoryIdsForLevel(cardId: string, level: number): Promise<string[]> {
  const card = await getMasterCard(cardId);
  if (!card) return [];
  const releaseId = String(card.CardLevelReleaseId ?? '');
  if (!releaseId) return [];
  return cardStoryIdsFromRelease(card, level, await listCardLevelReleases(releaseId));
}

/**
 * Upsert `UserStory{StoryId, StatusType: 1}` for the unlocked episodes into the
 * player's `Stories` collection. Never downgrades an existing `StatusType: 2`
 * (Read) entry. Returns the elements newly written (for an UpdatedData slice).
 */
export async function unlockCardStories(
  playerId: string,
  cardId: string,
  level: number,
  exec: Executor,
): Promise<Decoded[]> {
  const ids = await cardStoryIdsForLevel(cardId, level);
  if (ids.length === 0) return [];
  const existing = await listElements(playerId, STORIES, exec);
  const read = new Set(
    existing
      .filter((s) => Number(s.StatusType ?? 0) === STORY_STATUS_READ)
      .map((s) => String(s.StoryId ?? '')),
  );
  const writes = ids
    .filter((id) => !read.has(id))
    .map(
      (StoryId) =>
        ({ __msg: userStoryMsg(), StoryId, StatusType: STORY_STATUS_UNREAD }) as Decoded,
    );
  if (writes.length > 0) await putElements(playerId, STORIES, writes, exec);
  return writes;
}
