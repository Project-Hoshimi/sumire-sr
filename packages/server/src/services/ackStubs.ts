/**
 * Acknowledgement stubs: these endpoints are acknowledged without any state
 * change. They are recorded as `stub` in `endpointLevels.ts`. Each entry's
 * `todo` notes what a full implementation would do.
 */
import { register } from './handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';

function emptyCommon(): Decoded {
  return {
    __msg: COMMON_RESPONSE_MSG,
    UpdatedData: { __msg: UPDATED_DATA_MSG },
    DeletedData: { __msg: DELETED_DATA_MSG },
  } as Decoded;
}

export const ACK_STUBS: ReadonlyArray<{ name: string; responseMsg: string; hasCommon: boolean; todo: string }> = [
  {
    name: 'Anniversary:OutputTransitionLog',
    responseMsg: 'Solis.Common.Proto.Api.AnniversaryOutputTransitionLogResponse',
    hasCommon: true,
    todo: 'Client transition log; nothing to store.',
  },
  {
    name: 'Health:Check',
    responseMsg: 'Solis.Common.Proto.Api.HealthCheckResponse',
    hasCommon: false,
    todo: 'Empty response message; solis-server returns the same.',
  },
  {
    name: 'Home:SetReview',
    responseMsg: 'Solis.Common.Proto.Api.HomeSetReviewResponse',
    hasCommon: true,
    todo: 'Should record that the store-review prompt was shown.',
  },
  {
    name: 'Profile:ClearTwitterMission',
    responseMsg: 'Solis.Common.Proto.Api.ProfileClearTwitterMissionResponse',
    hasCommon: true,
    todo: 'Should advance the post-profile mission (solis-server profile/clear_twitter_mission.go).',
  },
  {
    name: 'Salary:GetPayslip',
    responseMsg: 'Solis.Common.Proto.Api.SalaryGetPayslipResponse',
    hasCommon: true,
    todo: 'Returns no payslips. Needs the payroll port (solis-server makino/salary): attendance, monthly payslip, Salary:Pay.',
  },
  {
    name: 'Warning:SetDisplayed',
    responseMsg: 'Solis.Common.Proto.Api.WarningSetDisplayedResponse',
    hasCommon: true,
    todo: 'Should persist the displayed warning ids.',
  },
];

for (const stub of ACK_STUBS) {
  register(
    stub.name,
    async () =>
      (stub.hasCommon
        ? { __msg: stub.responseMsg, CommonResponse: emptyCommon() }
        : { __msg: stub.responseMsg }) as Decoded,
    { ownsState: true },
  );
}
