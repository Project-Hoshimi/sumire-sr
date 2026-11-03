/**
 * Invite links and the admin API that manages them (docs/LOGIN_FLOW.md §2–3).
 *
 * `GET /invite/:token` renders a self-contained page (inline CSS/JS, no external
 * resources); the page POSTs `{password}` back to the same URL and the server
 * creates the account + player in one transaction, then shows the title ID.
 *
 * `/sumire/admin/*` is guarded by `Authorization: Bearer <SUMIRE_ADMIN_TOKEN>`;
 * with no token configured the routes answer 404 like they do not exist.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { accounts } from '../db/schema.ts';
import {
  consumeInvite,
  createInvite,
  findInviteByToken,
  isInviteUsable,
  listInvites,
  revokeInvite,
} from '../db/invites.ts';
import { upsertPassword } from '../db/credentials.ts';
import { generateLinkPassword, hashPassword, isValidLinkPassword } from '../auth/passwords.ts';
import { ADMIN_TOKEN, PUBLIC_URL, registrationMode } from '../config.ts';
import { createAccountWithPlayer, seedSandboxIfNeeded } from '../services/auth.ts';
import { message } from '../messages.ts';

const HTML_TYPE = 'text/html; charset=utf-8';
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_REQUESTS = 20;

const STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #14161c; color: #e8eaf0; }
  main { max-width: 26rem; margin: 0 auto; padding: 3rem 1.25rem; }
  h1 { font-size: 1.4rem; margin: 0 0 1.25rem; }
  h2 { font-size: 1.1rem; margin: 0 0 .75rem; }
  p { line-height: 1.55; }
  label { display: block; margin: 1rem 0 .35rem; font-size: .9rem; color: #b9bdca; }
  input { width: 100%; box-sizing: border-box; padding: .65rem .7rem; font-size: 1rem;
          border-radius: .4rem; border: 1px solid #3a3f4d; background: #1d2029; color: inherit; }
  button { margin-top: 1.4rem; width: 100%; padding: .75rem; font-size: 1rem; font-weight: 600;
           border: 0; border-radius: .4rem; background: #4f7cff; color: #fff; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  #status { min-height: 1.3em; color: #ff9c9c; }
  #done { margin-top: 1.5rem; padding: 1rem; border-radius: .5rem; background: #1d2029; }
  #title-id { font-size: 1.3rem; letter-spacing: .12em; }
`;

function page(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title><style>${STYLE}</style></head>`,
    `<body><main>${body}</main></body></html>`,
  ].join('');
}

const INVITE_FORM = [
  '<h1>Enter Link Password</h1>',
  '<p>Choose a link password for your account. Use 8–16 letters and digits.</p>',
  '<form id="invite-form" novalidate>',
  '<label for="password">Link password</label>',
  '<input id="password" name="password" type="password" autocomplete="new-password" required>',
  '<label for="confirm">Confirm link password</label>',
  '<input id="confirm" name="confirm" type="password" autocomplete="new-password" required>',
  '<p id="status" role="alert"></p>',
  '<button id="submit" type="submit">Create account</button>',
  '</form>',
  '<section id="done" hidden>',
  '<h2>Your account is ready</h2>',
  '<p>Your title ID: <strong id="title-id"></strong></p>',
  '<p>Open the game → title screen → Account → Enter Link Password → enter this ID and your password.</p>',
  '</section>',
  '<script>',
  'const form = document.getElementById("invite-form");',
  'const password = document.getElementById("password");',
  'const confirm = document.getElementById("confirm");',
  'const status = document.getElementById("status");',
  'const submit = document.getElementById("submit");',
  'const rule = /^[A-Za-z0-9]{8,16}$/;',
  'form.addEventListener("submit", async (event) => {',
  '  event.preventDefault();',
  '  status.textContent = "";',
  '  const value = password.value;',
  '  if (!rule.test(value)) { status.textContent = "Use 8-16 letters and digits."; return; }',
  '  if (value !== confirm.value) { status.textContent = "The passwords do not match."; return; }',
  '  submit.disabled = true;',
  '  try {',
  '    const response = await fetch(location.pathname, {',
  '      method: "POST", headers: { "content-type": "application/json" },',
  '      body: JSON.stringify({ password: value }),',
  '    });',
  '    const data = await response.json().catch(() => ({}));',
  '    if (!response.ok) {',
  '      status.textContent = data.error || "This invite link is no longer valid.";',
  '      submit.disabled = false;',
  '      return;',
  '    }',
  '    form.hidden = true;',
  '    document.getElementById("title-id").textContent = data.publicUserId;',
  '    document.getElementById("done").hidden = false;',
  '  } catch (e) {',
  '    status.textContent = "Could not reach the server. Try again.";',
  '    submit.disabled = false;',
  '  }',
  '});',
  '</script>',
].join('\n');

// In-memory GET/POST rate limit per client IP (single-process server).
const requestLog = new Map<string, number[]>();

function rateLimited(ip: string, now: number): boolean {
  const recent = (requestLog.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length === 0) requestLog.delete(ip);
  else requestLog.set(ip, recent);
  if (recent.length >= RATE_MAX_REQUESTS) return true;
  recent.push(now);
  requestLog.set(ip, recent);
  return false;
}

/** Body arrives as a Buffer from the server-wide catch-all parser. */
function readJsonBody(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    return body as Record<string, unknown>;
  }
  let text: string;
  if (Buffer.isBuffer(body)) text = body.toString('utf8');
  else if (typeof body === 'string') text = body;
  else return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header) : null;
  return match ? match[1] : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** No admin token configured → the routes behave as if they did not exist. */
function adminDenied(req: FastifyRequest): boolean {
  if (!ADMIN_TOKEN) return true;
  const token = bearerToken(req);
  return !token || !constantTimeEqual(token, ADMIN_TOKEN);
}

function inviteBaseUrl(req: FastifyRequest): string {
  const base = PUBLIC_URL || `https://${req.headers.host ?? 'localhost'}`;
  return base.replace(/\/+$/, '');
}

async function getInvitePage(req: FastifyRequest, reply: FastifyReply) {
  const { token } = req.params as { token: string };
  if (rateLimited(req.ip, Date.now())) {
    return reply.code(429).type(HTML_TYPE).send(page('Too many requests', '<h1>Too many requests</h1><p>Try again later.</p>'));
  }
  if (registrationMode() === 'closed') {
    return reply.code(403).type(HTML_TYPE).send(page('Registration closed', '<h1>Registration is closed.</h1>'));
  }
  const invite = await findInviteByToken(token);
  if (!invite || !isInviteUsable(invite)) {
    return reply.code(410).type(HTML_TYPE).send(page('Invite invalid', '<h1>This invite link is no longer valid.</h1>'));
  }
  return reply.type(HTML_TYPE).send(page('Enter Link Password', INVITE_FORM));
}

async function postInvite(req: FastifyRequest, reply: FastifyReply) {
  const { token } = req.params as { token: string };
  if (rateLimited(req.ip, Date.now())) {
    return reply.code(429).send({ error: 'Too many requests. Try again later.' });
  }
  if (registrationMode() === 'closed') {
    return reply.code(403).send({ error: 'Registration is closed.' });
  }
  const body = readJsonBody(req.body);
  const password = body?.password;
  if (!isValidLinkPassword(password)) {
    return reply.code(400).send({ error: message('invalidPassword') });
  }

  // Hash outside the transaction: scrypt is CPU-bound and holds no DB locks.
  const passwordHash = hashPassword(password);
  const now = new Date();
  const identity = await db.transaction(async (tx) => {
    const invite = await findInviteByToken(token, tx);
    if (!invite || !isInviteUsable(invite, now)) return null;
    if (!(await consumeInvite(invite.id, now, tx))) return null;
    const created = await createAccountWithPlayer(tx, null);
    await upsertPassword(created.accountId, passwordHash, tx);
    return created;
  });
  if (!identity) {
    return reply.code(410).send({ error: 'This invite link is no longer valid.' });
  }

  await seedSandboxIfNeeded(identity.serverUserId);
  req.log.info({ publicUserId: identity.publicUserId }, 'invite account created');
  return { publicUserId: identity.publicUserId };
}

export function registerInviteRoutes(app: FastifyInstance): void {
  app.get('/invite/:token', getInvitePage);
  app.post('/invite/:token', postInvite);

  app.post('/sumire/admin/invites', async (req, reply) => {
    if (adminDenied(req)) return reply.code(404).send({ error: 'not found' });
    const body = readJsonBody(req.body) ?? {};
    const uses = body.uses === undefined ? 1 : body.uses;
    if (typeof uses !== 'number' || !Number.isInteger(uses) || uses < 1 || uses > 1000) {
      return reply.code(400).send({ error: 'uses must be a positive integer' });
    }
    const days = body.expiresDays;
    if (days !== undefined && (typeof days !== 'number' || !Number.isFinite(days) || days <= 0 || days > 3650)) {
      return reply.code(400).send({ error: 'expiresDays must be between 0 and 3650' });
    }
    const note = typeof body.note === 'string' ? body.note : null;
    const expiresAt = days === undefined ? null : new Date(Date.now() + days * 86_400_000);
    const { invite, token } = await createInvite({ maxUses: uses, expiresAt, note });
    req.log.info({ id: invite.id, uses: invite.maxUses }, 'invite created');
    return { id: invite.id, url: `${inviteBaseUrl(req)}/invite/${token}` };
  });

  app.get('/sumire/admin/invites', async (req, reply) => {
    if (adminDenied(req)) return reply.code(404).send({ error: 'not found' });
    const rows = await listInvites();
    return rows.map((row) => ({
      id: row.id,
      uses: row.uses,
      max_uses: row.maxUses,
      expires_at: row.expiresAt,
      revoked_at: row.revokedAt,
      created_at: row.createdAt,
      note: row.note,
    }));
  });

  app.post('/sumire/admin/invites/:id/revoke', async (req, reply) => {
    if (adminDenied(req)) return reply.code(404).send({ error: 'not found' });
    const { id } = req.params as { id: string };
    if (!/^\d+$/.test(id)) return reply.code(400).send({ error: 'id must be a number' });
    const revoked = await revokeInvite(Number(id));
    if (!revoked) return reply.code(404).send({ error: 'invite not found' });
    req.log.info({ id: Number(id) }, 'invite revoked');
    return { id: Number(id), revoked: true };
  });

  app.post('/sumire/admin/accounts/:publicUserId/reset-password', async (req, reply) => {
    if (adminDenied(req)) return reply.code(404).send({ error: 'not found' });
    const { publicUserId } = req.params as { publicUserId: string };
    const seedId = publicUserId.trim().toUpperCase();
    const [acct] = await db.select().from(accounts).where(eq(accounts.seedId, seedId)).limit(1);
    if (!acct) return reply.code(404).send({ error: 'account not found' });
    const password = generateLinkPassword(12);
    await upsertPassword(acct.id, hashPassword(password));
    // Only the public id is logged; the password appears once in the response.
    req.log.warn({ publicUserId: acct.seedId }, 'admin reset link password');
    return { publicUserId: acct.seedId ?? seedId, password };
  });
}
