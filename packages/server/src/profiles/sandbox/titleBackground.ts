/**
 * Sandbox title-screen variants.
 *
 * `build_title_variants.py` writes one single-row `TitleBackground` master DB per
 * anniversary asset (23-0624, 24-0624, 25-0624, 26-0624) to
 * `phaseA2/blobs_title/<sha256>`. `Master:Get` advertises one of them, with a
 * manifest version derived from that file, and the sandbox serves the matching
 * blob for `/master/TitleBackground/<file>`.
 *
 * When the synced title differs from the one on screen, the client reloads the
 * title scene and logs in again, so the served title must not change on its
 * own. The player steps it with the title menu's "FAQ" button, whose
 * `Master:GetHelpCategory` call advances the rotation. The client checks the
 * title before it reloads the master it just downloaded, so the new title
 * shows two logins later.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../config.ts';

export type TitleVariant = {
  assetId: string;
  id: string;
  fileName: string;
  fileSize: number;
};

export const TITLE_VARIANTS_DIR = path.join(DATA_DIR, 'phaseA2', 'blobs_title');
const TITLE_VARIANTS_JSON = path.join(DATA_DIR, 'phaseA2', 'out', 'title_variants.json');

let cached: TitleVariant[] | null = null;

/** Read the generated variant index once; missing file means no variants. */
export function loadTitleVariants(): TitleVariant[] {
  if (cached) return cached;
  cached = existsSync(TITLE_VARIANTS_JSON)
    ? (JSON.parse(readFileSync(TITLE_VARIANTS_JSON, 'utf8')) as TitleVariant[])
    : [];
  return cached;
}

/**
 * The title the stock master shows (the active anniversary row), i.e. what a
 * client that has not been served a variant yet already has cached.
 */
export const STOCK_TITLE_ASSET_ID = '26-0624';

export type TitleRotation = {
  /** Title to serve on `Master:Get`; starts on the stock title. */
  current(variants: TitleVariant[]): TitleVariant | null;
  /** Step to the next title (in list order, wrapping) and return it. */
  next(variants: TitleVariant[]): TitleVariant | null;
};

export function createTitleRotation(): TitleRotation {
  let currentFile: string | undefined;
  const indexOf = (variants: TitleVariant[]) => {
    currentFile ??= variants.find((v) => v.assetId === STOCK_TITLE_ASSET_ID)?.fileName;
    return Math.max(0, variants.findIndex((v) => v.fileName === currentFile));
  };
  const at = (variants: TitleVariant[], index: number) => {
    const variant = variants[index % variants.length] ?? null;
    currentFile = variant?.fileName;
    return variant;
  };
  return {
    current: (variants) => at(variants, indexOf(variants)),
    next: (variants) => at(variants, indexOf(variants) + 1),
  };
}

/** Sandbox-wide rotation (single player). */
export const titleRotation = createTitleRotation();

/** Derive a master version that changes whenever the title variant changes. */
export function titleMasterVersion(baseVersion: string, variant: TitleVariant): string {
  return createHash('sha256').update(`${baseVersion}:${variant.fileName}`).digest('hex');
}

/** Local blob path for a title variant, or `null` for the regular master path. */
export function titleVariantBlobPath(
  type: string,
  file: string,
  variants: TitleVariant[] = loadTitleVariants(),
): string | null {
  if (type !== 'TitleBackground') return null;
  if (!variants.some((variant) => variant.fileName === file)) return null;
  return path.join(TITLE_VARIANTS_DIR, file);
}
