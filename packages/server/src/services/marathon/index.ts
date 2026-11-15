/**
 * Marathon event endpoints.
 *
 * The event itself is opt-in and server-authored (`SUMIRE_MARATHON_ID`, see
 * `catalog.ts`). This first slice advertises it on Home:Enter and answers
 * `Marathon:Top` from the authored config plus the event master tables. It was
 * built without recorded traffic, so it is registered as a `stub`.
 */
import MarathonTopResponse from '@sumire-sr/protocol/gen/Solis_Common_Proto_Api_MarathonTopResponse.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { register } from '../handlers.ts';
import { accountOf, commonResponse, playerForAccount } from '../activity.ts';
import { db } from '../../db/client.ts';
import { withPlayerTx } from '../../db/tx.ts';
import { listMarathonBoxGachaSettings, listMarathonQuests } from '../../master/index.ts';
import {
  activeMarathon,
  marathonConfig,
  marathonWindow,
  type MarathonConfig,
  type MarathonWindow,
} from './catalog.ts';
import { currentStamina, loadMarathonState, type MarathonState } from './state.ts';
import { liveBonusInfos } from './liveBonus.ts';
import { buildBoxGachaInfo, marathonPoints } from './boxInfo.ts';
import { buildMarathonQuestInfo } from './questInfo.ts';
import { buildEventStoryInfo, loadMarathonEventStory, marathonEventMissionInfo } from './eventInfo.ts';
import { ConditionEvaluator } from '../conditions.ts';

const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const EVENT_INFO_MSG = 'Solis.Common.Proto.Api.HomeEventInfo';
const HOME_MARATHON_INFO_MSG = 'Solis.Common.Proto.Api.HomeMarathonInfo';
const MARATHON_INFO_MSG = 'Solis.Common.Proto.Api.MarathonInfo';
const USER_MARATHON_INFO_MSG = 'Solis.Common.Proto.Api.UserMarathonInfo';

/**
 * Advertise the active authored event on Home:Enter, under every profile.
 * Call it after `applySandboxEvents` so the sandbox path does not wipe it.
 * With `SUMIRE_MARATHON_ID` unset this is a no-op, so the default response is
 * byte-for-byte unchanged. Other EventInfo fields are preserved.
 */
export function applyActiveMarathonToHomeEnter(decoded: Decoded): void {
  const config = activeMarathon();
  if (!config) return;

  const window = marathonWindow(Date.now());
  const eventInfo =
    decoded.EventInfo !== null && typeof decoded.EventInfo === 'object'
      ? (decoded.EventInfo as Decoded)
      : ({ __msg: EVENT_INFO_MSG } as Decoded);

  eventInfo.MarathonInfos = [homeMarathonInfo(config, window)];
  decoded.EventInfo = eventInfo;
}

/** UserMarathonInfo for a player: stamina at the given time plus owned live bonuses. */
export function buildUserMarathonInfo(
  state: MarathonState,
  stamina: { stamina: number; updated: number },
): Decoded {
  return {
    __msg: USER_MARATHON_INFO_MSG,
    CurrentStamina: stamina.stamina,
    StaminaUpdatedTime: stamina.updated,
    LiveBonusInfos: liveBonusInfos(state),
  } as Decoded;
}

function homeMarathonInfo(config: MarathonConfig, window: MarathonWindow): Decoded {
  return {
    __msg: HOME_MARATHON_INFO_MSG,
    Id: config.id,
    Name: config.name,
    StartTime: window.startTime,
    EndTime: window.endTime,
    ExchangeEndTime: window.exchangeEndTime,
    AssetId: config.assetId,
    BannerAssetId: config.bannerAssetId,
    Order: config.order,
    IsUnlocked: true,
    EventMissionId: config.eventMissionId,
    Type: config.type,
  } as Decoded;
}

register('Marathon:Top', async (ctx) => {
  // Marathon:Top is per-player state even though this slice only serves the
  // event's static configuration; reject unauthenticated callers like the rest
  // of the services.
  const accountId = accountOf(ctx);

  const marathonId = String((ctx.request as Decoded | undefined)?.MarathonId ?? '');
  const config = marathonId === '' ? undefined : marathonConfig(marathonId);
  if (!config) throw new Error(`Marathon:Top: unknown marathon ${marathonId}`);

  const player = await playerForAccount(accountId, 'Marathon:Top');
  const point = await marathonPoints(player.id, marathonId);

  const now = Date.now();
  const window = marathonWindow(now);
  const state = await loadMarathonState(player.id, config, now);

  const marathonInfo = {
    __msg: MARATHON_INFO_MSG,
    Id: config.id,
    Name: config.name,
    StartTime: window.startTime,
    EndTime: window.endTime,
    ExchangeEndTime: window.exchangeEndTime,
    InitialStamina: config.initialStamina,
    StaminaRecoveryMinutes: config.staminaRecoveryMinutes,
    AssetId: config.assetId,
    BoxGachaGroupId: config.boxGachaGroupId,
    StaminaRecoveryItemId: config.staminaRecoveryItemId,
    QuestUnlockItemId: config.questUnlockItemId,
    Type: config.type,
    EventStoryInfo: buildEventStoryInfo(await loadMarathonEventStory(config)),
    EventMissionInfo: await withPlayerTx(player.id, (tx) =>
      marathonEventMissionInfo(player.id, config, tx),
    ),
  } as Decoded;

  const stamina = currentStamina(state, config, now);
  const unlockEvaluator = new ConditionEvaluator(player.id, now, db);
  const userMarathonInfo = buildUserMarathonInfo(state, stamina);

  const questRows = await listMarathonQuests(marathonId);
  const questInfos: Decoded[] = [];
  for (const quest of questRows) {
    // Quest unlock comes from the master condition plus the optional item gate.
    questInfos.push(
      await buildMarathonQuestInfo(player.id, config, quest, state, db, unlockEvaluator),
    );
  }

  const settingRows = await listMarathonBoxGachaSettings(marathonId);
  const boxGachaInfos: Decoded[] = [];
  for (const setting of settingRows) {
    boxGachaInfos.push(
      await buildBoxGachaInfo(
        player.id,
        config,
        setting as unknown as Decoded,
        state,
        point,
        db,
        unlockEvaluator,
      ),
    );
  }

  return {
    __msg: MarathonTopResponse.name,
    MarathonInfo: marathonInfo,
    UserMarathonInfo: userMarathonInfo,
    QuestInfos: questInfos,
    BoxGachaInfos: boxGachaInfos,
    DokanInfos: [],
    CommonResponse: commonResponse({ __msg: UPDATED_DATA_MSG } as Decoded),
  } as Decoded;
});
