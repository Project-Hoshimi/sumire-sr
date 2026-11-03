// Dev helper: grant items to a player so restricted content can be exercised
// on a private server. Re-runnable and idempotent in the additive sense (it
// adds to the current amount).
//
// Usage:
//   node src/db/grantItem.ts <playerId|accountId> <itemId|loveId> <amount>
//
// `<itemId|loveId>` accepts a full item id (e.g. item-love-25-0426-story) or a
// love id shorthand (e.g. love-extra-25-0426 -> item-love-25-0426-story).
import { eq, or } from 'drizzle-orm';
import '@sumire-sr/protocol/gen/registry.ts';
import { db, client } from './client.ts';
import { players } from './schema.ts';
import { withPlayerTx } from './tx.ts';
import { grantItem, getItemAmount } from '../services/inventory.ts';

function storyItemId(ref: string): string {
  if (ref.startsWith('item-')) return ref;
  return 'item-' + ref.replace(/^love-extra-/, 'love-') + '-story';
}

async function main(): Promise<void> {
  const [ref, itemRef, amountRaw] = process.argv.slice(2);
  const amount = Number(amountRaw ?? 0);
  if (!ref || !itemRef || !Number.isFinite(amount) || amount <= 0) {
    console.error('usage: node src/db/grantItem.ts <playerId|accountId> <itemId|loveId> <amount>');
    process.exitCode = 1;
    return;
  }

  const [pl] = await db
    .select()
    .from(players)
    .where(or(eq(players.id, ref), eq(players.accountId, ref)))
    .limit(1);
  if (!pl) {
    console.error(`no player matching ${ref}`);
    process.exitCode = 1;
    return;
  }

  const itemId = storyItemId(itemRef);
  await withPlayerTx(pl.id, async (tx) => {
    await grantItem(pl.id, itemId, amount, tx);
  });
  const total = await getItemAmount(pl.id, itemId);
  console.log(`player ${pl.id}: ${itemId} += ${amount} (now ${total})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => client.end());
