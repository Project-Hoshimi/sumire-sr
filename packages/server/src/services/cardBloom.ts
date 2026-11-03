import { db } from '../db/client.ts';
import { type Executor } from '../db/tx.ts';
import {
  getCard as getMasterCard,
  getCardDuplicateExp,
  getCardDuplicateReward,
  getCardRarity,
} from '../master/index.ts';
import { getCard as getPlayerCard, getItemAmount, grantItem } from './inventory.ts';
import { putElements } from './playerState.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

const REWARD_RESULT_MSG = 'Solis.Common.Proto.Transaction.RewardResult';
const USER_ITEM_MSG = 'Solis.Common.Proto.Transaction.UserItem';
const CARD_MSG = 'Solis.Common.Proto.Transaction.UserCard';

// Universal "Bloom Piece" item (ブルームピース). Dedicated 開花Pt beyond the
// ★10 cap converts into this (officially delivered via the gift box; granted
// directly here).
const BLOOM_PIECE_ITEM_ID = 'item-card_limit_break';
const RESOURCE_ITEM = 1;
const RESOURCE_BLOOM_PT = 25;

export type CardBloomApply = {
  card: Decoded | null;
  items: Decoded[];
  results: Decoded[];
  beforeExp: number;
  afterExp: number;
  bloomed: boolean;
  overflow: number;
};

/**
 * Dedicated bloom Pt (才能開花Pt, ResourceType 25 "CardRarityExpLimitChange").
 *
 * Official semantics (Gacha master Precaution + CardRarity/CardDuplicateExp):
 *  - Pt accumulates on the owned card's `RarityTotalExp` (cumulative).
 *  - Reaching the next rarity's `RequiredExp` auto-blooms the card (rarity up;
 *    exp is never reset). ★10 holds at most RequiredExp(10) = 1210.
 *  - Overflow past the cap converts into universal Bloom Pieces.
 *  - A pickup acquisition grants the banner's CardRewards set-item (+100Pt) —
 *    callers pass the amount; duplicates credit CardDuplicateExp instead.
 *  - Pt granted for a card the player does not own (shop packs, etc.) falls
 *    back to universal Bloom Pieces.
 */
export async function applyCardBloomPt(
  playerId: string,
  cardId: string,
  pt: number,
  exec: Executor = db,
): Promise<CardBloomApply> {
  const items: Decoded[] = [];
  const results: Decoded[] = [];
  const ret = (
    card: Decoded | null,
    before: number,
    after: number,
    bloomed: boolean,
    overflow: number,
  ): CardBloomApply => ({ card, items, results, beforeExp: before, afterExp: after, bloomed, overflow });

  if (pt <= 0) return ret(null, 0, 0, false, 0);

  const owned = await getPlayerCard(playerId, cardId, exec);
  if (!owned) {
    // Unowned card: no dedicated storage exists — credit Bloom Pieces.
    const before = await getItemAmount(playerId, BLOOM_PIECE_ITEM_ID, exec);
    await grantItem(playerId, BLOOM_PIECE_ITEM_ID, pt, exec);
    items.push({ __msg: USER_ITEM_MSG, ItemId: BLOOM_PIECE_ITEM_ID, Amount: before + pt } as Decoded);
    results.push({
      __msg: REWARD_RESULT_MSG,
      ResourceType: RESOURCE_BLOOM_PT,
      ResourceId: cardId,
      BeforeAmount: before,
      AfterAmount: before + pt,
      AmountI64: pt,
    } as Decoded);
    return ret(null, 0, 0, false, 0);
  }

  const beforeExp = Number(owned.RarityTotalExp ?? 0);
  let rarity = owned.Rarity != null ? Number(owned.Rarity) : Number(owned.InitialRarity ?? 0);
  let exp = beforeExp + pt;
  let bloomed = false;
  while (rarity < 10) {
    const next = await getCardRarity(rarity + 1);
    const need = Number(next?.RequiredExp ?? 0);
    if (!need || exp < need) break;
    rarity += 1;
    bloomed = true;
  }
  // ★10 caps dedicated Pt; the excess converts to Bloom Pieces.
  const maxExp = Number((await getCardRarity(10))?.RequiredExp ?? 1210);
  let overflow = 0;
  if (exp > maxExp) {
    overflow = exp - maxExp;
    exp = maxExp;
  }
  const card = { ...owned, __msg: owned.__msg ?? CARD_MSG, Rarity: rarity, RarityTotalExp: exp } as Decoded;
  await putElements(playerId, 'Cards', [card], exec);
  results.push({
    __msg: REWARD_RESULT_MSG,
    ResourceType: RESOURCE_BLOOM_PT,
    ResourceId: cardId,
    BeforeAmount: beforeExp,
    AfterAmount: exp,
    AmountI64: pt,
  } as Decoded);
  if (overflow > 0) {
    const pieceBefore = await getItemAmount(playerId, BLOOM_PIECE_ITEM_ID, exec);
    await grantItem(playerId, BLOOM_PIECE_ITEM_ID, overflow, exec);
    items.push({ __msg: USER_ITEM_MSG, ItemId: BLOOM_PIECE_ITEM_ID, Amount: pieceBefore + overflow } as Decoded);
    results.push({
      __msg: REWARD_RESULT_MSG,
      ResourceType: RESOURCE_ITEM,
      ResourceId: BLOOM_PIECE_ITEM_ID,
      BeforeAmount: pieceBefore,
      AfterAmount: pieceBefore + overflow,
      AmountI64: overflow,
    } as Decoded);
  }
  return ret(card, beforeExp, exp, bloomed, overflow);
}

export type DuplicateMedal = { itemId: string; amount: number; result: Decoded };

/**
 * Duplicate conversion: medal(s) per CardDuplicateReward, keyed on the owned
 * card's InitialRarity × CURRENT rarity (a re-bloomed duplicate pays more).
 * Reward rows are inline `rd_auto;item;item-gacha_medal;N` grants.
 */
export async function grantDuplicateMedal(
  playerId: string,
  cardId: string,
  exec: Executor = db,
): Promise<DuplicateMedal | null> {
  const master = await getMasterCard(cardId);
  const owned = await getPlayerCard(playerId, cardId, exec);
  if (!master || !owned) return null;
  const initial = Number(master.InitialRarity ?? 1);
  const current = owned.Rarity != null ? Number(owned.Rarity) : initial;
  const dup = await getCardDuplicateReward(initial, current);
  const rewardId = dup?.RewardId ? String(dup.RewardId) : '';
  if (!rewardId.startsWith('rd_auto;')) return null;
  const [, typeName = '', resourceId = '', amountRaw = '1'] = rewardId.split(';');
  if (typeName !== 'item' || !resourceId) return null;
  const amount = Number(amountRaw) || 0;
  if (amount <= 0) return null;
  const before = await getItemAmount(playerId, resourceId, exec);
  await grantItem(playerId, resourceId, amount, exec);
  return {
    itemId: resourceId,
    amount,
    result: {
      __msg: REWARD_RESULT_MSG,
      ResourceType: RESOURCE_ITEM,
      ResourceId: resourceId,
      BeforeAmount: before,
      AfterAmount: before + amount,
      AmountI64: amount,
    } as Decoded,
  };
}
