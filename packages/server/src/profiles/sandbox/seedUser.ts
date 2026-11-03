// Sandbox helper: upgrade an existing account/player to the sandbox seed.
//
// Usage:
//   node src/profiles/sandbox/seedUser.ts <playerId|accountId>
//
// Safe to re-run; the seed only fills deltas (see `seed.ts`).
import { eq, or } from 'drizzle-orm';
import '@sumire-sr/protocol/gen/registry.ts';
import { db, client } from '../../db/client.ts';
import { players } from '../../db/schema.ts';
import { withPlayerTx } from '../../db/tx.ts';

// The documented CLI must work without SUMIRE_PROFILE exported. `profile.ts`
// caches the profile at import time, so force it before the seed (which imports
// it) is loaded — hence the dynamic import.
process.env.SUMIRE_PROFILE = 'sandbox';
const { seedSandboxAccount } = await import('./seed.ts');

async function main(): Promise<void> {
  const ref = process.argv[2];
  if (!ref) {
    console.error('usage: node src/profiles/sandbox/seedUser.ts <playerId|accountId>');
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

  const summary = await withPlayerTx(pl.id, (tx) => seedSandboxAccount(tx, pl.id));
  console.log(`sandbox seed applied: ${JSON.stringify(summary)}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => client.end());
