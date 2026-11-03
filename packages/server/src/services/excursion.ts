// Ported from solis-server (AGPL-3.0), internal/server/rpc/servers/excursion
import { randomInt, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { playerEntities, playerExcursionState } from '../db/schema.ts';
import {
  getCostume,
  getExcursionGazeReaction,
  getExcursionPlace,
  getExcursionPlaceSetting,
  getHair,
  getItem,
  listCompanyEnjoyObtainPointItemSettingsByCharacter,
  listExcursionPlaceSettingsByCharacter,
  master,
} from '../master/index.ts';
import { isSandbox } from '../profile.ts';
import { accountOf, commonResponse, playerForAccount } from './activity.ts';
import { listElements, putElements, replaceElements } from './playerState.ts';
import {
  encodeMessage,
  msgRegistry,
  Writer,
  type Decoded,
} from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Excursion (おでかけ) — port of the Solis list/start/finish flow.
 *
 * `List` offers a small random subset of a character's places, `Start` moves
 * one offered place into the active slot, and `Finish` records the watched gaze
 * reactions and posts the character's company-enjoy gift. The sandbox profile
 * relaxes the offer/wardrobe gates so every place and reaction is reachable.
 */

const LIST_RESPONSE_MSG = 'Solis.Common.Proto.Api.ExcursionListResponse';
const START_RESPONSE_MSG = 'Solis.Common.Proto.Api.ExcursionStartResponse';
const SET_WATCHED_RESPONSE_MSG = 'Solis.Common.Proto.Api.ExcursionSetWatchedGazeReactionResponse';
const FINISH_RESPONSE_MSG = 'Solis.Common.Proto.Api.ExcursionFinishResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const USER_EXCURSION_GAZE_REACTION_MSG =
  'Solis.Common.Proto.Transaction.UserExcursionGazeReaction';
const USER_GIFT_MSG = 'Solis.Common.Proto.Transaction.UserGift';
const USER_NOTIFICATION_MSG = 'Solis.Common.Proto.Transaction.UserNotification';
const REWARD_RESULT_MSG = 'Solis.Common.Proto.Transaction.RewardResult';

const GIFT_KIND = 'Gifts';
const NOTIFICATIONS_KIND = 'Notifications';
/** `Solis.Common.Proto.NotificationType.Gift`. */
const GIFT_NOTIFICATION_TYPE = 3;
const EXCURSION_GIFT_MESSAGE = '交流のおでかけ報酬';
const RES_ITEM = 1;
const OFFER_COUNT = 2;

type ExcursionStateRow = typeof playerExcursionState.$inferSelect;

type StateValues = {
  offeredCharacter: string;
  offeredPlaceIds: string[];
  activeCharacter: string;
  activePlaceId: string;
  startedTime: number;
};

function emptyUpdated(): Decoded {
  return { __msg: UPDATED_DATA_MSG } as Decoded;
}

async function loadState(exec: Executor, playerId: string): Promise<ExcursionStateRow | null> {
  const [row] = await exec
    .select()
    .from(playerExcursionState)
    .where(eq(playerExcursionState.playerId, playerId))
    .limit(1);
  return row ?? null;
}

async function saveState(
  exec: Executor,
  playerId: string,
  values: StateValues,
): Promise<void> {
  await exec
    .insert(playerExcursionState)
    .values({ playerId, ...values })
    .onConflictDoUpdate({
      target: playerExcursionState.playerId,
      set: { ...values, updatedAt: new Date() },
    });
}

async function requireOwnedCharacter(
  exec: Executor,
  playerId: string,
  characterId: string,
  rpc: string,
): Promise<void> {
  if (!characterId) throw new Error(`${rpc}: CharacterId is required`);
  const characters = await listElements(playerId, 'Characters', exec);
  if (!characters.some((c) => String(c.CharacterId ?? '') === characterId)) {
    throw new Error(`${rpc}: character not owned ${characterId}`);
  }
}

/** Fisher-Yates shuffle using crypto random, as Solis `list.go`. */
function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

function reactionKey(characterId: string, placeId: string, number: number): string {
  return `${characterId}\u0001${placeId}\u0001${number}`;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * `excursionReactionAvailable`: a reaction with costume unlocks is only shown
 * while wearing one of those costumes, and explicit exclusions always win.
 */
function excursionReactionAvailable(
  reaction: { UnlockCostumeIds?: unknown; UnlockNotCostumeIds?: unknown },
  costumeId: string,
): boolean {
  const unlock = stringList(reaction.UnlockCostumeIds);
  if (unlock.length > 0 && !unlock.includes(costumeId)) return false;
  return !stringList(reaction.UnlockNotCostumeIds).includes(costumeId);
}

/**
 * Port of Solis `validateExcursionWardrobe`: ownership, character match, and
 * hair/costume plus place wearability rules.
 */
async function validateExcursionWardrobe(
  exec: Executor,
  playerId: string,
  characterId: string,
  placeId: string,
  costumeId: string,
  hairId: string,
): Promise<{ CostumeTypeId: unknown }> {
  if (!costumeId) throw new Error('costume is required');
  if (!hairId) throw new Error('hair is required');

  const ownedCostumes = new Set(
    (await listElements(playerId, 'Costumes', exec)).map((c) => String(c.CostumeId ?? '')),
  );
  const ownedHairs = new Set(
    (await listElements(playerId, 'Hairs', exec)).map((h) => String(h.HairId ?? '')),
  );
  if (!ownedCostumes.has(costumeId)) throw new Error('costume is not owned');
  if (!ownedHairs.has(hairId)) throw new Error('hair is not owned');

  const [costume, hair, place] = await Promise.all([
    getCostume(costumeId),
    getHair(hairId),
    getExcursionPlace(placeId),
  ]);
  if (!costume || !hair || !place) throw new Error('excursion wardrobe master data is missing');

  if (
    String(costume.CharacterId ?? '') !== characterId ||
    String(hair.CharacterId ?? '') !== characterId
  ) {
    throw new Error('costume or hair belongs to another character');
  }

  const wearable = stringList(hair.WearableCostumeIds);
  if (wearable.length > 0 && !wearable.includes(costumeId)) {
    throw new Error('hair cannot be worn with costume');
  }
  if (stringList(hair.NotWearableCostumeIds).includes(costumeId)) {
    throw new Error('hair cannot be worn with costume');
  }

  if (stringList(place.NotWearableCostumeTypeIds).includes(String(costume.CostumeTypeId ?? ''))) {
    throw new Error('costume cannot be worn at excursion place');
  }

  return costume;
}

/**
 * Port of Solis `FindExcursionGiftItem`: the highest-`ObtainPoint` company-enjoy
 * item for the character. Returns null when there is nothing to award.
 */
async function findExcursionGiftItem(characterId: string): Promise<string | null> {
  const rows = await listCompanyEnjoyObtainPointItemSettingsByCharacter(characterId);
  if (rows.length === 0) return null;

  const best = rows[0]!;
  const itemId = String(best.ItemId ?? '');
  const point = Number(best.ObtainPoint ?? 0);
  if (!itemId || point <= 0) return null;

  for (const row of rows.slice(1)) {
    if (Number(row.ObtainPoint ?? 0) === point && String(row.ItemId ?? '') !== itemId) {
      throw new Error('excursion gift item is ambiguous');
    }
  }

  if (!(await getItem(itemId))) throw new Error(`excursion gift item not found ${itemId}`);
  return itemId;
}

/** Insert a UserGift row into the player's gift box (same storage as gift.ts). */
async function postExcursionGift(
  exec: Executor,
  playerId: string,
  itemId: string,
  now: number,
): Promise<void> {
  const gift = {
    __msg: USER_GIFT_MSG,
    GiftId: randomUUID(),
    ResourceType: RES_ITEM,
    ResourceId: itemId,
    Amount: 1,
    Message: EXCURSION_GIFT_MESSAGE,
    PostedTime: now,
    LimitTime: 0,
  } as Decoded;

  const shape = msgRegistry.get(USER_GIFT_MSG);
  if (!shape) throw new Error('UserGift proto is not registered');
  const writer = new Writer();
  encodeMessage(shape, gift, writer);

  const [max] = await exec
    .select({ ordinal: playerEntities.ordinal })
    .from(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, GIFT_KIND)))
    .orderBy(desc(playerEntities.ordinal))
    .limit(1);

  await exec.insert(playerEntities).values({
    id: randomUUID(),
    playerId,
    kind: GIFT_KIND,
    entityKey: String(gift.GiftId),
    ordinal: Number(max?.ordinal ?? -1) + 1,
    blob: Buffer.from(writer.toBytes()).toString('base64'),
    createdAt: new Date(),
  });
}

/** `Excursion:List` — offer places for a character. */
register(
  'Excursion:List',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const pl = await playerForAccount(accountId, 'Excursion:List');
    const characterId = String(ctx.request?.CharacterId ?? '');

    const placeIds = await withPlayerTx(pl.id, async (tx) => {
      await requireOwnedCharacter(tx, pl.id, characterId, 'Excursion:List');

      const settings = await listExcursionPlaceSettingsByCharacter(characterId);
      const masterPlaces = new Set(
        (await tx.select({ Id: master.masterExcursionPlace.Id }).from(master.masterExcursionPlace))
          .map((row) => String(row.Id ?? ''))
          .filter(Boolean),
      );

      const available: string[] = [];
      const seen = new Set<string>();
      for (const setting of settings) {
        const placeId = String(setting.ExcursionPlaceId ?? '');
        if (!placeId || seen.has(placeId) || !masterPlaces.has(placeId)) continue;
        seen.add(placeId);
        available.push(placeId);
      }
      if (available.length === 0) throw new Error('no excursion places are available');

      const state = await loadState(tx, pl.id);
      if (!isSandbox() && state?.activeCharacter) {
        throw new Error('an excursion is already active');
      }

      // Official: a random pair of offers. Sandbox: every place, master order.
      const offered = isSandbox() ? available : shuffle(available).slice(0, OFFER_COUNT);
      await saveState(tx, pl.id, {
        offeredCharacter: characterId,
        offeredPlaceIds: offered,
        activeCharacter: '',
        activePlaceId: '',
        startedTime: 0,
      });
      return offered;
    });

    return {
      __msg: LIST_RESPONSE_MSG,
      ExcursionPlaceIds: placeIds,
      CommonResponse: commonResponse(emptyUpdated()),
    } as Decoded;
  },
  { ownsState: true },
);

/** `Excursion:Start` — begin an offered excursion. */
register(
  'Excursion:Start',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const pl = await playerForAccount(accountId, 'Excursion:Start');
    const characterId = String(ctx.request?.CharacterId ?? '');
    const placeId = String(ctx.request?.ExcursionPlaceId ?? '');

    await withPlayerTx(pl.id, async (tx) => {
      await requireOwnedCharacter(tx, pl.id, characterId, 'Excursion:Start');

      const setting = await getExcursionPlaceSetting(characterId, placeId);
      if (!setting) throw new Error('excursion place is unavailable for character');
      if (!(await getExcursionPlace(placeId))) {
        throw new Error(`excursion place not found ${placeId}`);
      }

      const state = await loadState(tx, pl.id);
      if (!isSandbox()) {
        if (state?.activeCharacter) throw new Error('an excursion is already active');
        const offered = Array.isArray(state?.offeredPlaceIds) ? state.offeredPlaceIds : [];
        if (state?.offeredCharacter !== characterId || !offered.includes(placeId)) {
          throw new Error('excursion place was not offered');
        }
      }

      await saveState(tx, pl.id, {
        offeredCharacter: '',
        offeredPlaceIds: [],
        activeCharacter: characterId,
        activePlaceId: placeId,
        startedTime: Date.now(),
      });
    });

    return {
      __msg: START_RESPONSE_MSG,
      RewardResults: [],
      CommonResponse: commonResponse(emptyUpdated()),
    } as Decoded;
  },
  { ownsState: true },
);

/** `Excursion:SetWatchedGazeReaction` — remember a reaction the player watched. */
register(
  'Excursion:SetWatchedGazeReaction',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const pl = await playerForAccount(accountId, 'Excursion:SetWatchedGazeReaction');
    const characterId = String(ctx.request?.CharacterId ?? '');
    const placeId = String(ctx.request?.ExcursionPlaceId ?? '');
    const number = Number(ctx.request?.Number ?? 0);

    if (!characterId || !placeId) {
      throw new Error('Excursion:SetWatchedGazeReaction: CharacterId and ExcursionPlaceId are required');
    }

    const element = await withPlayerTx(pl.id, async (tx) => {
      const reaction = await getExcursionGazeReaction(characterId, placeId, number);
      if (!reaction) throw new Error('unknown gaze reaction');

      const existing = await listElements(pl.id, 'ExcursionGazeReactions', tx);
      const present = existing.some(
        (row) =>
          String(row.CharacterId ?? '') === characterId &&
          String(row.ExcursionPlaceId ?? '') === placeId &&
          Number(row.GazeReactionNumber ?? 0) === number,
      );

      const row = {
        __msg: USER_EXCURSION_GAZE_REACTION_MSG,
        CharacterId: characterId,
        ExcursionPlaceId: placeId,
        GazeReactionNumber: number,
      } as Decoded;
      if (!present) {
        await putElements(pl.id, 'ExcursionGazeReactions', [row], tx);
      }
      return row;
    });

    return {
      __msg: SET_WATCHED_RESPONSE_MSG,
      CommonResponse: commonResponse({
        __msg: UPDATED_DATA_MSG,
        ExcursionGazeReactions: [element],
      } as Decoded),
    } as Decoded;
  },
  { ownsState: true },
);

/** `Excursion:Finish` — record reactions, award the company-enjoy gift, clear state. */
register(
  'Excursion:Finish',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const pl = await playerForAccount(accountId, 'Excursion:Finish');
    const rawNumbers = Array.isArray(ctx.request?.GazeReactionNumbers)
      ? (ctx.request.GazeReactionNumbers as unknown[])
      : [];
    const costumeId = String(ctx.request?.CostumeId ?? '');
    const hairId = String(ctx.request?.HairId ?? '');

    const out = await withPlayerTx(pl.id, async (tx) => {
      const state = await loadState(tx, pl.id);
      if (
        !state ||
        !state.activeCharacter ||
        !state.activePlaceId ||
        Number(state.startedTime) <= 0
      ) {
        throw new Error('no excursion is active');
      }

      const characterId = state.activeCharacter;
      const placeId = state.activePlaceId;

      if (isSandbox()) {
        if (!costumeId || !hairId) throw new Error('costume or hair is required');
      } else {
        await validateExcursionWardrobe(tx, pl.id, characterId, placeId, costumeId, hairId);
      }

      const existing = await listElements(pl.id, 'ExcursionGazeReactions', tx);
      const watched = new Set(
        existing.map((row) =>
          reactionKey(
            String(row.CharacterId ?? ''),
            String(row.ExcursionPlaceId ?? ''),
            Number(row.GazeReactionNumber ?? 0),
          ),
        ),
      );

      const updatedReactions: Decoded[] = [];
      const seen = new Set<number>();
      for (const raw of rawNumbers) {
        const number = Number(raw);
        // Sandbox drops bad numbers (0 is the idle reaction) so the outing still ends.
        if (!Number.isInteger(number) || number <= 0) {
          if (isSandbox()) continue;
          throw new Error('gaze reaction numbers must be positive');
        }
        if (seen.has(number)) {
          if (isSandbox()) continue;
          throw new Error('gaze reaction numbers must be unique');
        }
        seen.add(number);

        const reaction = await getExcursionGazeReaction(characterId, placeId, number);
        if (!reaction) {
          if (isSandbox()) continue;
          throw new Error('unknown gaze reaction');
        }
        if (!isSandbox() && !excursionReactionAvailable(reaction, costumeId)) {
          throw new Error('gaze reaction is unavailable for costume');
        }

        const key = reactionKey(characterId, placeId, number);
        if (watched.has(key)) continue;
        watched.add(key);
        updatedReactions.push({
          __msg: USER_EXCURSION_GAZE_REACTION_MSG,
          CharacterId: characterId,
          ExcursionPlaceId: placeId,
          GazeReactionNumber: number,
        } as Decoded);
      }
      if (updatedReactions.length > 0) {
        await putElements(pl.id, 'ExcursionGazeReactions', updatedReactions, tx);
      }

      const now = Date.now();
      const giftItemId = await findExcursionGiftItem(characterId);
      let giftNotification: Decoded | null = null;
      if (giftItemId) {
        await postExcursionGift(tx, pl.id, giftItemId, now);

        // Light the present-box badge. `Notifications` has no identity key (its
        // rows use positional `#N` keys), so rewrite the whole collection.
        const notifications = await listElements(pl.id, NOTIFICATIONS_KIND, tx);
        const index = notifications.findIndex(
          (n) => Number(n.NotificationType) === GIFT_NOTIFICATION_TYPE,
        );
        if (index < 0) {
          giftNotification = {
            __msg: USER_NOTIFICATION_MSG,
            NotificationType: GIFT_NOTIFICATION_TYPE,
            Valid: true,
          } as Decoded;
          notifications.push(giftNotification);
          await replaceElements(pl.id, NOTIFICATIONS_KIND, notifications, tx);
        } else if (!notifications[index]!.Valid) {
          giftNotification = { ...notifications[index]!, Valid: true } as Decoded;
          notifications[index] = giftNotification;
          await replaceElements(pl.id, NOTIFICATIONS_KIND, notifications, tx);
        }
      }

      await saveState(tx, pl.id, {
        offeredCharacter: '',
        offeredPlaceIds: [],
        activeCharacter: '',
        activePlaceId: '',
        startedTime: 0,
      });

      const updated = emptyUpdated();
      if (updatedReactions.length > 0) updated.ExcursionGazeReactions = updatedReactions;
      if (giftNotification) updated.Notifications = [giftNotification];

      const rewardResults: Decoded[] = giftItemId
        ? [
            {
              __msg: REWARD_RESULT_MSG,
              ResourceType: RES_ITEM,
              ResourceId: giftItemId,
              AmountI64: 1,
              IsGift: true,
            } as Decoded,
          ]
        : [];

      return { rewardResults, updated };
    });

    return {
      __msg: FINISH_RESPONSE_MSG,
      RewardResults: out.rewardResults,
      CommonResponse: commonResponse(out.updated),
    } as Decoded;
  },
  { ownsState: true },
);
