// Notice endpoints. The private server has no notice backend, so these return
// empty/permissive payloads. Without a handler the client's home/gacha screens
// 500 on Notice:Get.
import { register } from './handlers.ts';
import type { RpcContext } from './handlers.ts';

const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';

function commonResponse(): Record<string, unknown> {
  return {
    __msg: COMMON_RESPONSE_MSG,
    UpdatedData: { __msg: UPDATED_DATA_MSG },
    DeletedData: { __msg: DELETED_DATA_MSG },
  };
}

register('Notice:Get', (ctx: RpcContext) => {
  const req = (ctx.request ?? {}) as Record<string, unknown>;
  return {
    __msg: '',
    Notice: { __msg: 'Solis.Common.Proto.Api.NoticeInfo', Id: req.NoticeId ?? '' },
    CommonResponse: commonResponse(),
  };
}, { ownsState: true });

register('Notice:List', () => {
  return {
    __msg: '',
    Notices: [],
    MalfunctionNotices: [],
    PrNotices: [],
    NoticeHasNext: false,
    MalfunctionNoticeHasNext: false,
    PrNoticeHasNext: false,
    CommonResponse: commonResponse(),
  };
}, { ownsState: true });

register('Notice:FetchList', () => {
  return {
    __msg: '',
    Notices: [],
    HasNext: false,
    CommonResponse: commonResponse(),
  };
}, { ownsState: true });
