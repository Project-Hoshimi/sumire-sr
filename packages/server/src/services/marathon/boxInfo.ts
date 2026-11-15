/**
 * Shared `MarathonBoxGachaInfo` builder used by `Marathon:Top` and
 * `Marathon:ResetBoxGacha`. Stock comes from the catalogue plus per-player
 * state; the unlock gate combines the setting's point threshold with the
 * master `BoxGacha.UnlockConditionId` condition.
 */
import { and, eq } from 'drizzle-orm';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { db } from '../../db/client.ts';
import type { Executor } from '../../db/tx.ts';
import { playerMarathonPoint } from '../../db/schema.ts';
import { getBoxGacha } from '../../master/index.ts';
import type { ConditionEvaluator } from '../conditions.ts';
import { boxItemStocks, isBoxFull, remainResetCount } from './box.ts';
import type { MarathonConfig } from './catalog.ts';
import type { MarathonState } from './state.ts';
import { marathonConditionMet } from './unlock.ts';

const BOX_GACHA_INFO_MSG = 'Solis.Common.Proto.Api.MarathonBoxGachaInfo';
const BOX_GACHA_ITEM_MSG = 'Solis.Common.Proto.Api.BoxGachaItem';

/** The player's marathon point; the same query `Marathon:Top` has always used. */
export async function marathonPoints(
  playerId: string,
  marathonId: string,
  exec: Executor = db,
): Promise<number> {
  const [pointRow] = await exec
    .select({ point: playerMarathonPoint.point })
    .from(playerMarathonPoint)
    .where(
      and(
        eq(playerMarathonPoint.playerId, playerId),
        eq(playerMarathonPoint.marathonId, marathonId),
      ),
    )
    .limit(1);
  return Number(pointRow?.point ?? 0);
}

/**
 * Build the client-facing info for one `MarathonBoxGachaSetting` row.
 * `point` is the player's current marathon point (see `marathonPoints`).
 * Pass one `evaluator` per request so condition results are cached.
 */
export async function buildBoxGachaInfo(
  playerId: string,
  config: MarathonConfig,
  setting: Decoded,
  state: MarathonState,
  point: number,
  exec: Executor = db,
  evaluator?: ConditionEvaluator,
): Promise<Decoded> {
  const boxGachaId = setting.BoxGachaId == null ? '' : String(setting.BoxGachaId);
  const requiredPoint = Number(setting.UnlockRequiredPoint ?? 0);
  const items = config.boxGachas?.[boxGachaId]?.items ?? [];
  const boxState = state.boxes?.[boxGachaId];
  const drawn = boxState?.drawn ?? {};
  const resetCount = boxState?.resetCount ?? 0;
  const boxGacha = await getBoxGacha(boxGachaId);

  const reachable = point >= requiredPoint;
  const conditionMet = await marathonConditionMet(
    playerId,
    boxGacha?.UnlockConditionId != null ? String(boxGacha.UnlockConditionId) : '',
    exec,
    evaluator,
  );

  return {
    __msg: BOX_GACHA_INFO_MSG,
    BoxGachaId: boxGachaId,
    BoxGachaItems: boxItemStocks(items, drawn).map(({ def, stock }) => ({
      __msg: BOX_GACHA_ITEM_MSG,
      Order: def.order,
      ItemType: def.itemType,
      RewardId: def.rewardId ?? '',
      LiveBonusGroupId: def.liveBonusGroupId ?? '',
      // The client sums these fields into the "Left" total, so infinite items send 0.
      InitialStock: def.isLimited === true ? def.initialStock : 0,
      Stock: def.isLimited === true ? stock : 0,
      IsLimited: def.isLimited === true,
      AssetId: def.assetId ?? '',
      Description: def.description ?? '',
    }) as Decoded),
    // IsFull = nothing drawn yet; the client blocks Reset on a full box.
    IsFull: isBoxFull(items, drawn),
    CurrentMarathonPoint: point,
    Unlocked: reachable && conditionMet,
    RemainResetCount: remainResetCount(
      {
        canReset: boxGacha?.CanReset === true,
        resetLimitCount: Number(boxGacha?.ResetLimitCount ?? 0),
      },
      resetCount,
    ),
  } as Decoded;
}
