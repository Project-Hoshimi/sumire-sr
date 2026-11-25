/**
 * Raid (協力ライブ, `MarathonType_Raid` = 2) RPC stubs.
 *
 * A raid marathon's quest data reaches the client through
 * `MarathonInfo.RaidQuest` (see `eventInfo.ts`), which is enough for the raid
 * screens to render the quest list. There is no server-side raid state yet, so
 * every raid endpoint is acknowledged with an empty/default response:
 * no joinable/progressing/finished quests, no history, no ranking, and
 * Start/Join/Finish change nothing. They are recorded as `stub` in
 * `endpointLevels.ts`; `todo` below notes what a full implementation needs.
 *
 * The codebase has no gRPC-status error helper for registered-but-unimplemented
 * handlers, so these return a normal empty response instead of an error.
 */
import { register, type RpcContext } from '../handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { commonResponse } from '../activity.ts';

const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';

function emptyUpdated(): Decoded {
  return { __msg: UPDATED_DATA_MSG } as Decoded;
}

function withCommon(message: string, fields: Decoded = {}): Decoded {
  return { __msg: message, ...fields, CommonResponse: commonResponse(emptyUpdated()) } as Decoded;
}

/** Raid endpoints and what a full implementation would do (docs/tests only). */
export const RAID_STUB_ENDPOINTS: ReadonlyArray<{ name: string; todo: string }> = [
  { name: 'Marathon:ListRaid', todo: 'Needs raid state: joinable, progressing and finished raids per marathon.' },
  { name: 'Marathon:CheckRaidProgress', todo: 'Needs raid state: whether the host raid finished.' },
  { name: 'Marathon:ListRaidHistory', todo: 'Needs raid history rows per player.' },
  { name: 'Marathon:GetRaidHistoryDetail', todo: 'Needs a stored raid result for the requested raid id.' },
  { name: 'Marathon:ListRaidRanking', todo: 'Needs a raid score ranking per quest difficulty.' },
  { name: 'Marathon:StartRaid', todo: 'Should host a raid, spend raid stamina and compute the live result.' },
  { name: 'Marathon:JoinRaid', todo: 'Should join another player\'s raid, spend raid stamina and grant join rewards.' },
  { name: 'Marathon:FinishRaid', todo: 'Should settle the raid, grant host/MVP rewards and end the raid.' },
  { name: 'Marathon:UseRaidStaminaRecoveryItem', todo: 'Should consume the raid stamina recovery item and return UserMarathonInfo.' },
  // deck.ts keeps buildDeckInfo/deckCardStats private, so there is no reusable
  // getter to serve the raid deck yet.
  { name: 'Marathon:ListRaidDeck', todo: 'Should reuse the marathon deck builder for the raid difficulty.' },
  { name: 'Marathon:SaveRaidDeck', todo: 'Should persist a raid deck via the marathon deck save path.' },
];

register(
  'Marathon:ListRaid',
  async (_ctx: RpcContext) =>
    withCommon('Solis.Common.Proto.Api.MarathonRaidListResponse', {
      JoinableQuests: [],
      ProgressingQuests: [],
      FinishedQuests: [],
      UpdateEnableTime: 0,
    }),
  { ownsState: true },
);

register(
  'Marathon:CheckRaidProgress',
  async (_ctx: RpcContext) =>
    withCommon('Solis.Common.Proto.Api.MarathonRaidCheckProgressResponse', { Finished: false }),
  { ownsState: true },
);

register(
  'Marathon:ListRaidHistory',
  async (_ctx: RpcContext) =>
    withCommon('Solis.Common.Proto.Api.MarathonRaidListHistoryResponse', { Quests: [] }),
  { ownsState: true },
);

register(
  'Marathon:GetRaidHistoryDetail',
  async (_ctx: RpcContext) =>
    withCommon('Solis.Common.Proto.Api.MarathonRaidGetHistoryDetailResponse'),
  { ownsState: true },
);

register(
  'Marathon:ListRaidRanking',
  async (_ctx: RpcContext) =>
    withCommon('Solis.Common.Proto.Api.MarathonRaidListRankingResponse', {
      RankedUsers: [],
      SelfScore: 0,
      HostUserName: '',
    }),
  { ownsState: true },
);

register(
  'Marathon:StartRaid',
  async (_ctx: RpcContext) =>
    withCommon('Solis.Common.Proto.Api.MarathonRaidStartResponse'),
  { ownsState: true },
);

register(
  'Marathon:JoinRaid',
  async (_ctx: RpcContext) =>
    withCommon('Solis.Common.Proto.Api.MarathonRaidJoinResponse', { Finished: false }),
  { ownsState: true },
);

register(
  'Marathon:FinishRaid',
  async (_ctx: RpcContext) =>
    withCommon('Solis.Common.Proto.Api.MarathonRaidFinishResponse'),
  { ownsState: true },
);

register(
  'Marathon:UseRaidStaminaRecoveryItem',
  async (_ctx: RpcContext) =>
    withCommon('Solis.Common.Proto.Api.MarathonUseRaidStaminaRecoveryItemResponse'),
  { ownsState: true },
);

register(
  'Marathon:ListRaidDeck',
  async (_ctx: RpcContext) =>
    withCommon('Solis.Common.Proto.Api.MarathonListRaidDeckResponse', {
      DeckInfos: [],
      RankedUsers: [],
    }),
  { ownsState: true },
);

register(
  'Marathon:SaveRaidDeck',
  async (_ctx: RpcContext) =>
    withCommon('Solis.Common.Proto.Api.MarathonRaidDeckSaveResponse'),
  { ownsState: true },
);
