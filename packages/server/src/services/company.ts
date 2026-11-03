import { eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import { listCompanyEnjoyObtainPointItemSettingsByCharacter, listMissions } from '../master/index.ts';
import { db } from '../db/client.ts';
import { withPlayerTx } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import { enumValues } from '@sumire-sr/protocol/gen/enums.ts';
import { getItemAmount, spendItem } from './inventory.ts';
import { listElements, putElements } from './playerState.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { isSandbox } from '../profile.ts';
import { sandboxCompanyGradeInfos, sandboxCompanyTrustLevelInfos, sandboxUserCompany } from '../profiles/sandbox/company.ts';

const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';
const USER_MISSION_MSG = 'Solis.Common.Proto.Transaction.UserMission';
const USER_ITEM_MSG = 'Solis.Common.Proto.Transaction.UserItem';
const USER_CHARACTER_MSG = 'Solis.Common.Proto.Transaction.UserCharacter';
const ENJOY_MISSION_INFO_MSG = 'Solis.Common.Proto.Api.CompanyEnjoyCharacterMissionInfo';
const TRUST_MISSION_INFO_MSG = 'Solis.Common.Proto.Api.CompanyTrustMissionInfo';

const ENJOY_CATEGORY_ENUM = 'Solis.Common.Proto.CompanyEnjoyCharacterMissionCategoryType';
const TRUST_CATEGORY_ENUM = 'Solis.Common.Proto.CompanyTrustMissionCategoryType';
const MISSION_STATUS_ENUM = 'Solis.Common.Proto.MissionStatusType';

function commonResponse(updated: Decoded | null = null, deleted: Decoded | null = null): Decoded {
  return {
    __msg: COMMON_RESPONSE_MSG,
    UpdatedData: (updated ?? { __msg: UPDATED_DATA_MSG }) as Decoded,
    DeletedData: (deleted ?? { __msg: DELETED_DATA_MSG }) as Decoded,
  } as Decoded;
}

function commonOnly(updated: Decoded | null = null): Decoded {
  return { __msg: '', CommonResponse: commonResponse(updated) } as Decoded;
}

function enumValue(enumName: string, valueName: string): number {
  for (const [value, name] of Object.entries(enumValues[enumName] ?? {})) {
    if (name === valueName) return Number(value);
  }
  throw new Error(`${enumName}.${valueName} is missing from the generated enums`);
}

/** Non-zero enum values in ascending numeric order (the `Unknown` member is 0). */
function categoryOrder(enumName: string): number[] {
  return Object.entries(enumValues[enumName] ?? {})
    .filter(([, name]) => name !== 'Unknown')
    .map(([value]) => Number(value))
    .sort((a, b) => a - b);
}

const ENJOY_CATEGORIES = categoryOrder(ENJOY_CATEGORY_ENUM);
const TRUST_CATEGORIES = categoryOrder(TRUST_CATEGORY_ENUM);
/** The sandbox reports every Company task as already completed. */
const STATUS_RECEIVED = enumValue(MISSION_STATUS_ENUM, 'Received');

type MissionRow = Awaited<ReturnType<typeof listMissions>>[number];

function missionProgresses(mission: MissionRow): Decoded[] {
  const raw = mission.Progresses;
  return Array.isArray(raw) ? (raw as Decoded[]) : [];
}

/** Highest threshold across the master `Progresses` (0 when there are none). */
function highestThreshold(progresses: Decoded[]): number {
  let highest = 0;
  for (const progress of progresses) {
    const threshold = Number(progress.Threshold ?? 0);
    if (threshold > highest) highest = threshold;
  }
  return highest;
}

/**
 * Build the Company mission infos from master data only - no player state is
 * read or written. The sandbox shows a single already-completed task per
 * category: an empty list crashes the client's
 * `CompanyEnjoyMissionScreenPresenter`, so each matching category emits exactly
 * one `Received` mission (the lowest master Id with at least one `Progresses`
 * entry) whose `Progress` equals its highest threshold.
 */
function buildMissionInfos(
  masters: MissionRow[],
  infoMsg: string,
  matches: (mission: MissionRow) => boolean,
  categoryOf: (mission: MissionRow) => number,
  order: number[],
): Decoded[] {
  const chosen = new Map<number, MissionRow>();
  for (const mission of masters) {
    const missionId = String(mission.Id ?? '');
    if (!missionId || !matches(mission)) continue;
    const category = categoryOf(mission);
    if (category === 0) continue;
    if (!missionProgresses(mission).length) continue;
    const current = chosen.get(category);
    if (!current || missionId < String(current.Id ?? '')) chosen.set(category, mission);
  }

  const infos: Decoded[] = [];
  for (const category of order) {
    const mission = chosen.get(category);
    if (!mission) continue;
    const threshold = highestThreshold(missionProgresses(mission));
    infos.push({
      __msg: infoMsg,
      CategoryType: category,
      UserMissions: [
        {
          __msg: USER_MISSION_MSG,
          MissionId: String(mission.Id ?? ''),
          CurrentThreshold: threshold,
          Progress: threshold,
          StatusType: STATUS_RECEIVED,
          LastUpdateTime: Date.now(),
        } as Decoded,
      ],
    } as Decoded);
  }
  return infos;
}

function enjoyMissionInfos(masters: MissionRow[], characterId: string): Decoded[] {
  if (!characterId) return [];
  return buildMissionInfos(
    masters,
    ENJOY_MISSION_INFO_MSG,
    (mission) =>
      String(mission.CompanyEnjoyCharacterId ?? '') === characterId &&
      Number(mission.CompanyEnjoyCharacterMissionCategoryType ?? 0) !== 0,
    (mission) => Number(mission.CompanyEnjoyCharacterMissionCategoryType ?? 0),
    ENJOY_CATEGORIES,
  );
}

function trustMissionInfos(masters: MissionRow[]): Decoded[] {
  return buildMissionInfos(
    masters,
    TRUST_MISSION_INFO_MSG,
    (mission) => Number(mission.CompanyTrustMissionCategoryType ?? 0) !== 0,
    (mission) => Number(mission.CompanyTrustMissionCategoryType ?? 0),
    TRUST_CATEGORIES,
  );
}

register(
  'Company:Top',
  async (ctx) => {
    ctx.fastifyReq.log.info('company top');
    const masters = await listMissions();
    return {
      __msg: '',
      // Sandbox shows the maxed office rank, so every grade and trust level is done.
      CompanyGradeInfos: isSandbox() ? sandboxCompanyGradeInfos() : [],
      TrustMissionInfos: trustMissionInfos(masters),
      TrustLevelInfos: isSandbox() ? sandboxCompanyTrustLevelInfos() : [],
      CurrentRank: 1,
      ReceivableLevelRewardEnjoyCharacterIds: [],
      ThisMonthSalaryPoint: 0,
      DokanInfos: [],
      // Also push the maxed UserCompany so the Office screen's grade is current.
      CommonResponse: commonResponse(
        isSandbox() ? ({ __msg: UPDATED_DATA_MSG, Company: sandboxUserCompany() } as Decoded) : null,
      ),
    } as Decoded;
  },
  { ownsState: true },
);

register(
  'Company:EnjoyCharacterTop',
  async (ctx) => {
    const characterId = String((ctx.request as any)?.CharacterId ?? '');
    ctx.fastifyReq.log.info({ characterId }, 'company enjoy character top');
    const masters = await listMissions();
    return {
      __msg: '',
      EnjoyLevelInfos: characterId
        ? [
            {
              __msg: 'Solis.Common.Proto.Api.CompanyEnjoyCharacterLevelInfo',
              CharacterId: characterId,
              LevelKey: 1,
              IsReceivable: false,
              IsAlreadyReceived: true,
            },
          ]
        : [],
      MissionInfos: enjoyMissionInfos(masters, characterId),
      CurrentRank: 1,
      CommonResponse: commonResponse(),
    } as Decoded;
  },
  { ownsState: true },
);

/**
 * `Company:UseEnjoyObtainPointItem` — spend character gifts from the interaction
 * menu and convert them into the character's CompanyEnjoyPoint. Missions and
 * TotalCount are intentionally untouched (the sandbox shows them as completed).
 */
register(
  'Company:UseEnjoyObtainPointItem',
  async (ctx) => {
    const req = ctx.request;
    if (!req) throw new Error('Company:UseEnjoyObtainPointItem: missing request');
    const characterId = String(req.CharacterId ?? '');
    const itemId = String(req.ItemId ?? '');
    const amount = Number(req.ConsumptionItemAmount ?? 0);
    if (!characterId) throw new Error('Company:UseEnjoyObtainPointItem: CharacterId is required');
    if (!itemId) throw new Error('Company:UseEnjoyObtainPointItem: ItemId is required');
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('Company:UseEnjoyObtainPointItem: ConsumptionItemAmount must be positive');
    }

    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('Company:UseEnjoyObtainPointItem: unauthenticated');
    const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
    if (!pl) throw new Error('Company:UseEnjoyObtainPointItem: no player for account');

    const setting = (
      await listCompanyEnjoyObtainPointItemSettingsByCharacter(characterId)
    ).find((row) => String(row.ItemId ?? '') === itemId);
    if (!setting) {
      throw new Error(
        `Company:UseEnjoyObtainPointItem: item ${itemId} is unavailable for character ${characterId}`,
      );
    }
    const obtainPoint = Number(setting.ObtainPoint ?? 0);
    if (obtainPoint <= 0) {
      throw new Error('Company:UseEnjoyObtainPointItem: master obtain point is invalid');
    }

    return withPlayerTx(pl.id, async (tx) => {
      const characters = await listElements(pl.id, 'Characters', tx);
      const character = characters.find((row) => String(row.CharacterId ?? '') === characterId);
      if (!character) {
        throw new Error(`Company:UseEnjoyObtainPointItem: character ${characterId} is not owned`);
      }

      await spendItem(pl.id, itemId, amount, tx);
      const remaining = await getItemAmount(pl.id, itemId, tx);

      const updatedCharacter = {
        ...character,
        __msg: USER_CHARACTER_MSG,
        CompanyEnjoyPoint: Number(character.CompanyEnjoyPoint ?? 0) + obtainPoint * amount,
      } as Decoded;
      await putElements(pl.id, 'Characters', [updatedCharacter], tx);

      const updated: Decoded = {
        __msg: UPDATED_DATA_MSG,
        Characters: [updatedCharacter],
      } as Decoded;
      const deleted: Decoded = { __msg: DELETED_DATA_MSG } as Decoded;
      const item = { __msg: USER_ITEM_MSG, ItemId: itemId } as Decoded;
      if (remaining > 0) {
        updated.Items = [{ ...item, Amount: remaining } as Decoded];
      } else {
        deleted.Items = [item];
      }

      return {
        __msg: '',
        CommonResponse: commonResponse(updated, deleted),
      } as Decoded;
    });
  },
  { ownsState: true },
);

for (const name of [
  'Company:ListRanking',
  'Company:ReceiveGradeRewards',
  'Company:BulkReceiveMission',
  'Company:ListEnjoyCharacterRanking',
  'Company:ReceiveEnjoyCharacterLevelRewards',
  'Company:BulkReceiveEnjoy',
  'Company:BulkReceiveEnjoyCharacterLevelRewards',
  'Company:ReceiveTrustLevelRewards',
]) {
  register(name, () => commonOnly(), { ownsState: true });
}
