// Load .env for any way of starting the server. `npm run -w packages/server ...`
// runs from the package directory, but the public repo keeps .env at its root
// because docker compose reads it there. Variables already set always win.
import { parse } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// Relative paths in .env mean "relative to the .env file", wherever we started.
const PATH_VARS = new Set(['SUMIRE_DATA_DIR', 'JWT_PRIVATE_KEY_PATH']);

/**
 * The .env in `start`, else in the nearest ancestor that is a project (has a
 * package.json), stopping at the checkout root so ~/.env is never picked up.
 */
export function findEnvFile(start: string): string | null {
  let dir = resolve(start);
  const here = join(dir, '.env');
  if (existsSync(here)) return here;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
    const candidate = join(dir, '.env');
    if (existsSync(candidate) && existsSync(join(dir, 'package.json'))) return candidate;
  }
}

export function loadEnv(start: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  const file = findEnvFile(start);
  if (!file) return;
  for (const [key, value] of Object.entries(parse(readFileSync(file)))) {
    if (env[key] !== undefined) continue;
    env[key] = PATH_VARS.has(key) && !isAbsolute(value) ? resolve(dirname(file), value) : value;
  }
}

loadEnv();
