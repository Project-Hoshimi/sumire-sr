# ASSET_MIRROR — official asset CDN mirror pipeline (design / RECON)

> Status: ⏳ planned (design only — no implementation yet). Saved 2026-10-08 per user request ("write these changes to the doc and add a short reference to it in the main project plan doc"). Main project plan: `docs/PLANS.md`. Scope: PLANS.md M2+ Static Asset/CDN track ("Mirrors official CDN URL structure" + "Serves mined assets (audio/textures…)").

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