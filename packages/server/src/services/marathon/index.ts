/**
 * Marathon event endpoints.
 *
 * The event comes from the DB-backed event registry (`openMarathons`,
 * `marathonConfig`); `SUMIRE_MARATHON_ID` is a development override. This first
 * slice advertises the open events on Home:Enter and answers `Marathon:Top`
 * from the authored config plus the event master tables. It was built without
 * recorded traffic, so it is registered as a `stub`.
 */
import MarathonTopResponse from '@sumire-sr/protocol/gen/Solis_Common_Proto_Api_MarathonTopResponse.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { register } from '../handlers.ts';
import { accountOf, commonResponse, playerForAccount } from '../activity.ts';
import { db } from '../../db/client.ts';
import { withPlayerTx } from '../../db/tx.ts';
import {
  getRaidQuestByMarathonId,
  listMarathonBoxGachaSettings,
  listMarathonQuests,
} from '../../master/index.ts';import {
  marathonConfig,
  marathonWindowFor,
  openMarathons,
  type MarathonConfig,
  type MarathonWindow,
} from './catalog.ts';
import { currentStamina, loadMarathonState, type MarathonState } from './state.ts';
import { liveBonusInfos } from './liveBonus.ts';
import { buildBoxGachaInfo, marathonPoints } from './boxInfo.ts';
import { buildMarathonQuestInfo } from './questInfo.ts';
import {
  buildEventStoryInfo,
  buildRaidMarathonInfoFields,
  buildRaidQuestInfo,
  loadMarathonEventStory,
  marathonEventMissionInfo,
  resolveRaidMarathonItemIds,
  type RaidQuestRow,
} from './eventInfo.ts';
import { ConditionEvaluator } from '../conditions.ts';

const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const EVENT_INFO_MSG = 'Solis.Common.Proto.Api.HomeEventInfo';
const HOME_MARATHON_INFO_MSG = 'Solis.Common.Proto.Api.HomeMarathonInfo';
const MARATHON_INFO_MSG = 'Solis.Common.Proto.Api.MarathonInfo';
const USER_MARATHON_INFO_MSG = 'Solis.Common.Proto.Api.UserMarathonInfo';
// Solis.Common.Proto.MarathonType_Raid (see plugin.ts MarathonConfig.type).
const MARATHON_TYPE_RAID = 2;

/**
 * Advertise the open authored events on Home:Enter, under every profile.
 * Call it after `applySandboxEvents` so the sandbox path does not wipe it.
 * With no open event (and no `SUMIRE_MARATHON_ID` override) this is a no-op, so
 * the default response is byte-for-byte unchanged. Other EventInfo fields are
 * preserved.
 */
export function applyActiveMarathonToHomeEnter(decoded: Decoded): void {
  const marathons = openMarathons(Date.now());
  if (marathons.length === 0) return;

  const eventInfo =
    decoded.EventInfo !== null && typeof decoded.EventInfo === 'object'
      ? (decoded.EventInfo as Decoded)
      : ({ __msg: EVENT_INFO_MSG } as Decoded);

  eventInfo.MarathonInfos = marathons.map(({ config, window }) => homeMarathonInfo(config, window));
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

  const now = Date.now();
  const window = marathonWindowFor(marathonId, now);
  if (!window) throw new Error(`Marathon:Top: marathon ${marathonId} is not open`);

  const player = await playerForAccount(accountId, 'Marathon:Top');
  const point = await marathonPoints(player.id, marathonId);

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

  // Raid marathons serve their quest (stage, music, 20 difficulties) through
  // MarathonInfo.RaidQuest; the client has no RaidQuest master partition. They
  // also need MarathonInfo.LadderInfo (the client dereferences it without a
  // null check in MarathonTopScreenPresenter.InitializeAsync) and the raid
  // stamina fields. The four raid stamina numbers are placeholders: IPR master
  // has no source for them.
  if (config.type === MARATHON_TYPE_RAID) {
    const raidRow = await getRaidQuestByMarathonId(marathonId);
    const raidQuestInfo = buildRaidQuestInfo(raidRow as RaidQuestRow | null);
    if (raidQuestInfo) marathonInfo.RaidQuest = raidQuestInfo;

    const raidItemIds = await resolveRaidMarathonItemIds(config.id);
    Object.assign(
      marathonInfo,
      buildRaidMarathonInfoFields({
        type: config.type,
        marathonId: config.id,
        name: config.name,
        startTime: window.startTime,
        endTime: window.endTime,
        assetId: config.assetId,
        eventMissionInfo: marathonInfo.EventMissionInfo as Decoded | undefined,
        ladderPointItemId: raidItemIds.ladderPointItemId,
        raidStaminaRecoveryItemId: raidItemIds.raidStaminaRecoveryItemId,
      }),
    );
  }

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
