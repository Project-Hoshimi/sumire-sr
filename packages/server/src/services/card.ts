import { eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import {
  getActivityAbility,
  getCard,
  getCardLevel,
  getCardParameter,
  getCardRank,
  getCardRarity,
  getCardSupportRelease,
  getLiveAbility,
  getMaxCardLevel,
  getSetting,
  getSkill,
} from '../master/index.ts';
import { getCard as getUserCard, getItemAmount, grantItem, spendItem } from './inventory.ts';
import { unlockCardStories } from './cardStories.ts';
import { applyCardRelease, cardReleaseForCard } from './cardRelease.ts';
import { getCurrency, spendCurrency } from './currency.ts';
import { getSingleton, listElements, putElements, putSingleton, removeElements } from './playerState.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

const USER_CARD_MSG = 'Solis.Common.Proto.Transaction.UserCard';
const USER_ITEM_MSG = 'Solis.Common.Proto.Transaction.UserItem';
const USER_BALANCE_MSG = 'Solis.Common.Proto.Transaction.UserBalance';
const USER_MSG = 'Solis.Common.Proto.Transaction.User';
const CARD_ENHANCE_RESPONSE_MSG = 'Solis.Common.Proto.Api.CardEnhanceResponse';
const CARD_LIMIT_BREAK_RESPONSE_MSG = 'Solis.Common.Proto.Api.CardLimitBreakResponse';
const CARD_RANK_UP_RESPONSE_MSG = 'Solis.Common.Proto.Api.CardRankUpResponse';
const CARD_LIVE_ABILITY_ENHANCE_RESPONSE_MSG = 'Solis.Common.Proto.Api.CardLiveAbilityEnhanceResponse';
const CARD_ACTIVITY_ABILITY_ENHANCE_RESPONSE_MSG = 'Solis.Common.Proto.Api.CardActivityAbilityEnhanceResponse';
const CARD_SKILL_ENHANCE_RESPONSE_MSG = 'Solis.Common.Proto.Api.CardSkillEnhanceResponse';
const CARD_SET_SUPPORT_RESPONSE_MSG = 'Solis.Common.Proto.Api.CardSetSupportResponse';
const CARD_REMOVE_SUPPORT_RESPONSE_MSG = 'Solis.Common.Proto.Api.CardRemoveSupportResponse';
const CARD_RELEASE_SUPPORT_RESPONSE_MSG = 'Solis.Common.Proto.Api.CardReleaseSupportResponse';
const CARD_RESET_RESPONSE_MSG = 'Solis.Common.Proto.Api.CardResetResponse';
const CARD_UPDATE_DISPLAY_TYPE_RESPONSE_MSG = 'Solis.Common.Proto.Api.CardUpdateDisplayTypeResponse';
const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';

/**
 * Card enhancement material. One unit is worth one point of card EXP; the
 * captured response shows this single item covering the full enhancement cost,
 * so we mirror that. Tunable if a richer cost model is needed later.
 */
const CARD_ENHANCE_ITEM = 'item-card_enhance';

/** Slice 13 card materials. */
const CARD_LIMIT_BREAK_ITEM = 'item-card_limit_break';
const CARD_RANK_ITEM = 'item-card_rank';
const CARD_SKILL_ITEM = 'item-card_skill';
const CARD_ABILITY_ITEM = 'item-card_ability';

/**
 * Bloom Piece cost keyed by the *target* rarity (user-confirmed slice13 model:
 * 2->3=25, 3->4=25, 4->5=50, 5->6=100, 6->7=200, 7->8=200, 8->9=200, 9->10=400).
 * There is no master cost table for this.
 */
const LIMIT_BREAK_COST: Record<number, number> = { 3: 25, 4: 25, 5: 50, 6: 100, 7: 200, 8: 200, 9: 200, 10: 400 };

function accountOf(ctx: { auth: { ok: boolean; claims?: { sub?: string } } }): string {
  const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
  if (!accountId) throw new Error('unauthenticated');
  return accountId;
}

async function playerForAccount(accountId: string, rpc: string, exec: Executor = db) {
  const [pl] = await exec.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  if (!pl) throw new Error(`${rpc}: no player for account`);
  return pl;
}

function commonResponse(updated: Decoded | null, deleted: Decoded | null = null): Decoded {
  return {
    __msg: COMMON_RESPONSE_MSG,
    UpdatedData: (updated ?? { __msg: UPDATED_DATA_MSG }) as Decoded,
    DeletedData: (deleted ?? { __msg: DELETED_DATA_MSG }) as Decoded,
  } as Decoded;
}

function updatedData(...entries: Array<[string, unknown]>): Decoded {
  const out: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
  for (const [k, v] of entries) {
    if (v !== undefined && v !== null) out[k] = v as Decoded;
  }
  return out;
}

/** Run a card mutation inside a row-locked transaction. */
async function runCardRaw(
  accountId: string,
  rpc: string,
  fn: (tx: Executor, playerId: string) => Promise<Decoded>,
): Promise<Decoded> {
  const pl = await playerForAccount(accountId, rpc);
  return withPlayerTx(pl.id, (tx) => fn(tx, pl.id));
}

/** Run a card mutation inside a row-locked transaction and wrap CommonResponse. */
async function runCard(
  accountId: string,
  rpc: string,
  fn: (tx: Executor, playerId: string) => Promise<Decoded>,
): Promise<Decoded> {
  const updated = await runCardRaw(accountId, rpc, fn);
  return { __msg: '', CommonResponse: commonResponse(updated) } as Decoded;
}

async function loadUser(exec: Executor, playerId: string): Promise<Decoded> {
  return (await getSingleton(playerId, 'User', exec)) ?? ({ __msg: USER_MSG } as Decoded);
}

/** Read + require an owned card, or throw. */
async function requireCard(exec: Executor, playerId: string, cardId: string, rpc: string): Promise<Decoded> {
  const card = await getUserCard(playerId, cardId, exec);
  if (!card) throw new Error(`${rpc}: card not owned ${cardId}`);
  return card;
}

export function levelCap(rarity: number, rank: number, rarityRow: Decoded | null, rankRow: Decoded | null): number {
  const base = Number(rarityRow?.LevelLimit ?? 200);
  const up = Number(rankRow?.LevelLimitUpAmount ?? 0);
  return base + up;
}

/** Recompute a card's level-derived stats from an already-loaded parameter row. */
export function applyCardStatsFromParam(userCard: Decoded, mc: Decoded, param: Decoded | null): void {
  const value = Number(param?.Value ?? 0);
  const staminaValue = Number(param?.StaminaValue ?? 0);
  const scale = (ratio: unknown, base: number) => Math.round((Number(ratio ?? 0) * base) / 1000);
  const vocal = scale(mc.VocalRatioPermil, value);
  const dance = scale(mc.DanceRatioPermil, value);
  const visual = scale(mc.VisualRatioPermil, value);
  const stamina = scale(mc.StaminaRatioPermil, staminaValue);
  userCard.Vocal = vocal;
  userCard.Dance = dance;
  userCard.Visual = visual;
  userCard.Stamina = stamina;
  userCard.BaseVocal = vocal;
  userCard.BaseDance = dance;
  userCard.BaseVisual = visual;
  userCard.BaseStamina = stamina;
}

/** Recompute a card's level-derived stats from its master parameter ratios. */
async function applyCardStats(userCard: Decoded, mc: Decoded, level: number): Promise<void> {
  const param = await getCardParameter(String(mc.CardParameterId ?? ''), level);
  applyCardStatsFromParam(userCard, mc, param);
}

/** Spend stones, draining free jewels before paid. Returns a UserBalance slice. */
async function spendStone(
  exec: Executor,
  playerId: string,
  amount: number,
): Promise<Decoded> {
  const free = await getCurrency(playerId, 'freeJewel', exec);
  let remaining = amount;
  if (free >= remaining) {
    await spendCurrency(playerId, 'freeJewel', remaining, exec);
  } else {
    await spendCurrency(playerId, 'freeJewel', free, exec);
    remaining -= free;
    await spendCurrency(playerId, 'paidJewel', remaining, exec);
  }
  const freeAfter = await getCurrency(playerId, 'freeJewel', exec);
  const paidAfter = await getCurrency(playerId, 'paidJewel', exec);
  return { __msg: USER_BALANCE_MSG, FreeBalance: freeAfter, PaidBalance: paidAfter } as Decoded;
}

function itemSlice(itemId: string, amount: number): Decoded {
  return { __msg: USER_ITEM_MSG, ItemId: itemId, Amount: amount } as Decoded;
}


/**
 * `Card:Enhance` — server-authoritative. The request carries the target level;
 * we charge `item-card_enhance` for the EXP delta between the card's current
 * cumulative EXP and the master `CardLevel.RequiredExp` for the target, then
 * recompute the card's stats from its `CardParameter` ratios. Replaces the
 * captured replay, so any owned card can be enhanced (not just the corpus one).
 */
register(
  'Card:Enhance',
  async (ctx) => {
    const req = ctx.request;
    if (!req) throw new Error('Card:Enhance: missing request');

    const cardId = req.CardId == null ? '' : String(req.CardId);
    const targetLevel = Number(req.Level ?? 0);
    if (!cardId || targetLevel <= 0) throw new Error('Card:Enhance: missing CardId/Level');

    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('Card:Enhance: unauthenticated');
    const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
    if (!pl) throw new Error('Card:Enhance: no player for account');

    const mc = await getCard(cardId);
    if (!mc) throw new Error(`Card:Enhance: unknown card ${cardId}`);

    const result = await withPlayerTx(pl.id, async (tx) => {
      const userCard = await getUserCard(pl.id, cardId, tx);
      if (!userCard) throw new Error(`Card:Enhance: card not owned ${cardId}`);

      const currentLevel = Number(userCard.Level ?? 1);
      const currentExp = Number(userCard.TotalExp ?? 0);
      if (targetLevel <= currentLevel) {
        throw new Error(`Card:Enhance: target ${targetLevel} not above current ${currentLevel}`);
      }

      const maxLevel = await getMaxCardLevel();
      const finalLevel = Math.min(targetLevel, maxLevel);
      const levelRow = await getCardLevel(finalLevel);
      if (!levelRow) throw new Error(`Card:Enhance: no CardLevel ${finalLevel}`);

      const targetExp = Number(levelRow.RequiredExp ?? 0);
      const expNeeded = Math.max(0, targetExp - currentExp);
      await spendItem(pl.id, CARD_ENHANCE_ITEM, expNeeded, tx);

      const param = await getCardParameter(String(mc.CardParameterId ?? ''), finalLevel);
      const value = Number(param?.Value ?? 0);
      const staminaValue = Number(param?.StaminaValue ?? 0);
      const scale = (ratio: unknown, base: number) => Math.round((Number(ratio ?? 0) * base) / 1000);
      const vocal = scale(mc.VocalRatioPermil, value);
      const dance = scale(mc.DanceRatioPermil, value);
      const visual = scale(mc.VisualRatioPermil, value);
      const stamina = scale(mc.StaminaRatioPermil, staminaValue);
      const now = Date.now();

      const updatedCard: Decoded = {
        ...userCard,
        __msg: USER_CARD_MSG,
        CardId: cardId,
        Level: finalLevel,
        TotalExp: targetExp,
        Vocal: vocal,
        Dance: dance,
        Visual: visual,
        Stamina: stamina,
        BaseLevel: finalLevel,
        BaseVocal: vocal,
        BaseDance: dance,
        BaseVisual: visual,
        BaseStamina: stamina,
        LastEnhanceTime: now,
      };

      // Unlock any skills / abilities gated behind the new level (e.g. Skill#2
      // at Lv20, Live/Activity abilities at Lv30, Skill#3 at Lv80).
      applyCardRelease(updatedCard, mc, await cardReleaseForCard(mc, finalLevel, Number(userCard.EvolutionLevel ?? 0)));

      await putElements(pl.id, 'Cards', [updatedCard], tx);

      // Unlock any card stories gated behind the new level (PLANS §1.7).
      const unlockedStories = await unlockCardStories(pl.id, cardId, finalLevel, tx);

      const remaining = await getItemAmount(pl.id, CARD_ENHANCE_ITEM, tx);
      const updatedItem: Decoded = {
        __msg: USER_ITEM_MSG,
        ItemId: CARD_ENHANCE_ITEM,
        Amount: remaining,
      };

      ctx.fastifyReq.log.info(
        { accountId, serverUserId: pl.id, cardId, from: currentLevel, to: finalLevel, expNeeded },
        'card enhance (server-authoritative)',
      );

      return {
        card: updatedCard,
        item: updatedItem,
        finalLevel,
        expNeeded,
        unlockedStories,
      };
    });

    const stories = result.unlockedStories.length > 0 ? result.unlockedStories : undefined;
    return {
      __msg: CARD_ENHANCE_RESPONSE_MSG,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: {
          __msg: UPDATED_DATA_MSG,
          Items: [result.item],
          Cards: [result.card],
          Stories: stories,
        },
        DeletedData: { __msg: DELETED_DATA_MSG },
      },
    } as Decoded;
  },
  { ownsState: true },
);

const REWARD_MSG = 'Solis.Common.Proto.Transaction.Reward';
const CARD_SUPPORT_MSG = 'Solis.Common.Proto.Transaction.UserCardSupport';

/**
 * `Card:LimitBreak` — raise a card's rarity. Hardcoded Bloom Piece cost keyed by
 * the target rarity (user-confirmed model; no master cost table exists).
 */
register(
  'Card:LimitBreak',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const cardId = ctx.request?.CardId == null ? '' : String(ctx.request.CardId);
    const target = Number(ctx.request?.Rarity ?? 0);
    if (!cardId || target <= 0) throw new Error('Card:LimitBreak: missing CardId/Rarity');

    const mc = await getCard(cardId);
    if (!mc) throw new Error(`Card:LimitBreak: unknown card ${cardId}`);

    return runCard(accountId, 'Card:LimitBreak', async (tx, playerId) => {
      const userCard = await requireCard(tx, playerId, cardId, 'Card:LimitBreak');
      const current = Number(userCard.Rarity ?? mc.InitialRarity ?? 1);
      if (target <= current) throw new Error(`Card:LimitBreak: target ${target} not above current ${current}`);

      const cost = LIMIT_BREAK_COST[target];
      if (!cost) throw new Error(`Card:LimitBreak: unsupported target rarity ${target}`);
      await spendItem(playerId, CARD_LIMIT_BREAK_ITEM, cost, tx);

      const rarityRow = await getCardRarity(target);
      const rank = Number(userCard.Rank ?? 0);
      const rankRow = await getCardRank(rank);
      userCard.Rarity = target;
      userCard.RarityTotalExp = Number(rarityRow?.RequiredExp ?? 0);
      const cap = levelCap(target, rank, rarityRow, rankRow);
      if (Number(userCard.Level ?? 1) > cap) {
        userCard.Level = cap;
        await applyCardStats(userCard, mc, cap);
      }
      applyCardRelease(userCard, mc, await cardReleaseForCard(mc, Number(userCard.Level ?? 1), Number(userCard.EvolutionLevel ?? 0)));
      await putElements(playerId, 'Cards', [userCard], tx);

      const remaining = await getItemAmount(playerId, CARD_LIMIT_BREAK_ITEM, tx);
      ctx.fastifyReq.log.info({ accountId, playerId, cardId, from: current, to: target, cost }, 'card limit break');
      return updatedData(['Items', [itemSlice(CARD_LIMIT_BREAK_ITEM, remaining)]], ['Cards', [userCard]]);
    });
  },
  { ownsState: true },
);

/**
 * `Card:RankUp` — rank points are `CardRank[target].RequiredExp / 5` Potential
 * Pieces summed across each rank step from current+1 to target.
 */
register(
  'Card:RankUp',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const cardId = ctx.request?.CardId == null ? '' : String(ctx.request.CardId);
    const target = Number(ctx.request?.Rank ?? -1);
    if (!cardId || target < 0) throw new Error('Card:RankUp: missing CardId/Rank');

    const mc = await getCard(cardId);
    if (!mc) throw new Error(`Card:RankUp: unknown card ${cardId}`);

    return runCard(accountId, 'Card:RankUp', async (tx, playerId) => {
      const userCard = await requireCard(tx, playerId, cardId, 'Card:RankUp');
      const current = Number(userCard.Rank ?? 0);
      if (target <= current) throw new Error(`Card:RankUp: target ${target} not above current ${current}`);

      let sum = 0;
      for (let r = current + 1; r <= target; r += 1) {
        const row = await getCardRank(r);
        if (!row) throw new Error(`Card:RankUp: no CardRank ${r}`);
        sum += Number(row.RequiredExp ?? 0);
      }
      const cost = Math.floor(sum / 5);
      await spendItem(playerId, CARD_RANK_ITEM, cost, tx);

      const rankRow = await getCardRank(target);
      userCard.Rank = target;
      userCard.RankTotalExp = Number(rankRow?.RequiredExp ?? 0);
      const rarity = Number(userCard.Rarity ?? mc.InitialRarity ?? 1);
      const rarityRow = await getCardRarity(rarity);
      const cap = levelCap(rarity, target, rarityRow, rankRow);
      if (Number(userCard.Level ?? 1) > cap) {
        userCard.Level = cap;
        await applyCardStats(userCard, mc, cap);
      }
      applyCardRelease(userCard, mc, await cardReleaseForCard(mc, Number(userCard.Level ?? 1), Number(userCard.EvolutionLevel ?? 0)));
      await putElements(playerId, 'Cards', [userCard], tx);

      const remaining = await getItemAmount(playerId, CARD_RANK_ITEM, tx);
      ctx.fastifyReq.log.info({ accountId, playerId, cardId, rank: target, cost }, 'card rank up');
      return updatedData(['Items', [itemSlice(CARD_RANK_ITEM, remaining)]], ['Cards', [userCard]]);
    });
  },
  { ownsState: true },
);

/**
 * `Card:LiveAbilityEnhance` — advance the card's live ability one level. The
 * target level is not in the request, so it is current+1; cost comes from the
 * master `LiveAbility.Levels[].RequiredItemAmount` Skill Powder.
 */
register(
  'Card:LiveAbilityEnhance',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const cardId = ctx.request?.CardId == null ? '' : String(ctx.request.CardId);
    const abilityId = ctx.request?.AbilityId == null ? '' : String(ctx.request.AbilityId);
    if (!cardId || !abilityId) throw new Error('Card:LiveAbilityEnhance: missing CardId/AbilityId');

    const mc = await getCard(cardId);
    if (!mc) throw new Error(`Card:LiveAbilityEnhance: unknown card ${cardId}`);
    if (String(mc.LiveAbilityId ?? '') !== abilityId) {
      throw new Error(`Card:LiveAbilityEnhance: ${abilityId} not the live ability of ${cardId}`);
    }
    const ability = await getLiveAbility(abilityId);
    if (!ability) throw new Error(`Card:LiveAbilityEnhance: unknown LiveAbility ${abilityId}`);

    return runCard(accountId, 'Card:LiveAbilityEnhance', async (tx, playerId) => {
      const userCard = await requireCard(tx, playerId, cardId, 'Card:LiveAbilityEnhance');
      const release = await cardReleaseForCard(mc, Number(userCard.Level ?? 1), Number(userCard.EvolutionLevel ?? 0));
      if (!release.liveAbility) {
        throw new Error(`Card:LiveAbilityEnhance: live ability not unlocked at level ${userCard.Level}`);
      }
      const current = Number(userCard.LiveAbilityLevel ?? 1);
      const target = current + 1;
      const levels = ((ability.Levels as Decoded[] | null) ?? []) as Decoded[];
      const lvl = levels.find((l) => Number(l.Level) === target);
      if (!lvl) throw new Error(`Card:LiveAbilityEnhance: ${abilityId} max level ${current}`);
      if (Number(userCard.Level ?? 1) < Number(lvl.RequiredCardLevel ?? 0)) {
        throw new Error(`Card:LiveAbilityEnhance: card level below ${lvl.RequiredCardLevel}`);
      }
      const amount = Number(lvl.RequiredItemAmount ?? 0);
      await spendItem(playerId, CARD_SKILL_ITEM, amount, tx);
      userCard.LiveAbilityLevel = target;
      userCard.BaseLiveAbilityLevel = target;
      await putElements(playerId, 'Cards', [userCard], tx);

      const remaining = await getItemAmount(playerId, CARD_SKILL_ITEM, tx);
      return updatedData(['Items', [itemSlice(CARD_SKILL_ITEM, remaining)]], ['Cards', [userCard]]);
    });
  },
  { ownsState: true },
);

/** `Card:ActivityAbilityEnhance` — same shape as live, but Cheer Powder. */
register(
  'Card:ActivityAbilityEnhance',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const cardId = ctx.request?.CardId == null ? '' : String(ctx.request.CardId);
    const abilityId = ctx.request?.AbilityId == null ? '' : String(ctx.request.AbilityId);
    if (!cardId || !abilityId) throw new Error('Card:ActivityAbilityEnhance: missing CardId/AbilityId');

    const mc = await getCard(cardId);
    if (!mc) throw new Error(`Card:ActivityAbilityEnhance: unknown card ${cardId}`);
    if (String(mc.ActivityAbilityId ?? '') !== abilityId) {
      throw new Error(`Card:ActivityAbilityEnhance: ${abilityId} not the activity ability of ${cardId}`);
    }
    const ability = await getActivityAbility(abilityId);
    if (!ability) throw new Error(`Card:ActivityAbilityEnhance: unknown ActivityAbility ${abilityId}`);

    return runCard(accountId, 'Card:ActivityAbilityEnhance', async (tx, playerId) => {
      const userCard = await requireCard(tx, playerId, cardId, 'Card:ActivityAbilityEnhance');
      const release = await cardReleaseForCard(mc, Number(userCard.Level ?? 1), Number(userCard.EvolutionLevel ?? 0));
      if (!release.activityAbility) {
        throw new Error(`Card:ActivityAbilityEnhance: activity ability not unlocked at level ${userCard.Level}`);
      }
      const current = Number(userCard.ActivityAbilityLevel ?? 1);
      const target = current + 1;
      const levels = ((ability.Levels as Decoded[] | null) ?? []) as Decoded[];
      const lvl = levels.find((l) => Number(l.Level) === target);
      if (!lvl) throw new Error(`Card:ActivityAbilityEnhance: ${abilityId} max level ${current}`);
      if (Number(userCard.Level ?? 1) < Number(lvl.RequiredCardLevel ?? 0)) {
        throw new Error(`Card:ActivityAbilityEnhance: card level below ${lvl.RequiredCardLevel}`);
      }
      const amount = Number(lvl.RequiredItemAmount ?? 0);
      await spendItem(playerId, CARD_ABILITY_ITEM, amount, tx);
      userCard.ActivityAbilityLevel = target;
      userCard.BaseActivityAbilityLevel = target;
      await putElements(playerId, 'Cards', [userCard], tx);

      const remaining = await getItemAmount(playerId, CARD_ABILITY_ITEM, tx);
      return updatedData(['Items', [itemSlice(CARD_ABILITY_ITEM, remaining)]], ['Cards', [userCard]]);
    });
  },
  { ownsState: true },
);

/** `Card:SkillEnhance` — advance the matching skill slot (1..4) one level. */
register(
  'Card:SkillEnhance',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const cardId = ctx.request?.CardId == null ? '' : String(ctx.request.CardId);
    const skillId = ctx.request?.SkillId == null ? '' : String(ctx.request.SkillId);
    if (!cardId || !skillId) throw new Error('Card:SkillEnhance: missing CardId/SkillId');

    const mc = await getCard(cardId);
    if (!mc) throw new Error(`Card:SkillEnhance: unknown card ${cardId}`);
    const slot = [1, 2, 3, 4].find((n) => String((mc as Decoded)[`SkillId${n}`] ?? '') === skillId);
    if (!slot) throw new Error(`Card:SkillEnhance: ${skillId} not a skill of ${cardId}`);
    const skill = await getSkill(skillId);
    if (!skill) throw new Error(`Card:SkillEnhance: unknown Skill ${skillId}`);

    return runCard(accountId, 'Card:SkillEnhance', async (tx, playerId) => {
      const userCard = await requireCard(tx, playerId, cardId, 'Card:SkillEnhance');
      const release = await cardReleaseForCard(mc, Number(userCard.Level ?? 1), Number(userCard.EvolutionLevel ?? 0));
      if (!release.skillSlots.includes(slot)) {
        throw new Error(`Card:SkillEnhance: skill slot ${slot} not unlocked at level ${userCard.Level}`);
      }
      const current = Number(userCard[`SkillLevel${slot}`] ?? 1);
      const target = current + 1;
      const levels = ((skill.Levels as Decoded[] | null) ?? []) as Decoded[];
      const lvl = levels.find((l) => Number(l.Level) === target);
      if (!lvl) throw new Error(`Card:SkillEnhance: ${skillId} max level ${current}`);
      if (Number(userCard.Level ?? 1) < Number(lvl.RequiredCardLevel ?? 0)) {
        throw new Error(`Card:SkillEnhance: card level below ${lvl.RequiredCardLevel}`);
      }
      const amount = Number(lvl.RequiredItemAmount ?? 0);
      await spendItem(playerId, CARD_SKILL_ITEM, amount, tx);
      userCard[`SkillLevel${slot}`] = target;
      userCard[`BaseSkillLevel${slot}`] = target;
      await putElements(playerId, 'Cards', [userCard], tx);

      const remaining = await getItemAmount(playerId, CARD_SKILL_ITEM, tx);
      return updatedData(['Items', [itemSlice(CARD_SKILL_ITEM, remaining)]], ['Cards', [userCard]]);
    });
  },
  { ownsState: true },
);

/** `Card:SetSupport` — assign a card to a support slot (idempotent per slot). */
register(
  'Card:SetSupport',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const cardId = ctx.request?.CardId == null ? '' : String(ctx.request.CardId);
    const number = Number(ctx.request?.Number ?? 0);
    if (!cardId || number <= 0) throw new Error('Card:SetSupport: missing Number/CardId');

    const mc = await getCard(cardId);
    if (!mc) throw new Error(`Card:SetSupport: unknown card ${cardId}`);

    return runCard(accountId, 'Card:SetSupport', async (tx, playerId) => {
      const userCard = await requireCard(tx, playerId, cardId, 'Card:SetSupport');
      const setting = await getSetting();
      const max = Number(setting?.CardSupportLevelLimit ?? 215);
      if (number > max) throw new Error(`Card:SetSupport: slot ${number} beyond max ${max}`);

      const supports = await listElements(playerId, 'CardSupports', tx);
      const existing = supports.find((s) => Number(s.Number) === number);
      if (existing) await removeElements(playerId, 'CardSupports', [existing], tx);

      const support: Decoded = { __msg: CARD_SUPPORT_MSG, Number: number, CardId: cardId, RemovableTime: 0 };
      await putElements(playerId, 'CardSupports', [support], tx);
      userCard.Supported = true;
      await putElements(playerId, 'Cards', [userCard], tx);

      ctx.fastifyReq.log.info({ accountId, playerId, cardId, number }, 'card set support');
      return updatedData(['CardSupports', [support]], ['Cards', [userCard]]);
    });
  },
  { ownsState: true },
);

/** `Card:RemoveSupport` — free a support slot and return the card as a reward. */
register(
  'Card:RemoveSupport',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const number = Number(ctx.request?.Number ?? 0);
    if (number <= 0) throw new Error('Card:RemoveSupport: missing Number');

    let rewardCardId = '';
    const updated = await runCardRaw(accountId, 'Card:RemoveSupport', async (tx, playerId) => {
      const supports = await listElements(playerId, 'CardSupports', tx);
      const support = supports.find((s) => Number(s.Number) === number);
      if (!support) throw new Error(`Card:RemoveSupport: no support in slot ${number}`);
      const cardId = String(support.CardId ?? '');
      rewardCardId = cardId;
      await removeElements(playerId, 'CardSupports', [support], tx);

      const userCard = cardId ? await getUserCard(playerId, cardId, tx) : null;
      if (userCard) {
        userCard.Supported = false;
        await putElements(playerId, 'Cards', [userCard], tx);
      }
      return updatedData(['Cards', userCard ? [userCard] : undefined]);
    });

    const rewards: Decoded[] = rewardCardId
      ? [{ __msg: REWARD_MSG, ResourceType: 2, ResourceId: rewardCardId, Amount: 1 } as Decoded]
      : [];
    return { __msg: '', Rewards: rewards, CommonResponse: commonResponse(updated) } as Decoded;
  },
  { ownsState: true },
);

/**
 * `Card:ReleaseSupport` — unlock the next support slot. Cost comes from
 * `CardSupportRelease[count]`, paid either in the item or stones.
 */
register(
  'Card:ReleaseSupport',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const useStone = Boolean(ctx.request?.UseStone);

    return runCard(accountId, 'Card:ReleaseSupport', async (tx, playerId) => {
      const user = await loadUser(tx, playerId);
      const next = Number(user.CardSupportReleaseCount ?? 0) + 1;
      const row = await getCardSupportRelease(next);
      if (!row) throw new Error(`Card:ReleaseSupport: no release step ${next}`);

      let balance: Decoded | null = null;
      if (useStone) {
        balance = await spendStone(tx, playerId, Number(row.StoneAmount ?? 0));
      } else {
        await spendItem(playerId, String(row.ItemId ?? ''), Number(row.ItemAmount ?? 0), tx);
      }
      user.CardSupportReleaseCount = next;
      await putSingleton(playerId, 'User', user, tx);

      const entries: Array<[string, unknown]> = [['User', user]];
      if (balance) entries.push(['Balance', balance]);
      if (!useStone && row.ItemId) {
        entries.push(['Items', [itemSlice(String(row.ItemId), await getItemAmount(playerId, String(row.ItemId), tx))]]);
      }
      ctx.fastifyReq.log.info({ accountId, playerId, count: next, useStone }, 'card release support');
      return updatedData(...entries);
    });
  },
  { ownsState: true },
);

/**
 * `Card:Reset` — return a card to level 1 for stones; refunds the accumulated
 * enhancement EXP as Lesson Pieces.
 */
register(
  'Card:Reset',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const cardId = ctx.request?.CardId == null ? '' : String(ctx.request.CardId);
    if (!cardId) throw new Error('Card:Reset: missing CardId');

    const mc = await getCard(cardId);
    if (!mc) throw new Error(`Card:Reset: unknown card ${cardId}`);

    let refund = 0;
    const updated = await runCardRaw(accountId, 'Card:Reset', async (tx, playerId) => {
      const userCard = await requireCard(tx, playerId, cardId, 'Card:Reset');
      const setting = await getSetting();
      const stone = Number(setting?.CardResetStoneAmount ?? 50);
      const balance = await spendStone(tx, playerId, stone);

      refund = Number(userCard.TotalExp ?? 0);
      if (refund > 0) await grantItem(playerId, CARD_ENHANCE_ITEM, refund, tx);

      await applyCardStats(userCard, mc, 1);
      userCard.Level = 1;
      userCard.TotalExp = 0;
      userCard.BaseLevel = 1;
      userCard.LiveAbilityLevel = 1;
      userCard.BaseLiveAbilityLevel = 1;
      userCard.ActivityAbilityLevel = 1;
      userCard.BaseActivityAbilityLevel = 1;
      for (const n of [1, 2, 3, 4]) {
        userCard[`SkillLevel${n}`] = 1;
        userCard[`BaseSkillLevel${n}`] = 1;
      }
      applyCardRelease(userCard, mc, await cardReleaseForCard(mc, 1, Number(userCard.EvolutionLevel ?? 0)));
      await putElements(playerId, 'Cards', [userCard], tx);

      const remaining = await getItemAmount(playerId, CARD_ENHANCE_ITEM, tx);
      ctx.fastifyReq.log.info({ accountId, playerId, cardId, refund }, 'card reset');
      return updatedData(
        ['Cards', [userCard]],
        ['Items', [itemSlice(CARD_ENHANCE_ITEM, remaining)]],
        ['Balance', balance],
      );
    });

    const rewards: Decoded[] = refund > 0
      ? [{ __msg: REWARD_MSG, ResourceType: 1, ResourceId: CARD_ENHANCE_ITEM, Amount: refund } as Decoded]
      : [];
    return { __msg: '', Rewards: rewards, CommonResponse: commonResponse(updated) } as Decoded;
  },
  { ownsState: true },
);

/** `Card:UpdateDisplayType` — set the card art variant shown. */
register(
  'Card:UpdateDisplayType',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const cardId = ctx.request?.CardId == null ? '' : String(ctx.request.CardId);
    const displayType = Number(ctx.request?.DisplayType ?? 0);
    if (!cardId) throw new Error('Card:UpdateDisplayType: missing CardId');

    const mc = await getCard(cardId);
    if (!mc) throw new Error(`Card:UpdateDisplayType: unknown card ${cardId}`);

    return runCard(accountId, 'Card:UpdateDisplayType', async (tx, playerId) => {
      const userCard = await requireCard(tx, playerId, cardId, 'Card:UpdateDisplayType');
      userCard.DisplayType = displayType;
      await putElements(playerId, 'Cards', [userCard], tx);
      return updatedData(['Cards', [userCard]]);
    });
  },
  { ownsState: true },
);
