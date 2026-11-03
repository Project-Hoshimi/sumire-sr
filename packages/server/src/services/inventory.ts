import { db } from '../db/client.ts';
import { type Executor } from '../db/tx.ts';
import {
  collectionElementMsg,
  listElements,
  putElements,
  removeElements,
} from './playerState.ts';
import { evolveOnDuplicate } from './cardEvolution.ts';
import { unlockCardStories } from './cardStories.ts';
import { applyCardRelease, cardReleaseForCard } from './cardRelease.ts';
import { getCard as getMasterCard, getCardParameter, getCardRarity } from '../master/index.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Item / card inventory helpers over the generic `player_entities` store.
 *
 * `Items` elements are `Solis.Common.Proto.Transaction.UserItem` blobs keyed by
 * `ItemId` with an absolute `Amount`; `Cards` elements are `UserCard` blobs keyed
 * by `CardId`. All helpers default to the shared DB handle and accept a
 * transaction `Executor` so they compose inside `withPlayerTx`.
 */

const ITEMS = 'Items';
const CARDS = 'Cards';
const ACCESSORIES = 'Accessories';

function itemMsg(): string {
  return collectionElementMsg(ITEMS) ?? 'Solis.Common.Proto.Transaction.UserItem';
}

function cardMsg(): string {
  return collectionElementMsg(CARDS) ?? 'Solis.Common.Proto.Transaction.UserCard';
}

function accessoryMsg(): string {
  return collectionElementMsg(ACCESSORIES) ?? 'Solis.Common.Proto.Transaction.UserAccessory';
}

export async function getItemAmount(
  playerId: string,
  itemId: string,
  exec: Executor = db,
): Promise<number> {
  const items = await listElements(playerId, ITEMS, exec);
  const found = items.find((i) => i.ItemId != null && String(i.ItemId) === itemId);
  return found ? Number(found.Amount ?? 0) : 0;
}

export async function grantItem(
  playerId: string,
  itemId: string,
  amount: number,
  exec: Executor = db,
): Promise<void> {
  if (amount <= 0) return;
  const current = await getItemAmount(playerId, itemId, exec);
  await putElements(playerId, ITEMS, [{ __msg: itemMsg(), ItemId: itemId, Amount: current + amount } as Decoded], exec);
}

export async function spendItem(
  playerId: string,
  itemId: string,
  amount: number,
  exec: Executor = db,
): Promise<void> {
  if (amount <= 0) return;
  const current = await getItemAmount(playerId, itemId, exec);
  if (current < amount) {
    throw new Error(`insufficient item ${itemId}: have ${current}, need ${amount}`);
  }
  const next = current - amount;
  if (next === 0) {
    await removeElements(playerId, ITEMS, [{ __msg: itemMsg(), ItemId: itemId } as Decoded], exec);
  } else {
    await putElements(playerId, ITEMS, [{ __msg: itemMsg(), ItemId: itemId, Amount: next } as Decoded], exec);
  }
}

export async function getCard(
  playerId: string,
  cardId: string,
  exec: Executor = db,
): Promise<Decoded | null> {
  const cards = await listElements(playerId, CARDS, exec);
  return cards.find((c) => c.CardId != null && String(c.CardId) === cardId) ?? null;
}

export async function grantCard(
  playerId: string,
  card: Decoded,
  exec: Executor = db,
): Promise<void> {
  const cardId = card.CardId != null ? String(card.CardId) : '';
  if (cardId) {
    const existing = await getCard(playerId, cardId, exec);
    if (existing) {
      // Duplicate copy: convert to bond exp (may evolve + unlock rewards).
      const evo = await evolveOnDuplicate(playerId, cardId, exec);
      if (evo) return;
      // Non-bond duplicate: merge onto the owned card so its fields survive.
      await putElements(playerId, CARDS, [{ __msg: cardMsg(), ...existing, ...card } as Decoded], exec);
      return;
    }
  }
  // New card: always materialize full user-card state (a bare id would leave
  // RarityTotalExp 0, which the client rejects on a later duplicate draw).
  const base = cardId ? await buildUserCard(cardId) : null;
  await putElements(playerId, CARDS, [{ __msg: cardMsg(), ...(base ?? {}), ...card } as Decoded], exec);
  // Unlock the card's episode #1 (and any level-gated stories for the granted
  // level) in the player's Stories collection (PLANS §1.7).
  if (cardId) {
    await unlockCardStories(playerId, cardId, Number(card.Level ?? 1), exec);
  }
}

/**
 * Construct a fresh `UserCard` blob from prefetched master rows. Pure: callers
 * that already hold the master card / rarity / parameter rows (the sandbox
 * seeder) can avoid per-card queries.
 */
export function newUserCard(
  cardId: string,
  card: Decoded,
  rarityRow: Decoded | null,
  param: Decoded | null,
): Decoded {
  const rarity = Number(card.InitialRarity ?? 1);
  const value = Number(param?.Value ?? 0);
  const staminaBase = Number(param?.StaminaValue ?? 0);
  const scale = (ratio: unknown, base: number) => Math.round((Number(ratio ?? 0) * base) / 1000);
  const vocal = scale(card.VocalRatioPermil, value);
  const dance = scale(card.DanceRatioPermil, value);
  const visual = scale(card.VisualRatioPermil, value);
  const stamina = scale(card.StaminaRatioPermil, staminaBase);
  return {
    __msg: cardMsg(),
    CardId: cardId,
    Level: 1,
    Rarity: rarity,
    RarityTotalExp: Number(rarityRow?.RequiredExp ?? 0),
    TotalExp: 0,
    Vocal: vocal,
    Dance: dance,
    Visual: visual,
    Stamina: stamina,
    // The client renders the card-level badge from `BaseLevel` (CardValueType
    // .Base), so a freshly obtained card must carry it (plus the Base stat
    // mirrors, Mental/Technique and ObtainedTime) or it shows as Lv0.
    BaseLevel: 1,
    BaseVocal: vocal,
    BaseDance: dance,
    BaseVisual: visual,
    BaseStamina: stamina,
    Mental: 100,
    Technique: 100,
    ObtainedTime: Date.now(),
  } as Decoded;
}

export async function buildUserCard(cardId: string): Promise<Decoded | null> {
  const card = await getMasterCard(cardId);
  if (!card) return null;
  const rarity = Number(card.InitialRarity ?? 1);
  const rarityRow = await getCardRarity(rarity);
  const param = await getCardParameter(String(card.CardParameterId ?? ''), 1);
  const userCard = newUserCard(cardId, card, rarityRow, param);
  // Skills / abilities are unlocked by card level (and card evolution for the
  // bond skill slot); emit only the unlocked ids so the client greys the rest.
  applyCardRelease(userCard, card, await cardReleaseForCard(card, 1, 0));
  return userCard;
}

/**
 * Repair a stored UserCard whose `RarityTotalExp` is missing/lower than the
 * current rarity threshold. The client's gacha result screen resolves a
 * duplicate's medal count via `CardRarity`/`CardDuplicateReward` lookups keyed
 * on rarity-exp; a 0 value picks the wrong row and crashes.
 */
export async function normalizeCardRarityExp(card: Decoded): Promise<Decoded> {
  const rarity = card.Rarity != null ? Number(card.Rarity) : 0;
  if (!rarity) return card;
  const row = await getCardRarity(rarity);
  const want = Number(row?.RequiredExp ?? 0);
  if (want <= Number(card.RarityTotalExp ?? 0)) return card;
  return { ...card, __msg: cardMsg(), RarityTotalExp: want } as Decoded;
}

export async function deleteElement(
  playerId: string,
  field: string,
  element: Decoded,
  exec: Executor = db,
): Promise<void> {
  await removeElements(playerId, field, [element], exec);
}

export async function getAccessoryAmount(
  playerId: string,
  accessoryId: string,
  exec: Executor = db,
): Promise<number> {
  const accessories = await listElements(playerId, ACCESSORIES, exec);
  const found = accessories.find((a) => a.AccessoryId != null && String(a.AccessoryId) === accessoryId);
  return found ? Number(found.Amount ?? 0) : 0;
}

export async function grantAccessory(
  playerId: string,
  accessoryId: string,
  amount: number,
  exec: Executor = db,
): Promise<void> {
  if (amount <= 0) return;
  const current = await getAccessoryAmount(playerId, accessoryId, exec);
  await putElements(
    playerId,
    ACCESSORIES,
    [{ __msg: accessoryMsg(), AccessoryId: accessoryId, Amount: current + amount } as Decoded],
    exec,
  );
}

export async function spendAccessory(
  playerId: string,
  accessoryId: string,
  amount: number,
  exec: Executor = db,
): Promise<void> {
  if (amount <= 0) return;
  const current = await getAccessoryAmount(playerId, accessoryId, exec);
  if (current < amount) {
    throw new Error(`insufficient accessory ${accessoryId}: have ${current}, need ${amount}`);
  }
  const next = current - amount;
  if (next === 0) {
    await removeElements(playerId, ACCESSORIES, [{ __msg: accessoryMsg(), AccessoryId: accessoryId } as Decoded], exec);
  } else {
    await putElements(
      playerId,
      ACCESSORIES,
      [{ __msg: accessoryMsg(), AccessoryId: accessoryId, Amount: next } as Decoded],
      exec,
    );
  }
}
