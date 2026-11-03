import { eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import { getCostume, getHair } from '../master/index.ts';
import { listElements, putElements } from './playerState.ts';
import { type Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Server-authoritative costume / hair equip + "checked" marking.
 *
 * Costumes and hairs are cosmetic outfits. Which outfit a character wears is
 * held on that character's `UserCharacter` row (`FavoriteCostumeId`/
 * `FavoriteHairId` for the home outfit, `LiveCostumeId`/`LiveHairId` for the
 * live outfit). Ownership itself lives in the `Costumes`/`Hairs` collections
 * (kind `Costumes`/`Hairs`, element `UserCostume`/`UserHair`).
 *
 * None of these endpoints were captured, so they are built from the generated
 * schema and validated with `dbtest.ts` only (no byte-exact verification).
 */

const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';

type Character = Decoded & {
  CharacterId?: string;
  FavoriteCostumeId?: string;
  FavoriteHairId?: string;
  LiveCostumeId?: string;
  LiveHairId?: string;
};

async function playerForAccount(accountId: string, rpc: string, exec: Executor = db) {
  const [pl] = await exec.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  if (!pl) throw new Error(`${rpc}: no player for account`);
  return pl;
}

function commonResponse(updated: Decoded | null, deleted: Decoded | null = null): Decoded {
  return {
    __msg: COMMON_RESPONSE_MSG,
    UpdatedData: (updated ?? { __msg: UPDATED_DATA_MSG }) as Decoded,
    DeletedData: (deleted ?? { __msg: DELETED_DATA_MSG }) as Decoded,
  } as Decoded;
}

function updatedData(...entries: Array<[string, unknown]>): Decoded {
  const out: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
  for (const [k, v] of entries) {
    if (v !== undefined && v !== null) out[k] = v as Decoded;
  }
  return out;
}

/** Locate the owning character of a costume (master `CharacterId`). */
async function characterForCostume(
  exec: Executor,
  playerId: string,
  costumeId: string,
): Promise<Character> {
  const master = await getCostume(costumeId);
  if (!master) throw new Error(`unknown costume ${costumeId}`);
  const characters = (await listElements(playerId, 'Characters', exec)) as Character[];
  const char = characters.find((c) => String(c.CharacterId) === String(master.CharacterId));
  if (!char) throw new Error(`player does not own character ${master.CharacterId}`);
  return char;
}

/** Apply a partial patch to a character row and persist it. */
async function patchCharacter(
  exec: Executor,
  playerId: string,
  char: Character,
  patch: Partial<Character>,
): Promise<Character> {
  const next: Character = { ...char, ...patch };
  await putElements(playerId, 'Characters', [next], exec);
  return next;
}

/** Equip a costume (and optionally a hair) on the owning character. */
async function equip(
  accountId: string,
  rpc: string,
  req: Decoded | null,
  fields: { costume: keyof Character; hair: keyof Character },
): Promise<Decoded> {
  const costumeId = req?.CostumeId ? String(req.CostumeId) : '';
  if (!costumeId) throw new Error(`${rpc}: missing CostumeId`);
  const hairId = req?.HairId ? String(req.HairId) : '';

  const pl = await playerForAccount(accountId, rpc);
  const updated = await withPlayerTx(pl.id, async (tx) => {
    const char = await characterForCostume(tx, pl.id, costumeId);
    const patch: Partial<Character> = { [fields.costume]: costumeId };
    if (hairId) {
      const hair = await getHair(hairId);
      if (!hair) throw new Error(`${rpc}: unknown hair ${hairId}`);
      if (hair.CharacterId && String(hair.CharacterId) !== String(char.CharacterId)) {
        throw new Error(`${rpc}: hair ${hairId} does not belong to character ${char.CharacterId}`);
      }
      patch[fields.hair] = hairId;
    }
    const next = await patchCharacter(tx, pl.id, char, patch);
    return updatedData(['Characters', [next]]);
  });
  return { __msg: '', CommonResponse: commonResponse(updated) } as Decoded;
}

register(
  'Costume:SetCostume',
  (ctx) => {
    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('Costume:SetCostume: unauthenticated');
    return equip(accountId, 'Costume:SetCostume', ctx.request, {
      costume: 'FavoriteCostumeId',
      hair: 'FavoriteHairId',
    });
  },
  { ownsState: true },
);

register(
  'Costume:SetLiveCostume',
  (ctx) => {
    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('Costume:SetLiveCostume: unauthenticated');
    return equip(accountId, 'Costume:SetLiveCostume', ctx.request, {
      costume: 'LiveCostumeId',
      hair: 'LiveHairId',
    });
  },
  { ownsState: true },
);

/** Mark owned costumes/hairs as "checked" (seen). Returns the changed elements. */
async function markChecked(
  accountId: string,
  rpc: string,
  costumes: string[],
  hairs: string[],
): Promise<Decoded> {
  const pl = await playerForAccount(accountId, rpc);
  const updated = await withPlayerTx(pl.id, async (tx) => {
    const out: Array<[string, unknown]> = [];

    if (costumes.length) {
      const wanted = new Set(costumes);
      const owned = (await listElements(pl.id, 'Costumes', tx)) as Decoded[];
      const matched = owned.filter((c) => wanted.has(String(c.CostumeId)));
      const next = matched.map((c) => ({ ...c, Checked: true }));
      if (matched.some((c) => !c.Checked)) await putElements(pl.id, 'Costumes', next, tx);
      if (next.length) out.push(['Costumes', next]);
    }

    if (hairs.length) {
      const wanted = new Set(hairs);
      const owned = (await listElements(pl.id, 'Hairs', tx)) as Decoded[];
      const matched = owned.filter((h) => wanted.has(String(h.HairId)));
      const next = matched.map((h) => ({ ...h, Checked: true }));
      if (matched.some((h) => !h.Checked)) await putElements(pl.id, 'Hairs', next, tx);
      if (next.length) out.push(['Hairs', next]);
    }

    return updatedData(...out);
  });
  return { __msg: '', CommonResponse: commonResponse(updated) } as Decoded;
}

register(
  'Costume:CheckCostume',
  (ctx) => {
    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('Costume:CheckCostume: unauthenticated');
    const id = ctx.request?.CostumeId ? String(ctx.request.CostumeId) : '';
    if (!id) throw new Error('Costume:CheckCostume: missing CostumeId');
    return markChecked(accountId, 'Costume:CheckCostume', [id], []);
  },
  { ownsState: true },
);

register(
  'Costume:CheckBulk',
  (ctx) => {
    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('Costume:CheckBulk: unauthenticated');
    const costumeIds = ((ctx.request?.CostumeIds as string[] | undefined) ?? []).map(String).filter(Boolean);
    const hairIds = ((ctx.request?.HairIds as string[] | undefined) ?? []).map(String).filter(Boolean);
    return markChecked(accountId, 'Costume:CheckBulk', costumeIds, hairIds);
  },
  { ownsState: true },
);

register(
  'Hair:CheckHair',
  (ctx) => {
    const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
    if (!accountId) throw new Error('Hair:CheckHair: unauthenticated');
    const id = ctx.request?.HairId ? String(ctx.request.HairId) : '';
    if (!id) throw new Error('Hair:CheckHair: missing HairId');
    return markChecked(accountId, 'Hair:CheckHair', [], [id]);
  },
  { ownsState: true },
);
