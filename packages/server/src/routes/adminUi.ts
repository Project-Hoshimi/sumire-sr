/**
 * Static hosting for the built admin console.
 *
 * The console is a separate Vite project under `<repo>/admin`; this plugin
 * serves its build output under `/sumire/admin/`. Nothing here touches the
 * admin JSON API under `/sumire/admin/...`, so those routes are never shadowed.
 *
 * A missing build is not fatal: the server boots, logs one info line, and
 * `/sumire/admin/` answers 404 with a build hint until `npm run build` runs in
 * `packages/admin/`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

export const ADMIN_UI_CSP =
  "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
export const ADMIN_UI_MISSING_TEXT = 'admin UI not built: run npm run build in packages/admin/';

/** `<repo>/packages/admin/dist`, resolved from this file (`packages/server/src/routes`). */
export const DEFAULT_ADMIN_UI_DIR = resolve(import.meta.dirname, '../../../admin/dist');

export interface AdminUiOptions {
  /** Build output directory; defaults to `SUMIRE_ADMIN_UI_DIR` or `<repo>/packages/admin/dist`. */
  dir?: string;
}

function setCommonHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header('Content-Security-Policy', ADMIN_UI_CSP)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Referrer-Policy', 'no-referrer');
}

export const adminUiRoutes: FastifyPluginAsync<AdminUiOptions> = async (app, opts) => {
  const uiDir = opts.dir ?? process.env.SUMIRE_ADMIN_UI_DIR ?? DEFAULT_ADMIN_UI_DIR;
  const indexPath = resolve(uiDir, 'index.html');
  const assetsDir = resolve(uiDir, 'assets');

  // Index contents are cached until the file's mtime changes, so a rebuild is
  // picked up without a restart and normal requests do not re-read the file.
  let indexCache: { html: string; mtimeMs: number } | null = null;
  const readIndex = (): string | null => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(indexPath).mtimeMs;
    } catch {
      indexCache = null;
      return null;
    }
    if (indexCache !== null && indexCache.mtimeMs === mtimeMs) return indexCache.html;
    try {
      const html = readFileSync(indexPath, 'utf8');
      indexCache = { html, mtimeMs };
      return html;
    } catch {
      indexCache = null;
      return null;
    }
  };

  if (!existsSync(indexPath)) {
    app.log.info(
      { uiDir, indexPath },
      'admin UI not built: GET /sumire/admin/ returns 404 until `npm run build` runs in packages/admin/',
    );
  }

  // Assets are served by @fastify/static, which only sets headers on successful
  // responses; apply the security headers to every asset-scope reply including
  // its 404s.
  app.addHook('onSend', (req, reply, payload, done) => {
    if (req.url.startsWith('/sumire/admin/assets/')) setCommonHeaders(reply);
    done(null, payload);
  });

  // Only `dist/assets` is exposed, and only by exact file name (no listing, no
  // directories). `@fastify/static`/`send` rejects `..` traversal outside root.
  await app.register(fastifyStatic, {
    root: assetsDir,
    prefix: '/sumire/admin/assets/',
    index: false,
    list: false,
    // Vite hashes asset names, so a year-long immutable cache is safe.
    maxAge: '1y',
    immutable: true,
    setHeaders(res) {
      res.header('Content-Security-Policy', ADMIN_UI_CSP);
      res.header('X-Content-Type-Options', 'nosniff');
      res.header('Referrer-Policy', 'no-referrer');
    },
  });

  app.get('/sumire/admin', (_req, reply) => reply.redirect('/sumire/admin/', 302));

  app.get('/sumire/admin/', (_req, reply) => {
    const html = readIndex();
    if (html === null) {
      return setCommonHeaders(reply)
        .header('Cache-Control', 'no-store')
        .type('text/plain; charset=utf-8')
        .code(404)
        .send(ADMIN_UI_MISSING_TEXT);
    }
    return setCommonHeaders(reply)
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(html);
  });
};
