/**
 * Mission:Event. Returns the EventMissionInfo of the active marathon's event
 * mission. Any other EventMissionId is rejected.
 */
import { register, type RpcContext } from '../handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { commonResponse } from '../activity.ts';
import { withQuestPlayer } from '../quest.ts';
import { withPlayerTx } from '../../db/tx.ts';
import { activeMarathon } from './catalog.ts';
import { marathonEventMissionInfo } from './eventInfo.ts';

const RPC = 'Mission:Event';
const MISSION_EVENT_RESPONSE_MSG = 'Solis.Common.Proto.Api.MissionEventResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';

register(RPC, async (ctx: RpcContext) => {
  const req = (ctx.request ?? {}) as Decoded;
  const eventMissionId = String(req.EventMissionId ?? '');
  return withQuestPlayer(ctx, RPC, async (playerId) => {
    const config = activeMarathon();
    if (!config || eventMissionId === '' || eventMissionId !== config.eventMissionId) {
      throw new Error(`Mission:Event: unknown event mission ${eventMissionId}`);
    }
    return {
      __msg: MISSION_EVENT_RESPONSE_MSG,
      Info: await withPlayerTx(playerId, (tx) => marathonEventMissionInfo(playerId, config, tx)),
      CommonResponse: commonResponse({ __msg: UPDATED_DATA_MSG } as Decoded),
    } as Decoded;
  });
});
