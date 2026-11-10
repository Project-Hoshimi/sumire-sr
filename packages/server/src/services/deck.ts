import { eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx } from '../db/tx.ts';
import { players, playerEntities } from '../db/schema.ts';
import { allocateDeckNumber, deleteDeck, saveDeck } from './playerState.ts';
import { GRPC_STATUS, RpcError } from './errors.ts';
import { decodeMessage, msgRegistry, Reader, type Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

const USER_DECK_MSG = 'Solis.Common.Proto.Transaction.UserDeck';
const DECK_POSITION_MSG = 'Solis.Common.Proto.Api.UserDeckPosition';
const DECK_SAVE_RESPONSE_MSG = 'Solis.Common.Proto.Api.DeckSaveResponse';
const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DECK_DELETE_RESPONSE_MSG = 'Solis.Common.Proto.Api.DeckDeleteResponse';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';

/**
 * `Deck:Save` — server-authoritative. Persists the client's submitted deck name
 * and positions for the authenticated player and echoes the resulting
 * `Decks`/`DeckPositions` in `CommonResponse.UpdatedData`. Replaces the captured
 * replay response, so any deck (not just the one in the corpus) is editable.
 */
register('Deck:Save', async (ctx) => {
  const req = ctx.request;
  if (!req) throw new Error('Deck:Save: missing request');

  const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
  if (!accountId) throw new Error('Deck:Save: unauthenticated');
  const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  if (!pl) throw new Error('Deck:Save: no player for account');

  // `Number` 0 asks for a new deck: the server assigns the next number in the
  // account's deck sequence and echoes it (solis-server deck/save.go). Any
  // other value edits that deck.
  const requested = Number(req.Number ?? 0);
  const submittedName = String(req.Name ?? '');
  const submitted = Array.isArray(req.UserDeckPositions) ? (req.UserDeckPositions as Decoded[]) : [];

  const ownedCards = await ownedCardIds(pl.id);
  const positions: Decoded[] = [];
  for (const p of submitted) {
    const cardId = p.CardId == null ? '' : String(p.CardId);
    if (cardId && ownedCards.size > 0 && !ownedCards.has(cardId)) {
      ctx.fastifyReq.log.warn({ deckNumber: requested, cardId }, 'deck save references unowned card');
    }
    positions.push({
      __msg: DECK_POSITION_MSG,
      Number: requested,
      Position: Number(p.Position ?? 0),
      CardId: cardId || undefined,
      Part1AccessoryId: p.Part1AccessoryId,
      Part2AccessoryId: p.Part2AccessoryId,
      PhotoIds: Array.isArray(p.PhotoIds) ? p.PhotoIds : undefined,
      CostumeId: p.CostumeId,
      BuddyUserId: p.BuddyUserId,
      HairId: p.HairId,
    });
  }

  const { number, name, user } = await withPlayerTx(pl.id, async (tx) => {
    const alloc = requested === 0 ? await allocateDeckNumber(pl.id, tx) : { number: requested, user: null };
    // The client normally sends the name; the reference server falls back to
    // this one when it is empty.
    const deckName = requested === 0 && submittedName === '' ? `ユニット${alloc.number}` : submittedName;
    for (const p of positions) p.Number = alloc.number;
    await saveDeck(pl.id, { Number: alloc.number, Name: deckName }, positions, tx);
    return { number: alloc.number, name: deckName, user: alloc.user };
  });

  ctx.fastifyReq.log.info(
    { accountId, serverUserId: pl.id, deckNumber: number, positions: positions.length },
    'deck save (server-authoritative)',
  );

  return {
    __msg: DECK_SAVE_RESPONSE_MSG,
    CommonResponse: {
      __msg: COMMON_RESPONSE_MSG,
      UpdatedData: {
        __msg: UPDATED_DATA_MSG,
        // A new deck advances `User.DeckSequence`; the client names the next
        // new deck from it.
        User: user ?? undefined,
        Decks: [{ __msg: USER_DECK_MSG, Number: number, Name: name }],
        DeckPositions: positions,
      },
    },
  } as Decoded;
}, { ownsState: true });

/**
 * `Deck:Delete` — removes the deck with the requested `Number` and its
 * positions for the authenticated player, and reports both in
 * `CommonResponse.DeletedData`. Deleting a deck that does not exist succeeds
 * and still reports the deck number.
 */
register('Deck:Delete', async (ctx) => {
  const req = ctx.request;
  if (!req) throw new Error('Deck:Delete: missing request');

  const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
  if (!accountId) throw new Error('Deck:Delete: unauthenticated');
  const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  if (!pl) throw new Error('Deck:Delete: no player for account');

  const number = Number(req.Number ?? 0);
  if (!Number.isInteger(number) || number <= 0) {
    throw new RpcError('Deck:Delete: a positive deck number is required', GRPC_STATUS.INVALID_ARGUMENT);
  }

  const removed = await withPlayerTx(pl.id, (tx) => deleteDeck(pl.id, number, tx));

  ctx.fastifyReq.log.info(
    { accountId, serverUserId: pl.id, deckNumber: number, positions: removed.length },
    'deck delete',
  );

  return {
    __msg: DECK_DELETE_RESPONSE_MSG,
    CommonResponse: {
      __msg: COMMON_RESPONSE_MSG,
      UpdatedData: { __msg: UPDATED_DATA_MSG },
      DeletedData: {
        __msg: DELETED_DATA_MSG,
        Decks: [{ __msg: USER_DECK_MSG, Number: number }],
        DeckPositions: removed.map((position) => ({ __msg: DECK_POSITION_MSG, Number: number, Position: position })),
      },
    },
  } as Decoded;
}, { ownsState: true });

async function ownedCardIds(playerId: string): Promise<Set<string>> {
  const shape = msgRegistry.get('Solis.Common.Proto.Transaction.UserCard');
  if (!shape) return new Set();
  const rows = await db
    .select()
    .from(playerEntities)
    .where(eq(playerEntities.playerId, playerId));
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.kind !== 'Cards') continue;
    const el = decodeMessage(shape, new Reader(Uint8Array.from(Buffer.from(r.blob, 'base64'))));
    if (el.CardId != null) ids.add(String(el.CardId));
  }
  return ids;
}
