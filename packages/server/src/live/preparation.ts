// Ported from Solis internal/makino/live/preparation.go.
//
// Preparation is pure: it derives NPC stats and venue seating from master data
// without touching the simulation RNG.

import {
  PhotoAbilityTargetType,
  PhotoAbilityType,
} from './enums.ts';
import type {
  LiveBattleCardInfo,
  PhotoAbilityTarget,
  Quest,
  QuestCharacterAdvantage,
  QuestOpponentInfo,
  Setting,
} from './types.ts';
import type { CardData } from './input.ts';
import { npcBalance } from './data/npcBalance.ts';
import { npcRosters } from './data/npcRosters.ts';
import { lanesAreNeighbors } from './selectors.ts';
import { n, s } from './util.ts';

export interface NPCBonuses {
  Version: string;
  Primary: number;
  Stamina: number;
  Mental: number;
  Technique: number;
}

function validateBalance(): void {
  const c = npcBalance;
  if (c.Version === '' || c.Start < 0 || c.Anchor <= c.Start || c.Tail !== 'linear-tangent') {
    throw new Error('invalid NPC balance configuration');
  }
  for (const curve of [c.Primary, c.Stamina, c.Mental, c.Technique]) {
    if (curve.Base < 0 || curve.Growth < 0 || curve.Minimum < 0) {
      throw new Error('negative NPC balance coefficient');
    }
  }
}

/**
 * Implements the authored v1 curve for every new NPC simulation. Mental and
 * Technique are final values; Primary and Stamina are additions.
 */
export function NPCBalance(quest: Quest, setting: Setting): NPCBonuses {
  if (
    n(quest.DifficultyLevel) <= 0 ||
    n(quest.MentalThreshold) <= 0 ||
    n(quest.MaxCapacity) <= 0 ||
    n(setting.CardDefaultMental) <= 0 ||
    n(setting.CardDefaultTechnique) <= 0
  ) {
    throw new Error('invalid NPC quest/default parameters');
  }
  validateBalance();
  const c = npcBalance;
  const x = BigInt(Math.max(0, n(quest.DifficultyLevel) - c.Start));
  const h = BigInt(c.Anchor - c.Start);
  // bigint keeps edited coefficients safe; outputs must still fit int64.
  const denominator = h * h;
  let numerator = x * x;
  if (x > h) numerator += 2n * h * (x - h);
  const calc = (curve: { Base: number; Growth: number }, base: number): number => {
    const value = (numerator * BigInt(curve.Growth)) / denominator + BigInt(curve.Base) + BigInt(base);
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('NPC balance overflows int64');
    }
    return Number(value);
  };
  const out: NPCBonuses = {
    Version: c.Version,
    Primary: calc(c.Primary, 0),
    Stamina: calc(c.Stamina, 0),
    Mental: calc(c.Mental, n(setting.CardDefaultMental)),
    Technique: calc(c.Technique, n(setting.CardDefaultTechnique)),
  };
  const floor = (BigInt(n(quest.MentalThreshold)) * BigInt(c.Mental.Minimum) + 999n) / 1000n;
  out.Mental = Math.max(out.Mental, Number(floor));
  return out;
}

/** Returns a fresh protobuf-shaped object so callers cannot mutate shared settings. */
export function NPCRoster(questID: string): QuestOpponentInfo {
  const roster = npcRosters[questID];
  if (roster === undefined) {
    throw new Error(`NPC roster for "${questID}" is not configured`);
  }
  const out: QuestOpponentInfo = { Name: roster.Name, ManagerLevel: roster.ManagerLevel, CardInfos: [] };
  const seen = new Set<number>();
  for (const c of roster.Cards) {
    if (c.Position < 1 || c.Position > 5 || seen.has(c.Position) || c.CardId === '' || c.Level <= 0 || c.Rarity <= 0 || c.LightFanAmount < 0 || c.MiddleFanAmount < 0 || c.HeavyFanAmount < 0) {
      throw new Error(`invalid NPC roster "${questID}"`);
    }
    seen.add(c.Position);
    const info: LiveBattleCardInfo = {
      Position: c.Position,
      CardId: c.CardId,
      Level: c.Level,
      Rarity: c.Rarity,
      LightFanAmount: c.LightFanAmount,
      MiddleFanAmount: c.MiddleFanAmount,
      HeavyFanAmount: c.HeavyFanAmount,
      EvolutionLevel: c.EvolutionLevel,
    };
    out.CardInfos!.push(info);
  }
  if (out.CardInfos!.length !== 5) throw new Error('NPC roster requires five cards');
  return out;
}

/**
 * Floors fan tiers separately, applies the candidate minimum, then ceilings
 * proportional seats. Removes overbooking from the largest lane, choosing the
 * latest lane on ties (the documented capture-backed policy).
 */
export function AllocateAudience(cards: readonly CardData[], capacity: number, setting: Setting): number[] {
  if (capacity <= 0 || cards.length === 0 || cards.length > 10 || n(setting.LiveMinimumGuaranteedAudienceAmount) < 0) {
    throw new Error('invalid venue or actor count');
  }
  const weights = [
    n(setting.LiveLightFanAmountWeightPermil),
    n(setting.LiveMiddleFanAmountWeightPermil),
    n(setting.LiveHeavyFanAmountWeightPermil),
  ];
  const candidates: number[] = [];
  let total = 0;
  for (const c of cards) {
    let fans = 0;
    const tiers = [c.LightFans, c.MiddleFans, c.HeavyFans];
    for (let j = 0; j < tiers.length; j++) {
      const f = tiers[j];
      if (f < 0 || weights[j] < 0) throw new Error('invalid fan count or weight');
      fans += Math.trunc((f * weights[j]) / 1000);
    }
    fans = Math.max(fans, n(setting.LiveMinimumGuaranteedAudienceAmount));
    // No current master record specifies this option's units. AmountUp is
    // interpreted as additional candidate fans (not a multiplier), before both
    // sides share the same capacity allocation.
    const bonus = n(c.Bonuses.get(PhotoAbilityType.AudienceAmountUp));
    if (bonus < 0) throw new Error('invalid audience bonus');
    fans += bonus;
    if (fans < 0) throw new Error('invalid audience minimum or total');
    candidates.push(fans);
    total += fans;
  }
  const out = new Array<number>(cards.length).fill(0);
  if (total === 0) return out;
  let assigned = 0;
  for (let i = 0; i < candidates.length; i++) {
    let seats = candidates[i];
    if (total > capacity) {
      seats = Number((BigInt(candidates[i]) * BigInt(capacity) + BigInt(total - 1)) / BigInt(total));
    }
    out[i] = seats;
    assigned += seats;
  }
  while (assigned > capacity) {
    let largest = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i] >= out[largest]) largest = i;
    }
    out[largest]--;
    assigned--;
  }
  return out;
}

/**
 * Returns the encounter's score multiplier for the scoring character,
 * independently of any cosmetic replacement. It must not alter prepared stats:
 * attribute-based targeting and battle authority use those stats without the
 * score-only advantage. Master 1000 is neutral.
 */
export function ResolveCharacterAdvantage(data: CardData, advantage: QuestCharacterAdvantage | null | undefined): number {
  if (advantage === null || advantage === undefined) return 1000;
  const ids = advantage.CharacterIds ?? [];
  const matchId = ids.includes(data.CharacterID);
  const groupId = s(advantage.CharacterGroupId);
  const matchGroup = groupId !== '' && groupId === data.GroupID;
  if (!matchId && !matchGroup) return 1000;
  if (n(advantage.AdvantagePermil) <= 0) throw new Error('invalid character advantage');
  return n(advantage.AdvantagePermil);
}

/**
 * Resolves equipment recipients within one side only. The source photo's
 * card/live conditions are checked before this function.
 */
export function PhotoTargetIndexes(
  cards: readonly { Index?: number | null }[],
  data: ReadonlyMap<number, CardData>,
  source: number,
  target: PhotoAbilityTarget | null | undefined,
): number[] {
  const positionOf = (index: number): number => ((index - 1) % 5) + 1;
  if (target === null || target === undefined) return [source];
  let sourcePosition = -1;
  for (const card of cards) {
    if (n(card.Index) === source) {
      sourcePosition = positionOf(source);
      break;
    }
  }
  if (sourcePosition < 0) throw new Error('photo source is not in this unit');
  const out: number[] = [];
  const targetId = s(target.TargetId);
  for (const card of cards) {
    const index = n(card.Index);
    const position = positionOf(index);
    let match = false;
    switch (n(target.Type)) {
      case PhotoAbilityTargetType.Self:
        match = index === source;
        break;
      case PhotoAbilityTargetType.All:
        match = true;
        break;
      case PhotoAbilityTargetType.Center:
        match = position === 1;
        break;
      case PhotoAbilityTargetType.Neighbor:
        match = lanesAreNeighbors(position, sourcePosition);
        break;
      case PhotoAbilityTargetType.Character:
        match = targetId !== '' && data.get(index)?.CharacterID === targetId;
        break;
      case PhotoAbilityTargetType.CharacterGroup:
        match = targetId !== '' && data.get(index)?.GroupID === targetId;
        break;
      default:
        throw new Error(`unsupported photo target ${n(target.Type)}`);
    }
    if (match) out.push(index);
  }
  return out;
}

/**
 * Chooses cosmetic performers independently of the five scoring actors.
 * Five-performer songs retain the captured optional sixth spare.
 */
export function ExtraCharacterIDs(displayCount: number, owned: readonly string[], displayed: readonly string[]): string[] {
  if (displayCount < 0) throw new Error('negative display character count');
  const used = new Set<string>();
  for (const id of displayed) used.add(id);
  const spares: string[] = [];
  for (const id of owned) {
    if (id !== '' && !used.has(id)) {
      spares.push(id);
      used.add(id);
    }
  }
  spares.sort();
  const required = Math.max(0, displayCount - displayed.length);
  if (required > spares.length) {
    throw new Error(`music requires ${required} additional owned display idols`);
  }
  const count = Math.min(spares.length, Math.max(1, required));
  return spares.slice(0, count);
}
