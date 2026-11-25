/**
 * Race deck endpoints.
 *
 * `Race:SaveDeck` behaves like the normal `Deck:Save`: it reuses
 * `saveDeckRequest`, so `Number` 0 allocates the next account deck number from
 * the deck sequence (echoing the updated `User`, `Decks` and `DeckPositions`)
 * and any other number edits that account deck. The race response carries that
 * `CommonResponse` plus a `RaceDeckInfo` for the deck that was saved.
 *
 * Older builds saved a formation per race in `RaceDecks:<raceId>`. Those rows are
 * still read so old data keeps listing, but an account deck of the same number
 * wins over a stale stored race deck; the stored rows only cover deck numbers
 * the account does not have.
 *
 * `Race:ListDeck` must still cover every deck the client holds locally. The
 * client builds a `RaceDeckLiveBonus` from the returned `RaceDeckInfo`s (keyed
 * by `Number`) and, for each deck in `DeckManager`, calls
 * `GetLiveBonusedDeckInfo(number)` and passes the result to
 * `DeckBase.SetLiveBonusedDeckInfo`. A deck missing from the response leaves
 * that lookup null and the presenter throws a `NullReferenceException` right
 * after the RPC returns, so the listing is the union of the account decks and
 * the saved race decks.
 *
 * Card stats reuse the marathon deck-stat path (same live-bonus / accessory /
 * photo pipeline as `prepareLiveInput`), only the message names differ.
 */
import { register, type RpcContext } from '../handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { db } from '../../db/client.ts';
import { commonResponse } from '../activity.ts';
import { listElements } from '../playerState.ts';
import { liveDeckCharacterAssets, loadLiveFormation } from '../liveInput.ts';
import { listCardsByIds, listCharacters } from '../../master/index.ts';
import { withQuestPlayer } from '../quest.ts';
import { saveDeckRequest } from '../deck.ts';
import { deckCardStats } from '../marathon/deck.ts';
import { getRaceQuest, getRaceQuestDifficulty } from './master.ts';
import { loadRaceDecks } from './state.ts';
import type { RaceDeckPosition } from './state.ts';

const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const LIST_DECK_RESPONSE_MSG = 'Solis.Common.Proto.Api.RaceListDeckResponse';
const DECK_SAVE_RESPONSE_MSG = 'Solis.Common.Proto.Api.RaceSaveDeckResponse';
const QUEST_LIST_ASSET_RESPONSE_MSG = 'Solis.Common.Proto.Api.RaceQuestListAssetResponse';
const DECK_INFO_MSG = 'Solis.Common.Proto.Api.RaceDeckInfo';
const CARD_DETAIL_MSG = 'Solis.Common.Proto.Api.RaceDeckCardDetailInfo';
const ACCESSORY_INFO_MSG = 'Solis.Common.Proto.Api.RaceAccessoryInfo';
const PHOTO_INFO_MSG = 'Solis.Common.Proto.Api.RacePhotoInfo';

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function s(value: unknown): string {
  return value == null ? '' : String(value);
}

function emptyUpdated(): Decoded {
  return { __msg: UPDATED_DATA_MSG } as Decoded;
}

function requiredRaceId(req: Decoded, rpc: string): string {
  const raceId = s(req.RaceId);
  if (raceId === '') throw new Error(`${rpc}: RaceId is required`);
  return raceId;
}

function toDecoded(row: RaceDeckPosition): Decoded {
  return { ...row } as unknown as Decoded;
}

/**
 * Live quest row for the quest/difficulty named in the request. Null when the
 * request names no quest (base stats, no bonuses), matching `Marathon:ListDeck`.
 */
async function resolveRaceQuest(req: Decoded, rpc: string): Promise<Decoded | null> {
  const raceQuestId = s(req.RaceQuestId);
  if (raceQuestId === '') return null;
  const quest = await getRaceQuest(raceQuestId);
  if (quest === null) throw new Error(`${rpc}: race quest not found: ${raceQuestId}`);
  const difficultyNumber = n(req.DifficultyNumber);
  const diff = await getRaceQuestDifficulty(raceQuestId, difficultyNumber);
  if (diff === null) throw new Error(`${rpc}: difficulty ${difficultyNumber} not found for ${raceQuestId}`);
  return {
    ...(quest as unknown as Decoded),
    ...(diff as unknown as Decoded),
    Id: raceQuestId,
  } as Decoded;
}

function accessoryInfos(row: Decoded): Decoded[] {
  return [s(row.Part1AccessoryId), s(row.Part2AccessoryId)]
    .filter((id) => id !== '')
    .map((id) => ({ __msg: ACCESSORY_INFO_MSG, AccessoryId: id }) as Decoded);
}

function photoInfos(row: Decoded): Decoded[] {
  const ids = Array.isArray(row.PhotoIds) ? (row.PhotoIds as unknown[]) : [];
  return ids
    .map((id) => s(id))
    .filter((id) => id !== '')
    .map((id) => ({ __msg: PHOTO_INFO_MSG, PhotoId: id }) as Decoded);
}

/** One `RaceDeckInfo` for deck `number`, built from the given position rows. */
async function buildRaceDeckInfo(
  playerId: string,
  number: number,
  positionRows: readonly Decoded[],
  quest: Decoded | null,
): Promise<Decoded> {
  const rows = positionRows
    .filter((row) => n(row.Number) === number && s(row.CardId) !== '')
    .sort((a, b) => n(a.Position) - n(b.Position));
  const cards = rows.length === 0 ? [] : await deckCardStats(playerId, quest as never, rows);
  let overall = 0;
  const details = cards.map((card, index) => {
    const row = rows[index];
    overall += n(card.Vocal) + n(card.Dance) + n(card.Visual);
    return {
      __msg: CARD_DETAIL_MSG,
      Position: n(row.Position),
      Vocal: card.Vocal,
      Dance: card.Dance,
      Visual: card.Visual,
      Stamina: card.Stamina,
      Mental: card.Mental,
      Technique: card.Technique,
      AccessoryInfos: accessoryInfos(row),
      PhotoInfos: photoInfos(row),
    } as Decoded;
  });
  return {
    __msg: DECK_INFO_MSG,
    Number: number,
    CardDetailInfos: details,
    DeckOverallValue: overall,
  } as Decoded;
}

/** The player's normal account decks. */
async function accountDecks(playerId: string): Promise<{ decks: Decoded[]; positions: Decoded[] }> {
  const decks = (await listElements(playerId, 'Decks', db))
    .map((row) => ({ __msg: 'Solis.Common.Proto.Api.UserDeck', Number: n(row.Number), Name: s(row.Name) } as Decoded))
    .sort((a, b) => n(a.Number) - n(b.Number));
  const positions = (await listElements(playerId, 'DeckPositions', db)) as Decoded[];
  return { decks, positions };
}

/**
 * Every deck number the client must see a `RaceDeckInfo` for: the account decks
 * it holds locally, plus race decks stored only in `RaceDecks:<raceId>`.
 *
 * An account deck wins over a stored race deck with the same number (race saves
 * now land in the account store), so a stale race formation never overrides the
 * formation the client just saved; stored rows only cover numbers the account
 * does not have.
 */
async function deckLayers(
  playerId: string,
  raceId: string,
): Promise<{ numbers: number[]; positions: Decoded[] }> {
  const account = await accountDecks(playerId);
  const stored = await loadRaceDecks(playerId, raceId, db);
  const accountNumbers = account.decks.map((row) => n(row.Number));
  const numbers = [
    ...new Set([...accountNumbers, ...stored.decks.map((row) => n(row.Number))]),
  ].sort((a, b) => a - b);
  const positions: Decoded[] = [
    ...account.positions,
    ...stored.positions.filter((row) => !accountNumbers.includes(n(row.Number))).map(toDecoded),
  ];
  return { numbers, positions };
}

register(
  'Race:ListDeck',
  async (ctx: RpcContext) => {
    const req = (ctx.request ?? {}) as Decoded;
    return withQuestPlayer(ctx, 'Race:ListDeck', async (playerId) => {
      const raceId = requiredRaceId(req, 'Race:ListDeck');
      const quest = await resolveRaceQuest(req, 'Race:ListDeck');
      const layers = await deckLayers(playerId, raceId);
      const deckInfos: Decoded[] = [];
      for (const number of layers.numbers) {
        deckInfos.push(await buildRaceDeckInfo(playerId, number, layers.positions, quest));
      }
      return {
        __msg: LIST_DECK_RESPONSE_MSG,
        DeckInfos: deckInfos,
      } as Decoded;
    });
  },
  { ownsState: true },
);

register(
  'Race:SaveDeck',
  async (ctx: RpcContext) => {
    const req = (ctx.request ?? {}) as Decoded;
    return withQuestPlayer(ctx, 'Race:SaveDeck', async (playerId) => {
      const requested = n(req.Number);
      // Negative numbers are invalid; a missing `Number` decodes to 0 and asks
      // for a new account deck, exactly like `Deck:Save`.
      if (requested < 0) throw new Error('Race:SaveDeck: Number is required');
      // The race quest only drives the card stats in the returned deck info.
      const quest = await resolveRaceQuest(req, 'Race:SaveDeck');

      // Same account save as `Deck:Save` (and `Marathon:SaveDeck`): 0 allocates
      // the next deck number, any other number edits that deck, and the
      // response echoes the resulting User/Decks/DeckPositions.
      const saved = await saveDeckRequest(ctx, {
        Number: req.Number,
        Name: req.Name,
        UserDeckPositions: req.UserDeckPositions,
      } as Decoded);
      const data = (saved.CommonResponse as Decoded).UpdatedData as Decoded;
      const number = n((data.Decks as Decoded[])[0].Number);
      const deckInfo = await buildRaceDeckInfo(
        playerId,
        number,
        (data.DeckPositions as Decoded[]) ?? [],
        quest,
      );
      return {
        __msg: DECK_SAVE_RESPONSE_MSG,
        DeckInfo: deckInfo,
        CommonResponse: saved.CommonResponse,
      } as Decoded;
    });
  },
  { ownsState: true },
);

register(
  'Race:ListQuestAsset',
  async (ctx: RpcContext) => {
    const req = (ctx.request ?? {}) as Decoded;
    return withQuestPlayer(ctx, 'Race:ListQuestAsset', async (playerId) => {
      const raceId = requiredRaceId(req, 'Race:ListQuestAsset');
      const deckNumber = n(req.DeckNumber);
      if (deckNumber < 0) throw new Error('Race:ListQuestAsset: DeckNumber is required');
      const stored = await loadRaceDecks(playerId, raceId, db);
      // Race saves land in the account deck store, so the account formation for
      // this number wins; a stored race deck only covers a number the account
      // does not have (old data whose deck has since been deleted).
      const accountDeckNumbers = (await listElements(playerId, 'Decks', db)).map((row) => n(row.Number));
      const storedPositions = stored.positions
        .filter((row) => row.Number === deckNumber)
        .sort((a, b) => a.Position - b.Position)
        .map((row) => toDecoded(row));
      const positions: Decoded[] = accountDeckNumbers.includes(deckNumber)
        ? ((await loadLiveFormation(playerId, deckNumber, db)).Positions as unknown as Decoded[])
        : storedPositions;
      const cards = await listElements(playerId, 'Cards', db);
      const byCard = new Map(cards.map((row) => [s(row.CardId), row]));
      const masterIds = positions.map((position) => s(byCard.get(s(position.CardId))?.CardId));
      const masterCards = await listCardsByIds(masterIds);
      const masterById = new Map(masterCards.map((row) => [s(row.Id), row]));
      const originalIds = positions.map((position) => s(masterById.get(s(position.CardId))?.CharacterId));
      const characters = await listElements(playerId, 'Characters', db);
      const masterCharacters = await listCharacters();
      const byMasterCharacter = new Map(masterCharacters.map((row) => [s(row.Id), row]));
      const assets = await liveDeckCharacterAssets(
        positions,
        originalIds,
        characters,
        byMasterCharacter as never,
        db,
      );
      return {
        __msg: QUEST_LIST_ASSET_RESPONSE_MSG,
        CharacterAssets: assets,
        CommonResponse: commonResponse(emptyUpdated()),
      } as Decoded;
    });
  },
  { ownsState: true },
);
