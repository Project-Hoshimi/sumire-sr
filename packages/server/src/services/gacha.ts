import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx } from '../db/tx.ts';
import { gachaHistory, playerGachaState, players } from '../db/schema.ts';
import {
  getCard,
  getCardDuplicateExp,
  getGacha,
  getGachaButton,
  getGachaExchange,
  listCards,
  listCharacters,
  listGachaButtons,
  listGachaExchanges,
  listGachaStamps,
  listGachas,
} from '../master/index.ts';
import { applyGrants, applyRewardRefs } from '../master/reward.ts';
import { cosmeticGrantsForCard } from './cardCosmetics.ts';
import { applyCardBloomPt, grantDuplicateMedal } from './cardBloom.ts';
import { evolveOnDuplicate } from './cardEvolution.ts';
import { consume, consumptionResult } from './consumption.ts';
import { spendCurrency } from './currency.ts';
import { buildUserCard, getItemAmount, grantItem, normalizeCardRarityExp, spendItem } from './inventory.ts';
import { unlockCardStories } from './cardStories.ts';
import { listElements, putElements } from './playerState.ts';
import { type Executor } from '../db/tx.ts';
import { isSandbox } from '../profile.ts';
import { sandboxCardBuckets } from '../profiles/sandbox/gacha.ts';
import {
  MEMORIAL_GACHA_CATEGORY,
  MEMORIAL_GACHA_IDS,
  MEMORIAL_RATES,
  buildMemorialPools,
  isMemorialGachaId,
  memorialBuckets,
  type MemorialCategory,
} from '../profiles/sandbox/memorialGacha.ts';
import { isSandboxBlockedGacha } from '../profiles/sandbox/showcase.ts';
import { NotImplementedError } from './errors.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

const GACHA_LIST_RESPONSE_MSG = 'Solis.Common.Proto.Api.GachaListResponse';
const GACHA_DRAW_RESPONSE_MSG = 'Solis.Common.Proto.Api.GachaDrawResponse';
const GACHA_EXCHANGE_RESPONSE_MSG = 'Solis.Common.Proto.Api.GachaExchangeResponse';
const GACHA_PROBABILITY_RESPONSE_MSG = 'Solis.Common.Proto.Api.GachaProbabilityResponse';
const GACHA_HISTORY_RESPONSE_MSG = 'Solis.Common.Proto.Api.GachaHistoryResponse';
const GACHA_SELECT_CARD_RESPONSE_MSG = 'Solis.Common.Proto.Api.GachaSelectCardResponse';
const GACHA_FREE_TICKET_RESPONSE_MSG =
  'Solis.Common.Proto.Api.GachaReceiveFreePremiumGachaTicketResponse';

const GACHA_INFO_MSG = 'Solis.Common.Proto.Api.GachaInfo';
const GACHA_BUTTON_INFO_MSG = 'Solis.Common.Proto.Api.GachaButtonInfo';
const GACHA_EXCHANGE_INFO_MSG = 'Solis.Common.Proto.Api.GachaExchangeInfo';
const GACHA_STAMP_INFO_MSG = 'Solis.Common.Proto.Api.GachaStampInfo';
const GACHA_PREMIUM_INFO_MSG = 'Solis.Common.Proto.Api.GachaPremiumInfo';
const NOTICE_INFO_MSG = 'Solis.Common.Proto.Api.NoticeInfo';
const GACHA_CONTINUOUS_INFO_MSG = 'Solis.Common.Proto.Api.GachaContinuousInfo';
const RARITY_PROBABILITY_INFO_MSG = 'Solis.Common.Proto.Api.RarityProbabilityInfo';
const PROBABILITY_INFO_MSG = 'Solis.Common.Proto.Api.ProbabilityInfo';
const GACHA_HISTORY_MSG = 'Solis.Common.Proto.Api.GachaHistory';

// Gacha banners offered to the player. The client's GachaScreenModel only
// tolerates a small, curated list of live banners — returning the whole
// historical master (1600+) makes NormalGachaScreenModel throw a
// NullReferenceException. Only the sandbox lists banners: the nine Memorial
// banners, each drawing ★5 only from its category pool at the festival 7%
// rate with no featured rate-up. Other profiles list none. The banners listed
// before the Memorials are recorded in docs/SANDBOX_GACHA_BANNERS.md.
const SANDBOX_ACTIVE_GACHA_IDS = new Set<string>(MEMORIAL_GACHA_IDS);

const USER_GACHA_BUTTON_MSG = 'Solis.Common.Proto.Transaction.UserGachaButton';const USER_CARD_MSG = 'Solis.Common.Proto.Transaction.UserCard';
const USER_ITEM_MSG = 'Solis.Common.Proto.Transaction.UserItem';
const REWARD_MSG = 'Solis.Common.Proto.Transaction.Reward';
const REWARD_RESULT_MSG = 'Solis.Common.Proto.Transaction.RewardResult';

const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';

const RESOURCE_CARD = 2;
const RESOURCE_ITEM = 1;
const RESOURCE_GOLD = 8;
const RESOURCE_STONE = 15;

// IDOLY PRIDE banner rates (percent). There is no authoritative weight table in
// the client master data, so these follow the documented game rates and are the
// single source of truth for both `Gacha:Draw` and `Gacha:Probability`. Every
// draw — including the 10th of a 10-pull — uses the same table (the actual game
// has no slot-10 guarantee).
const STAR_RATES = {
  normal: { slot: { 5: 3.5, 4: 15.0, 3: 81.5 } },
  fes: { slot: { 5: 7.0, 4: 15.0, 3: 78.0 } },
} as const;
// Featured rate-up (percent) inside ★5. A single rate-up banner takes the solo
// share, multi-rate-up banners split the dual share. EVERY rate is doubled on
// festival banners (★5 3.5% -> 7% and the rate-up too), so the featured share is
// multiplied by FES_MULTIPLIER there: 1.0% -> 2.0% solo, 0.75% -> 1.5% each.
const FEATURED_SOLO = 1.0;
const FEATURED_DUAL = 0.75;
const FES_MULTIPLIER = 2;
// Guaranteed-★5 draws (★5アイドル1人確定 banners): the guaranteed draw rolls on
// a ★5-only table (100% ★5). Solo rate-up takes 3.0%, dual rate-ups split
// 2.25% each; the rest of the ★5 pool splits the remainder (97 / 95.5).
const GUARANTEE_SOLO = 3.0;
const GUARANTEE_DUAL = 2.25;
// Response probability unit: the client renders Probability as
// `Probability / 1000f` with "{0:F1}%" (verified in libil2cpp
// NormalGachaProbabilityGroup.SetData -> fdiv by 0x447a0000 == 1000.0f),
// so 100% == 100000 and 3.5% -> 3500.
const PROB_SCALE = 1000;
const GACHA_RARITIES = [5, 4, 3] as const;

type GachaRates = { slot: Record<number, number> };

function isFesGacha(g: GachaRow | null): boolean {
  if (!g) return false;
  const id = String(g.Id ?? '');
  const name = String(g.Name ?? '');
  // `gacha-fs-*` is the "アイプラフェス" (The AiLE fes) family; its ids/text use
  // the `fs` abbreviation or katakana フェス rather than the latin "fes".
  return /fes/i.test(id) || /fes/i.test(name) || /gacha-fs-/i.test(id) || /フェス/.test(name);
}

/** ★5アイドル1人確定 banners: every pull contains one guaranteed ★5 draw. */
function isGuaranteedGacha(g: GachaRow | null): boolean {
  if (!g) return false;
  return /1人[\s\S]*?確定/.test(String(g.Name ?? ''));
}

/** Free excursion banners (初回10連無料): each 10-pull contains one guaranteed pickup. */
function isExcursionGacha(g: GachaRow | null): boolean {
  if (!g) return false;
  return /^gacha-excursion-.*-free$/.test(String(g.Id ?? ''));
}

/** The selectable pool of a "選べる" (select) banner. */
function selectPool(g: GachaRow | null): string[] {
  return Array.isArray(g?.SelectCardIds) ? (g!.SelectCardIds as string[]).map(String) : [];
}

/** How many cards the player may pick (`SelectPickupAmount`). */
function selectAmount(g: GachaRow | null): number {
  return Math.max(0, Number(g?.SelectPickupAmount ?? 0));
}

/** A select banner: a non-empty pool with a positive pick count. */
function isSelectGacha(g: GachaRow | null): boolean {
  return selectPool(g).length > 0 && selectAmount(g) > 0;
}

/**
 * The player's valid selection for a select banner: a subset of the pool,
 * capped at `SelectPickupAmount`. The chosen cards take the rate-up; every
 * other pool card is ordinary (base-pool) ★5 fodder.
 */
function resolveSelected(g: GachaRow | null, state: GachaStateRow | null): string[] {
  const pool = selectPool(g);
  if (!pool.length) return [];
  const amount = selectAmount(g);
  const raw = Array.isArray(state?.selectedCardIds) ? (state!.selectedCardIds as string[]).map(String) : [];
  return raw.filter((id) => pool.includes(id)).slice(0, amount);
}

function featuredIds(g: GachaRow | null, selected: string[] | null = null): string[] {
  if (!g) return [];
  // Select banners rate up only the player's chosen cards. Until a valid
  // selection exists we fall back to the master pickup cards that live inside
  // the pool (the banner's headline cards), capped to the pick count.
  if (isSelectGacha(g)) {
    const amount = selectAmount(g);
    const pool = selectPool(g);
    const chosen = (selected ?? []).map(String).filter((id) => pool.includes(id));
    if (chosen.length) return chosen.slice(0, amount);
    const pickup = Array.isArray(g.PickupCardIds) ? (g.PickupCardIds as string[]).map(String) : [];
    const inPool = pickup.filter((id) => pool.includes(id));
    return (inPool.length ? inPool : pool).slice(0, amount);
  }
  const pickup = Array.isArray(g.PickupCardIds) ? (g.PickupCardIds as string[]).map(String) : [];
  if (pickup.length) return pickup;
  const select = Array.isArray(g.SelectCardIds) ? (g.SelectCardIds as string[]).map(String) : [];
  if (select.length) return select;
  const rewards = Array.isArray(g.CardRewards) ? (g.CardRewards as Decoded[]) : [];
  return rewards.map((r) => String(r.CardId ?? '')).filter(Boolean);
}

/** All drawable cards grouped by their star rarity (>= ★3). */
async function cardBuckets(): Promise<Map<number, string[]>> {
  const all = await listCards();
  // Sandbox: every banner draws from the whole catalogue, not just ★3–★5.
  if (isSandbox()) return sandboxCardBuckets(all);
  const byRarity = new Map<number, string[]>();
  for (const c of all) {
    const r = Number(c.InitialRarity ?? 0);
    if (!(GACHA_RARITIES as readonly number[]).includes(r)) continue;
    const arr = byRarity.get(r) ?? [];
    arr.push(String(c.Id));
    byRarity.set(r, arr);
  }
  return byRarity;
}

type ProbabilityModel = {
  featured: Set<string>;
  weights: Map<string, number>;
  rarityRate: Map<number, number>;
  cardRate: Map<string, number>;
  rarityOfCard: Map<string, number>;
  isFes: boolean;
};

let memorialPoolsPromise: Promise<Map<MemorialCategory, string[]>> | null = null;

/** Memorial ★5 category pools, built lazily once from the master catalogue. */
function memorialPools(): Promise<Map<MemorialCategory, string[]>> {
  memorialPoolsPromise ??= (async () => {
    const [cards, gachas, characters] = await Promise.all([
      listCards(),
      listGachas(),
      listCharacters(),
    ]);
    return buildMemorialPools({ cards, gachas, characters });
  })();
  return memorialPoolsPromise;
}

/** Memorial category of a sandbox memorial banner, or null for other banners. */
function memorialCategoryOfGacha(g: GachaRow | null): MemorialCategory | null {
  if (!isSandbox() || !isMemorialGachaId(g?.Id)) return null;
  return MEMORIAL_GACHA_CATEGORY[String(g!.Id)] ?? null;
}

/**
 * Build the banner's probability model from the catalogue buckets + the
 * banner's featured cards. Per-rarity rates come from `STAR_RATES`; the
 * featured cards absorb the rate-up share and the remaining ★5 mass is split
 * across the off-rate ★5 pool. Mass is renormalised to 100% so pools missing a
 * rarity still sum correctly.
 */
export async function buildProbabilityModel(g: GachaRow | null, guaranteed = false, pickupGuaranteed = false, selected: string[] | null = null): Promise<ProbabilityModel> {
  const isFes = isFesGacha(g);
  const memorial = memorialCategoryOfGacha(g);
  // A guaranteed draw rolls on a ★5-only table; everything else uses the
  // banner's normal (or fes) rarity table. The expedition pickup guarantee
  // likewise forces the guaranteed draw to the ★5 table, but splits all of the
  // ★5 mass across the pickups (no off-rate ★5). Memorial banners always use
  // the festival table; they have no featured rate-up to absorb.
  const rates: GachaRates = guaranteed || pickupGuaranteed
    ? { slot: { 5: 100.0, 4: 0, 3: 0 } }
    : memorial
      ? { slot: MEMORIAL_RATES }
      : isFes
        ? STAR_RATES.fes
        : STAR_RATES.normal;
  const buckets = memorial
    ? memorialBuckets(memorial, await memorialPools(), await listCards())
    : await cardBuckets();
  // A "選べる" (select) banner's selectable pool (`Gacha.SelectCardIds`) is a
  // ★5-only list: it constrains which ★5 cards the banner can draw, while the
  // ★4/★3 pools remain the shared catalogue. Restricting only the ★5 bucket
  // keeps the draw, the pool listing and the probability page consistent.
  const poolIds = selectPool(g);
  // Sandbox banners expose the full catalogue, so a select banner's pool no
  // longer narrows the ★5 bucket (featured rate-ups still apply). Memorial
  // banners draw from category pools and never narrow them either.
  if (poolIds.length && !isSandbox() && !memorial) {
    const allow = new Set(poolIds);
    buckets.set(5, (buckets.get(5) ?? []).filter((id) => allow.has(id)));
  }
  const featured = memorial ? [] : featuredIds(g, selected);
  const featuredSet = new Set(featured);
  const fCount = featured.length;
  const fPer = fCount === 0
    ? 0
    : pickupGuaranteed
      ? 100.0 / fCount
      : guaranteed
        ? fCount === 1
          ? GUARANTEE_SOLO
          : GUARANTEE_DUAL
        : (fCount === 1 ? FEATURED_SOLO : FEATURED_DUAL) * (isFes ? FES_MULTIPLIER : 1);
  const featTotal = fPer * fCount;

  const build = (base: Record<number, number>) => {
    const raw = new Map<string, number>();
    for (const r of GACHA_RARITIES) {
      const bucket = buckets.get(r) ?? [];
      if (!bucket.length) continue;
      if (r === 5 && fCount > 0 && featTotal <= base[5]!) {
        let featInBucket = 0;
        for (const id of featured) {
          if (bucket.includes(id)) {
            raw.set(id, fPer);
            featInBucket++;
          }
        }
        const off = base[5]! - fPer * featInBucket;
        const nonFeat = bucket.filter((id) => !featuredSet.has(id));
        if (nonFeat.length) for (const id of nonFeat) raw.set(id, off / nonFeat.length);
      } else {
        for (const id of bucket) raw.set(id, base[r]! / bucket.length);
      }
    }
    // Renormalise to 100%.
    let total = 0;
    for (const v of raw.values()) total += v;
    if (total > 0 && Math.abs(total - 100) > 1e-9) {
      for (const [k, v] of raw) raw.set(k, (v * 100) / total);
    }
    return raw;
  };

  const weights = build(rates.slot);

  // Map cardId -> rarity for the response grouping.
  const bucketsRarityCache = new Map<string, number>();
  for (const [r, ids] of buckets) for (const id of ids) bucketsRarityCache.set(id, r);

  const sumByRarity = (m: Map<string, number>) => {
    const acc = new Map<number, number>();
    for (const [id, w] of m) {
      const r = bucketsRarityCache.get(id) ?? 0;
      acc.set(r, (acc.get(r) ?? 0) + w);
    }
    return acc;
  };

  return {
    featured: featuredSet,
    weights,
    rarityRate: sumByRarity(weights),
    cardRate: weights,
    rarityOfCard: bucketsRarityCache,
    isFes,
  };
}

/** Draw a card id from a probability weight map. */
function pickWeighted(weights: Map<string, number>): string {
  let total = 0;
  for (const w of weights.values()) total += w;
  if (total <= 0) throw new Error('Gacha:Draw: empty draw pool');
  let roll = Math.random() * total;
  let last = '';
  for (const [id, w] of weights) {
    last = id;
    roll -= w;
    if (roll <= 0) return id;
  }
  return last;
}

type GachaRow = Awaited<ReturnType<typeof getGacha>>;
type GachaStateRow = typeof playerGachaState.$inferSelect;

/**
 * Card-pull gacha suite (home-screen GACHA page) — server-authoritative.
 *
 * `Gacha:List` enumerates the master gachas with buttons, exchange booths,
 * stamp/premium/continuous progress and the player's selected cards.
 * `Gacha:Draw` resolves button+gacha, spends the button consumption, draws from
 * the banner's own pool (`SelectCardIds` → `CardRewards` → `PickupCardIds` →
 * catalogue), converts duplicates, advances stamp sheets and records history.
 * `Gacha:Exchange`, `Gacha:SelectCard`, `Gacha:Probability`, `Gacha:History`
 * and `Gacha:ReceiveFreePremiumGachaTicket` complete the page.
 */

async function playerForCtx(ctx: {
  auth: { ok: boolean; claims?: { sub?: string } };
}): Promise<{ accountId: string | undefined; pl: typeof players.$inferSelect | null }> {
  const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
  if (!accountId) return { accountId: undefined, pl: null };
  const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  return { accountId, pl: pl ?? null };
}

async function getGachaState(
  playerId: string,
  gachaId: string,
  exec: Executor = db,
): Promise<GachaStateRow | null> {
  const [row] = await exec
    .select()
    .from(playerGachaState)
    .where(and(eq(playerGachaState.playerId, playerId), eq(playerGachaState.gachaId, gachaId)))
    .limit(1);
  return row ?? null;
}

async function putGachaState(
  playerId: string,
  gachaId: string,
  patch: Partial<Omit<GachaStateRow, 'id' | 'playerId' | 'gachaId' | 'updatedAt'>>,
  exec: Executor = db,
): Promise<void> {
  const existing = await getGachaState(playerId, gachaId, exec);
  if (existing) {
    await exec
      .update(playerGachaState)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(playerGachaState.id, existing.id));
  } else {
    await exec.insert(playerGachaState).values({ id: randomUUID(), playerId, gachaId, ...patch });
  }
}

/** Stamp-sheet progress for the response (only when the banner has a sheet). */
function buildStampInfo(state: GachaStateRow | null, hasStampGroup: boolean): Decoded | undefined {
  if (!hasStampGroup) return undefined;
  return {
    __msg: GACHA_STAMP_INFO_MSG,
    CurrentSheetNumber: Number(state?.stampSheetNumber ?? 1),
    CurrentStampNumber: Number(state?.stampNumber ?? 0),
  } as Decoded;
}

function buildContinuousInfo(state: GachaStateRow | null): Decoded | undefined {
  if (!state) return undefined;
  return {
    __msg: GACHA_CONTINUOUS_INFO_MSG,
    TotalDrawCount: Number(state.totalDrawCount ?? 0),
  } as Decoded;
}

function buildGachaInfo(
  g: NonNullable<GachaRow>,
  buttonInfos: Decoded[],
  state: GachaStateRow | null,
  exchanges: Decoded[],
  hasStampGroup: boolean,
): Decoded {
  // Only the player's *current* selection is surfaced; the selectable pool
  // itself comes from the master `Gacha.SelectCardIds` the client already has.
  // Before the player picks, fall back to the banner's headline pickups so the
  // probability page can still list the rate-up cards instead of a single line.
  // Memorial banners have no rate-up, so they never advertise a pick-up.
  const memorial = memorialCategoryOfGacha(g) !== null;
  const stored = !memorial && isSelectGacha(g) ? resolveSelected(g, state) : [];
  const selected = memorial
    ? []
    : isSelectGacha(g)
      ? (stored.length ? stored : featuredIds(g, null))
      : (state?.selectedCardIds?.length ? (state.selectedCardIds as string[]).map(String) : []);
  const info: Decoded = {
    __msg: GACHA_INFO_MSG,
    Id: g.Id,
    Unlocked: true,
    Buttons: buttonInfos,
    Exchanges: exchanges.length ? exchanges : undefined,
    SelectedCardIds: selected.length ? selected : undefined,
  } as Decoded;
  const stamp = buildStampInfo(state, hasStampGroup);
  if (stamp) info.StampInfo = stamp;
  if (isGuaranteedGacha(g)) {
    info.NoticeInfo = {
      __msg: NOTICE_INFO_MSG,
      Id: `info-${g.Id}`,
      Title: String(g.Name ?? ''),
      BannerAssetId: String(g.BannerAssetId ?? ''),
      LinkType: 999,
      DisplayNotification: 0,
      ListTitle: String(g.Name ?? ''),
    } as Decoded;
  }
  return info;
}

register(
  'Gacha:List',
  async (ctx) => {
    const { accountId, pl } = await playerForCtx(ctx);
    const counters = new Map<string, Decoded>();
    if (pl) {
      for (const b of await listElements(pl.id, 'GachaButtons', db)) {
        if (b.GachaButtonId != null) counters.set(String(b.GachaButtonId), b);
      }
    }

    const [gachas, buttons] = await Promise.all([listGachas(), listGachaButtons()]);
    const buttonById = new Map(buttons.map((b) => [b.Id, b]));
    const activeGachaIds = isSandbox() ? SANDBOX_ACTIVE_GACHA_IDS : new Set<string>();

    const infos: Decoded[] = [];
    for (const g of gachas) {
      const buttonIds = Array.isArray(g.ButtonIds) ? (g.ButtonIds as string[]) : [];
      if (!buttonIds.length) continue;
      if (!activeGachaIds.has(g.Id)) continue;

      const state = pl ? await getGachaState(pl.id, g.Id) : null;
      const exchangeCounts = state?.exchangeCounts ?? {};

      const buttonInfos: Decoded[] = [];
      let hasStampGroup = false;
      for (const bid of buttonIds) {
        const btn = buttonById.get(bid);
        if (!btn) continue;
        if (btn.GachaStampSheetGroupId) hasStampGroup = true;
        const c = counters.get(bid);
        buttonInfos.push({
          __msg: GACHA_BUTTON_INFO_MSG,
          Id: bid,
          TodayCount: Number(c?.TodayCount ?? 0),
          TotalCount: Number(c?.TotalCount ?? 0),
          DrawTime: Number(c?.DrawTime ?? 0),
        } as Decoded);
      }

      const exchangeInfos: Decoded[] = [];
      for (const ex of await listGachaExchanges(g.Id)) {
        exchangeInfos.push({
          __msg: GACHA_EXCHANGE_INFO_MSG,
          Id: ex.Id,
          ExchangedCount: Number(exchangeCounts[ex.Id] ?? 0),
          ExchangedTime: 0,
        } as Decoded);
      }

      infos.push(buildGachaInfo(g, buttonInfos, state, exchangeInfos, hasStampGroup));
    }

    ctx.fastifyReq.log.info({ accountId, gachas: infos.length }, 'gacha list (card suite)');

    return {
      __msg: GACHA_LIST_RESPONSE_MSG,
      Gachas: infos,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: { __msg: UPDATED_DATA_MSG },
        DeletedData: { __msg: DELETED_DATA_MSG },
      },
    } as Decoded;
  },
  { ownsState: true },
);

register(
  'Gacha:Draw',
  async (ctx) => {
    const req = ctx.request;
    if (!req) throw new Error('Gacha:Draw: missing request');
    const { accountId, pl } = await playerForCtx(ctx);
    if (!accountId || !pl) throw new Error('Gacha:Draw: unauthenticated');

    const buttonId = String(req.GachaButtonId ?? '');
    const execCount = Math.max(1, Number(req.ExecCount ?? 1));

    const button = await getGachaButton(buttonId);
    if (!button) throw new Error(`Gacha:Draw: unknown button ${buttonId}`);
    const gacha = button.GachaId ? await getGacha(button.GachaId) : null;
    if (isSandbox() && isSandboxBlockedGacha(gacha)) {
      ctx.fastifyReq.log.warn({ gachaId: gacha?.Id }, 'sandbox-blocked showcase toy gacha');
      throw new NotImplementedError('Gacha:Draw');
    }
    const drawCount = Math.max(1, Number(button.DrawCount ?? 1)) * execCount;
    const now = Date.now();

    const result = await withPlayerTx(pl.id, async (tx) => {
      // Sandbox: pulls are free (no stones/tickets consumed).
      const consumptionResults = isSandbox()
        ? ([] as Decoded[])
        : await consume(pl.id, button.ConsumptionId, execCount, tx);

      const drawState = gacha ? await getGachaState(pl.id, gacha.Id, tx) : null;
      const selected = isSelectGacha(gacha) ? resolveSelected(gacha, drawState) : null;
      const model = await buildProbabilityModel(gacha, false, false, selected);
      // ★5確定 banners: the last draw of each 10-pull rolls on the
      // ★5-only guarantee table, so every pull contains ≥1 ★5.
      const guaranteeModel = isGuaranteedGacha(gacha)
        ? await buildProbabilityModel(gacha, true, false, selected)
        : isExcursionGacha(gacha)
          ? await buildProbabilityModel(gacha, false, true, selected)
          : null;
      const owned = new Map((await listElements(pl.id, 'Cards', tx)).map((c) => [String(c.CardId), c]));

      // Per-banner featured-card bloom rewards (ResourceType 25, 才能開花Pt).
      // Master `CardRewards` maps a featured card id to the reward granted
      // whenever that card is drawn.
      const bloomByCard = new Map<string, string>();
      if (gacha && Array.isArray(gacha.CardRewards)) {
        for (const cr of gacha.CardRewards as Decoded[]) {
          const cid = String(cr.CardId ?? '');
          const rid = String(cr.RewardId ?? '');
          if (cid && rid) bloomByCard.set(cid, rid);
        }
      }

      const cardRewards: Decoded[] = [];
      const pickupRewards: Decoded[] = [];
      const rewardResults: Decoded[] = [];
      const newCards: Decoded[] = [];
      const updatedCards: Decoded[] = [];
      const frags: (Decoded | null)[] = [];

      let medalId: string | null = null;
      let medalBefore = 0;
      // The ★5確定 / free-excursion guarantee only forces the 10th slot when
      // the promised outcome (a ★5, or a pickup on the free excursion banner)
      // has not already appeared earlier in the same 10-pull.
      const isExcursionFree = isExcursionGacha(gacha);
      let guaranteeSatisfied = false;
      for (let i = 0; i < drawCount; i++) {
        const pullSlot = i % 10;
        if (pullSlot === 0) guaranteeSatisfied = false;
        const useGuarantee = !!guaranteeModel && pullSlot === 9 && !guaranteeSatisfied;
        const slotModel = useGuarantee ? (guaranteeModel as ProbabilityModel) : model;
        const cardId = pickWeighted(slotModel.weights);
        cardRewards.push({ __msg: REWARD_MSG, ResourceType: RESOURCE_CARD, ResourceId: cardId, Amount: 1 } as Decoded);
        if (guaranteeModel) {
          if (isExcursionFree) {
            if (model.featured.has(cardId)) guaranteeSatisfied = true;
          } else {
            const drawnMaster = await getCard(cardId);
            if (Number(drawnMaster?.InitialRarity ?? 0) === 5) guaranteeSatisfied = true;
          }
        }
        let bloomRef: string | null = null;
        if (slotModel.featured.has(cardId)) {
          pickupRewards.push({ __msg: REWARD_MSG, ResourceType: RESOURCE_CARD, ResourceId: cardId, Amount: 1 } as Decoded);
          bloomRef = bloomByCard.get(cardId) ?? null;
        }

        if (owned.has(cardId)) {
          const master = await getCard(cardId);
          const dupResults: Decoded[] = [];
          // Duplicate → medal(s) per CardDuplicateReward, keyed on the owned
          // card's current (bloom) rarity, so re-bloomed dups pay more.
          const dup = await grantDuplicateMedal(pl.id, cardId, tx);
          if (dup) {
            dupResults.push(dup.result);
            if (medalId === null && /gacha_medal/.test(dup.itemId)) {
              medalId = dup.itemId;
              medalBefore = Number(dup.result.BeforeAmount ?? 0);
            }
            frags.push({
              __msg: UPDATED_DATA_MSG,
              Items: [{ __msg: USER_ITEM_MSG, ItemId: dup.itemId, Amount: Number(dup.result.AfterAmount ?? 0) }],
            } as Decoded);
          }
          // Duplicates also credit dedicated 開花Pt (CardDuplicateExp). A
          // featured duplicate instead receives the banner's CardRewards
          // set-item (+100) from the bloom branch below, which replaces it.
          const dupExp = bloomRef
            ? 0
            : Number((await getCardDuplicateExp(Number(master?.InitialRarity ?? 1)))?.Exp ?? 0);
          let bloomedCard: Decoded | null = null;
          if (dupExp > 0) {
            const bloom = await applyCardBloomPt(pl.id, cardId, dupExp, tx);
            for (const r of bloom.results) dupResults.push(r);
            if (bloom.items.length || bloom.card) {
              frags.push({
                __msg: UPDATED_DATA_MSG,
                ...(bloom.items.length ? { Items: bloom.items } : {}),
                ...(bloom.card ? { Cards: [bloom.card] } : {}),
              } as Decoded);
            }
            bloomedCard = bloom.card;
          }
          const evo = await evolveOnDuplicate(pl.id, cardId, tx);
          for (const r of evo?.results ?? []) dupResults.push(r);
          const current = evo?.card ?? bloomedCard ?? owned.get(cardId);
          if (current) {
            const normalized = await normalizeCardRarityExp(current);
            newCards.push(normalized);
            updatedCards.push(normalized);
          }
          rewardResults.push({
            __msg: REWARD_RESULT_MSG,
            ResourceType: RESOURCE_CARD,
            ResourceId: cardId,
            BeforeAmount: 1,
            AfterAmount: 1,
            IsNew: false,
            AmountI64: 1,
            DuplicateRewardResults: dupResults.length ? dupResults : undefined,
          } as Decoded);
          continue;
        }

        const card = await synthesizeCard(cardId);
        if (card) {
          newCards.push(card);
          updatedCards.push(card);
          owned.set(cardId, card);
          rewardResults.push({
            __msg: REWARD_RESULT_MSG,
            ResourceType: RESOURCE_CARD,
            ResourceId: cardId,
            BeforeAmount: 0,
            AfterAmount: 1,
            IsNew: true,
            AmountI64: 1,
          } as Decoded);
          // New cards also unlock their reward costume and hair; the client
          // surfaces these as separate RewardResults (ResourceType 5 / 28).
          const masterCard = await getCard(cardId);
          const extraGrants = await cosmeticGrantsForCard(masterCard);
          if (extraGrants.length) {
            const extras = await applyGrants(pl.id, extraGrants, tx);
            for (const r of extras.results) rewardResults.push(r);
            frags.push(extras.updated);
          }
          // Featured pickup: credit the banner's set-item 開花Pt (CardRewards)
          // after the card exists, so it lands on the owned card (auto-bloom
          // when the cumulative CardRarity threshold is reached).
          if (bloomRef) {
            await putElements(pl.id, 'Cards', [card], tx);
            const applied = await applyRewardRefs(pl.id, [bloomRef], tx);
            for (const r of applied.results) rewardResults.push(r);
            frags.push(applied.updated);
            const bloomed = ((applied.updated?.Cards as Decoded[] | undefined) ?? []).find(
              (c) => String(c.CardId ?? '') === cardId,
            );
            if (bloomed) {
              const nIdx = newCards.findIndex((c) => String(c.CardId ?? '') === cardId);
              if (nIdx >= 0) newCards[nIdx] = bloomed;
              const uIdx = updatedCards.findIndex((c) => String(c.CardId ?? '') === cardId);
              if (uIdx >= 0) updatedCards[uIdx] = bloomed;
              else updatedCards.push(bloomed);
            }
          }
        }
      }

      // Aggregated duplicate medal, reported once per draw above the per-card
      // nested entries (matches real Gacha:Draw responses).
      if (medalId) {
        const after = await getItemAmount(pl.id, medalId, tx);
        if (after > medalBefore) {
          rewardResults.push({
            __msg: REWARD_RESULT_MSG,
            ResourceType: RESOURCE_ITEM,
            ResourceId: medalId,
            BeforeAmount: medalBefore,
            AfterAmount: after,
            AmountI64: after - medalBefore,
          } as Decoded);
        }
      }

      if (newCards.length) await putElements(pl.id, 'Cards', newCards, tx);

      // Unlock card stories for every drawn/held card at its current level
      // (PLANS §1.7): new cards gain episode #1; cards that evolved past a
      // story-gating level gain their later episodes.
      const unlockedStories: Decoded[] = [];
      for (const nc of newCards) {
        const grantedId = String(nc.CardId ?? '');
        if (!grantedId) continue;
        const unread = await unlockCardStories(pl.id, grantedId, Number(nc.Level ?? 1), tx);
        unlockedStories.push(...unread);
      }

      // Spark points: 1 point per pull, credited as the banner's exchange item.
      if (gacha && Number(gacha.ExchangeResourceType ?? 0) === RESOURCE_ITEM && gacha.ExchangeResourceId) {
        const pointItemId = String(gacha.ExchangeResourceId);
        const before = await getItemAmount(pl.id, pointItemId, tx);
        await grantItem(pl.id, pointItemId, drawCount, tx);
        frags.push({
          __msg: UPDATED_DATA_MSG,
          Items: [{ __msg: USER_ITEM_MSG, ItemId: pointItemId, Amount: before + drawCount }],
        } as Decoded);
      }

      const drawRewardResults: Decoded[] = [];
      const bonus = button.BonusRewardId ? await applyRewardRefs(pl.id, [String(button.BonusRewardId)], tx) : null;
      if (bonus) {
        for (const r of bonus.results) drawRewardResults.push(r);
        frags.push(bonus.updated);
      }

      // Stamp sheet progression (one stamp per draw).
      const stampRewards: Decoded[] = [];
      let stampInfo: Decoded | undefined;
      const groupId = button.GachaStampSheetGroupId;
      if (groupId) {
        const prev = await getGachaState(pl.id, gacha?.Id ?? button.GachaId ?? '', tx);
        const stamp = await advanceStamps(
          pl.id,
          String(groupId),
          Number(prev?.stampSheetNumber ?? 1),
          Number(prev?.stampNumber ?? 0),
          drawCount,
          tx,
        );
        for (const r of stamp.results) stampRewards.push(r);
        frags.push(stamp.updated);
        stampInfo = {
          __msg: GACHA_STAMP_INFO_MSG,
          CurrentSheetNumber: stamp.sheetNumber,
          CurrentStampNumber: stamp.stampNumber,
        } as Decoded;
        await putGachaState(
          pl.id,
          gacha?.Id ?? button.GachaId ?? '',
          {
            stampSheetNumber: stamp.sheetNumber,
            stampNumber: stamp.stampNumber,
            totalDrawCount: Number(prev?.totalDrawCount ?? 0) + drawCount,
          },
          tx,
        );
      } else if (gacha) {
        const prev = await getGachaState(pl.id, gacha.Id, tx);
        await putGachaState(pl.id, gacha.Id, { totalDrawCount: Number(prev?.totalDrawCount ?? 0) + drawCount }, tx);
      }

      // Per-button counters.
      const counters = await listElements(pl.id, 'GachaButtons', tx);
      const prevBtn = counters.find((c) => String(c.GachaButtonId) === buttonId);
      const todayCount = Number(prevBtn?.TodayCount ?? 0) + 1;
      const totalCount = Number(prevBtn?.TotalCount ?? 0) + 1;
      const userButton = {
        __msg: USER_GACHA_BUTTON_MSG,
        GachaButtonId: buttonId,
        DrawTime: now,
        TodayCount: todayCount,
        TotalCount: totalCount,
      } as Decoded;
      await putElements(pl.id, 'GachaButtons', [userButton], tx);

      await tx.insert(gachaHistory).values({
        id: randomUUID(),
        playerId: pl.id,
        gachaMasterId: gacha?.Id ?? button.GachaId ?? buttonId,
        drawCount,
        costType: String(button.ConsumptionId ?? ''),
        costAmount: execCount,
        results: cardRewards as unknown[],
      });

      const updated = buildUpdated(updatedCards, frags);
      updated.GachaButtons = [userButton];
      if (unlockedStories.length) updated.Stories = unlockedStories;

      return {
        button: { __msg: GACHA_BUTTON_INFO_MSG, Id: buttonId, TodayCount: todayCount, TotalCount: totalCount, DrawTime: now } as Decoded,
        cardRewards,
        pickupRewards,
        consumptionResults,
        rewardResults,
        drawRewardResults,
        stampInfo,
        stampRewards,
        updated,
      };
    });

    ctx.fastifyReq.log.info({ accountId, buttonId, drawCount }, 'gacha draw (card suite)');

    const resp = {
      __msg: GACHA_DRAW_RESPONSE_MSG,
      Button: result.button,
      Rewards: result.cardRewards,
      ConsumptionResults: result.consumptionResults,
      RewardResults: result.rewardResults,
      DrawRewardResults: result.drawRewardResults,
      StampInfo: result.stampInfo,
      StampRewards: result.stampRewards.length ? result.stampRewards : undefined,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: result.updated,
        DeletedData: { __msg: DELETED_DATA_MSG },
      },
    } as Decoded;
    return resp;
  },
  { ownsState: true },
);

register(
  'Gacha:Exchange',
  async (ctx) => {
    const req = ctx.request;
    if (!req) throw new Error('Gacha:Exchange: missing request');
    const { accountId, pl } = await playerForCtx(ctx);
    if (!accountId || !pl) throw new Error('Gacha:Exchange: unauthenticated');

    const exchangeId = String(req.GachaExchangeId ?? '');
    const count = Math.max(1, Number(req.Count ?? 1));
    const exchange = await getGachaExchange(exchangeId);
    if (!exchange) throw new Error(`Gacha:Exchange: unknown exchange ${exchangeId}`);
    const gacha = exchange.GachaId ? await getGacha(exchange.GachaId) : null;
    const gachaId = gacha?.Id ?? exchange.GachaId ?? '';
    const now = Date.now();

    const out = await withPlayerTx(pl.id, async (tx) => {
      const state = gachaId ? await getGachaState(pl.id, gachaId, tx) : null;
      const already = Number(state?.exchangeCounts?.[exchangeId] ?? 0);
      let buy = count;
      if (exchange.ExchangeLimit != null && Number(exchange.ExchangeLimit) > 0) {
        buy = Math.max(0, Math.min(buy, Number(exchange.ExchangeLimit) - already));
      }

      const consumptionResults: Decoded[] = [];
      // Sandbox: exchanging still yields the reward but costs nothing.
      if (buy > 0 && !isSandbox()) {
        const unit = Number(exchange.RequiredResourceAmount ?? 0);
        const amount = unit * buy;
        const type = Number(gacha?.ExchangeResourceType ?? 0);
        const resourceId = gacha?.ExchangeResourceId ? String(gacha.ExchangeResourceId) : '';
        if (amount > 0 && type === RESOURCE_ITEM) {
          const before = await getItemAmount(pl.id, resourceId, tx);
          await spendItem(pl.id, resourceId, amount, tx);
          consumptionResults.push(consumptionResult(RESOURCE_ITEM, resourceId, amount, before, before - amount));
        } else if (amount > 0 && (type === RESOURCE_STONE || type === 16)) {
          const before = await getCurrencyLocal(pl.id, type, tx);
          await spendCurrency(pl.id, 'freeJewel', amount, tx);
          consumptionResults.push(consumptionResult(type, '', amount, before, before - amount));
        } else if (amount > 0 && type === RESOURCE_GOLD) {
          const before = await getCurrencyLocal(pl.id, RESOURCE_GOLD, tx);
          await spendCurrency(pl.id, 'gold', amount, tx);
          consumptionResults.push(consumptionResult(type, '', amount, before, before - amount));
        }
      }

      const rewardResults: Decoded[] = [];
      const frags: (Decoded | null)[] = [];
      const rewardCards: Decoded[] = [];
      if (buy > 0 && exchange.RewardId) {
        const applied = await applyRewardRefs(pl.id, [String(exchange.RewardId)], tx);
        for (const r of applied.results) rewardResults.push(r);
        for (const c of (applied.updated?.Cards as Decoded[] | undefined) ?? []) rewardCards.push(c);
        frags.push(applied.updated);
      }

      const exchangeCounts = { ...(state?.exchangeCounts ?? {}) };
      exchangeCounts[exchangeId] = already + buy;
      if (gachaId) await putGachaState(pl.id, gachaId, { exchangeCounts }, tx);

      const updated = buildUpdated(rewardCards, frags);
      for (const r of consumptionResults) {
        const t = Number(r.ResourceType ?? 0);
        if (t === RESOURCE_ITEM) {
          updated.Items = [...((updated.Items as Decoded[]) ?? []), { __msg: USER_ITEM_MSG, ItemId: String(r.ResourceId ?? ''), Amount: Number(r.AfterAmount ?? 0) } as Decoded];
        }
      }

      return {
        exchange: {
          __msg: GACHA_EXCHANGE_INFO_MSG,
          Id: exchangeId,
          ExchangedCount: already + buy,
          ExchangedTime: now,
        } as Decoded,
        rewardResults,
        consumptionResults,
        updated,
      };
    });

    ctx.fastifyReq.log.info({ accountId, exchangeId, count }, 'gacha exchange');

    return {
      __msg: GACHA_EXCHANGE_RESPONSE_MSG,
      Exchange: out.exchange,
      RewardResults: out.rewardResults.length ? out.rewardResults : undefined,
      ConsumptionResults: out.consumptionResults.length ? out.consumptionResults : undefined,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: out.updated,
        DeletedData: { __msg: DELETED_DATA_MSG },
      },
    } as Decoded;
  },
  { ownsState: true },
);

register(
  'Gacha:SelectCard',
  async (ctx) => {
    const req = ctx.request;
    if (!req) throw new Error('Gacha:SelectCard: missing request');
    const { accountId, pl } = await playerForCtx(ctx);
    if (!accountId || !pl) throw new Error('Gacha:SelectCard: unauthenticated');

    const gachaId = String(req.GachaId ?? '');
    const gacha = gachaId ? await getGacha(gachaId) : null;
    const requested = Array.isArray(req.SelectedCardIds) ? (req.SelectedCardIds as string[]).map(String) : [];
    // Select banners only accept cards from the pool, capped at the pick count
    // (`SelectPickupAmount`) — so e.g. the 1人★5確定 picker stores exactly one.
    const selected = gacha && isSelectGacha(gacha)
      ? requested.filter((id) => selectPool(gacha).includes(id)).slice(0, selectAmount(gacha))
      : requested;
    if (gachaId) await putGachaState(pl.id, gachaId, { selectedCardIds: selected });

    ctx.fastifyReq.log.info({ accountId, gachaId, selected: selected.length }, 'gacha select card');

    return {
      __msg: GACHA_SELECT_CARD_RESPONSE_MSG,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: { __msg: UPDATED_DATA_MSG },
        DeletedData: { __msg: DELETED_DATA_MSG },
      },
    } as Decoded;
  },
  { ownsState: true },
);

register(
  'Gacha:Probability',
  async (ctx) => {
    const req = ctx.request;
    if (!req) throw new Error('Gacha:Probability: missing request');
    const { pl } = await playerForCtx(ctx);
    const gacha = req.GachaId ? await getGacha(String(req.GachaId)) : null;
    const selected = gacha && pl && isSelectGacha(gacha)
      ? resolveSelected(gacha, await getGachaState(pl.id, gacha.Id))
      : null;
    // ★5アイドル1人確定 banners advertise the ★5-only guarantee table.
    const model = await buildProbabilityModel(gacha, isGuaranteedGacha(gacha), false, selected);

    const cardInfo = (cardId: string, pct: number): Decoded => ({
      __msg: PROBABILITY_INFO_MSG,
      ResourceType: RESOURCE_CARD,
      ResourceId: cardId,
      Amount: 1,
      Probability: Math.round(pct * PROB_SCALE),
      IsRatioUp: model.featured.has(cardId) ? true : undefined,
    } as Decoded);

    // Group the per-card rates by rarity. The probability dialog reads the
    // individual cards from `RarityProbabilityInfo.ProbabilityInfos` (field 3),
    // so the pool and per-card rates only render when they are nested here — the
    // flat top-level list alone is ignored by the row builder.
    const byRarity = new Map<number, Decoded[]>();
    const probabilityInfos: Decoded[] = [];
    for (const [cardId, pct] of [...model.cardRate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      // Zero-rate cards are omitted (proto3 drops 0 varints anyway) — e.g. the
      // ★4/★3 entries of a ★5-only guarantee table.
      if (pct <= 0) continue;
      const info = cardInfo(cardId, pct);
      const rarity = model.rarityOfCard.get(cardId) ?? 0;
      const arr = byRarity.get(rarity) ?? [];
      arr.push(info);
      byRarity.set(rarity, arr);
      probabilityInfos.push(info);
    }
    const sortCards = (a: Decoded, b: Decoded) => {
      const af = model.featured.has(String(a.ResourceId)) ? 0 : 1;
      const bf = model.featured.has(String(b.ResourceId)) ? 0 : 1;
      return af - bf || String(a.ResourceId).localeCompare(String(b.ResourceId));
    };

    const rarityInfos: Decoded[] = [];
    for (const rarity of GACHA_RARITIES) {
      const pct = model.rarityRate.get(rarity) ?? 0;
      if (pct <= 0) continue;
      const cards = (byRarity.get(rarity) ?? []).sort(sortCards);
      rarityInfos.push({
        __msg: RARITY_PROBABILITY_INFO_MSG,
        Rarity: rarity,
        Probability: Math.round(pct * PROB_SCALE),
        // GachaRewardPatternType: 1 = SelectCard, 2 = NotSelectCard. The client
        // uses this when a pickup banner has no selected cards yet.
        GachaRewardPatternType: isSelectGacha(gacha) ? 1 : 2,
        IndividualProbability: Math.round(pct * PROB_SCALE),
        ProbabilityInfos: cards.length ? cards : undefined,
      } as Decoded);
    }

    return {
      __msg: GACHA_PROBABILITY_RESPONSE_MSG,
      RarityProbabilityInfos: rarityInfos,
      ProbabilityInfos: probabilityInfos,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: { __msg: UPDATED_DATA_MSG },
        DeletedData: { __msg: DELETED_DATA_MSG },
      },
    } as Decoded;
  },
  { ownsState: true },
);

register(
  'Gacha:History',
  async (ctx) => {
    const { accountId, pl } = await playerForCtx(ctx);
    if (!accountId || !pl) throw new Error('Gacha:History: unauthenticated');

    const rows = await db
      .select()
      .from(gachaHistory)
      .where(eq(gachaHistory.playerId, pl.id))
      .orderBy(desc(gachaHistory.drawnAt))
      .limit(100);

    const histories: Decoded[] = rows.map(
      (r) =>
        ({
          __msg: GACHA_HISTORY_MSG,
          GachaType: 1,
          DrawTime: r.drawnAt ? new Date(r.drawnAt).getTime() : 0,
          GachaId: r.gachaMasterId,
          ResourceType: RESOURCE_CARD,
          Amount: Number(r.drawCount ?? 0),
        }) as Decoded,
    );

    return {
      __msg: GACHA_HISTORY_RESPONSE_MSG,
      Histories: histories,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: { __msg: UPDATED_DATA_MSG },
        DeletedData: { __msg: DELETED_DATA_MSG },
      },
    } as Decoded;
  },
  { ownsState: true },
);

register(
  'Gacha:ReceiveFreePremiumGachaTicket',
  async (ctx) => {
    const req = ctx.request;
    if (!req) throw new Error('Gacha:ReceiveFreePremiumGachaTicket: missing request');
    const { accountId, pl } = await playerForCtx(ctx);
    if (!accountId || !pl) throw new Error('Gacha:ReceiveFreePremiumGachaTicket: unauthenticated');

    const gachaId = String(req.GachaId ?? '');
    // The free-ticket item id is not present in this build's master data, so
    // this is a permissive acknowledgment (marks the claim, no grant).
    if (gachaId) await putGachaState(pl.id, gachaId, { freeTicketClaimed: true });

    ctx.fastifyReq.log.info({ accountId, gachaId }, 'gacha free premium ticket');

    return {
      __msg: GACHA_FREE_TICKET_RESPONSE_MSG,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: { __msg: UPDATED_DATA_MSG },
        DeletedData: { __msg: DELETED_DATA_MSG },
      },
    } as Decoded;
  },
  { ownsState: true },
);

async function getCurrencyLocal(playerId: string, type: number, tx: Executor): Promise<number> {
  const { getCurrency } = await import('./currency.ts');
  if (type === RESOURCE_GOLD) return getCurrency(playerId, 'gold', tx);
  if (type === RESOURCE_STONE) return getCurrency(playerId, 'freeJewel', tx);
  return 0;
}

async function synthesizeCard(cardId: string): Promise<Decoded | null> {
  return buildUserCard(cardId);
}

async function advanceStamps(
  playerId: string,
  groupId: string,
  sheetNumber: number,
  stampNumber: number,
  draws: number,
  tx: Executor,
): Promise<{ sheetNumber: number; stampNumber: number; results: Decoded[]; updated: Decoded | null }> {
  const stamps = await listGachaStamps(groupId);
  const bySheet = new Map<number, { max: number; rewardByStamp: Map<number, string> }>();
  for (const s of stamps) {
    const sheet = Number(s.SheetNumber ?? 1);
    const stamp = Number(s.StampNumber ?? 1);
    const entry = bySheet.get(sheet) ?? { max: 0, rewardByStamp: new Map<number, string>() };
    entry.max = Math.max(entry.max, stamp);
    if (s.RewardId) entry.rewardByStamp.set(stamp, String(s.RewardId));
    bySheet.set(sheet, entry);
  }
  const maxSheet = bySheet.size ? Math.max(...bySheet.keys()) : 0;

  let sheet = Math.max(1, sheetNumber);
  let stamp = Math.max(0, stampNumber);
  const rewardIds: string[] = [];
  for (let i = 0; i < draws; i++) {
    const entry = bySheet.get(sheet);
    stamp += 1;
    if (entry) {
      const reward = entry.rewardByStamp.get(stamp);
      if (reward) rewardIds.push(reward);
      if (stamp >= entry.max) {
        if (sheet < maxSheet) {
          sheet += 1;
          stamp = 0;
        }
      }
    }
  }

  const results: Decoded[] = [];
  let updated: Decoded | null = null;
  if (rewardIds.length) {
    const applied = await applyRewardRefs(playerId, rewardIds, tx);
    for (const r of applied.results) results.push(r);
    updated = applied.updated;
  }
  return { sheetNumber: sheet, stampNumber: stamp, results, updated };
}

const FRAG_COLLECTION_KEYS: Record<string, string> = {
  Items: 'ItemId',
  Points: 'PointType',
  Cards: 'CardId',
  Photos: 'PhotoId',
  Accessories: 'AccessoryId',
  Characters: 'CharacterId',
  Costumes: 'CostumeId',
  Emblems: 'EmblemId',
  Decorations: 'DecorationId',
  PhotoRecipes: 'PhotoRecipeId',
  Hairs: 'HairId',
  PhotoPoses: 'PhotoPoseId',
};

function buildUpdated(cards: Decoded[], frags: (Decoded | null)[]): Decoded {
  const merged = new Map<string, Map<string, Decoded>>();
  let balance: Decoded | null = null;
  for (const f of frags) {
    if (!f) continue;
    for (const [field, key] of Object.entries(FRAG_COLLECTION_KEYS)) {
      const arr = f[field] as Decoded[] | undefined;
      if (!arr) continue;
      let m = merged.get(field);
      if (!m) {
        m = new Map<string, Decoded>();
        merged.set(field, m);
      }
      for (const el of arr) m.set(String(el[key]), el);
    }
    if (f.Balance) balance = f.Balance as Decoded;
  }
  const cardMap = merged.get('Cards') ?? new Map<string, Decoded>();
  for (const c of cards) cardMap.set(String(c.CardId), c);
  merged.set('Cards', cardMap);

  const updated: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
  if (balance) updated.Balance = balance;
  for (const [field, m] of merged) if (m.size) updated[field] = [...m.values()];
  return updated;
}
