# ASSET_MIRROR — official asset CDN mirror pipeline (design / RECON)

> Status: 🟡 partial. The serving slice (step 4's local route) is implemented; manifest sync and extraction are not. See §0.
>
> Original status: ⏳ planned (design only). Saved 2026-10-08 per user request ("write these changes to the doc and add a short reference to it in the main project plan doc"). Main project plan: `docs/PLANS.md`. Scope: PLANS.md M2+ Static Asset/CDN track ("Mirrors official CDN URL structure" + "Serves mined assets (audio/textures…)").

## 0. Implementation status

### What exists today (verified in code)

| Piece | Where | What it does |
|---|---|---|
| `/v2/*` | `packages/server/src/server.ts` (`proxyHandler`) | Live pass-through proxy to the upstream Octo API (`api.octo-cloud.com`). It buffers each response and relays it unchanged: no cache, no decrypt, nothing on disk. It is **not** a mirror, and the asset mirror does not touch it. |
| Firebase Storage | `packages/server/src/firebaseStorage.ts` | Photo image upload (resumable `POST /v0/b/<bucket>/o`) and download (`GET …/o/<name>?alt=media&token=…`) for the `udc-idolypride` and `event-idolypride` buckets, stored under `RESOURCE_DIR/Photo/…`. Separate from the asset mirror. |
| **Asset mirror serving** | `packages/server/src/assetMirror.ts` | `GET`/`HEAD /assets/<relative path>` streams already-extracted final artifacts from `SUMIRE_ASSET_MIRROR_DIR`. |
| Sync/extract contracts | `packages/server/src/assetMirrorPipeline.ts` | Types only (`OctoManifestEntry`, `AssetFetchPolicy`, `AssetFetchPlan`, `AssetExtractor`). No implementation. |

### Serving slice behaviour

- **Opt-in.** The route is registered only when `SUMIRE_ASSET_MIRROR_DIR` is set. When it is unset, the route table is unchanged. The setting is profile-independent and changes no RPC behaviour. Keep the directory outside version control; `data/` is already git-ignored.
- **Layout.** The URL path is the path relative to the mirror root, e.g. `/assets/sud/vo/adv/<clip>.opus`. The exact `assetIdToPath` mapping is for the extractor to decide (§2.3); the server does not derive paths from asset ids.
- **Allowed types:** `.opus` (`audio/ogg; codecs=opus`), `.png`, `.atlas` (text), and `.json`. Any other extension is rejected with 400, including raw bundles and manifests.
- **Path safety.** The raw path is percent-decoded once and then validated segment by segment (`parseAssetPath`). Requests fail with 400 if they contain empty, `.` or `..` segments, dot files, `\`, `%` after decoding, NUL, or Windows device names. They also fail if they exceed the depth or length limits. The file is then resolved with `realpath` and must stay inside the root, so symlinks and junctions that point outside return 404. On POSIX the file is opened with `O_NOFOLLOW`.
- **Responses.** Files are streamed from an open file handle and never buffered. Responses carry `content-length` and a weak `ETag` (size + mtime), with `cache-control: no-cache` and `x-content-type-options: nosniff`. `If-None-Match` returns 304. A single `Range` request returns 206 and an unsatisfiable range returns 416. Multi-range requests get the full body, and a stale `If-Range` also gets the full body. A missing file returns 404 with a fixed body that does not include the path.
- **Not a game-client CDN.** The game client downloads UnityFS bundles from the URL in the Octo manifest's `urlFormat` (the official CloudFront host). This route serves *extracted* artifacts, so it cannot stand in for that host. Serving bundles to the client would follow the reference design instead: a local Octo database with a rewritten `urlFormat`, and bundles resolved by MD5. That is a different feature.
- **Tests.** `npm run -w packages/server test:assetmirror`, which is part of `npm run check`. The tests use only synthetic fixtures in a temp directory. They cover serving each type, HEAD, 304, ranges, missing files, invalid identifiers, raw `..`/`%2e%2e` targets over a loopback socket, junction escapes, and `/v2/*` plus the RPC catch-alls keeping their routes, both with the mirror enabled and disabled.

### Local Octo store (experimental, opt-in, removable)

`packages/server/src/octoStore.ts` serves the game client's bundles from local disk, for local testing with your own copy. It is separate from the final-artifact mirror above.

- **Enable** by setting `SUMIRE_OCTO_DATABASE` (a decrypted, bare `octodb.Database` protobuf) together with `SUMIRE_OCTO_ASSETS` (directories of MD5-named CDN files, flat or `<md5[0:2]>/<md5>`, separated by the platform path delimiter). `SUMIRE_OCTO_AES_KEY` and `SUMIRE_OCTO_AES_IV` are also required, as hex values from the environment; they are never in source. When `SUMIRE_OCTO_DATABASE` is unset nothing is registered and `/v2/*` proxies upstream as before.
- **Behaviour.** `GET /v2/pub/a/<app>/v/<ver>/list/<rev>` returns the local database with `urlFormat` rewritten to `SUMIRE_OCTO_URL_FORMAT` (default `https://api.octo-cloud.com/octo/{type}/{o}?v={v}&g={g}`, a host the client mod already redirects). It is re-encrypted as AES-256-CBC over 16 random bytes followed by the database. `GET`/`HEAD /octo/<assetbundle|resources>/<objectName>` streams the matching file unchanged. Only objects listed in the database are served, and only if the file on disk has the manifest size. Range requests are supported. Other methods and other `/v2/*` paths still go to the proxy.
- **Verified on device** (JP 6.1.0, x86_64 emulator): the client accepts the re-encrypted list with a random 16-byte prefix and the always-full list for `{rev}` 0 and 1078. It then downloaded 1,001 bundles (1,090 MiB) from the local route, all with status 200.
- **Remote stores.** A network share already works, because `SUMIRE_OCTO_ASSETS` takes plain (UNC or mounted) paths. Clients can also download from another host directly if `SUMIRE_OCTO_URL_FORMAT` points at a server that answers by objectName, such as another sumire-sr with this store enabled. *Not implemented:* fetching from a remote HTTP store that serves files by MD5 and passing them through to the client, with optional MD5-checked caching. That would need a `SUMIRE_OCTO_REMOTE` URL template in `OctoStore.open()`. A list-only node would also need the asset-directory requirement relaxed.
- **Remove** by deleting `octoStore.ts` and `octoStore.test.ts`, the two `octoStore` lines in `server.ts`, the `test:octostore` script, the `.env.example` block, and this subsection.
- **Tests:** `npm run -w packages/server test:octostore`. They use a synthetic database, synthetic files and a random key and IV.

### Raw MD5 bundles vs extracted artifacts

The two routes serve different things and are not interchangeable:

| | Octo store (`/octo/*`, implemented) | Extracted mirror (`/assets/*`, serving only) |
|---|---|---|
| Content | The unmodified CDN files: still obfuscated UnityFS bundles plus raw resources, named by the MD5 in the Octo database | Final artifacts: `.opus`, `.png`, `.atlas`, `.json` |
| Consumer | The game client. It deobfuscates and loads bundles itself. | Tools, web viewers and later milestones (e.g. M3 ADV audio). The game client cannot use these. |
| Lookup | `objectName` from the database → `md5` → `<dir>/<md5>` or `<dir>/<md5[0:2]>/<md5>` | Mirror-relative path (`parseAssetPath`) |
| Processing | None: byte-for-byte streaming | Done offline by an extractor; the server only streams the result |

An extracted solution would need these steps per asset, in a separate operator-run tool. The MD5 store can be its input, so nothing has to be downloaded again.
1. Map the asset `name` → `md5` via the decrypted database, and read the bundle from the MD5 store.
2. **Deobfuscate**: XOR the first 256 bytes with the name-derived mask (§2.2) unless the file already starts with `UnityFS`. The algorithm must first be pinned down with a verified test vector.
3. **Parse UnityFS**: the block directory, LZ4/LZMA decompression, and SerializedFile type trees for Unity 2022.3.21f1.
4. **Convert per type**: Texture2D (ASTC/ETC) → PNG, AudioClip (FSB5) → Opus via ffmpeg, spine `.atlas`/`.skl` → text/JSON (§2.3). `resources` entries are already raw and need no conversion.
5. **Write** to the mirror under the `assetIdToPath` layout. Every output path must pass `parseAssetPath()`; writes go through tmp + rename, with an MD5 sidecar for skip-if-unchanged, and nothing intermediate is kept.

Steps 3 and 4 are the tooling blocker described below. Nothing in this repo implements steps 1–5 yet; `AssetExtractor` in `assetMirrorPipeline.ts` is the seam where they would plug in.

### What remains, and blockers

1. **Manifest sync (`feat/octo-asset-sync`).** Feasible with the existing runtime: `fetch`, `node:crypto` AES-256-CBC, `node:zlib`, and the protocol package's protobuf `Reader`. Prerequisites:
   - Add an `octodb.Database` / `Data` schema descriptor. It is not in `packages/protocol/schemas/` today.
   - Read the decrypt key, IV and request headers from the environment, following the `WIRE_SEC_KEY` convention, not from source.
   - Persist only `OctoManifestEntry` metadata.
   - Ship it as an operator-run script with an explicit prefix allowlist, a byte budget and a mandatory dry-run report. The server never starts it.
2. **Fetch + deobfuscation (`feat/asset-mirror-fetch`).** The XOR mask in §2.2 is described only informally. Implement it only against a verified reference test vector; none is in this repo, and tests may not use real assets.
3. **Unity extraction.** Blocked on tooling. Extraction needs UnityFS block decompression (LZ4 and LZMA; LZMA is not in `node:zlib`), SerializedFile type-tree parsing, Texture2D decoding (ASTC/ETC), and AudioClip FSB5 → Opus transcoding (ffmpeg). None of these are in the workspace's dependencies, and adding a Python or native toolchain needs its own review. `AssetExtractor` is the seam where such a tool would plug in.

## 1. Where the official asset pipeline lives (upstream sources)

The info-pride ecosystem spans 3 repos; this doc captures what matters for privateserver:



| Repo | Role | What privateserver reuses |
|---|---|---|
| `github.com/vilebbit/IDOLY-Backend` (local `~/IDOLY-Backend`) | info-pride data backend (`idoly-backend.outv.im`: Express 5 + MongoDB). Octo asset manifest is stored as `Octo_assetBundleList` / `Octo_resourceList` collections (split from the `Octo` KV key by `manage/write`; served via `GET /manage/raw?key=Octo_assetBundleList`). | Manage/write split-store + ETag/cache wrapper patterns (we already have better equivalents — reference only. |
| `github.com/vilebbit/idoly-assets-curator` (local `~/idoly-assets-curator`) | Asset retrieval/storage for `idoly-assets.outv.im` (Backblaze B2 S3): downloads bundles from the official CDN, deobfuscates, extracts AudioClip→`.opus` + Texture2D→PNG + spine `.atlas`/`.skl`→text/JSON, md5-delta sync via `assets/{sud,spi}/meta.json`. | Extraction recipes + incremental md5 skip pattern. |
| `github.com/vilebbit/SolisClient` (submodule `solis/` of IDOLY-Backend) | **The official-server client** (Python gRPC): firebase auth → login scenarios → `Master.Get` → master blobs; **Octo manifest fetch+AES decrypt** → full asset manifest → download + deobfuscate + UnityPy extract (+ ESRGAN upscale). | **The treasure trove** — octo endpoint + decrypt keys + `crypt_by_string` deobfuscation + asset URL scheme (all verified below). |

## 2. Verified facts (live 2026-10-08)

### 2.1 Octo asset manifest (public, no auth)
- Endpoint: `GET https://api.octo-cloud.com/v2/pub/a/212/v/205051/list/{rev}` — `{rev}=0` full list; `{rev}=<prev>` returns diff since revision. **Public** (no auth; app-level headers only). Response = AES-CBC-encrypted protobuf (`content-type: application/x-protobuf`). Server revision comes from `ETag` (`"3.212.205051.0.1071"` → **rev 1071**).
- Headers (from `SolisClient/client_config.json` "octo"): `User-Agent: UnityPlayer/2022.3.21f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)`, `Accept: application/x-protobuf,x-octo-app/212`, `X-OCTO-KEY: <OCTO_KEY from client_config.json>`, `X-Unity-Version: 2022.3.21f1`. (App-public constants in the public SolisClient repo — not secrets.)
- **Decrypt** (`octo_manager.py`): AES-256-CBC (the 32-byte key rules out AES-128; verified 2026-11-01), key `aa8a30926db9d49410360d0a99aa735d035638dfc09ef99fb575d9c91a8f6cdc` (hex 32 B), IV `9ce1286f5481bb3d92eb8529bc35962c` (hex 16 B), PKCS7 unpad → skip first 16 bytes → protobuf `octodb.Database`.
- **Schema** (`octodb.proto`): `Database { int32 revision=1; repeated Data assetBundleList=2; repeated string tagname=3; repeated Data resourceList=4; string urlFormat=5; }`; `Data { int32 id=1; string filepath=2; string name=3; int32 size=4; uint32 crc=5; int32 priority=6; repeated int32 tagid=7; repeated int32 dependencie=8; enum State{ADD,UPDATE,LATEST,DELETE} state=9; string md5=10; string objectName=11; uint64 generation=12; int32 uploadVersionId=13; }`.
- Verified live: **49,185 asset bundles + 5,049 resources**, revision **1071**;
  `urlFormat = https://d2ilil7yh5oi1v.cloudfront.net/solis-{v}-{type}/{o}?generation={g}&alt=media` (**CloudFront CDN**; `{v}=uploadVersionId`, `{type}∈assetbundle|resources`, `{o}=objectName`, `{g}=generation`).
  Sample rows: `sud_vo_adv_hbd_02_skr005` (uploadVersionId 202050), `img_gacha_appeal_pickup-21-0910`, `spi_sd_chr_cos_ngs-akma-00.atlas` — all `state=2` (LATEST).

### 2.2 Asset download + deobfuscation (verified end-to-end)
- URL: `<urlFormat>` above (type `assetbundle` for bundles; `resources` = raw, NOT obfuscated, no extraction). File sizes byte-match the manifest `Data.size` field.
- **Deobfuscation** (`deobfuscate.py` / `octo_manager.crypt_by_string`): only if blob `[0:5] != b'Unity'` — XOR the **first 256 bytes** with a mask derived from the asset `name` (see `string_to_mask_bytes`: name chars placed at even offsets + bitwise-complemented at odd offsets, then ROR-1-0x9B-LFSR pass over the mask, XOR into the header). Verified: `sud_vo_adv_hbd_02_skr005` (40,711 B byte-exact vs manifest) → deobfuscated head `UnityFS\x00` ✔.
- Unity version for extraction: **2022.3.21f1** (`UnityPy.config.FALLBACK_UNITY_VERSION`).

### . 2.3 Extraction recipes (from idoly-assets-curator)
| Bundle prefix | Content | Recipe | Output path (relative `assets/` |
|---|---|---|---|---|
| `sud_*` | voice/story/BGM audio (`AudioClip`) | ffmpeg wav→`.opus` | `id_to_path_segs(clip_name)` = split by `_`; <3 segs → `['_', id]` else 3 segs → `.opus` (matches info-pride `utils/paths.ts` `assetIdToPath`. |
| `spi_*` | spine textures/sprites | Texture2D→PNG; `.atlas`→text; `.skl`→JSON | `spi/<a>/<b>/<c>/<d>/<fullname>.png|.atlas|.json` (first 4 segs + full name; matches `spiAssetIdToBasePath`. |
| `img_*` | card/UI/story images (`Texture2D`) | PNG extract (+ optional ESRGAN upscale in SolisClient) | — (idoly-ac image API is a separate service; we self-serve PNGs.) |

## 3. Reuse map → privateserver (PLANS.md M1/M2+/M3)
- **Missing piece found**: octo manifest + URL scheme + deobfuscation = the "Mirrors official CDN URL structure" capability (PLANS.md M2+ track). Now fully understood + verified.
- **M3 (ADV `love_2505_*` + story scenario/voice)**: `sud_vo_adv_*` / `sud_*` bundles ARE the voice/story audio — extract `.opus`, serve by `assetIdToPath`. Exact `love_2505_*` scenario-bundle names to enumerate via a dry-run prefix scan at implementation (no big download).
- **M1/M2 (home/banner visuals)**: `spi_*` (spine) + `img_*` (textures) — extract PNG/text, serve via CDN route. 
- **Incremental sync**: track octo `revision` + per-asset `md5`; skip unchanged (`state ∈ {ADD,UPDATE,LATEST}`; diff fetch via `/list/{prev_rev}`; curator's `meta.json` md5 map pattern). 
- **gRPC client reference** (`SolisClient`): full official login + `Master.Get` + octo flow — a compact cross-check for our A1/A2/A4 reimplementation (no new work needed; reference only).

## 4. Proposed architecture (design only — future session)
1. **Sync worker** (TS, in privateserver stack; standalone script or fastify-api module): fetch `/list/{rev}` → decrypt **in-stream** (never persist raw octo blob) → persist only manifest metadata (`{name, md5, objectName, generation, uploadVersionId, size, state}`) as compressed JSON (`json.gz`) or sqlite. 
2.. **Fetch policy** (disk-conscious): allowlist by prefix (`love_2505_*`, `sud_vo_adv_*`, `spi_*`, `img_*`…), `state ∈ {ADD,UPDATE,LATEST}`; download via CloudFront URL → deobfuscate in-memory → verify `UnityFS` → extract final artifact → **delete temp immediately**; atomic write (tmp+rename); skip if on-disk md5 matches (sidecar `.md5` or manifest).
3. **Serving**: extracted finals in a static dir **mirroring the official URL structure** (`assets/<assetIdToPath>…`) per PLANS.md; served via existing Fastify static/CDN layer or Nginx (no new heavy infra).
4. **Milestone sizing**: M3 subset first (targeted ADV/story/voice — modest size); M2+ full categories later with explicit budgets. Do **not** mirror all 49k bundles / 5k resources blind.

##  ̈5. Disk-space guardrails (hard rules
- **Never persist** the raw octo blob (~5.8 MB) or raw encrypted bundles (temp-only; extract→delete).
- **Extract-only storage**: keep final artifacts only (`.opus`/`.png`/`.atlas`/`.json`); no UnityFS/raw retained.

- **Skip-if-unchanged** (md5 sidecar) + diff-revision fetch (deltas ≪ full).
- **Prefix allowlist + per-milestone size budgets** + dry-run mode reporting planned GiB **before** any download + abort thresholds.
 `du` tracking of the mirror dir.
.
 
- **Cleanup at kickoff**: remove `/tmp` probe artifacts from this investigation (`/tmp/octo_probe.bin` ~5.8 MB, `/tmp/asset1.bin` ~40 KB).

##  ̈6. Open questions (deferred)
- `resources` type (5,049) content: unknown, un-obfuscated — inspect one sample later (cheap).
- `idoly-ac.outv.im` image API (`img_*` serving, ESRGAN etc)) is a separate outv.im service — out of scope; we self-serve extracted PNGs.

- Exact `love_2505_*` / ADV scenario bundle names (enumerate via a **dry-run prefix scan** of the manifest metadata — no big download needed).
- Whether voice extraction should transcode to `.opus` (client-native, per info-pride) vs serve raw AudioClip.

##  Implementation steps (future session; each on its own branch)
1. `feat/asset-mirror-doc` — this doc + PLANS.md reference (done when committed).
2. `feat/octo-asset-sync` — manifest fetch+decrypt+metadata store + dry-run scanner (no downloads).
3. `feat/asset-mirror-fetch` — allowlisted download+deobfuscate+extract worker (M3 subset first. 
4. `feat/asset-mirror-serve` — static CDN route (mirror URL structure) + client device verify (ADV playback at M3.