import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

/**
 * True when the module at `metaUrl` is the script Node was asked to run.
 *
 * The naive `import.meta.url === `file://${process.argv[1]}`` check breaks on
 * paths with spaces (the URL is percent-encoded), on Windows (drive-letter
 * case and backslashes) and when the script is reached through a symlink
 * (Node resolves the module to its real path). Compare file URLs instead and,
 * on POSIX, try the realpath of both sides so a symlinked checkout starts.
 */
export function isMainModule(
  metaUrl: string,
  argv1: string | undefined,
  opts: { windows?: boolean } = {},
): boolean {
  if (argv1 === undefined) return false;

  const windows = opts.windows ?? process.platform === 'win32';
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const toHref = (path: string) => pathToFileURL(path, { windows }).href;

  // Only resolve symlinks when the platform actually supports the semantics we
  // expect; a simulated win32 run (opts.windows on POSIX) must stay pure.
  const canRealpath = !windows || process.platform === 'win32';

  const argvHrefs = [toHref(argv1)];
  if (canRealpath) {
    try {
      argvHrefs.push(toHref(realpathSync(argv1)));
    } catch {
      // Missing file: keep the raw path comparison.
    }
  }

  const metaHrefs = [metaUrl];
  if (canRealpath) {
    try {
      metaHrefs.push(toHref(realpathSync(fileURLToPath(metaUrl))));
    } catch {
      // Not a file URL or missing: keep the raw URL comparison.
    }
  }

  return argvHrefs.some((argvHref) => metaHrefs.some((metaHref) => same(argvHref, metaHref)));
}
