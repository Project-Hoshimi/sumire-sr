import { db } from '../db/client.ts';
import { type Executor } from '../db/tx.ts';
import {
  getCard as getMasterCard,
  getCardEvolution,
  getCardEvolutionLevel,
} from '../master/index.ts';
import { collectionElementMsg, listElements, putElements } from './playerState.ts';
import { applyCardRelease, cardReleaseForCard } from './cardRelease.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Card bond ("card evolution") on duplicate obtain.
 *
 * When the player obtains a copy of a card they already own, the copy converts
 * to bond exp (`CardEvolutionLevel.DuplicateObtainExp` for the card's current
 * evolution level). Accumulated `UserCard.EvolutionLevelTotalExp` that reaches
 * the next level's `Exp` threshold raises `UserCard.EvolutionLevel`, which in
 * turn unlocks the level's `CardEvolution` rewards (costume/hair).
 *
 * Card evolution groups are per-card via `master_Card.CardEvolutionLevelGroupId`
 * (`card_evolution_level_bond` for the bond set). Cards without a group are not
 * bond-eligible and return `null` so callers fall back to plain grants.
 *
 * This module deliberately avoids importing `inventory.ts`/`reward.ts` so it can
 * be called from both without an import cycle.
 */

const REWARD_RESULT_MSG = 'Solis.Common.Proto.Transaction.RewardResult';
const CARD_MSG = 'Solis.Common.Proto.Transaction.UserCard';

const CARDS = 'Cards';

const COSTUME_TYPE = 5;
const HAIR_TYPE = 28;
const COSTUME_GRANT = { field: 'Costumes', key: 'CostumeId' } as const;
const HAIR_GRANT = { field: 'Hairs', key: 'HairId' } as const;

export type EvolutionResult = {
  card: Decoded;
  results: Decoded[];
  fromLevel: number;
  toLevel: number;
};

function rewardResult(
  resourceType: number,
  resourceId: string,
  before: number,
  after: number,
): Decoded {
  return {
    __msg: REWARD_RESULT_MSG,
    ResourceType: resourceType,
    ResourceId: resourceId,
    BeforeAmount: before,
    AfterAmount: after,
    AmountI64: 1,
  } as Decoded;
}

async function ensureCollection(
  playerId: string,
  field: string,
  key: string,
  resourceId: string,
  exec: Executor,
): Promise<boolean> {
  const existing = await listElements(playerId, field, exec);
  const found = existing.some((e) => e[key] != null && String(e[key]) === resourceId);
  if (!found) {
    const msg = collectionElementMsg(field) ?? undefined;
    await putElements(playerId, field, [{ __msg: msg, [key]: resourceId } as Decoded], exec);
  }
  return !found;
}

/**
 * Apply duplicate-obtain bond exp to an already-owned card and level it up when
 * the threshold is reached. Returns `null` when the card is missing or not
 * bond-eligible. The updated card is persisted to the `Cards` collection.
 */
export async function evolveOnDuplicate(
  playerId: string,
  cardId: string,
  exec: Executor = db,
): Promise<EvolutionResult | null> {
  const master = await getMasterCard(cardId);
  const groupId = master?.CardEvolutionLevelGroupId ? String(master.CardEvolutionLevelGroupId) : '';
  if (!groupId) return null;

  const cards = await listElements(playerId, CARDS, exec);
  const existing = cards.find((c) => c.CardId != null && String(c.CardId) === cardId);
  if (!existing) return null;

  const fromLevel = Number(existing.EvolutionLevel ?? 0);
  const levelRow = await getCardEvolutionLevel(groupId, fromLevel);
  if (!levelRow) return null;

  const gain = Number(levelRow.DuplicateObtainExp ?? 0);
  const totalExp = Number(existing.EvolutionLevelTotalExp ?? 0) + gain;

  let toLevel = fromLevel;
  for (;;) {
    const next = await getCardEvolutionLevel(groupId, toLevel + 1);
    if (next && next.Exp != null && totalExp >= Number(next.Exp)) toLevel += 1;
    else break;
  }

  const card: Decoded = {
    ...existing,
    __msg: CARD_MSG,
    CardId: cardId,
    EvolutionLevel: toLevel,
    EvolutionLevelTotalExp: totalExp,
  } as Decoded;
  // Evolution can unlock the bond skill slot (Skill#4 for `*-link-00` cards).
  applyCardRelease(card, master, await cardReleaseForCard(master, Number(card.Level ?? 1), toLevel));
  await putElements(playerId, CARDS, [card], exec);

  const results: Decoded[] = [];
  for (let lvl = fromLevel + 1; lvl <= toLevel; lvl++) {
    const evo = await getCardEvolution(cardId, lvl);
    if (!evo) continue;
    if (evo.RewardCostumeId) {
      const id = String(evo.RewardCostumeId);
      const isNew = await ensureCollection(playerId, COSTUME_GRANT.field, COSTUME_GRANT.key, id, exec);
      results.push({ ...rewardResult(COSTUME_TYPE, id, isNew ? 0 : 1, 1), IsNew: isNew } as Decoded);
    }
    if (evo.RewardHairId) {
      const id = String(evo.RewardHairId);
      const isNew = await ensureCollection(playerId, HAIR_GRANT.field, HAIR_GRANT.key, id, exec);
      results.push({ ...rewardResult(HAIR_TYPE, id, isNew ? 0 : 1, 1), IsNew: isNew } as Decoded);
    }
  }

  return { card, results, fromLevel, toLevel };
}