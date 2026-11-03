import HomeEnterResponse from '@sumire-sr/protocol/gen/Solis_Common_Proto_Api_HomeEnterResponse.ts';
import HomeLoginResponse from '@sumire-sr/protocol/gen/Solis_Common_Proto_Api_HomeLoginResponse.ts';
import '@sumire-sr/protocol/gen/Solis_Common_Proto_Api_HomeLoveInfo.ts';
import '@sumire-sr/protocol/gen/Solis_Common_Proto_Api_HomeEventInfo.ts';
import { decodeMessage, encodeMessage, Reader, Writer, type Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { eq } from 'drizzle-orm';
import { getCorpusResponse, getFreshCapture } from './replay/corpus.ts';
import {
  collectionElementMsg,
  findPlayerByAccountId,
  getSingleton,
  isFreshPlayer,
  listElements,
  putElements,
  replaceElements,
} from './playerState.ts';
import { register } from './handlers.ts';
import { withPlayerTx } from '../db/tx.ts';
import { hasReceivableGift } from './gift.ts';
import { accountOf, commonResponse, lessonHomeFields, playerForAccount, reconcileLessonState } from './activity.ts';
import { activePromotionForHome } from './activityPromotion.ts';
import { isSandbox } from '../profile.ts';
import { SANDBOX_HIERARCHY_DETAIL_GRADE_ID, SANDBOX_HIERARCHY_RANK } from '../profiles/sandbox/hierarchy.ts';
import { db } from '../db/client.ts';
import { listGachas, master } from '../master/index.ts';
import { isSandboxBlockedGacha } from '../profiles/sandbox/showcase.ts';
import { sandboxEventStoryInfos } from '../profiles/sandbox/story.ts';
import { sandboxHomeShelfInfo, sandboxShelfButton } from '../profiles/sandbox/shelf.ts';

const LOVE_INFO_MSG = 'Solis.Common.Proto.Api.HomeLoveInfo';
const EVENT_INFO_MSG = 'Solis.Common.Proto.Api.HomeEventInfo';

// Official fresh-account Home:Enter responses: during the opening tutorial and
// after it has been cleared (see captures/2026-10-25_fresh_official).
const FRESH_HOME_DURING_TUTORIAL = '00033.resp-plain.Home:Enter.bin';
const FRESH_HOME_CLEARED = '00055.resp-plain.Home:Enter.bin';
// Account-progress fields taken from the fresh capture; everything else in a
// fresh player's Home:Enter is the corpus body (it matches our master data).
const FRESH_HOME_FIELDS = [
  'LessonProgress',
  'LessonInfo',
  'CurrentMainAreaId',
  'CurrentTowerQuestId',
  'IsUnclearedPlayableQuest',
  'HasReceivableGift',
];

/**
 * The Love (idol bond VN) feature is server-gated: the client only reveals the
 * Love menu when `Home:Enter` carries a viewable/unlocked `HomeLoveInfo`. The
 * captured responses all omit it, so we inject an unlocked one on top of the
 * replayed `Home:Enter` payload, preserving every other field verbatim.
 */
function unlockedLoveInfo() {
  return {
    __msg: LOVE_INFO_MSG,
    IsViewable: true,
    IsUnlocked: true,
    ExistsLessonRewardMaxLove: true,
    ExistsUnplayedLove: true,
    ExistsHasHiddenFavorabilityObtainItemLove: true,
  };
}

/**
 * The captured `Home:Enter` carries the captured account's in-progress (or
 * ended) Promotion and Refresh slots, idols included. Show the player's own
 * promotion run instead, and an empty Refresh slot (Refresh is not served).
 */
function setActiveSlots(body: any, activePromotion: unknown): void {
  if (body.PromotionInfo) {
    if (activePromotion) body.PromotionInfo.ActivePromotion = activePromotion;
    else delete body.PromotionInfo.ActivePromotion;
  }
  if (body.RefreshInfo) delete body.RefreshInfo.ActiveRefresh;
}

/**
 * The home Events page lists what `Home:Enter` EventInfo carries (event
 * missions, tours, marathons...), and the home Events button shows the art of
 * the top `EventButtonDisplayInfos` entry. The sandbox serves none of those
 * events, so it sends both empty: the page opens blank and the button falls
 * back to the generic one. The Story > Event list is built from
 * EventStoryInfos (the client never calls Story:ListEvent for it), and the
 * corpus capture predates newer event stories, so send every master event
 * story unlocked instead.
 */
async function applySandboxEvents(body: any): Promise<void> {
  if (!isSandbox()) return;
  body.EventInfo = { __msg: EVENT_INFO_MSG };
  body.EventInfo.ShelfInfo = sandboxHomeShelfInfo();
  body.EventButtonDisplayInfos = [sandboxShelfButton()];
  body.EventStoryInfos = sandboxEventStoryInfos(await db.select().from(master.masterEventStory));
}

/**
 * The goods shop's 開封 button opens the showcase toy packs listed in the
 * cached `GachaInfos`, without asking the server. Their assets are missing
 * from the client and sandbox players already own every toy, so drop them
 * (`Gacha:Draw` refuses them too).
 */
async function dropSandboxToyGachas(body: any): Promise<void> {
  if (!isSandbox() || !Array.isArray(body.GachaInfos)) return;
  const blocked = new Set((await listGachas()).filter((g) => isSandboxBlockedGacha(g)).map((g) => String(g.Id)));
  body.GachaInfos = body.GachaInfos.filter((g: any) => !blocked.has(String(g.Id ?? '')));
}

/**
 * The sandbox does not serve the home Roulette, VENUS UNION (guild), Manager
 * Training or Invite Code features. The corpus capture still carries an empty
 * `RouletteInfo` message (which the client reads as "roulette open"), a
 * `GvgInfo` block and positive exercise/invite flags, so those buttons would
 * appear and lead nowhere. Drop or clear them alongside the event overrides.
 */
function applySandboxHomeButtons(body: any): void {
  if (!isSandbox()) return;
  delete body.RouletteInfo;
  delete body.GvgInfo;
  body.ExistsUnclearedExercise = false;
  body.HasCanReceiveInviteHostRewards = false;
  // Shop and Exchange are blocked, so drop the data that lights their "!" badges.
  delete body.NotiStoneShopItem;
  delete body.NotiNormalShopItem;
  delete body.NotiShowcaseShopItem;
  body.IsDefaultNormalShopFreeItemStockExist = false;
  body.ExchangeBoothIds = [];
  // The Photo Album event replaces the Special Photography home icon.
  delete body.SpecialPhotoShootingInfo;
  // Shop ids the client hasn't seen show a "NEW" tag on the Shop button.
  body.ShopIds = [];
  body.ShowcaseToyShopIds = [];
  // Every diary page is served as read, and friend requests are never listed,
  // so neither the diary nor the profile's Requests button gets a "!" badge.
  body.IsRemainingDiary = false;
  body.FriendAppliedCount = 0;
  // Unclaimed achievement rank rewards light the Task badge; Tasks are blocked too.
  body.HierarchyNotiInfo = {
    __msg: 'Solis.Common.Proto.Api.HierarchyNotiInfo',
    ...(body.HierarchyNotiInfo ?? {}),
    RewardIds: [],
    DivisionRewardIds: [],
    // Every sandbox player is shown at the top Venus ranking grade (BIG4).
    CurrentDetailGradeId: SANDBOX_HIERARCHY_DETAIL_GRADE_ID,
    CurrentRank: SANDBOX_HIERARCHY_RANK,
  };
}

register('Home:Enter', async (ctx) => {
  const pl = await findPlayerByAccountId(ctx.auth.ok ? ctx.auth.claims?.sub : undefined);
  const activity = pl
    ? await withPlayerTx(pl.id, async (tx) =>
        lessonHomeFields(await reconcileLessonState(pl.id, Date.now(), tx)),
      )
    : null;
  const activePromotion = pl ? await withPlayerTx(pl.id, (tx) => activePromotionForHome(pl.id, tx)) : null;
  // The present-box badge is driven by this field; the capture's value (true)
  // is stale, so a real answer from the player's gift box always wins.
  const receivableGift = pl ? await hasReceivableGift(pl.id) : null;
  let captured: Buffer | null;
  if (pl && isFreshPlayer(pl)) {
    const user = await getSingleton(pl.id, 'User');
    const file = user?.TutorialClearedTime != null ? FRESH_HOME_CLEARED : FRESH_HOME_DURING_TUTORIAL;
    // The fresh capture references October gachas/banners/events that our
    // (September) master lacks, which crashes the client (GachaInfo lookup in
    // UserDataManager.SetCustomData). So keep the corpus body, take only the
    // account-progress fields from the fresh capture, and skip the Love unlock.
    const corpus = getCorpusResponse('Home:Enter');
    const fresh = getFreshCapture(file);
    if (corpus && fresh) {
      const body = decodeMessage(HomeEnterResponse, new Reader(Uint8Array.from(corpus)));
      const freshBody = decodeMessage(HomeEnterResponse, new Reader(Uint8Array.from(fresh)));
      for (const k of FRESH_HOME_FIELDS) {
        if (freshBody[k] === undefined) delete body[k];
        else body[k] = freshBody[k];
      }
      if (activity) {
        body.LessonProgress = activity.LessonProgress;
        body.LessonInfo = activity.LessonInfo;
      }
      body.HasReceivableGift = receivableGift === true;
      setActiveSlots(body, activePromotion);
      await applySandboxEvents(body);
      applySandboxHomeButtons(body);
      await dropSandboxToyGachas(body);
      const w = new Writer();
      encodeMessage(HomeEnterResponse, body, w);
      return Buffer.from(w.toBytes());
    }
    captured = corpus;
  } else {
    captured = getCorpusResponse('Home:Enter');
  }

  const loveInfo = unlockedLoveInfo();
  if (!captured) {
    const w = new Writer();
    encodeMessage(
      HomeEnterResponse,
      {
        __msg: HomeEnterResponse.name,
        ...(activity ?? {}),
        ...(receivableGift === null ? {} : { HasReceivableGift: receivableGift }),
        LoveInfo: loveInfo,
      },
      w,
    );
    return Buffer.from(w.toBytes());
  }
  const decoded = decodeMessage(HomeEnterResponse, new Reader(Uint8Array.from(captured)));
  if (activity) {
    decoded.LessonProgress = activity.LessonProgress;
    decoded.LessonInfo = activity.LessonInfo;
  }
  if (receivableGift !== null) decoded.HasReceivableGift = receivableGift;
  decoded.LoveInfo = loveInfo;
  setActiveSlots(decoded, activePromotion);
  await applySandboxEvents(decoded);
  applySandboxHomeButtons(decoded);
  await dropSandboxToyGachas(decoded);
  const w = new Writer();
  encodeMessage(HomeEnterResponse, decoded, w);
  return Buffer.from(w.toBytes());
});

// Official fresh-account Home:Login (00015). Its UpdatedData carries the User,
// login mission and photo poses from the fresh flow. Swap in the player's
// persisted User so a later login cannot roll back the chosen tutorial name or
// the step-150 level-2 promotion.
const FRESH_HOME_LOGIN = '00015.resp-plain.Home:Login.bin';

/**
 * Tasks are not implemented in sandbox; the captured login mission progress in
 * UpdatedData pops the "Login once a day" task toast on every login.
 */
function dropSandboxLoginMissions(decoded: any): void {
  if (!isSandbox()) return;
  const updated = decoded.CommonResponse?.UpdatedData;
  if (updated) delete updated.Missions;
}

register('Home:Login', async (ctx) => {
  const pl = await findPlayerByAccountId(ctx.auth.ok ? ctx.auth.claims?.sub : undefined);
  const captured = pl && isFreshPlayer(pl) ? getFreshCapture(FRESH_HOME_LOGIN) : null;
  if (!captured) {
    const corpus = getCorpusResponse('Home:Login');
    if (!corpus) throw new Error('corpus has no response for Home:Login');
    if (!isSandbox()) return corpus;
    const decoded = decodeMessage(HomeLoginResponse, new Reader(Uint8Array.from(corpus)));
    dropSandboxLoginMissions(decoded);
    const w = new Writer();
    encodeMessage(HomeLoginResponse, decoded, w);
    return Buffer.from(w.toBytes());
  }

  const decoded = decodeMessage(HomeLoginResponse, new Reader(Uint8Array.from(captured)));
  const user = await getSingleton(pl!.id, 'User');
  if (user) decoded.CommonResponse.UpdatedData.User = user;
  dropSandboxLoginMissions(decoded);
  const w = new Writer();
  encodeMessage(HomeLoginResponse, decoded, w);
  return Buffer.from(w.toBytes());
});

const HOME_POSITION_MSG = 'Solis.Common.Proto.Transaction.UserHomePosition';
const USER_HOME_TALK_MSG = 'Solis.Common.Proto.Transaction.UserHomeTalk';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
// HomePositionType: Home, Training, Activity, Idol.
const HOME_POSITION_TYPES = new Set([1, 2, 3, 4]);
const IDOL_POSITION_TYPE = 4;
const SATOMI = 'char-stm';

/**
 * Slot 4 (Idol) is Satomi's side spot. Master data no longer pins a character
 * there, so the client fills it from the player's type-4 `HomePositions` row and
 * hangs on the lobby load when that row is missing. Every served/stored list
 * must therefore carry a real type-4 character: Satomi when she is not placed in
 * slots 1-3, otherwise a random owned idol that is neither Satomi nor already
 * placed. An existing type-4 row that still satisfies that rule is kept, so the
 * random pick stays stable across logins instead of reshuffling.
 */
export function resolveIdolSlot(
  positions: Decoded[],
  ownedCharacterIds: readonly string[],
  rand: () => number = Math.random,
): Decoded {
  const placed = new Set<string>();
  let satomiPlaced = false;
  let existing: Decoded | undefined;
  for (const p of positions) {
    const type = Number(p.HomePositionType ?? 0);
    if (type === IDOL_POSITION_TYPE) {
      existing ??= p;
      continue;
    }
    if (type < 1 || type > 3) continue;
    const characterId = String(p.CharacterId ?? '');
    if (!characterId) continue;
    placed.add(characterId);
    if (characterId === SATOMI) satomiPlaced = true;
  }

  const row = (characterId: string): Decoded => ({
    __msg: HOME_POSITION_MSG,
    HomePositionType: IDOL_POSITION_TYPE,
    CharacterId: characterId,
    IsCharacterRandom: false,
    IsCostumeRandom: false,
  });

  if (!satomiPlaced) return row(SATOMI);

  const candidates = [...new Set(ownedCharacterIds)].filter(
    (id) => id !== '' && id !== SATOMI && !placed.has(id),
  );
  const existingId = String(existing?.CharacterId ?? '');
  if (existingId !== '' && candidates.includes(existingId)) return row(existingId);
  if (candidates.length === 0) return row(SATOMI);
  const index = Math.min(candidates.length - 1, Math.floor(rand() * candidates.length));
  return row(candidates[index]);
}

/**
 * `Home:SetCharacterPosition` — the lobby idol switch. Each position names a
 * slot (`Type`) and either an owned idol or "random". Random slots get an idol
 * drawn from the owned ones now (as solis-server does) and keep
 * `IsCharacterRandom`. Slots the request leaves out keep their stored idol, and
 * the Idol slot (type 4) is derived by `resolveIdolSlot` so it is always echoed.
 */
register(
  'Home:SetCharacterPosition',
  async (ctx) => {
    const requested = (ctx.request?.Positions ?? []) as Decoded[];
    if (requested.length === 0) throw new Error('Home:SetCharacterPosition: no positions');
    const pl = await playerForAccount(accountOf(ctx), 'Home:SetCharacterPosition');

    const positions = await withPlayerTx(pl.id, async (tx) => {
      const owned = (await listElements(pl.id, 'Characters', tx))
        .map((c) => String(c.CharacterId ?? ''))
        .filter(Boolean);
      const ownedSet = new Set(owned);
      const seen = new Set<number>();
      const out: Decoded[] = [];
      for (const p of requested) {
        const type = Number(p.Type ?? 0);
        if (!HOME_POSITION_TYPES.has(type)) throw new Error(`Home:SetCharacterPosition: bad type ${type}`);
        if (seen.has(type)) throw new Error(`Home:SetCharacterPosition: duplicate type ${type}`);
        seen.add(type);
        const random = !!p.IsCharacterRandom;
        let characterId = String(p.CharacterId ?? '');
        if (random) {
          if (owned.length === 0) throw new Error('Home:SetCharacterPosition: no owned idol for a random slot');
          characterId = owned[Math.floor(Math.random() * owned.length)];
        } else if (!ownedSet.has(characterId)) {
          throw new Error(`Home:SetCharacterPosition: idol not owned ${characterId}`);
        }
        out.push({
          __msg: HOME_POSITION_MSG,
          HomePositionType: type,
          CharacterId: characterId,
          IsCharacterRandom: random,
          IsCostumeRandom: !!p.IsCostumeRandom,
        } as Decoded);
      }
      // Rows stored before HomePositions was keyed by slot type are keyed by
      // idol, so merge in memory and rewrite the whole collection.
      const kept = (await listElements(pl.id, 'HomePositions', tx)).filter(
        (p) => !seen.has(Number(p.HomePositionType ?? 0)),
      );
      // Slot 4 is never taken from the request: the client only sends 1-3 and
      // fills Satomi's side spot from the stored row. Append the resolved Idol
      // row and return the whole stored list so the new slot shows immediately.
      const merged = [...kept, ...out].filter((p) => Number(p.HomePositionType ?? 0) !== IDOL_POSITION_TYPE);
      const stored = [...merged, resolveIdolSlot(merged, owned)];
      await replaceElements(pl.id, 'HomePositions', stored, tx);
      return stored;
    });

    ctx.fastifyReq.log.info({ playerId: pl.id, positions }, 'home positions set');
    return {
      __msg: '',
      CommonResponse: commonResponse({ __msg: UPDATED_DATA_MSG, HomePositions: positions } as Decoded),
    } as Decoded;
  },
  { ownsState: true },
);

/**
 * `Home:ReadTalk` — records that the player opened a home talk. The client
 * keys the "seen" state off the `UserHomeTalk` element, so a missing row means
 * the talk is not yet unlocked; the sandbox seed pre-fills every row. Trust is
 * not touched here (`IsReliabilityUp` stays false).
 */
register(
  'Home:ReadTalk',
  async (ctx) => {
    const homeTalkId = String((ctx.request as Decoded | undefined)?.HomeTalkId ?? '');
    if (!homeTalkId) throw new Error('Home:ReadTalk: missing HomeTalkId');
    const pl = await playerForAccount(accountOf(ctx), 'Home:ReadTalk');

    const element = await withPlayerTx(pl.id, async (tx) => {
      const [talk] = await tx
        .select({ HomeTalkId: master.masterHomeTalk.HomeTalkId })
        .from(master.masterHomeTalk)
        .where(eq(master.masterHomeTalk.HomeTalkId, homeTalkId))
        .limit(1);
      if (!talk) throw new Error(`Home:ReadTalk: unknown home talk ${homeTalkId}`);
      const existing = (await listElements(pl.id, 'HomeTalks', tx)).find(
        (row) => String(row.HomeTalkId ?? '') === homeTalkId,
      );
      if (existing) return existing;
      const added = {
        __msg: collectionElementMsg('HomeTalks') ?? USER_HOME_TALK_MSG,
        HomeTalkId: homeTalkId,
      } as Decoded;
      await putElements(pl.id, 'HomeTalks', [added], tx);
      return added;
    });

    ctx.fastifyReq.log.info({ playerId: pl.id, homeTalkId }, 'home talk read');
    return {
      __msg: '',
      IsReliabilityUp: false,
      CommonResponse: commonResponse({
        __msg: UPDATED_DATA_MSG,
        HomeTalks: [element],
      } as Decoded),
    } as Decoded;
  },
  { ownsState: true },
);
