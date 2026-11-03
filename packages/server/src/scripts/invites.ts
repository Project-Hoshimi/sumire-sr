// Dev/ops helper for invite links (docs/LOGIN_FLOW.md §2–3).
//
// Usage:
//   node src/scripts/invites.ts create --uses N --expires 7d --note text
//   node src/scripts/invites.ts list
//   node src/scripts/invites.ts revoke <id>
//
// `create` prints an invite URL built from SUMIRE_PUBLIC_URL; the plaintext
// token is stored only hashed, so the URL cannot be recovered later.
import { client } from '../db/client.ts';
import { createInvite, listInvites, revokeInvite } from '../db/invites.ts';
import { PUBLIC_URL } from '../config.ts';

const USAGE = [
  'usage:',
  '  node src/scripts/invites.ts create --uses N --expires 7d --note text',
  '  node src/scripts/invites.ts list',
  '  node src/scripts/invites.ts revoke <id>',
].join('\n');

type CreateArgs = {
  uses: number;
  expiresAt: Date | null;
  note: string | null;
};

function parseExpires(raw: string): Date {
  const match = /^(\d+)([dh])$/.exec(raw);
  if (!match) throw new Error(`--expires must look like 7d or 12h (got ${raw})`);
  const amount = Number(match[1]);
  if (amount <= 0) throw new Error('--expires must be positive');
  const ms = match[2] === 'd' ? amount * 86_400_000 : amount * 3_600_000;
  return new Date(Date.now() + ms);
}

function parseCreate(args: string[]): CreateArgs {
  const out: CreateArgs = { uses: 1, expiresAt: null, note: null };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '--uses') {
      out.uses = Number(value);
      i += 1;
    } else if (flag === '--expires') {
      out.expiresAt = parseExpires(value ?? '');
      i += 1;
    } else if (flag === '--note') {
      out.note = value ?? '';
      i += 1;
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!Number.isInteger(out.uses) || out.uses < 1) throw new Error('--uses must be a positive integer');
  return out;
}

async function create(args: string[]): Promise<void> {
  const opts = parseCreate(args);
  if (!PUBLIC_URL) {
    console.error('SUMIRE_PUBLIC_URL is not set; set it to build the invite URL (e.g. https://sumire.example).');
    process.exitCode = 1;
    return;
  }
  const { invite, token } = await createInvite(opts);
  const base = PUBLIC_URL.replace(/\/+$/, '');
  console.log(`invite ${invite.id} (uses ${invite.maxUses}/${invite.maxUses})`);
  console.log(`${base}/invite/${token}`);
}

async function list(): Promise<void> {
  const rows = await listInvites();
  if (rows.length === 0) {
    console.log('no invites');
    return;
  }
  for (const row of rows) {
    const expires = row.expiresAt ? row.expiresAt.toISOString() : '-';
    const revoked = row.revokedAt ? row.revokedAt.toISOString() : '-';
    const note = row.note ? `  ${row.note}` : '';
    console.log(`${row.id}\t${row.uses}/${row.maxUses}\texpires ${expires}\trevoked ${revoked}${note}`);
  }
}

async function revoke(args: string[]): Promise<void> {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id < 1) {
    console.error('usage: node src/scripts/invites.ts revoke <id>');
    process.exitCode = 1;
    return;
  }
  const ok = await revokeInvite(id);
  if (!ok) {
    console.error(`invite ${id} not found (or already revoked)`);
    process.exitCode = 1;
    return;
  }
  console.log(`invite ${id} revoked`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'create') return create(rest);
  if (command === 'list') return list();
  if (command === 'revoke') return revoke(rest);
  console.error(USAGE);
  process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => client.end());
