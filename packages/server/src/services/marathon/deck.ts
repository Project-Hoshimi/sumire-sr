/**
 * Marathon pre-start endpoints that read or save the player's normal decks.
 *
 * Marathon:ListDeck and Marathon:SaveDeck take the Marathon quest and
 * difficulty named in the request. Card stats are the live stats the engine
 * would use for that quest (same bonus path as prepareLiveInput). With no
 * MarathonQuestId, base stats are used with no bonuses.
 */
import { register, type RpcContext } from '../handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { db } from '../../db/client.ts';
import { accountOf, commonResponse } from '../activity.ts';
import { listElements } from '../playerState.ts';
import {
  applyLiveCardStats,
  applyPreparedPhotoBonuses,
  liveCardAttribute,
  liveDeckCharacterAssets,
  loadLiveFormation,
  prepareLiveEquipment,
  prepareOwnedLiveAbilities,
  type PreparedPhotoBonus,
} from '../liveInput.ts';
import { getMarathonQuest, getMarathonQuestDifficulty, getSetting, listCardsByIds, listCharacters } from '../../master/index.ts';
import { withQuestPlayer } from '../quest.ts';
import { saveDeckRequest } from '../deck.ts';
import { liveQuestFromMarathonRows } from './quest.ts';
import type { Input } from '../../live/input.ts';
import type { LiveDeckCard, LiveUserInfo } from '../../live/types.ts';

const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const QUEST_LIST_ASSET_RESPONSE_MSG = 'Solis.Common.Proto.Api.MarathonQuestListAssetResponse';
const BUDDY_DECK_RESPONSE_MSG = 'Solis.Common.Proto.Api.MarathonBuddyDeckResponse';
const LIST_DECK_RESPONSE_MSG = 'Solis.Common.Proto.Api.MarathonListDeckResponse';
const DECK_SAVE_RESPONSE_MSG = 'Solis.Common.Proto.Api.MarathonDeckSaveResponse';
const DECK_INFO_MSG = 'Solis.Common.Proto.Api.MarathonDeckInfo';
const CARD_DETAIL_MSG = 'Solis.Common.Proto.Api.MarathonDeckCardDetailInfo';
const ACCESSORY_INFO_MSG = 'Solis.Common.Proto.Api.MarathonAccessoryInfo';
const PHOTO_INFO_MSG = 'Solis.Common.Proto.Api.MarathonPhotoInfo';

type QuestRow = Parameters<typeof prepareOwnedLiveAbilities>[1];
type CharacterRow = Parameters<typeof prepareLiveEquipment>[4];

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

register(
  'Marathon:ListQuestAsset',
  async (ctx: RpcContext) => {
    const req = (ctx.request ?? {}) as Decoded;
    return withQuestPlayer(ctx, 'Marathon:ListQuestAsset', async (playerId) => {
      const deckNumber = n(req.DeckNumber);
      if (deckNumber <= 0) throw new Error('Marathon:ListQuestAsset: DeckNumber is required');
      if (Array.isArray(req.UserBuddyDeckPositions) && req.UserBuddyDeckPositions.length > 0) {
        throw new Error('buddy deck is not supported');
      }
      const formation = await loadLiveFormation(playerId, deckNumber, db);
      const cards = await listElements(playerId, 'Cards', db);
      const byCard = new Map(cards.map((row) => [s(row.CardId), row]));
      const masterIds = formation.Positions.map((pos) => s(byCard.get(s(pos.CardId))?.CardId));
      const masterCards = await listCardsByIds(masterIds);
      const masterById = new Map(masterCards.map((row) => [s(row.Id), row]));
      const originalIds = formation.Positions.map((pos) => s(masterById.get(s(pos.CardId))?.CharacterId));
      const characters = await listElements(playerId, 'Characters', db);
      const masterCharacters = await listCharacters();
      const byMasterCharacter = new Map(masterCharacters.map((row) => [s(row.Id), row]));
      const assets = await liveDeckCharacterAssets(formation.Positions, originalIds, characters, byMasterCharacter, db);
      return {
        __msg: QUEST_LIST_ASSET_RESPONSE_MSG,
        CharacterAssets: assets,
        CommonResponse: commonResponse(emptyUpdated()),
      } as Decoded;
    });
  },
  { ownsState: true },
);

register('Marathon:BuddyDeck', async (ctx: RpcContext) => {
  accountOf(ctx);
  return {
    __msg: BUDDY_DECK_RESPONSE_MSG,
    BuddyDeckInfos: [],
    CommonResponse: commonResponse(emptyUpdated()),
  } as Decoded;
});

/** Same quest and difficulty lookup and errors as Marathon:StartQuest. Null when no quest is named. */
async function resolveMarathonQuest(req: Decoded, rpc: string): Promise<QuestRow | null> {
  const marathonQuestId = s(req.MarathonQuestId);
  if (marathonQuestId === '') return null;
  const difficultyNumber = n(req.MarathonQuestDifficultyNumber);
  const quest = (await getMarathonQuest(marathonQuestId)) as unknown as Decoded | null;
  if (!quest) throw new Error(`${rpc}: marathon quest not found: ${marathonQuestId}`);
  const diff = (await getMarathonQuestDifficulty(marathonQuestId, difficultyNumber)) as unknown as Decoded | null;
  if (!diff) throw new Error(`${rpc}: difficulty ${difficultyNumber} not found for ${marathonQuestId}`);
  return liveQuestFromMarathonRows(marathonQuestId, quest, diff) as unknown as QuestRow;
}

/**
 * Live card stats for filled deck positions, in the order given (sorted by
 * Position by the caller). Index is 1-based by array order.
 */
export async function deckCardStats(playerId: string, quest: QuestRow | null, positions: Decoded[]): Promise<LiveDeckCard[]> {
  const setting = await getSetting();
  if (setting === null) throw new Error('master Setting is missing');
  const owned = await listElements(playerId, 'Cards', db);
  const ownedByID = new Map(owned.map((row) => [s(row.CardId), row]));
  const cards: LiveDeckCard[] = [];
  const ownedRows: Decoded[] = [];
  positions.forEach((position, i) => {
    const ownedCard = ownedByID.get(s(position.CardId));
    if (ownedCard === undefined) throw new Error(`deck card ${s(position.CardId)} is not owned`);
    ownedRows.push(ownedCard);
    cards.push({
      Index: i + 1,
      CardId: s(ownedCard.CardId),
      Level: n(ownedCard.Level),
      Rarity: n(ownedCard.Rarity),
      EvolutionLevel: n(ownedCard.EvolutionLevel),
      Vocal: n(ownedCard.Vocal),
      Dance: n(ownedCard.Dance),
      Visual: n(ownedCard.Visual),
      Stamina: n(ownedCard.Stamina),
      Mental: n(setting.CardDefaultMental),
      Technique: n(setting.CardDefaultTechnique),
      Skills: [],
    } as unknown as LiveDeckCard);
  });

  if (quest === null) {
    for (const card of cards) applyLiveCardStats(card, new Map<number, number>());
    return cards;
  }

  const { bonuses: global, equipment } = await prepareOwnedLiveAbilities(owned, quest, db);
  const masters = await listCardsByIds(positions.map((p) => s(p.CardId)));
  const byCard = new Map(masters.map((row) => [s(row.Id), row]));
  const byCharacter = new Map((await listElements(playerId, 'Characters', db)).map((row) => [s(row.CharacterId), row]));
  const byMasterCharacter = new Map((await listCharacters()).map((row) => [s(row.Id), row]));
  const input = { Cards: new Map(), Users: [] } as unknown as Input;
  const self = {
    Index: 1,
    UserId: '',
    Name: '',
    EmblemId: '',
    UserDeck: { DeckName: '', Cards: [], BonusSkills: [] },
  } as unknown as LiveUserInfo;
  const photoBonuses: PreparedPhotoBonus[] = [];
  const seenPhotos = new Set<string>();
  const accessoryCounts = new Map<string, number>();
  const bonusByIndex = new Map<number, Map<number, number>>();

  for (let i = 0; i < positions.length; i++) {
    const position = positions[i];
    const card = cards[i];
    const master = byCard.get(s(position.CardId));
    if (master === undefined) throw new Error(`deck card ${s(position.CardId)} is missing from master`);
    const masterCharacter = byMasterCharacter.get(s(master.CharacterId));
    const userCharacter = byCharacter.get(s(master.CharacterId));
    if (masterCharacter === undefined || userCharacter === undefined) throw new Error('live character is missing');
    const bonuses = new Map<number, number>(global);
    await prepareLiveEquipment(
      playerId,
      quest,
      position,
      ownedRows[i],
      masterCharacter as unknown as CharacterRow,
      n(master.Type),
      card,
      bonuses,
      equipment,
      photoBonuses,
      seenPhotos,
      accessoryCounts,
      db,
    );
    input.Cards.set(i + 1, {
      CharacterID: s(masterCharacter.Id),
      GroupID: s(masterCharacter.CharacterGroupId),
      Type: n(master.Type),
      Attribute: liveCardAttribute(master),
      LightFans: n(userCharacter.LightFanAmount),
      MiddleFans: n(userCharacter.MiddleFanAmount),
      HeavyFans: n(userCharacter.HeavyFanAmount),
      Bonuses: bonuses,
      StrengthModifiers: [],
      CharacterAdvantagePermil: 0,
    } as never);
    bonusByIndex.set(i + 1, bonuses);
    self.UserDeck!.Cards!.push(card);
  }
  await applyPreparedPhotoBonuses(input, self, photoBonuses, db);
  for (const card of cards) applyLiveCardStats(card, bonusByIndex.get(n(card.Index))!);
  return cards;
}

function accessoryInfos(row: Decoded): Decoded[] {
  return [s(row.Part1AccessoryId), s(row.Part2AccessoryId)]
    .filter((id) => id !== '')
    .map((id) => ({ __msg: ACCESSORY_INFO_MSG, AccessoryId: id } as Decoded));
}

function photoInfos(row: Decoded): Decoded[] {
  const ids = Array.isArray(row.PhotoIds) ? (row.PhotoIds as unknown[]) : [];
  return ids
    .map((id) => s(id))
    .filter((id) => id !== '')
    .map((id) => ({ __msg: PHOTO_INFO_MSG, PhotoId: id } as Decoded));
}

/** One MarathonDeckInfo for deck `number`, built from the given DeckPositions rows. */
async function buildDeckInfo(
  playerId: string,
  number: number,
  positionRows: Decoded[],
  quest: QuestRow | null,
): Promise<Decoded> {
  const rows = positionRows
    .filter((row) => n(row.Number) === number && s(row.CardId) !== '')
    .sort((a, b) => n(a.Position) - n(b.Position));
  const cards = rows.length === 0 ? [] : await deckCardStats(playerId, quest, rows);
  let overall = 0;
  const details = cards.map((card, i) => {
    const row = rows[i];
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
    CardDetailInfo: details,
    DeckOverallValue: overall,
  } as Decoded;
}

register(
  'Marathon:ListDeck',
  async (ctx: RpcContext) => {
    const req = (ctx.request ?? {}) as Decoded;
    return withQuestPlayer(ctx, 'Marathon:ListDeck', async (playerId) => {
      const quest = await resolveMarathonQuest(req, 'Marathon:ListDeck');
      const decks = (await listElements(playerId, 'Decks', db)).sort((a, b) => n(a.Number) - n(b.Number));
      const positionRows = await listElements(playerId, 'DeckPositions', db);
      const deckInfos: Decoded[] = [];
      for (const deck of decks) {
        deckInfos.push(await buildDeckInfo(playerId, n(deck.Number), positionRows, quest));
      }
      return {
        __msg: LIST_DECK_RESPONSE_MSG,
        DeckInfos: deckInfos,
        BuddyDeckInfos: [],
        CommonResponse: commonResponse(emptyUpdated()),
      } as Decoded;
    });
  },
  { ownsState: true },
);

register(
  'Marathon:SaveDeck',
  async (ctx: RpcContext) => {
    const req = (ctx.request ?? {}) as Decoded;
    return withQuestPlayer(ctx, 'Marathon:SaveDeck', async (playerId) => {
      const quest = await resolveMarathonQuest(req, 'Marathon:SaveDeck');
      const saved = await saveDeckRequest(ctx, {
        Number: req.Number,
        Name: req.Name,
        UserDeckPositions: req.UserDeckPositions,
      } as Decoded);
      const data = (saved.CommonResponse as Decoded).UpdatedData as Decoded;
      const number = n((data.Decks as Decoded[])[0].Number);
      const deckInfo = await buildDeckInfo(playerId, number, (data.DeckPositions as Decoded[]) ?? [], quest);
      return {
        __msg: DECK_SAVE_RESPONSE_MSG,
        DeckInfo: deckInfo,
        CommonResponse: saved.CommonResponse,
      } as Decoded;
    });
  },
  { ownsState: true },
);
