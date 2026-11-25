// `Race:MovePanel`: advance along the race board as far as the client's
// "Advance N tile" button previews.
//
// The request only carries `RaceId`, so the server owns the distance: one call
// walks panel by panel, paying every panel's `RequiredRacePointAmount` while the
// player can afford the cumulative cost. The walk ends on (and includes) the
// first event story panel — that is the destination the client animates to and
// then opens the story for — and on a VENUS panel, which ends the area's run and
// locks the board until `Race:StartLivePanelQuest` clears it. A call never
// crosses into the next area; the following call wraps to that area's panel 1.
//
// The last area loops (the client's `RaceMainScreenModel._isLoopArea`): once its
// VENUS panel is cleared, the next call wraps back to panel 1 of the same area
// and increments `RaceState.loopCount`. On those loop laps story panels are
// pass-throughs — they cost their race point and count as cleared panels, but
// they do not stop the walk and do not re-read the story — while reward panels
// grant again and the VENUS panel still stops and locks the board.
//
// Arrivals are applied as the walk passes them: reward panels grant their
// `RacePanelReward`, story panels record the episode, everything else just counts
// as a cleared panel. The total cost is spent once, then the race point's
// absolute amount is echoed in `UpdatedData`.
import { register, type RpcContext } from '../handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { withPlayerTx } from '../../db/tx.ts';
import { applyRewardRefs } from '../../master/reward.ts';
import { commonResponse } from '../activity.ts';
import { getItemAmount, spendItem } from '../inventory.ts';
import { compactUpdated, withQuestPlayer } from '../quest.ts';
import { raceConfigFor, raceWindowFor } from './catalog.ts';
import { getRacePanel, getRacePanelReward } from './master.ts';
import { buildRaceOpponentProgressInfos } from './rivals.ts';
import { loadRaceState, markRaceInitialLogin, saveRaceState } from './state.ts';
import { buildRaceLiveQuestInfos } from './top.ts';
import { panelRewardOverride } from './types.ts';
import { grantInitialRacePoints, mergeUpdated, pushItemAmount } from './updated.ts';
import { raceConditionInvalid, raceResourceNotEnough } from './errors.ts';
import { loadRaceUserRaceInfo } from './userRaceInfo.ts';
import { enterVenusPanel } from './venusStep.ts';

const RPC = 'Race:MovePanel';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';

/** `RacePanel.Type`: 1 empty, 2 reward, 3 VENUS live, 4 event story. */
const PANEL_EMPTY = 1;
const PANEL_REWARD = 2;
const PANEL_VENUS = 3;
const PANEL_STORY = 4;

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function s(value: unknown): string {
  return value == null ? '' : String(value);
}

register(
  RPC,
  async (ctx: RpcContext) => {
    const req = (ctx.request ?? {}) as Decoded;
    const raceId = s(req.RaceId);
    const config = raceConfigFor(raceId);
    if (config === undefined) throw new Error(`${RPC}: unknown race ${raceId}`);
    const now = Date.now();
    const window = raceWindowFor(raceId, now);
    if (window === undefined) raceConditionInvalid(`${RPC}: race ${raceId} is not open`);
    return withQuestPlayer(ctx, RPC, async (playerId) => {
      const payload = await withPlayerTx(playerId, async (tx) => {
        const updated = { __msg: UPDATED_DATA_MSG } as Decoded;
        const state = await loadRaceState(playerId, raceId, tx);
        const firstLogin = markRaceInitialLogin(state, now);
        if (firstLogin) await grantInitialRacePoints(playerId, config, updated, tx);
        if (state.pendingVenus) {
          raceConditionInvalid(`${RPC}: the VENUS panel live must be cleared first`);
        }

        const areaIds = config.areaIds;
        // `panelNumber` 0 means "before the first panel" (a fresh board).
        let areaIndex = state.areaIndex;
        let panelNumber = state.panelNumber + 1;
        if (areaIndex < 0 || areaIndex >= areaIds.length) {
          throw new Error(`${RPC}: area index ${areaIndex} is out of range`);
        }
        if (state.panelNumber > 0 && (await getRacePanel(areaIds[areaIndex], panelNumber)) === null) {
          if (areaIndex + 1 < areaIds.length) {
            // Past the last panel of the area: wrap to the first panel of the
            // next one.
            areaIndex += 1;
            panelNumber = 1;
          } else {
            // The last area loops: the client's `RaceMainScreenModel` marks it
            // as a loop area (`_isLoopArea`), so after its VENUS panel the next
            // walk starts again at panel 1 of the same area. `loopCount` marks
            // the lap the walk is on (see the story pass-through below).
            panelNumber = 1;
            state.loopCount += 1;
          }
        }
        const isLoopLap = state.loopCount > 0;

        const have = await getItemAmount(playerId, config.racePointItemId, tx);
        let remaining = have;
        let totalCost = 0;
        let moved = 0;
        const rewardResults: Decoded[] = [];

        for (;;) {
          const areaId = areaIds[areaIndex];
          const panel = (await getRacePanel(areaId, panelNumber)) as unknown as Decoded | null;
          if (!panel) {
            if (moved === 0) {
              throw new Error(`${RPC}: panel ${panelNumber} not found in area ${areaId}`);
            }
            // The area ends here: one call never crosses into the next area.
            break;
          }

          const panelType = n(panel.Type);
          if (![PANEL_EMPTY, PANEL_REWARD, PANEL_VENUS, PANEL_STORY].includes(panelType)) {
            throw new Error(`${RPC}: panel type ${panelType} cannot be entered`);
          }
          // Resolve the reward before spending so a broken reward row spends
          // nothing. A draft override for this panel wins over the master
          // `RacePanelReward` row; an absent override keeps master as the source.
          let rewardRefs: string[] = [];
          if (panelType === PANEL_REWARD) {
            const override = panelRewardOverride(config, areaId, panelNumber);
            if (override !== undefined) {
              rewardRefs = [...override];
            } else {
              const rewardId = s(panel.RacePanelRewardId);
              const reward = rewardId === '' ? null : await getRacePanelReward(rewardId, raceId);
              const rewardRef = reward === null ? '' : s(reward.RewardId);
              if (rewardRef === '') {
                throw new Error(`${RPC}: reward panel ${panelNumber} has no reward row`);
              }
              rewardRefs = [rewardRef];
            }
          }

          const cost = n(panel.RequiredRacePointAmount);
          if (remaining < cost) {
            // Affordability ends the walk on the last panel it could pay for.
            // If this left the piece right before a VENUS panel, the next
            // `Race:Top` steps onto it once the balance covers it (the client
            // never offers a move onto the VENUS panel itself).
            if (moved === 0) {
              raceResourceNotEnough(
                `${RPC}: insufficient race point ${config.racePointItemId}: have ${have}, need ${cost}`,
              );
            }
            break;
          }
          remaining -= cost;
          totalCost += cost;

          // The walk leaves the current panel: drop its VENUS stage score.
          // After a clear the stored total stays so the client can show the
          // panel as cleared while the piece still stands on it, but once the
          // piece walks off (including the last-area loop wrap back to panel 1)
          // the score must not leak into the next panels' `UserRaceInfo`.
          if (moved === 0) state.currentLivePanelScore = 0;

          state.areaIndex = areaIndex;
          state.panelNumber = panelNumber;
          moved += 1;

          if (panelType === PANEL_REWARD) {
            const applied = await applyRewardRefs(playerId, rewardRefs, tx);
            mergeUpdated(updated, applied.updated);
            for (const row of applied.results) rewardResults.push(row);
          } else if (panelType === PANEL_STORY) {
            // On a loop lap the story was already read on the first pass: the
            // panel is a pass-through that only costs its race point (and counts
            // as a cleared panel below), never a destination that stops the walk.
            if (!isLoopLap) {
              const episode = n(panel.EventStoryEpisode);
              if (episode > 0 && !state.readStoryEpisodes.includes(episode)) {
                state.readStoryEpisodes.push(episode);
                state.readStoryEpisodes.sort((a, b) => a - b);
              }
            }
          } else if (panelType === PANEL_VENUS) {
            // The VENUS panel is only counted once its live is cleared, and its
            // stage score starts empty. `UserRaceInfo.CurrentLivePanelScore` is
            // the *current* panel's progress: the client compares it with the
            // panel's master `ClearScore` to decide whether the VENUS live is
            // cleared. Keeping the previous VENUS panel's score made the client
            // treat a fresh VENUS panel as cleared and send `MovePanel`, which
            // this handler then refused with "the VENUS panel live must be
            // cleared first".
            enterVenusPanel(state, panelNumber);
          }
          if (panelType !== PANEL_VENUS) state.totalClearPanelCount += 1;

          // The story panel is the walk's destination on the first pass; from
          // the second lap on it is a pass-through. The VENUS panel always ends
          // the walk and locks the board.
          if (panelType === PANEL_VENUS) break;
          if (panelType === PANEL_STORY && !isLoopLap) break;
          panelNumber += 1;
        }

        if (totalCost > 0) await spendItem(playerId, config.racePointItemId, totalCost, tx);

        // Report the race points' absolute amount: the client keeps its own
        // counters and would otherwise keep paging with a stale balance.
        await pushItemAmount(playerId, updated, config.racePointItemId, tx);

        await saveRaceState(playerId, raceId, state, tx);
        ctx.fastifyReq.log.info(
          {
            playerId,
            raceId,
            areaIndex: state.areaIndex,
            panelNumber: state.panelNumber,
            loopCount: state.loopCount,
            moved,
            totalCost,
            pendingVenus: state.pendingVenus,
          },
          'race move panel',
        );
        return {
          __msg: 'Solis.Common.Proto.Api.RaceMovePanelResponse',
          RewardResults: rewardResults,
          UserRaceInfo: await loadRaceUserRaceInfo(playerId, config, state, now, window.startTime, tx),
          OpponentProgressInfos: await buildRaceOpponentProgressInfos(playerId, config, state, tx),
          LiveQuestInfos: await buildRaceLiveQuestInfos(playerId, config, state, tx),
          CommonResponse: commonResponse(compactUpdated(updated)),
        } as Decoded;
      });
      return payload;
    });
  },
  { ownsState: true },
);
