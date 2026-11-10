// Dev/admin helper: post gifts into a player's gift box (the `Gifts` rows that
// `Gift:List` serves and `Gift:Receive` grants), and inspect a player's pending
// gifts.
//
// Usage:
//   node src/tools/sendGift.ts --player <player uuid|account uuid|public id>
//       --type <ResourceType> [--id <ResourceId>] --amount <n>
//       [--message <text>] [--count <k>]
//   node src/tools/sendGift.ts --player <player uuid|account uuid|public id> --list
//
// `--type` must be a resource type `applyGrants` supports (see
// `SUPPORTED_GRANT_TYPES` in src/master/reward.ts). `--id` is required for every
// type except the player-currency ones (8 gold, 14 manager exp, 15 free jewel,
// 16 paid jewel, 20 group story point). Item / card / costume ids are checked
// against the master data.
import { randomUUID } from 'node:crypto';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import '@sumire-sr/protocol/gen/registry.ts';
import { db, client } from '../db/client.ts';
import { accounts, players, playerEntities } from '../db/schema.ts';
import { withPlayerTx } from '../db/tx.ts';
import { getCard, getCostume, getItem } from '../master/index.ts';
import { SUPPORTED_GRANT_TYPES } from '../master/reward.ts';
import { postGifts } from '../services/gift.ts';
import { decodeMessage, msgRegistry, Reader, type Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

const USER_GIFT_MSG = 'Solis.Common.Proto.Transaction.UserGift';
const GIFT_KIND = 'Gifts';
const DEFAULT_MESSAGE = 'テスト用プレゼント';

/** Resource types that are amounts of a player currency, not an entity id. */
const TYPES_WITHOUT_ID = new Set([8, 14, 15, 16, 20]);

const USAGE = `usage:
  node src/tools/sendGift.ts --player <player uuid|account uuid|public id>
      --type <ResourceType> [--id <ResourceId>] --amount <n>
      [--message <text>] [--count <k>]
  node src/tools/sendGift.ts --player <player uuid|account uuid|public id> --list`;

type Options = {
  player?: string;
  type?: string;
  id?: string;
  amount?: string;
  message?: string;
  count?: string;
  list: boolean;
};

function parseArgs(argv: string[]): Options {
  const opts: Options = { list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [name, inline] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new Error(`missing value for ${name}`);
      return next;
    };
    switch (name) {
      case '--player':
        opts.player = value();
        break;
      case '--type':
        opts.type = value();
        break;
      case '--id':
        opts.id = value();
        break;
      case '--amount':
        opts.amount = value();
        break;
      case '--message':
        opts.message = value();
        break;
      case '--count':
        opts.count = value();
        break;
      case '--list':
        opts.list = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

type PlayerRow = { player: typeof players.$inferSelect; account: typeof accounts.$inferSelect };

/** Resolve a player uuid, account uuid or public id to its player row. */
async function resolvePlayer(ref: string): Promise<PlayerRow | undefined> {
  const [row] = await db
    .select({ player: players, account: accounts })
    .from(players)
    .innerJoin(accounts, eq(players.accountId, accounts.id))
    .where(
      or(
        eq(players.id, ref),
        eq(accounts.id, ref),
        eq(accounts.seedId, ref),
        sql`${players.data} ->> 'publicUserId' = ${ref}`,
      ),
    )
    .limit(1);
  return row;
}

function publicUserIdOf(row: PlayerRow): string {
  return (row.player.data as { publicUserId?: string } | null)?.publicUserId ?? row.account.seedId ?? '';
}

/** Validate `resourceId` against master data where a lookup helper exists. */
async function validateResourceId(type: number, resourceId: string): Promise<void> {
  if (type === 1) {
    if (!(await getItem(resourceId))) throw new Error(`item not found in master data: ${resourceId}`);
  } else if (type === 2) {
    if (!(await getCard(resourceId))) throw new Error(`card not found in master data: ${resourceId}`);
  } else if (type === 5) {
    if (!(await getCostume(resourceId))) throw new Error(`costume not found in master data: ${resourceId}`);
  }
}

async function listPending(row: PlayerRow): Promise<void> {
  const rows = await db
    .select()
    .from(playerEntities)
    .where(
      and(eq(playerEntities.playerId, row.player.id), eq(playerEntities.kind, GIFT_KIND)),
    )
    .orderBy(asc(playerEntities.ordinal));
  const shape = msgRegistry.get(USER_GIFT_MSG)!;
  console.log(
    `player ${row.player.id} (${row.player.name}, public ${publicUserIdOf(row)}): ${rows.length} pending gift(s)`,
  );
  for (const r of rows) {
    const g = decodeMessage(
      shape,
      new Reader(Uint8Array.from(Buffer.from(r.blob, 'base64'))),
    ) as Decoded;
    const posted = Number(g.PostedTime ?? 0);
    console.log(
      `  ${String(g.GiftId)}  type=${Number(g.ResourceType ?? 0)}` +
        `${g.ResourceId != null && g.ResourceId !== '' ? ` id=${String(g.ResourceId)}` : ''}` +
        ` amount=${Number(g.Amount ?? 0)}` +
        `${posted ? ` posted=${new Date(posted).toISOString()}` : ''}` +
        `${g.Message ? ` message=${JSON.stringify(String(g.Message))}` : ''}`,
    );
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.player) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const row = await resolvePlayer(opts.player);
  if (!row) {
    console.error(`no player matching ${opts.player}`);
    process.exitCode = 1;
    return;
  }

  if (opts.list) {
    await listPending(row);
    return;
  }

  if (opts.type === undefined || opts.amount === undefined) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const type = Number(opts.type);
  if (!Number.isInteger(type) || !SUPPORTED_GRANT_TYPES.has(type)) {
    console.error(
      `unsupported resource type: ${opts.type} (supported: ${[...SUPPORTED_GRANT_TYPES].sort((a, b) => a - b).join(', ')})`,
    );
    process.exitCode = 1;
    return;
  }

  if (!TYPES_WITHOUT_ID.has(type) && !opts.id) {
    console.error(`resource type ${type} requires --id`);
    process.exitCode = 1;
    return;
  }
  if (opts.id !== undefined) {
    await validateResourceId(type, opts.id);
  }

  const amount = Number(opts.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    console.error(`--amount must be a positive integer: ${opts.amount}`);
    process.exitCode = 1;
    return;
  }

  const count = opts.count === undefined ? 1 : Number(opts.count);
  if (!Number.isSafeInteger(count) || count <= 0) {
    console.error(`--count must be a positive integer: ${opts.count}`);
    process.exitCode = 1;
    return;
  }

  const message = opts.message ?? DEFAULT_MESSAGE;
  const postedTime = Date.now();
  const gifts: Decoded[] = Array.from({ length: count }, () => ({
    __msg: USER_GIFT_MSG,
    GiftId: randomUUID(),
    ResourceType: type,
    ...(opts.id !== undefined ? { ResourceId: opts.id } : {}),
    Amount: amount,
    Message: message,
    PostedTime: postedTime,
  }));

  const giftIds = await withPlayerTx(row.player.id, (tx) =>
    postGifts(tx, row.player.id, gifts),
  );

  console.log(
    `player ${row.player.id} (${row.player.name}, public ${publicUserIdOf(row)}): posted ${giftIds.length} gift(s)`,
  );
  for (const id of giftIds) console.log(`  ${id}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => client.end());
