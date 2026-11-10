/**
 * Contracts for the asset-mirror stages that are NOT implemented yet
 * (docs/ASSET_MIRROR.md §4 steps 1–2). Types only: nothing here fetches,
 * decrypts, deobfuscates or extracts. The serving side lives in `assetMirror.ts`.
 *
 * Guardrails every implementation must keep (docs/ASSET_MIRROR.md §5):
 * - Sync is an explicit, operator-run command; never started by the server.
 * - Downloads require a non-empty prefix allowlist and a byte budget, and a
 *   dry run that reports the planned total must precede any real fetch.
 * - Octo decrypt material comes from the environment, never from source.
 * - The raw encrypted manifest and raw bundles are never persisted: decrypt and
 *   extract in memory/temp, write only final artifacts (tmp + rename), delete temp.
 * - Output paths must pass `parseAssetPath()` so the mirror can serve them.
 */

/** Octo `Data.State` (octodb.proto): ADD=0, UPDATE=1, LATEST=2, DELETE=3. */
export type OctoAssetState = 'ADD' | 'UPDATE' | 'LATEST' | 'DELETE';

/** Which list a row came from (`assetBundleList` vs `resourceList`), also the `{type}` URL segment. */
export type OctoAssetKind = 'assetbundle' | 'resources';

/** Manifest metadata worth persisting (no URLs with tokens, no raw blob). */
export type OctoManifestEntry = {
  kind: OctoAssetKind;
  name: string;
  objectName: string;
  /** Lower-case hex MD5 of the CDN file; the skip-if-unchanged key. */
  md5: string;
  size: number;
  /** uint64 on the wire; kept as a decimal string to avoid precision loss. */
  generation: string;
  uploadVersionId: number;
  state: OctoAssetState;
};

export type OctoManifestSnapshot = {
  revision: number;
  entries: OctoManifestEntry[];
};

/** Operator-supplied policy; an empty allowlist must plan nothing. */
export type AssetFetchPolicy = {
  allowPrefixes: readonly string[];
  maxTotalBytes: number;
  dryRun: boolean;
};

export type AssetFetchPlan = {
  revision: number;
  selected: OctoManifestEntry[];
  /** Already present with a matching md5 sidecar. */
  skippedUnchanged: number;
  totalBytes: number;
  /** True when `totalBytes > maxTotalBytes`; a real run must abort. */
  overBudget: boolean;
};

/** One final artifact produced from a bundle, addressed by mirror-relative path. */
export type ExtractedArtifact = {
  /** Must satisfy `parseAssetPath()`. */
  relativePath: string;
  data: Uint8Array;
};

/**
 * Turns one deobfuscated UnityFS bundle into final artifacts. Implementations
 * will need a Unity asset reader (LZ4/LZMA block decompression, SerializedFile
 * type trees, Texture2D decoding, AudioClip/FSB5 → opus); none exists in this
 * workspace's dependencies, so no extractor is provided yet.
 */
export interface AssetExtractor {
  readonly id: string;
  canExtract(entry: OctoManifestEntry): boolean;
  extract(entry: OctoManifestEntry, bundle: Uint8Array): Promise<ExtractedArtifact[]>;
}
