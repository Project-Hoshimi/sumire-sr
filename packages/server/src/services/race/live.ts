// Shared live-battle runner for the race RPCs, modelled on
// `services/marathon/quest.ts`: the engine decides the clear, the deck comes
// from the race deck storage (`RaceDecks:<raceId>`), and a failed attempt only
// updates the recorded score (no rewards).
//
// Known limitation (spec section 7): owned race live bonuses are recorded in
// the player state but are NOT routed into the simulation, and the race live
// bonus group lives in `master_RaceLiveBonusGroup` rather than
// `master_LiveBonusGroup`, so the quest is prepared without a bonus group.
//
// Versus quests (ClearScore 0) have no opponent column in master; they play the
// compiled draft's `npcRosterId` (or its `npcRosterByQuest` override) scaled to
// the tier's `DifficultyLevel`.
import { randomBytes } from 'node:crypto';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import type { Executor } from '../../db/tx.ts';
import { db } from '../../db/client.ts';
import { simulate } from '../../live/engine.ts';
import type { Input } from '../../live/input.ts';
import type { LiveResult } from '../../live/types.ts';
import {
  loadLiveFormation,
  prepareLiveInput,
  type LiveFormation,
} from '../liveInput.ts';
import { questStartRankPatterns, questStartScoreRank } from '../quest.ts';
import { listElements } from '../playerState.ts';
import { getRaceQuest, getRaceQuestDifficulty } from './master.ts';
import { loadRaceDecks } from './state.ts';
import type { RaceConfig } from './types.ts';

/** `AREA_DAILY` in `../quest.ts`: selects the daily score-rank branch. */
const RANK_PATTERN_AREA_TYPE_DAILY = 3;

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function s(value: unknown): string {
  return value == null ? '' : String(value);
}

/**
 * The quest object the live engine reads: the race quest master row merged with
 * its difficulty row (stage, capacity, clear score and the rank reward ids only
 * exist on `master_RaceQuestDifficulty` for race quests). `LiveBonusGroupId` is
 * dropped on purpose — the race group is not part of `master_LiveBonusGroup`.
 */
export async function raceQuestLike(raceQuestId: string, difficultyNumber: number): Promise<Decoded> {
  const quest = (await getRaceQuest(raceQuestId)) as unknown as Decoded | null;
  if (!quest) throw new Error(`race quest not found: ${raceQuestId}`);
  const diff = (await getRaceQuestDifficulty(raceQuestId, difficultyNumber)) as unknown as Decoded | null;
  if (!diff) throw new Error(`difficulty ${difficultyNumber} not found for ${raceQuestId}`);
  return { ...quest, ...diff, Id: raceQuestId, LiveBonusGroupId: '' } as Decoded;
}

/**
 * The formation for `deckNumber` as a live formation. Race saves now land in
 * the normal account deck store, so an account deck of that number wins over a
 * stale legacy race deck (same precedence as `Race:ListDeck` and
 * `Race:ListQuestAsset`); the legacy `RaceDecks:<raceId>` deck of that number
 * only covers numbers the account does not have. A stored deck with no occupied
 * position is an error.
 */
export async function loadRaceFormation(
  playerId: string,
  raceId: string,
  deckNumber: number,
  exec: Executor = db,
): Promise<LiveFormation> {
  const accountDeckNumbers = (await listElements(playerId, 'Decks', exec)).map((row) => n(row.Number));
  if (accountDeckNumbers.includes(deckNumber)) return loadLiveFormation(playerId, deckNumber, exec);
  const stored = await loadRaceDecks(playerId, raceId, exec);
  const deck = stored.decks.find((row) => n(row.Number) === deckNumber);
  if (deck === undefined) throw new Error(`race deck ${deckNumber} not found`);
  const positions = stored.positions
    .filter((row) => n(row.Number) === deckNumber && s(row.CardId) !== '')
    .sort((a, b) => n(a.Position) - n(b.Position));
  if (positions.length === 0) throw new Error(`race deck ${deckNumber} has no cards`);
  return { Name: s(deck.Name), Positions: positions as unknown as Decoded[] };
}

/** Card ids of a formation, de-duplicated, in deck order. */
export function formationCardIds(formation: LiveFormation): string[] {
  const ids = formation.Positions.map((row) => s(row.CardId)).filter((id) => id !== '');
  return [...new Set(ids)];
}

export interface RaceLiveRunOptions {
  playerId: string;
  raceId: string;
  /** Compiled race draft: its NPC roster and tier rules drive the opponent. */
  config: RaceConfig;
  raceQuestId: string;
  difficultyNumber: number;
  deckNumber: number;
  isSkip: boolean;
  exec: Executor;
  /** Pre-loaded formation (the panel quest checks cool times on it first). */
  formation: LiveFormation;
}

export interface RaceLiveRun {
  result: Decoded;
  score: number;
  cleared: boolean;
  patterns: Decoded[];
  questLike: Decoded;
}

/** Runs the live for a race quest tier and reports the engine outcome. */
export async function runRaceLive(options: RaceLiveRunOptions): Promise<RaceLiveRun> {
  const { playerId, raceId, config, raceQuestId, difficultyNumber, deckNumber, isSkip, exec, formation } = options;
  const seed = randomBytes(8).readBigUInt64BE();
  const questLike = await raceQuestLike(raceQuestId, difficultyNumber);
  const reqLike = {
    QuestId: raceQuestId,
    DeckNumber: deckNumber,
    PlayCount: 1,
    IsSkip: isSkip,
    UserBuddyDeckPositions: [],
  } as Decoded;
  // Race quests carry no opponent column, so the versus branch (ClearScore 0)
  // plays the draft's roster, scaled to the tier's authored difficulty level.
  const npcRosterId = config.npcRosterByQuest[raceQuestId] ?? (config.npcRosterId || undefined);
  const npcLevel = n(questLike.DifficultyLevel);
  const npcOptions = {
    ...(npcRosterId === undefined ? {} : { npcRosterId }),
    ...(npcLevel > 0 ? { npcLevel } : {}),
  };
  const input = await prepareLiveInput(
    playerId,
    reqLike,
    questLike as unknown as Parameters<typeof prepareLiveInput>[2],
    seed,
    formation,
    exec,
    Object.keys(npcOptions).length > 0 ? npcOptions : undefined,
  );
  const result = simulate(input as Input) as LiveResult;
  const playerResult = result.UserInfos?.[0]?.UserResult;
  if (!playerResult) throw new Error('live produced no player result');
  const score = n(playerResult.Score);
  if (score < 0) throw new Error('live score is negative');
  const patterns = questStartRankPatterns(questLike, RANK_PATTERN_AREA_TYPE_DAILY);
  const { rankType, plus } = questStartScoreRank(patterns, score);
  void raceId;
  void rankType;
  void plus;
  return {
    result: result as unknown as Decoded,
    score,
    cleared: result.Cleared === true,
    patterns,
    questLike,
  };
}
