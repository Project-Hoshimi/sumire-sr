// Dev/ops helper for admin console accounts.
//
// Usage:
//   node src/tools/adminUser.ts create <username> <role>
//   node src/tools/adminUser.ts reset <username>
//   node src/tools/adminUser.ts disable <username>
//   node src/tools/adminUser.ts enable <username>
//   node src/tools/adminUser.ts list
//
// Passwords are read from stdin (one line) and never from argv. On a TTY the
// prompt disables echo. Roles: viewer|editor|publisher|owner.
import { randomUUID } from 'node:crypto';
import { client } from '../db/client.ts';
import { drizzleAdminStore } from '../services/admin/store.drizzle.ts';
import {
  type AdminUserRow,
  UsernameTakenError,
  isAdminRole,
  isValidAdminUsername,
  normalizeAdminUsername,
} from '../services/admin/store.ts';
import { hashAdminPassword, isValidAdminPassword } from '../services/admin/auth.ts';

const USAGE = [
  'usage:',
  '  node src/tools/adminUser.ts create <username> <role>',
  '  node src/tools/adminUser.ts reset <username>',
  '  node src/tools/adminUser.ts disable <username>',
  '  node src/tools/adminUser.ts enable <username>',
  '  node src/tools/adminUser.ts list',
].join('\n');

/** First line of stdin when piped. */
async function readPipedLine(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk.toString();
  return data.split(/\r?\n/, 1)[0] ?? '';
}

/** Prompt on stderr and read one line without echo on a TTY. */
function readHiddenLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.stderr.write('\n');
          process.exitCode = 130;
          resolve('');
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPassword(prompt: string): Promise<string> {
  return process.stdin.isTTY ? readHiddenLine(prompt) : readPipedLine();
}

function requireArg(args: string[], index: number, name: string): string {
  const value = args[index];
  if (!value) throw new Error(`missing ${name}\n${USAGE}`);
  return value;
}

function normalizeValidUsername(raw: string): string {
  const username = normalizeAdminUsername(raw);
  if (!isValidAdminUsername(username)) {
    throw new Error('username must match /^[a-z0-9_.-]{3,32}$/');
  }
  return username;
}

async function create(args: string[]): Promise<void> {
  const username = normalizeValidUsername(requireArg(args, 0, 'username'));
  const role = requireArg(args, 1, 'role');
  if (!isAdminRole(role)) throw new Error('role must be viewer, editor, publisher or owner');

  const password = await readPassword('Password: ');
  if (!isValidAdminPassword(password)) {
    throw new Error('password must be between 12 and 200 characters');
  }

  const store = drizzleAdminStore();
  if (await store.getByUsername(username)) throw new Error(`admin user already exists: ${username}`);
  let user: AdminUserRow;
  try {
    user = await store.create({
      id: randomUUID(),
      username,
      passwordHash: hashAdminPassword(password),
      role,
    });
  } catch (error) {
    if (error instanceof UsernameTakenError) {
      throw new Error(`admin user already exists: ${username}`);
    }
    throw error;
  }
  console.log(`created ${user.username} (${user.role}) ${user.id}`);
}

async function reset(args: string[]): Promise<void> {
  const username = normalizeValidUsername(requireArg(args, 0, 'username'));
  const password = await readPassword('New password: ');
  if (!isValidAdminPassword(password)) {
    throw new Error('password must be between 12 and 200 characters');
  }

  const store = drizzleAdminStore();
  const user = await store.getByUsername(username);
  if (!user) throw new Error(`admin user not found: ${username}`);
  await store.setPasswordHash(user.id, hashAdminPassword(password));
  await store.deleteSessionsForUser(user.id);
  console.log(`password reset for ${user.username}; sessions revoked`);
}

async function setDisabled(args: string[], disabled: boolean): Promise<void> {
  const username = normalizeValidUsername(requireArg(args, 0, 'username'));
  const store = drizzleAdminStore();
  const user = await store.getByUsername(username);
  if (!user) throw new Error(`admin user not found: ${username}`);
  await store.setDisabled(user.id, disabled);
  if (disabled) await store.deleteSessionsForUser(user.id);
  console.log(`${user.username} ${disabled ? 'disabled' : 'enabled'}`);
}

async function list(): Promise<void> {
  const store = drizzleAdminStore();
  const users = await store.list();
  if (users.length === 0) {
    console.log('no admin users');
    return;
  }
  for (const user of users) {
    const state = user.disabled ? 'disabled' : 'active';
    const last = user.lastLoginAt ? user.lastLoginAt.toISOString() : '-';
    console.log(`${user.username}\t${user.role}\t${state}\tlast-login ${last}\t${user.id}`);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'create') return create(rest);
  if (command === 'reset') return reset(rest);
  if (command === 'disable') return setDisabled(rest, true);
  if (command === 'enable') return setDisabled(rest, false);
  if (command === 'list') return list();
  console.error(USAGE);
  process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => client.end());
