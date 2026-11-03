/**
 * Sandbox office (company) rank display.
 *
 * The client derives the office grade from EnjoyPoint + TrustPoint + SalaryPoint
 * (UserCompany.GetRankPoint), and the trust/enjoy levels from each point alone.
 * Every sandbox player is shown at the top grade, S+50 (company_grade_rank-055,
 * 360000 points), with trust and enjoy at level 50. Display only.
 */
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/** Level-50 thresholds from CompanyTrustLevel / CompanyEnjoyLevel master data. */
export const SANDBOX_COMPANY_TRUST_POINT = 142000;
export const SANDBOX_COMPANY_ENJOY_POINT = 56800;
/** Tops the sum up to the S+50 requirement (360000). */
export const SANDBOX_COMPANY_SALARY_POINT = 360000 - 142000 - 56800;

/** The maxed UserCompany every sandbox player is shown with. */
export function sandboxUserCompany(base: Decoded | undefined = undefined): Decoded {
  return {
    __msg: 'Solis.Common.Proto.Transaction.UserCompany',
    ...(base ?? {}),
    TrustPoint: SANDBOX_COMPANY_TRUST_POINT,
    EnjoyPoint: SANDBOX_COMPANY_ENJOY_POINT,
    SalaryPoint: SANDBOX_COMPANY_SALARY_POINT,
  } as Decoded;
}

const GRADE_COUNT = 55;
const TRUST_LEVEL_COUNT = 50;

/** Every office grade, already reached and its reward already received. */
export function sandboxCompanyGradeInfos(): Decoded[] {
  return Array.from({ length: GRADE_COUNT }, (_, i) => ({
    __msg: 'Solis.Common.Proto.Api.CompanyGradeInfo',
    Id: `company_grade_rank-${String(i + 1).padStart(3, '0')}`,
    IsReceivable: false,
    IsAlreadyReceived: true,
  }) as Decoded);
}

/** Every trust level, already reached and its reward already received. */
export function sandboxCompanyTrustLevelInfos(): Decoded[] {
  return Array.from({ length: TRUST_LEVEL_COUNT }, (_, i) => ({
    __msg: 'Solis.Common.Proto.Api.CompanyTrustLevelInfo',
    LevelKey: i + 1,
    IsReceivable: false,
    IsAlreadyReceived: true,
  }) as Decoded);
}
