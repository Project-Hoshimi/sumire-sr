/**
 * Sandbox Photo Album ("Shelf") event.
 *
 * There is no Shelf master table: the official event shipped as fixed rows in
 * the client. The capture of event-shelf-26-1002 (2026-10-09) carries the whole
 * surface — every album, their episodes (backed by `Story` master rows), the
 * album templates and the event missions — so these builders serve it
 * statically for every profile. Per-player photos/templates live outside this
 * file; see `Shelf:*` in `services/photo.ts`.
 */
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { SANDBOX_SHELF_ALL_ALBUMS } from './shelfAlbums.ts';

export const SANDBOX_SHELF_ID = 'shelf-26-1002';
export const SANDBOX_SHELF_ASSET_ID = 'event-shelf-26-1002';
export const SANDBOX_SHELF_START = 1790910000000;
/** 0 = no end. The official servers mark permanent events this way; the client then shows no remaining time. */
export const SANDBOX_SHELF_END_TIME = 0;
export const SANDBOX_SHELF_PHOTO_CREATING_ITEM_ID = 'item-photo_contest_create-26-1002';
export const SANDBOX_SHELF_PLAY_CONDITION_ID = 'cd-shelf-26-1002-play';
export const SANDBOX_SHELF_STORY_CONDITION_ID = 'cd-shelf-26-1002-story';

export const SANDBOX_SHELF_NAME = 'フォトアルバム';
export const SANDBOX_SHELF_BANNER_ASSET_ID = 'img_banner_l_event-shelf-26-1002';
export const SANDBOX_SHELF_DEFAULT_TEMPLATE_ID = 'shelf-tempate-shelf-24-0103-001';
/** The help text caps the album at 100 saved photos across all albums. */
export const SANDBOX_SHELF_PHOTO_LIMIT = 100;

const SHELF_ALBUM_INFO_MSG = 'Solis.Common.Proto.Api.ShelfAlbumInfo';
const SHELF_TEMPLATE_INFO_MSG = 'Solis.Common.Proto.Api.ShelfTemplateInfo';
const SHELF_ALBUM_SLOT_INFO_MSG = 'Solis.Common.Proto.Api.ShelfAlbumSlotInfo';
const SHELF_ALBUM_EPISODE_INFO_MSG = 'Solis.Common.Proto.Api.ShelfAlbumEpisodeInfo';
const EVENT_MISSION_INFO_MSG = 'Solis.Common.Proto.Api.EventMissionInfo';
const USER_MISSION_MSG = 'Solis.Common.Proto.Transaction.UserMission';

export type SandboxShelfAlbum = {
  AlbumId: string;
  AssetId: string;
  Name: string;
  BgmAssetId: string;
  EpisodeCount: number;
  /** Explicit episode Story ids, for albums with no st-shelf-* story rows. */
  StoryIds?: readonly string[];
  /** The album frame of the album's own event, when that event had one. */
  TemplateId?: string;
};

/** Every album from master; see `shelfAlbums.ts`. */
export const SANDBOX_SHELF_ALBUMS: readonly SandboxShelfAlbum[] = SANDBOX_SHELF_ALL_ALBUMS;

export type SandboxShelfTemplate = {
  TemplateId: string;
  TemplateType: number;
  BackgroundAssetId: string;
  SlotNumbers: readonly number[];
};

/**
 * Every other event's album frame (`img_shelf_template_<id>` in the asset
 * list). The client only lays out slots for TemplateType 1 (six slots) and 2
 * (four slots); event frames are type 1 like the captured 24-0103 frame.
 */
const SANDBOX_SHELF_EVENT_FRAMES: readonly string[] = [
  'shelf-23-1027-001',
  'shelf-23-1128-001',
  'shelf-24-0128-001',
  'shelf-24-0128-002',
  'shelf-24-0226-001',
  'shelf-24-0401-001',
  'shelf-24-0401-002',
  'shelf-24-0404-001',
  'shelf-24-0426-001',
  'shelf-24-0626-001',
  'shelf-24-0708-001',
  'shelf-24-0727-001',
  'shelf-24-0827-001',
  'shelf-24-0925-001',
  'shelf-24-1028-001',
  'shelf-24-1128-001',
  'shelf-25-0104-001',
  'shelf-25-0128-001',
  'shelf-25-0225-001',
  'shelf-25-0326-001',
  'shelf-25-0401-001',
  'shelf-25-0401-002',
  'shelf-25-0625-001',
  'shelf-25-0728-001',
  'shelf-25-0825-001',
  'shelf-25-0927-001',
  'shelf-25-1028-001',
  'shelf-25-1126-001',
  'shelf-26-0104-001',
  'shelf-26-0128-001',
  'shelf-26-0226-001',
  'shelf-26-0327-001',
  'shelf-26-0427-001',
  'shelf-26-0625-001',
  'shelf-26-0708-001',
  'shelf-26-1030-001',
];

const eventFrameTemplate = (frame: string): SandboxShelfTemplate => ({
  TemplateId: `shelf-tempate-${frame}`,
  TemplateType: 1,
  BackgroundAssetId: frame,
  SlotNumbers: [1, 2, 3, 4, 5, 6],
});

const defaultFrameTemplate = (frame: string): SandboxShelfTemplate => ({
  TemplateId: `shelf-tempate-${frame}`,
  TemplateType: 2,
  BackgroundAssetId: frame,
  SlotNumbers: [1, 2, 3, 4],
});

/**
 * The two templates from the official Shelf:AlbumTop capture first (the
 * 24-0103 event frame and default-001), then every other event frame by date
 * and the second default frame.
 */
export const SANDBOX_SHELF_TEMPLATES: readonly SandboxShelfTemplate[] = [
  eventFrameTemplate('shelf-24-0103-001'),
  defaultFrameTemplate('default-001'),
  ...SANDBOX_SHELF_EVENT_FRAMES.map(eventFrameTemplate),
  defaultFrameTemplate('default-002'),
];

export type SandboxShelfStoryRow = {
  Id?: string | null;
  AdvAssetIds?: unknown;
};

/** The event's missions (album complete / creating / photo creating / save). */
const SANDBOX_SHELF_MISSIONS: ReadonlyArray<{ MissionId: string; CurrentThreshold: number }> = [
  { MissionId: 'event-shelf-26-1002-photo-album-complete-1', CurrentThreshold: 1 },
  { MissionId: 'event-shelf-26-1002-photo-album-creating-1', CurrentThreshold: 1 },
  { MissionId: 'event-shelf-26-1002-photo-creating-1', CurrentThreshold: 1 },
  { MissionId: 'event-shelf-26-1002-photo-save-1', CurrentThreshold: 5 },
];

export function sandboxShelfAlbum(albumId: string): SandboxShelfAlbum | undefined {
  return SANDBOX_SHELF_ALBUMS.find((album) => album.AlbumId === albumId);
}

/** The frame an album page starts on: its own event's frame, else the default. */
export function sandboxShelfAlbumTemplateId(albumId: string): string {
  return sandboxShelfAlbum(albumId)?.TemplateId ?? SANDBOX_SHELF_DEFAULT_TEMPLATE_ID;
}

/** Structural view of a player's persisted per-album shelf state. */
export type SandboxShelfAlbumState = {
  photos: Array<{ AssetId: string; MainCharacterId: string }>;
  templateId: string;
  slots: Record<string, Record<string, string>>;
};

/**
 * The character most present among the photos placed in an album page's slots.
 * Ties go to the character whose first appearance is in the lowest slot; ''
 * when no placed slot resolves to a non-empty character.
 */
export function shelfPageSubject(state: SandboxShelfAlbumState): string {
  const slots = state.slots[state.templateId] ?? {};
  const ordered = Object.entries(slots).sort(([a], [b]) => Number(a) - Number(b));
  // Map insertion order is first-appearance order, so a strict `>` keeps ties
  // with the character seen in the lowest slot.
  const counts = new Map<string, number>();
  for (const [, assetId] of ordered) {
    const photo = state.photos.find((p) => p.AssetId === assetId);
    const characterId = photo?.MainCharacterId ?? '';
    if (!characterId) continue;
    counts.set(characterId, (counts.get(characterId) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [characterId, count] of counts) {
    if (count > bestCount) {
      best = characterId;
      bestCount = count;
    }
  }
  return best;
}

/** Story id prefix for an album (`st-<YY-MMDD>-<NNN>`). */
export function sandboxShelfStoryPrefix(albumId: string): string {
  const album = sandboxShelfAlbum(albumId);
  if (!album) throw new Error(`unknown shelf album ${albumId}`);
  if (!album.AlbumId.startsWith('shelf-album_shelf-')) {
    throw new Error(`shelf album ${albumId} has no story prefix`);
  }
  return `st-${album.AlbumId.slice('shelf-album_'.length)}`;
}

export function sandboxShelfAlbumInfos(): Decoded[] {
  return SANDBOX_SHELF_ALBUMS.map(
    (album) =>
      ({
        __msg: SHELF_ALBUM_INFO_MSG,
        AlbumId: album.AlbumId,
        AssetId: album.AssetId,
        UnlockConditionId: SANDBOX_SHELF_STORY_CONDITION_ID,
        IsUnlocked: true,
        IsNew: false,
        Name: album.Name,
        BgmAssetId: album.BgmAssetId,
      }) as Decoded,
  );
}

/** The event mission block carried by Shelf:Top (the notice is not sent). */
export function sandboxShelfMissionInfo(now: number = Date.now()): Decoded {
  return {
    __msg: EVENT_MISSION_INFO_MSG,
    Id: SANDBOX_SHELF_ASSET_ID,
    Unlocked: true,
    UserMissions: SANDBOX_SHELF_MISSIONS.map(
      (mission) =>
        ({
          __msg: USER_MISSION_MSG,
          MissionId: mission.MissionId,
          CurrentThreshold: mission.CurrentThreshold,
          StatusType: 1,
          LastUpdateTime: now,
        }) as Decoded,
    ),
  } as Decoded;
}

/**
 * Album templates. `slots` is the per-template `{ [slotNumber]: assetId }` map
 * from the player's saved album state; empty slots omit `AssetId`. `positions`
 * is the matching `{ [slotNumber]: PositionX }` crop offset for filled slots.
 */
export function sandboxShelfTemplateInfos(
  slots: Record<string, Record<string, string>> = {},
  positions: Record<string, Record<string, number>> = {},
): Decoded[] {
  return SANDBOX_SHELF_TEMPLATES.map((template) => {
    const filled = slots[template.TemplateId] ?? {};
    const offsets = positions[template.TemplateId] ?? {};
    return {
      __msg: SHELF_TEMPLATE_INFO_MSG,
      TemplateId: template.TemplateId,
      SlotInfos: template.SlotNumbers.map((slotNumber) => {
        const info: Decoded = {
          __msg: SHELF_ALBUM_SLOT_INFO_MSG,
          SlotNumber: slotNumber,
        } as Decoded;
        const assetId = filled[String(slotNumber)];
        if (assetId) {
          info.AssetId = assetId;
          const positionX = offsets[String(slotNumber)];
          if (positionX) info.PositionX = positionX;
        }
        return info;
      }),
      TemplateType: template.TemplateType,
      BackgroundAssetId: template.BackgroundAssetId,
    } as Decoded;
  });
}

/**
 * Episodes 1..EpisodeCount for an album, resolved from the event's `Story`
 * master rows (`AdvAssetIds[0]` is the adventure asset the client plays).
 */
export function sandboxShelfEpisodeInfos(
  albumId: string,
  stories: readonly SandboxShelfStoryRow[],
): Decoded[] {
  const album = sandboxShelfAlbum(albumId);
  if (!album) throw new Error(`unknown shelf album ${albumId}`);
  const storyIds: readonly string[] =
    album.StoryIds ??
    Array.from(
      { length: album.EpisodeCount },
      (_, index) => `${sandboxShelfStoryPrefix(albumId)}-${String(index + 1).padStart(3, '0')}`,
    );
  return storyIds.map((storyId, index) => {
    const episode = index + 1;
    const row = stories.find((story) => String(story.Id ?? '') === storyId);
    if (!row) throw new Error(`shelf story not found ${storyId}`);
    const assetIds = Array.isArray(row.AdvAssetIds) ? row.AdvAssetIds : [];
    const assetId = assetIds[0] == null ? '' : String(assetIds[0]);
    if (!assetId) throw new Error(`shelf story ${storyId} has no adventure asset`);
    return {
      __msg: SHELF_ALBUM_EPISODE_INFO_MSG,
      Episode: episode,
      AssetId: assetId,
      StoryId: storyId,
      ViewConditionId: SANDBOX_SHELF_STORY_CONDITION_ID,
      UnlockConditionId: SANDBOX_SHELF_STORY_CONDITION_ID,
      IsUnlocked: true,
    } as Decoded;
  });
}

/** `Home:Enter.EventInfo.ShelfInfo` — the home event entry. */
export function sandboxHomeShelfInfo(): Decoded {
  return {
    __msg: 'Solis.Common.Proto.Api.HomeShelfInfo',
    Id: SANDBOX_SHELF_ID,
    Name: SANDBOX_SHELF_NAME,
    StartTime: SANDBOX_SHELF_START,
    EndTime: SANDBOX_SHELF_END_TIME,
    BannerAssetId: SANDBOX_SHELF_BANNER_ASSET_ID,
    Order: 10,
    UnlockConditionId: SANDBOX_SHELF_PLAY_CONDITION_ID,
    IsUnlocked: true,
    AlbumInfos: sandboxShelfAlbumInfos(),
    EventMissionId: SANDBOX_SHELF_ASSET_ID,
  } as Decoded;
}

/** The home Events button that opens the album. */
export function sandboxShelfButton(): Decoded {
  return {
    __msg: 'Solis.Common.Proto.Api.EventButtonDisplayInfo',
    ConditionId: SANDBOX_SHELF_PLAY_CONDITION_ID,
    Priority: 100,
    AssetId: SANDBOX_SHELF_ASSET_ID,
  } as Decoded;
}

/** `Shelf:Top` — the event top page. */
export function sandboxShelfInfo(now: number = Date.now()): Decoded {
  return {
    __msg: 'Solis.Common.Proto.Api.ShelfInfo',
    Name: SANDBOX_SHELF_NAME,
    StartTime: SANDBOX_SHELF_START,
    EndTime: SANDBOX_SHELF_END_TIME,
    AssetId: SANDBOX_SHELF_ASSET_ID,
    EventMissionInfo: sandboxShelfMissionInfo(now),
    PhotoCreatingItemId: SANDBOX_SHELF_PHOTO_CREATING_ITEM_ID,
    AlbumInfos: sandboxShelfAlbumInfos(),
  } as Decoded;
}
