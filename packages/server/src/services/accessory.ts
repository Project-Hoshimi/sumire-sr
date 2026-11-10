import { eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import { getAccessory, getAccessoryEnhancement, getSetting } from '../master/index.ts';
import { getCurrency, grantCurrency, spendCurrency } from './currency.ts';
import { consume, consumptionSpendsStones, mergeConsumptionUpdatedData } from './consumption.ts';
import { grantAccessory } from './inventory.ts';
import { listElements, putElements, readPlayerBalance, removeElements } from './playerState.ts';
import { type Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Server-authoritative accessory actions.
 *
 * Accessories are equippable stat gear. The player owns them as the
 * `Accessories` collection (kind `Accessories`, element
 * `Transaction.UserAccessory{AccessoryId, Amount}` — `Amount` is how many
 * copies are held). Rarity/phase is encoded in the accessory id series
 * (`ac-{group}-{series}-{NN}`, NN 01..20 = rarity 1..20, 21..41 = rarity 21
 * tiers); `Enhance` advances the id suffix one step up to rarity 21, and
 * `LimitBreak` continues within the rarity-21 tiers driven by master
 * `Consumption` rows.
 */

const SELL_RESPONSE_MSG = 'Solis.Common.Proto.Api.AccessorySellResponse';
const ENHANCE_RESPONSE_MSG = 'Solis.Common.Proto.Api.AccessoryEnhanceResponse';
const LIMIT_BREAK_RESPONSE_MSG = 'Solis.Common.Proto.Api.AccessoryLimitBreakResponse';
const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';

async function playerForAccount(accountId: string, rpc: string, exec: Executor = db) {
  const [pl] = await exec.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  if (!pl) throw new Error(`${rpc}: no player for account`);
  return pl;
}

const RARITY_21 = 21;

/** Split an accessory id into its numeric suffix (the rarity step). */
function parseAccessoryId(id: string): { prefix: string; num: number; width: number } | null {
  const parts = id.split('-');
  const last = parts[parts.length - 1];
  if (!/^\d+$/.test(last)) return null;
  return { prefix: parts.slice(0, -1).join('-'), num: Number(last), width: last.length };
}

function advanceAccessoryId(id: string): string {
  const parsed = parseAccessoryId(id);
  if (!parsed) throw new Error(`Accessory: cannot advance id ${id}`);
  return `${parsed.prefix}-${String(parsed.num + 1).padStart(parsed.width, '0')}`;
}

register(
  'Accessory:Sell',
  async (ctx) => {
    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('Accessory:Sell: unauthenticated');
    const accessoryId = ctx.request?.AccessoryId ? String(ctx.request.AccessoryId) : '';
    if (!accessoryId) throw new Error('Accessory:Sell: missing AccessoryId');
    const count = Number(ctx.request?.Count ?? 0);
    if (!Number.isFinite(count) || count <= 0) throw new Error('Accessory:Sell: invalid Count');

    const pl = await playerForAccount(accountId, 'Accessory:Sell');

    const out = await withPlayerTx(pl.id, async (tx) => {
      const owned = (await listElements(pl.id, 'Accessories', tx)) as Decoded[];
      const found = owned.find((a) => String(a.AccessoryId) === accessoryId);
      if (!found) throw new Error(`Accessory:Sell: player does not own ${accessoryId}`);
      const amount = Number(found.Amount ?? 0);
      if (amount < count) {
        throw new Error(`Accessory:Sell: have ${amount}, cannot sell ${count} of ${accessoryId}`);
      }

      const master = await getAccessory(accessoryId);
      const salePrice = Number(master?.SalePrice ?? 0);
      const gold = salePrice * count;
      if (gold > 0) await grantCurrency(pl.id, 'gold', gold, tx);

      const next = amount - count;
      const updated: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
      const deleted: Decoded = { __msg: DELETED_DATA_MSG } as Decoded;
      if (next === 0) {
        await removeElements(pl.id, 'Accessories', [found], tx);
        deleted.Accessories = [found];
      } else {
        const el = { ...found, Amount: next } as Decoded;
        await putElements(pl.id, 'Accessories', [el], tx);
        updated.Accessories = [el];
      }

      const goldNow = await getCurrency(pl.id, 'gold', tx);
      updated.Points = [{ PointType: 1, Amount: goldNow } as Decoded];

      return { updated, deleted, gold, sold: count };
    });

    ctx.fastifyReq.log.info(
      { playerId: pl.id, accessoryId, sold: out.sold, gold: out.gold },
      'accessory sell (server-authoritative)',
    );

    return {
      __msg: SELL_RESPONSE_MSG,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: out.updated,
        DeletedData: out.deleted,
      },
    } as Decoded;
  },
  { ownsState: true },
);

/**
 * `Accessory:Enhance` — consume same-classification fodder accessories and gold
 * to advance the accessory one rarity step (id suffix +1). `MaterialType` only
 * filters deck usage server-side; we hold no deck-usage index, so all copies
 * are eligible fodder.
 */
register(
  'Accessory:Enhance',
  async (ctx) => {
    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('Accessory:Enhance: unauthenticated');
    const accessoryId = ctx.request?.AccessoryId ? String(ctx.request.AccessoryId) : '';
    if (!accessoryId) throw new Error('Accessory:Enhance: missing AccessoryId');

    const pl = await playerForAccount(accountId, 'Accessory:Enhance');

    const out = await withPlayerTx(pl.id, async (tx) => {
      const master = await getAccessory(accessoryId);
      if (!master) throw new Error(`Accessory:Enhance: unknown accessory ${accessoryId}`);
      const rarity = Number(master.Rarity ?? 1);
      if (rarity >= RARITY_21) {
        throw new Error(`Accessory:Enhance: ${accessoryId} already at max rarity; use LimitBreak`);
      }
      const target = rarity + 1;
      const row = await getAccessoryEnhancement(target);
      if (!row) throw new Error(`Accessory:Enhance: no AccessoryEnhancement ${target}`);

      const setting = await getSetting();
      const required = Number(setting?.AccessoryEnhancesRequiredMaterialAmount ?? 3);
      if (required <= 0) throw new Error('Accessory:Enhance: no material requirement configured');

      const owned = (await listElements(pl.id, 'Accessories', tx)) as Decoded[];
      const base = owned.find((a) => String(a.AccessoryId) === accessoryId);
      if (!base) throw new Error(`Accessory:Enhance: player does not own ${accessoryId}`);

      const classification = String(master.Classification ?? '');
      const pool = owned
        .filter((a) => String(a.AccessoryId) !== accessoryId && Number(a.Amount ?? 0) > 0)
        .sort((a, b) => String(a.AccessoryId).localeCompare(String(b.AccessoryId)));

      const updated: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
      const deleted: Decoded = { __msg: DELETED_DATA_MSG } as Decoded;
      const updatedAccessories: Decoded[] = [];
      const deletedAccessories: Decoded[] = [];

      let need = required;
      for (const a of pool) {
        if (need <= 0) break;
        const candidate = String(a.AccessoryId);
        const cm = await getAccessory(candidate);
        if (!cm || String(cm.Classification ?? '') !== classification) continue;
        const amt = Number(a.Amount ?? 0);
        const take = Math.min(amt, need);
        need -= take;
        const next = amt - take;
        if (next === 0) {
          await removeElements(pl.id, 'Accessories', [a], tx);
          deletedAccessories.push(a);
        } else {
          const el = { ...a, Amount: next } as Decoded;
          await putElements(pl.id, 'Accessories', [el], tx);
          updatedAccessories.push(el);
        }
      }
      if (need > 0) {
        throw new Error(`Accessory:Enhance: insufficient ${classification} fodder (need ${required})`);
      }

      const gold = Number(row.RequiredGold ?? 0);
      if (gold > 0) await spendCurrency(pl.id, 'gold', gold, tx);

      const nextId = advanceAccessoryId(accessoryId);
      const nextMaster = await getAccessory(nextId);
      if (!nextMaster) throw new Error(`Accessory:Enhance: no next accessory ${nextId}`);

      const baseAmt = Number(base.Amount ?? 0);
      if (baseAmt <= 1) {
        await removeElements(pl.id, 'Accessories', [base], tx);
        deletedAccessories.push(base);
      } else {
        const el = { ...base, Amount: baseAmt - 1 } as Decoded;
        await putElements(pl.id, 'Accessories', [el], tx);
        updatedAccessories.push(el);
      }
      await grantAccessory(pl.id, nextId, 1, tx);
      const enhanced = (await listElements(pl.id, 'Accessories', tx)).find(
        (a) => String(a.AccessoryId) === nextId,
      );
      if (enhanced) updatedAccessories.push(enhanced);

      if (updatedAccessories.length) updated.Accessories = updatedAccessories;
      if (deletedAccessories.length) deleted.Accessories = deletedAccessories;
      const goldNow = await getCurrency(pl.id, 'gold', tx);
      updated.Points = [{ PointType: 1, Amount: goldNow } as Decoded];

      return { updated, deleted, from: accessoryId, to: nextId, gold };
    });

    ctx.fastifyReq.log.info(
      { playerId: pl.id, from: out.from, to: out.to, gold: out.gold },
      'accessory enhance (server-authoritative)',
    );

    return {
      __msg: ENHANCE_RESPONSE_MSG,
      IsUnsetLeague: false,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: out.updated,
        DeletedData: out.deleted,
      },
    } as Decoded;
  },
  { ownsState: true },
);

/**
 * `Accessory:LimitBreak` — spend the master `con-acc-lb-{series}-{tier}` cost
 * (Spirit Riser + gold, sometimes a duplicate rarity-21 accessory) to advance a
 * rarity-21 accessory one tier (id suffix +1, e.g. -21 -> -22).
 */
register(
  'Accessory:LimitBreak',
  async (ctx) => {
    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('Accessory:LimitBreak: unauthenticated');
    const accessoryId = ctx.request?.AccessoryId ? String(ctx.request.AccessoryId) : '';
    if (!accessoryId) throw new Error('Accessory:LimitBreak: missing AccessoryId');

    const pl = await playerForAccount(accountId, 'Accessory:LimitBreak');

    const out = await withPlayerTx(pl.id, async (tx) => {
      const master = await getAccessory(accessoryId);
      if (!master) throw new Error(`Accessory:LimitBreak: unknown accessory ${accessoryId}`);
      const parsed = parseAccessoryId(accessoryId);
      if (!parsed) throw new Error(`Accessory:LimitBreak: cannot parse id ${accessoryId}`);
      const tier = parsed.num - 20;
      if (tier < 1) throw new Error(`Accessory:LimitBreak: ${accessoryId} is not rarity 21`);

      const series = String(master.Classification ?? '');
      const consumptionId = `con-acc-lb-${series}-${String(tier).padStart(2, '0')}`;
      const results = await consume(pl.id, consumptionId, 1, tx);

      const nextId = advanceAccessoryId(accessoryId);
      const nextMaster = await getAccessory(nextId);
      if (!nextMaster) throw new Error(`Accessory:LimitBreak: no next accessory ${nextId}`);

      const owned = (await listElements(pl.id, 'Accessories', tx)) as Decoded[];
      const base = owned.find((a) => String(a.AccessoryId) === accessoryId);
      if (!base) throw new Error(`Accessory:LimitBreak: player does not own ${accessoryId}`);
      const baseAmt = Number(base.Amount ?? 0);

      const updated: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
      const deleted: Decoded = { __msg: DELETED_DATA_MSG } as Decoded;
      const updatedAccessories: Decoded[] = [];
      const deletedAccessories: Decoded[] = [];

      if (baseAmt <= 1) {
        await removeElements(pl.id, 'Accessories', [base], tx);
        deletedAccessories.push(base);
      } else {
        const el = { ...base, Amount: baseAmt - 1 } as Decoded;
        await putElements(pl.id, 'Accessories', [el], tx);
        updatedAccessories.push(el);
      }
      await grantAccessory(pl.id, nextId, 1, tx);
      const changed = (await listElements(pl.id, 'Accessories', tx)).find(
        (a) => String(a.AccessoryId) === nextId,
      );
      if (changed) updatedAccessories.push(changed);

      if (updatedAccessories.length) updated.Accessories = updatedAccessories;
      if (deletedAccessories.length) deleted.Accessories = deletedAccessories;
      // The limit-break cost (items/accessories/gold) must come back with its
      // post-spend amounts, merged into the same collections.
      await mergeConsumptionUpdatedData(pl.id, updated, results, tx);
      if (consumptionSpendsStones(results)) {
        updated.Balance = await readPlayerBalance(pl.id, tx);
      }

      return { updated, deleted, from: accessoryId, to: nextId, consumptionId };
    });

    ctx.fastifyReq.log.info(
      { playerId: pl.id, from: out.from, to: out.to, consumptionId: out.consumptionId },
      'accessory limit break (server-authoritative)',
    );

    return {
      __msg: LIMIT_BREAK_RESPONSE_MSG,
      CommonResponse: {
        __msg: COMMON_RESPONSE_MSG,
        UpdatedData: out.updated,
        DeletedData: out.deleted,
      },
    } as Decoded;
  },
  { ownsState: true },
);
