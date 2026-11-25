// Home event banner block for race events: `HomeEventInfo.RaceInfos`, and the
// first-visit race-state initialisation that rides on `Home:Enter`.
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { db } from '../../db/client.ts';
import type { Executor } from '../../db/tx.ts';
import { openRaces } from './catalog.ts';
import type { RaceConfig } from './types.ts';
import type { RaceWindow } from './catalog.ts';
import { loadRaceState, markRaceInitialLogin, saveRaceState } from './state.ts';
import { grantInitialRacePoints, mergeUpdated } from './updated.ts';

const HOME_EVENT_INFO_MSG = 'Solis.Common.Proto.Api.HomeEventInfo';
const HOME_RACE_INFO_MSG = 'Solis.Common.Proto.Api.HomeRaceInfo';
const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';

/** One `HomeRaceInfo` row for the home event list. */
export function homeRaceInfo(config: RaceConfig, window: RaceWindow): Decoded {
  return {
    __msg: HOME_RACE_INFO_MSG,
    Id: config.raceId,
    Name: config.name,
    StartTime: window.startTime,
    EndTime: window.endTime,
    AggregateEndTime: window.endTime,
    ExchangeEndTime: window.exchangeEndTime,
    AssetId: config.assetId,
    BannerAssetId: config.bannerAssetId,
    Order: 1,
    UnlockConditionId: '',
    IsUnlocked: true,
    EventMissionId: config.eventMissionId,
    IsLessenRewardMax: false,
  } as Decoded;
}

/**
 * Fill `HomeEventInfo.RaceInfos` with `races`. Leaves the payload untouched when
 * nothing is open, like `applyActiveMarathonToHomeEnter`.
 */
export function applyRaceInfosToHome(
  decoded: Decoded,
  races: ReadonlyArray<{ config: RaceConfig; window: RaceWindow }>,
): void {
  if (races.length === 0) return;
  const existing = decoded.EventInfo as Decoded | undefined;
  const eventInfo: Decoded =
    existing && typeof existing === 'object' ? existing : { __msg: HOME_EVENT_INFO_MSG };
  eventInfo.RaceInfos = races.map(({ config, window }) => homeRaceInfo(config, window));
  decoded.EventInfo = eventInfo;
}

/** `Home:Enter`'s `CommonResponse.UpdatedData`, created when the body has none. */
function homeUpdated(decoded: Decoded): Decoded {
  const common = (decoded.CommonResponse ??= {
    __msg: COMMON_RESPONSE_MSG,
    UpdatedData: { __msg: UPDATED_DATA_MSG },
    DeletedData: { __msg: DELETED_DATA_MSG },
  } as Decoded) as Decoded;
  return (common.UpdatedData ??= { __msg: UPDATED_DATA_MSG } as Decoded) as Decoded;
}

/**
 * Fill `HomeEventInfo.RaceInfos` with every race open now, and initialise the
 * state of each open race the player has not started yet.
 *
 * The initialisation is the same one `Race:Top` performs on its first call
 * (`markRaceInitialLogin` + `grantInitialRacePoints`): the starting race points
 * are granted here so the item row lands in `Home:Enter`'s
 * `CommonResponse.UpdatedData`, which the client applies to its item cache
 * before the race screen is opened. `Race:Top` is kept as the fallback for a
 * player who reached the race without a fresh `Home:Enter`; it sees
 * `initialized` set and grants nothing, so the points are granted once.
 */
export async function applyActiveRaceToHomeEnter(
  decoded: Decoded,
  playerId: string | null = null,
  exec: Executor = db,
  now: number = Date.now(),
): Promise<void> {
  const races = openRaces(now);
  applyRaceInfosToHome(decoded, races);
  if (playerId === null || races.length === 0) return;
  const granted = { __msg: UPDATED_DATA_MSG } as Decoded;
  for (const { config } of races) {
    const state = await loadRaceState(playerId, config.raceId, exec);
    if (state.initialized) continue;
    markRaceInitialLogin(state, now);
    await grantInitialRacePoints(playerId, config, granted, exec);
    await saveRaceState(playerId, config.raceId, state, exec);
  }
  if (Object.keys(granted).some((key) => key !== '__msg')) {
    mergeUpdated(homeUpdated(decoded), granted);
  }
}
