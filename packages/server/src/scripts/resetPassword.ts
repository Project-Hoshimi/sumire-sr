// Dev/ops helper: reset a player's link password (docs/LOGIN_FLOW.md §3).
//
// Usage:
//   node src/scripts/resetPassword.ts <publicUserId>
//
// Prints the new password exactly once; only the scrypt hash is stored.
import { eq } from 'drizzle-orm';
import { client, db } from '../db/client.ts';
import { accounts } from '../db/schema.ts';
import { upsertPassword } from '../db/credentials.ts';
import { generateLinkPassword, hashPassword } from '../auth/passwords.ts';

async function main(): Promise<void> {
  const [publicUserId] = process.argv.slice(2);
  if (!publicUserId) {
    console.error('usage: node src/scripts/resetPassword.ts <publicUserId>');
    process.exitCode = 1;
    return;
  }

  const seedId = publicUserId.trim().toUpperCase();
  const [acct] = await db.select().from(accounts).where(eq(accounts.seedId, seedId)).limit(1);
  if (!acct) {
    console.error(`no account matching ${publicUserId}`);
    process.exitCode = 1;
    return;
  }

  const password = generateLinkPassword(12);
  await upsertPassword(acct.id, hashPassword(password));
  console.log(`${acct.seedId}: ${password}`);
}

main()
  .catch((e) => {
    console.error(e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => client.end());
