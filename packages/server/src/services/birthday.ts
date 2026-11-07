import { eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import { accountOf, commonResponse, playerForAccount } from './activity.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { playerBirthdayState } from '../db/schema.ts';
import { getSingleton } from './playerState.ts';
import { AppRpcError, ERROR_ACTION, ERROR_CODE, GRPC_STATUS } from './errors.ts';
import { getCharacter, getCostume } from '../master/index.ts';
import { applyGrants } from '../master/reward.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import {
  BIRTHDAY_CODES,
  DEFAULT_BIRTHDAY_TEXT,
  advAssetIdOf,
  birthdayClock,
  birthdayPeriod,
  codeOfBirthdayId,
  decorationIdOf,
  homeInfo,
  nextAdv,
  receivableIds,
  reconcileState,
  reminder,
  reminderYear,
  unwatchedIds,
  type BirthdayAdv,
  type BirthdayRemindView,
  type BirthdayState,
} from './birthdayLogic.ts';

const PROFILE_MSG = 'Solis.Common.Proto.Transaction.UserProfile';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const EVENT_INFO_MSG = 'Solis.Common.Proto.Api.HomeEventInfo';
const BANNER_INFO_MSG = 'Solis.Common.Proto.Api.BannerInfo';
const BANNER_MSG = 'Solis.Common.Proto.Api.Banner';
const BUTTON_MSG = 'Solis.Common.Proto.Api.EventButtonDisplayInfo';
const BIRTHDAY_INFO_MSG = 'Solis.Common.Proto.Api.BirthdayInfo';
const BIRTHDAY_ADV_INFO_MSG = 'Solis.Common.Proto.Api.BirthdayAdvInfo';

const BIRTHDAY_BANNER_ID = 'banner-user-birthday';
const BIRTHDAY_CONDITION_ID = 'cd-user-birthday';
const DECORATION_RESOURCE_TYPE = 26;

/**
 * Argument errors for the birthday endpoints all point the client back at the
 * home screen; any other action makes it retry the failing call in a loop.
 */
export function birthdayBadRequest(message: string): never {
  throw new AppRpcError(
    ERROR_CODE.INVALID_ARGUMENT,
    ERROR_ACTION.HOME,
    message,
    GRPC_STATUS.INVALID_ARGUMENT,
  );
}

function emptyUpdatedData(): Decoded {
  return { __msg: UPDATED_DATA_MSG };
}

function profileMonthDay(profile: Decoded | null): { month: number; day: number; favorites: string[] } {
  const month = profile?.BirthMonth != null ? Number(profile.BirthMonth) : 0;
  const day = profile?.BirthDay != null ? Number(profile.BirthDay) : 0;
  const raw = profile?.FavoriteCharacterIds;
  const favorites = Array.isArray(raw) ? raw.map((v: unknown) => String(v)) : [];
  return { month, day, favorites };
}

async function readState(playerId: string, tx: Executor): Promise<BirthdayState | null> {
  const [row] = await tx
    .select()
    .from(playerBirthdayState)
    .where(eq(playerBirthdayState.playerId, playerId))
    .limit(1);
  if (!row) return null;
  return {
    eventYear: Number(row.eventYear),
    birthdayIds: Array.isArray(row.birthdayIds) ? (row.birthdayIds as string[]) : [],
    watchedIds: Array.isArray(row.watchedIds) ? (row.watchedIds as string[]) : [],
    claimedIds: Array.isArray(row.claimedIds) ? (row.claimedIds as string[]) : [],
    remindedYear: Number(row.remindedYear),
  };
}

async function writeState(playerId: string, state: BirthdayState, tx: Executor): Promise<void> {
  const values = {
    eventYear: state.eventYear,
    birthdayIds: state.birthdayIds,
    watchedIds: state.watchedIds,
    claimedIds: state.claimedIds,
    remindedYear: state.remindedYear,
    updatedAt: new Date(),
  };
  await tx
    .insert(playerBirthdayState)
    .values({ playerId, ...values })
    .onConflictDoUpdate({ target: playerBirthdayState.playerId, set: values });
}

/**
 * Read the player's profile and birthday row, roll the state forward when the
 * event year changed, and persist it when needed.
 */
export async function loadReconciledBirthday(
  playerId: string,
  tx: Executor,
  nowMs: number,
): Promise<{ state: BirthdayState; month: number; day: number }> {
  const profile = (await getSingleton(playerId, 'Profile', tx)) ?? ({ __msg: PROFILE_MSG } as Decoded);
  const { month, day, favorites } = profileMonthDay(profile);
  const current = await readState(playerId, tx);
  const { state, changed } = reconcileState(current, month, day, favorites, nowMs);
  if (changed) await writeState(playerId, state, tx);
  return { state, month, day };
}

export type BirthdayLoginValues = {
  adv?: BirthdayAdv;
  remind?: BirthdayRemindView;
};

/** The Home:Login birthday fields for a player, without touching a decoded body. */
export async function birthdayLoginFields(
  playerId: string,
  nowMs: number = birthdayClock(),
): Promise<BirthdayLoginValues> {
  const { state, month, day } = await withPlayerTx(playerId, (tx) =>
    loadReconciledBirthday(playerId, tx, nowMs),
  );
  return {
    adv: nextAdv(state, month, day, nowMs),
    remind: reminder(state, month, day, nowMs),
  };
}

/** Set or clear the two Home:Login birthday fields. */
export async function applyBirthdayToHomeLogin(
  decoded: Decoded,
  playerId: string,
  values?: BirthdayLoginValues,
): Promise<void> {
  const fields = values ?? (await birthdayLoginFields(playerId));
  if (fields.adv) decoded.BirthdayAdvInfo = fields.adv;
  else delete decoded.BirthdayAdvInfo;
  if (fields.remind) decoded.BirthdayRemindInfo = fields.remind;
  else delete decoded.BirthdayRemindInfo;
}

function stripBirthdayFromHome(decoded: Decoded): void {
  if (decoded.EventInfo && typeof decoded.EventInfo === 'object') {
    delete decoded.EventInfo.HomeBirthdayInfo;
  }
  const banners = decoded.BannerInfo?.MenuBanners;
  if (Array.isArray(banners)) {
    decoded.BannerInfo.MenuBanners = banners.filter(
      (b: any) => String(b?.Id ?? '') !== BIRTHDAY_BANNER_ID,
    );
  }
  const buttons = decoded.EventButtonDisplayInfos;
  if (Array.isArray(buttons)) {
    decoded.EventButtonDisplayInfos = buttons.filter(
      (b: any) => String(b?.ConditionId ?? '') !== BIRTHDAY_CONDITION_ID,
    );
  }
}

/**
 * Replace any stale birthday block in a Home:Enter body and add the current
 * banner/button when the event window is open.
 */
export async function applyBirthdayToHomeEnter(decoded: Decoded, playerId: string): Promise<void> {
  stripBirthdayFromHome(decoded);
  const now = birthdayClock();
  const { state, month, day } = await withPlayerTx(playerId, (tx) =>
    loadReconciledBirthday(playerId, tx, now),
  );
  const info = homeInfo(state, month, day, now);
  if (!info) return;

  if (!decoded.EventInfo || typeof decoded.EventInfo !== 'object') {
    decoded.EventInfo = { __msg: EVENT_INFO_MSG };
  }
  decoded.EventInfo.HomeBirthdayInfo = info;

  if (!decoded.BannerInfo || typeof decoded.BannerInfo !== 'object') {
    decoded.BannerInfo = { __msg: BANNER_INFO_MSG };
  }
  if (!Array.isArray(decoded.BannerInfo.MenuBanners)) decoded.BannerInfo.MenuBanners = [];
  decoded.BannerInfo.MenuBanners.unshift({
    __msg: BANNER_MSG,
    Id: BIRTHDAY_BANNER_ID,
    AssetId: 'img_banner_s_user-birthday',
    Text: 'HAPPY BIRTHDAY！',
    LinkType: 108,
    Order: 1,
    ViewConditionId: BIRTHDAY_CONDITION_ID,
  });

  if (!Array.isArray(decoded.EventButtonDisplayInfos)) decoded.EventButtonDisplayInfos = [];
  decoded.EventButtonDisplayInfos.push({
    __msg: BUTTON_MSG,
    ConditionId: BIRTHDAY_CONDITION_ID,
    Priority: 2000,
    AssetId: 'event-user-birthday',
  });
}

async function birthdayInfoFor(id: string): Promise<Decoded | null> {
  const code = codeOfBirthdayId(id);
  if (!code) return null;
  const character = await getCharacter(`char-${code}`);
  // `master_Character` has no costume list in our schema, so check the derived
  // costume id against `master_Costume` and fall back to the default costume.
  const preferred = `cos-${code}-casl-00`;
  const costume = await getCostume(preferred);
  const costumeId =
    costume && String(costume.CharacterId ?? '') === `char-${code}`
      ? preferred
      : String(character?.DefaultCostumeId ?? '');
  return {
    __msg: BIRTHDAY_INFO_MSG,
    BirthdayAdvInfo: {
      __msg: BIRTHDAY_ADV_INFO_MSG,
      BirthdayId: id,
      AdvAssetId: advAssetIdOf(code),
    },
    Text: BIRTHDAY_CODES[code] ?? DEFAULT_BIRTHDAY_TEXT,
    CostumeId: costumeId,
  };
}

register(
  'Birthday:SetWatched',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const birthdayId = ctx.request?.BirthdayId != null ? String(ctx.request.BirthdayId) : '';
    if (!birthdayId) birthdayBadRequest('birthday id is required');
    const pl = await playerForAccount(accountId, 'Birthday:SetWatched');
    const now = birthdayClock();
    return withPlayerTx(pl.id, async (tx) => {
      const { state, month, day } = await loadReconciledBirthday(pl.id, tx, now);
      if (!birthdayPeriod(month, day, now).active || !state.birthdayIds.includes(birthdayId)) {
        birthdayBadRequest('invalid birthday id');
      }
      if (!state.watchedIds.includes(birthdayId)) {
        state.watchedIds = [...state.watchedIds, birthdayId];
        await writeState(pl.id, state, tx);
      }
      return {
        __msg: '',
        UnwatchAdvBirthdayIds: unwatchedIds(state, month, day, now),
        ReceivableRewardBirthdayIds: receivableIds(state, month, day, now),
        CommonResponse: commonResponse(emptyUpdatedData()),
      };
    });
  },
  { ownsState: true },
);

register(
  'Birthday:Top',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const pl = await playerForAccount(accountId, 'Birthday:Top');
    const now = birthdayClock();
    const result = await withPlayerTx(pl.id, async (tx) => {
      const { state, month, day } = await loadReconciledBirthday(pl.id, tx, now);
      const period = birthdayPeriod(month, day, now);
      const active = period.active && state.eventYear === period.year;
      return {
        state,
        month,
        day,
        active,
        unwatched: active ? unwatchedIds(state, month, day, now) : [],
        receivable: active ? receivableIds(state, month, day, now) : [],
      };
    });

    const infos: Decoded[] = [];
    if (result.active) {
      for (const id of result.state.birthdayIds) {
        const info = await birthdayInfoFor(id);
        if (info) infos.push(info);
      }
    }
    return {
      __msg: '',
      BirthdayInfos: infos,
      UnwatchedAdvBirthdayIds: result.unwatched,
      ReceivableRewardBirthdayIds: result.receivable,
      CommonResponse: commonResponse(emptyUpdatedData()),
    };
  },
  { ownsState: true },
);

register(
  'Birthday:OutputWatchedLog',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const birthdayId = ctx.request?.BirthdayId != null ? String(ctx.request.BirthdayId) : '';
    if (!birthdayId) birthdayBadRequest('birthday id is required');
    await playerForAccount(accountId, 'Birthday:OutputWatchedLog');
    return { __msg: '', CommonResponse: commonResponse(emptyUpdatedData()) };
  },
  { ownsState: true },
);

register(
  'Birthday:ReceiveReward',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const pl = await playerForAccount(accountId, 'Birthday:ReceiveReward');
    const now = birthdayClock();
    return withPlayerTx(pl.id, async (tx) => {
      const { state, month, day } = await loadReconciledBirthday(pl.id, tx, now);
      if (!birthdayPeriod(month, day, now).active) {
        birthdayBadRequest('birthday event is not active');
      }
      const rewardIds = receivableIds(state, month, day, now).filter(
        (id) => codeOfBirthdayId(id) !== null,
      );
      if (rewardIds.length === 0) {
        return {
          __msg: '',
          Rewards: [],
          CommonResponse: commonResponse(emptyUpdatedData()),
        };
      }

      const grants = rewardIds.map((id) => ({
        resourceType: DECORATION_RESOURCE_TYPE,
        resourceId: decorationIdOf(codeOfBirthdayId(id)!),
        amount: 1,
      }));
      const applied = await applyGrants(pl.id, grants, tx);
      state.claimedIds = [
        ...state.claimedIds,
        ...rewardIds.filter((id) => !state.claimedIds.includes(id)),
      ];
      await writeState(pl.id, state, tx);

      return {
        __msg: '',
        Rewards: applied.results,
        CommonResponse: commonResponse(applied.updated ?? emptyUpdatedData()),
      };
    });
  },
  { ownsState: true },
);

register(
  'Birthday:SetWatchedRemindInfo',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const pl = await playerForAccount(accountId, 'Birthday:SetWatchedRemindInfo');
    const now = birthdayClock();
    return withPlayerTx(pl.id, async (tx) => {
      const profile = (await getSingleton(pl.id, 'Profile', tx)) ?? ({ __msg: PROFILE_MSG } as Decoded);
      const { month, day } = profileMonthDay(profile);
      const year = reminderYear(month, day, now);
      if (year !== 0) {
        const current = await readState(pl.id, tx);
        const state: BirthdayState = current ?? {
          eventYear: 0,
          birthdayIds: [],
          watchedIds: [],
          claimedIds: [],
          remindedYear: 0,
        };
        state.remindedYear = year;
        await writeState(pl.id, state, tx);
      }
      return { __msg: '', CommonResponse: commonResponse(emptyUpdatedData()) };
    });
  },
  { ownsState: true },
);
