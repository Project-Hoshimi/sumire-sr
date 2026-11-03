import { register } from './handlers.ts';
import { isGuestAuth } from '../auth/authenticate.ts';
import { getCorpusResponse, getFreshCapture } from './replay/corpus.ts';
import { decodeMessage, msgRegistry, Reader } from '@sumire-sr/protocol/runtime/proto.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { db } from '../db/client.ts';
import {
  findPlayerByAccountId,
  isFreshPlayer,
  loadOrSeed,
  putElements,
  listElements,
  replaceElements,
} from './playerState.ts';
import { resolveIdolSlot } from './home.ts';
import { unlockCardStories } from './cardStories.ts';
import { syncCardRelease } from './cardRelease.ts';
import { missingCardCosmetics } from './cardCosmetics.ts';
import { applyGrants } from '../master/reward.ts';
import { isSandbox } from '../profile.ts';
import { SANDBOX_HIERARCHY_DETAIL_GRADE_ID, SANDBOX_HIERARCHY_POINT } from '../profiles/sandbox/hierarchy.ts';
import { sandboxUserCompany } from '../profiles/sandbox/company.ts';

const RESPONSE_MSG = 'Solis.Common.Proto.Api.UserGetResponse';
const USER_PUBLIC_MSG = 'Solis.Common.Proto.Transaction.UserPublic';
const USER_AREA_MSG = 'Solis.Common.Proto.Transaction.UserArea';
const FRESH_USER_GET = '00005.resp-plain.User:Get.bin';

/**
 * Areas force-marked as cleared so the 交流 / CompanyEnjoy feature (gated by
 * FunctionLock `cd-function_lock-company` -> ClearArea) stays unlocked even
 * after the player_entities store is reseeded.
 */
const FORCE_CLEARED_AREAS: string[] = ['area-main-013'];

const POINT_GOLD = 1;
const POINT_STAMINA = 4;

/**
 * CompanyEnjoy / 交流 bond points. The client derives each idol's bond level
 * from `UserCharacter.CompanyEnjoyPoint` against master CompanyEnjoyCharacterLevel
 * (RequiredPoint), and gates bond content (思い出 / home actions) behind
 * ConditionCompanyEnjoyCharacterPointGte. A high value keeps every gated page
 * unlocked; persisted so it survives reseeds.
 */
const BOND_POINTS = 999999;

/**
 * User:Get backed by Postgres for the authenticated account. Identity and
 * scalar stats come from the player row; the whole remaining surface (every
 * collection and singleton message) is lazily seeded from the captured corpus
 * template on first read, then served from (and owned by) the generic
 * player_entities store so it can diverge per account once mutations land.
 */
register('User:Get', async (ctx) => {
  // Guest session (invite/closed mode): there is no account behind the token,
  // so answer with an empty response and never touch the database.
  if (isGuestAuth(ctx.auth)) {
    ctx.fastifyReq.log.info('user get (guest, blank response)');
    return {};
  }
  const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
  const pl = await findPlayerByAccountId(accountId);
  const fresh = pl ? isFreshPlayer(pl) : false;

  const template = fresh ? getFreshCapture(FRESH_USER_GET) : getCorpusResponse(ctx.name);
  if (!template) {
    throw new Error(fresh ? 'fresh capture has no User:Get template' : 'corpus has no User:Get template');
  }
  const shape = msgRegistry.get(RESPONSE_MSG);
  if (!shape) throw new Error(`no schema for ${RESPONSE_MSG}`);
  const out = decodeMessage(shape, new Reader(Uint8Array.from(template)));

  if (!accountId || !pl) return out;

  const publicUserId =
    (pl.data as { publicUserId?: string } | null)?.publicUserId ?? ctx.auth.claims?.seedId ?? pl.id;

  out.UserPublic = {
    __msg: USER_PUBLIC_MSG,
    ServerUserId: pl.id,
    PublicUserId: publicUserId,
  } as Decoded;

  const { collections, singletons, seeded, served } = await loadOrSeed(pl.id, out);
  for (const [field, val] of Object.entries(collections)) out[field] = val;
  for (const [field, val] of Object.entries(singletons)) out[field] = val;

  // Slot 4 (Idol) must always be present: the client fills Satomi's side spot
  // from it and hangs on the lobby load when it is missing. Master data no
  // longer pins a character, so derive the row from the placed idols and own
  // roster. Persist it when the stored row is absent or no longer valid so the
  // random pick stays stable across logins.
  const storedPositions = (collections.HomePositions as Decoded[] | undefined) ?? [];
  const ownedCharacterIds = ((collections.Characters as Decoded[] | undefined) ?? [])
    .map((c) => String(c.CharacterId ?? ''))
    .filter(Boolean);
  const idolSlot = resolveIdolSlot(storedPositions, ownedCharacterIds);
  const storedIdols = storedPositions.filter((p) => Number(p.HomePositionType ?? 0) === 4);
  const servedPositions = [
    ...storedPositions.filter((p) => Number(p.HomePositionType ?? 0) !== 4),
    idolSlot,
  ];
  out.HomePositions = servedPositions;
  if (storedIdols.length !== 1 || String(storedIdols[0].CharacterId ?? '') !== String(idolSlot.CharacterId)) {
    await replaceElements(pl.id, 'HomePositions', servedPositions, db);
  }

  // These overrides exist to keep the captured veteran account playable. Fresh
  // accounts own their persisted state, so none of them apply.
  if (!fresh) {
    // Durable feature unlock: ensure prerequisite areas are always present/cleared.
    const areas = (collections.Areas as Decoded[] | undefined) ?? [];
    for (const areaId of FORCE_CLEARED_AREAS) {
      if (areas.some((a) => String(a.AreaId) === areaId)) continue;
      const row = { __msg: USER_AREA_MSG, AreaId: areaId, ClearQuestCount: 9999 } as Decoded;
      areas.push(row);
      await putElements(pl.id, 'Areas', [row]);
    }
    out.Areas = areas;

    // Durable bond progress: push every idol's CompanyEnjoyPoint high enough to
    // unlock all master bond levels (交流Lv) and their gated 思い出 pages.
    const chars = (collections.Characters as Decoded[] | undefined) ?? [];
    for (const c of chars) {
      if (Number(c.CompanyEnjoyPoint ?? 0) >= BOND_POINTS) continue;
      c.CompanyEnjoyPoint = BOND_POINTS;
      await putElements(pl.id, 'Characters', [c]);
    }
    out.Characters = chars;
    if (out.Company) out.Company.EnjoyPoint = BOND_POINTS;

    // Reconcile card-story unlocks: cards granted before the feature (or on a
    // reseeded account) may own episodes that never made it into the Stories
    // collection. Emit the missing Unread entries so the client lists them; never
    // downgrades an existing Read entry.
    const ownedCards = (collections.Cards as Decoded[] | undefined) ?? [];
    const storyWrites: Decoded[] = [];
    for (const c of ownedCards) {
      const cardId = String(c.CardId ?? '');
      if (!cardId) continue;
      const written = await unlockCardStories(pl.id, cardId, Number(c.Level ?? 1), db);
      storyWrites.push(...written);
    }
    if (storyWrites.length > 0) {
      const allStories = await listElements(pl.id, 'Stories');
      out.Stories = allStories;
    }

    // Reconcile card skill/ability unlocks: cards stored before the level/evolution
    // release model existed carry every skill id unconditionally (so a Lv1 card
    // wrongly showed Skill#3) or miss ability ids. Re-derive the gated ids from
    // master + the card's current level/evolution and persist any that changed.
    let releaseChanged = false;
    for (const c of ownedCards) {
      if (await syncCardRelease(c)) {
        await putElements(pl.id, 'Cards', [c]);
        releaseChanged = true;
      }
    }
    if (releaseChanged) out.Cards = ownedCards;

    // Reconcile card-tied cosmetics: cards acquired before the cosmetic grant
    // existed (or imported from the corpus template) may lack their outfit and
    // hairstyles. Grant the missing ones so the wardrobe shows them.
    const missingCosmetics = await missingCardCosmetics(pl.id, db);
    if (missingCosmetics.length > 0) {
      await applyGrants(pl.id, missingCosmetics, db);
      out.Costumes = await listElements(pl.id, 'Costumes');
      out.Hairs = await listElements(pl.id, 'Hairs');
    }

    // Player-row scalars stay authoritative over the stored blobs.
    if (out.User) {
      out.User.Name = pl.name;
      out.User.ManagerLevel = pl.level;
      out.User.ManagerExp = pl.exp;
    }
    if (out.Balance) {
      out.Balance.FreeBalance = pl.freeJewel;
      out.Balance.PaidBalance = Number(pl.paidJewel ?? 0);
    }

    if (Array.isArray(out.Points)) {
      for (const p of out.Points as Decoded[]) {
        if (p.PointType === POINT_GOLD) p.Amount = pl.gold;
        else if (p.PointType === POINT_STAMINA) p.Amount = pl.stamina;
      }
    }
  }

  ctx.fastifyReq.log.info(
    {
      accountId,
      serverUserId: pl.id,
      publicUserId,
      seed: fresh ? 'fresh' : 'corpus',
      fieldsSeeded: seeded,
      fieldsServed: served,
    },
    'user get (db-backed full state)',
  );
  // Tasks are not implemented in sandbox; without missions the Task button has no badge.
  if (isSandbox()) {
    out.Missions = [];
    // Show every sandbox player at the top Venus ranking grade (BIG4).
    out.Hierarchy = {
      __msg: 'Solis.Common.Proto.Transaction.UserHierarchy',
      ...(out.Hierarchy ?? {}),
      BestDetailGradeId: SANDBOX_HIERARCHY_DETAIL_GRADE_ID,
      CurrentFixedPoint: SANDBOX_HIERARCHY_POINT,
      BestTotalPoint: SANDBOX_HIERARCHY_POINT,
    };
    // Max office (company) rank; see profiles/sandbox/company.ts.
    out.Company = sandboxUserCompany(out.Company);
    // Every story episode is open to Story Photos; no Shoot Unlock Ticket needed.
    const stories = (out.Stories as Decoded[] | undefined) ?? [];
    const changedStories = stories.filter((s) => !s.IsUseActivatePhotoShootingStoryTicket);
    for (const s of changedStories) s.IsUseActivatePhotoShootingStoryTicket = true;
    if (changedStories.length > 0) await putElements(pl.id, 'Stories', changedStories);
    out.Stories = stories;
  }
  return out;
});
