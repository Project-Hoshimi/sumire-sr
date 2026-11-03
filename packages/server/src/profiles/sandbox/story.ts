/**
 * Sandbox-only story list overrides.
 *
 * The official `Story:ListExtra` / `Story:ListEvent` handlers return an empty
 * `Infos` list (the flows are not implemented yet), so the client shows every
 * extra/event story as locked. In sandbox mode every master story must be
 * visible and unlocked, so these builders project the whole master catalogue
 * into the response messages with `Unlocked = true`.
 *
 * Logic is ported from Solis (`internal/makino/user/god.go` and
 * `internal/makino/user/extrastory/extra_story_part_info.go`, AGPL).
 *
 * The builders take master rows instead of querying so they can be exercised
 * directly by the sandbox DB test.
 */
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

const EXTRA_STORY_PART_INFO_MSG = 'Solis.Common.Proto.Api.ExtraStoryPartInfo';
const EXTRA_STORY_INFO_MSG = 'Solis.Common.Proto.Api.ExtraStoryInfo';
const EXTRA_STORY_EPISODE_INFO_MSG = 'Solis.Common.Proto.Api.ExtraStoryEpisodeInfo';
const EVENT_STORY_INFO_MSG = 'Solis.Common.Proto.Api.EventStoryInfo';
const EVENT_STORY_EPISODE_INFO_MSG = 'Solis.Common.Proto.Api.EventStoryEpisodeInfo';

export type MasterStoryRow = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function rowId(row: MasterStoryRow): string {
  return row.Id == null ? '' : String(row.Id);
}

/** Sort master rows by `Order` then `Id` (the order the client expects). */
function byOrderThenId(a: MasterStoryRow, b: MasterStoryRow): number {
  const order = Number(a.Order ?? 0) - Number(b.Order ?? 0);
  if (order !== 0) return order;
  return rowId(a).localeCompare(rowId(b));
}

function extraStoryEpisodes(row: MasterStoryRow): Decoded[] {
  return asArray(row.Episodes)
    .map(
      (episode) =>
        ({
          __msg: EXTRA_STORY_EPISODE_INFO_MSG,
          Episode: Number((episode as MasterStoryRow).Episode ?? 0),
          Unlocked: true,
        }) as Decoded,
    )
    .sort((a, b) => Number(a.Episode ?? 0) - Number(b.Episode ?? 0));
}

function extraStoryInfo(row: MasterStoryRow): Decoded {
  return {
    __msg: EXTRA_STORY_INFO_MSG,
    Id: rowId(row),
    Unlocked: true,
    Episodes: extraStoryEpisodes(row),
  } as Decoded;
}

/**
 * Build `StoryListExtraResponse.Infos` for the sandbox: every extra story part
 * (sorted by Order then Id), its extra stories (from `ExtraStoryIds`, falling
 * back to the rows whose `ExtraStoryPartId` matches), each unlocked with every
 * master episode unlocked.
 */
export function sandboxExtraStoryPartInfos(
  partRows: readonly MasterStoryRow[],
  storyRows: readonly MasterStoryRow[],
): Decoded[] {
  const storyById = new Map<string, MasterStoryRow>();
  for (const row of storyRows) {
    const id = rowId(row);
    if (id) storyById.set(id, row);
  }

  const storiesByPart = new Map<string, MasterStoryRow[]>();
  for (const row of storyRows) {
    const partId = row.ExtraStoryPartId == null ? '' : String(row.ExtraStoryPartId);
    if (!partId) continue;
    const list = storiesByPart.get(partId) ?? [];
    list.push(row);
    storiesByPart.set(partId, list);
  }

  return [...partRows].sort(byOrderThenId).map((part) => {
    const partId = rowId(part);
    const storyIds = asArray(part.ExtraStoryIds)
      .map((id) => (id == null ? '' : String(id)))
      .filter(Boolean);
    const selected = storyIds.length
      ? storyIds
          .map((id) => storyById.get(id))
          .filter((row): row is MasterStoryRow => row !== undefined)
      : (storiesByPart.get(partId) ?? []);

    return {
      __msg: EXTRA_STORY_PART_INFO_MSG,
      Id: partId,
      Unlocked: true,
      Stories: [...selected].sort(byOrderThenId).map(extraStoryInfo),
    } as Decoded;
  });
}

/**
 * Build `StoryListEventResponse.Infos` for the sandbox: every event story
 * (sorted by Order then Id) with every master episode unlocked.
 */
export function sandboxEventStoryInfos(eventRows: readonly MasterStoryRow[]): Decoded[] {
  return [...eventRows].sort(byOrderThenId).map(
    (row) =>
      ({
        __msg: EVENT_STORY_INFO_MSG,
        Id: rowId(row),
        Episodes: asArray(row.Episodes)
          .map(
            (episode) =>
              ({
                __msg: EVENT_STORY_EPISODE_INFO_MSG,
                Episode: Number((episode as MasterStoryRow).Episode ?? 0),
                Unlocked: true,
              }) as Decoded,
          )
          .sort((a, b) => Number(a.Episode ?? 0) - Number(b.Episode ?? 0)),
      }) as Decoded,
  );
}
