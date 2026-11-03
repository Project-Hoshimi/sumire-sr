# Custom Outfit Modding — Sumire idol-02 (texture-first)

> **Status:** PLAN — not yet implemented. Targets a future session once a custom asset CDN layer exists. Outcome of the 2026-10-08 feasibility discussion (Interpretation B: modded/custom outfits overriding an existing outfit slot, rendered in 3D live). Depends on: asset CDN, octo AES key, bundle authoring tooling.

## Goal

Allow players to opt into a **modded look for `cos-smr-idol-02` (フィーリングハート)**, Sumire's default idol outfit, visible in **3D live playback**. Scope: re-texture first, fully custom models later. Delivered as a **per-player toggle** (stock vs modded).

## Target outfit (master facts)

From `phaseA2/out/structured/Costume.json`:

| Field | Value |
|---|---|
| `Id` | `cos-smr-idol-02` |
| `BodyAssetId` | `smr-idol-02` |
| `SdAssetId` | `smr-idol-02` |
| `MotifAssetId` | `idol-02` |
| `DefaultHairId` | `hair-smr-idol-02` |
| `CharacterId` | `char-smr` |
| `CostumeTypeId` | `idol` |
| `Name` | フィーリングハート |
| `Order` | 1 (default idol outfit) |

Client resolves 3D body + chibi via `AssetNames.Costume.GetBody(costumeBodyAssetId)` / `GetThumb(costumeSdAssetId)` (dump.cs L775358-775367) → octo asset-bundle names. Assets are fetched through our gateway's `proxyHandler` (`fastify-api/src/server.ts:221`, `app.all('/v2/*', proxyHandler)` → upstream `130.211.5.37` SNI `api.octo-cloud.com`, rejectUnauthorized:false) — **this is the interception point**.

## Pipeline today

1. `Costume:SetLiveCostume` → `UserCharacter.LiveCostumeId` (server already permissive; validates master existence + character ownership only, not costume ownership — src/services/costume.ts:126).
2. 3D live: `LiveAssetListUtility` (TypeDefIndex 664) enumerates assets via `ListCostumeAssets(ActorCostume,isFullSkip)` / `ListActorCostume3DAssets(ActorCostume)` / `ListCardAssets` / `ListMusicAssets` / `ListStageAssets` (iterator state machines RVAs 0x589F078 / 0x589EF50).
3. Client downloads octo asset bundles (AES-encrypted) via `OctoAPI` (`GetList`/`GetListAes`/`DownloadAssetBundle`/`DownloadAndLoadAssetBundle`), cached under `files/octo/v1/212/`.

## Phase 0 — Discovery (prerequisite; gates everything)

No octo `/v2` URL or bundle path was ever captured. Required findings:

1. **Asset-name derivation:** frida hook `AssetNames.Costume.GetBody`/`GetThumb` + `OctoAPI.CreateUrl` + `OctoBaseLoader.GetItemByName` while a 3D live loads → exact derived name (`ab_*`/`bd_*`?) and final URL for `smr-idol-02`.
2. **Real `/v2/*` traffic:** add a request/response logger to `proxyHandler`; capture the octo list (`/v2/pub/a/212/v/205051/list/0`, 5.7 MB) + bundle GETs.
3. **Decrypt the octo list:** extract octo AES key via frida on `AesApiListFormat`/`DecryptAes` or binary search (FastAES.dll). Find the `smr-idol-02` row → `urlFormat`, bucket, `filepath`, `uploadVersionId`, `md5`, `crc`, `size`.
4. **Decision point — hash verification:** octo list rows carry `md5`/`crc`/`size`; loader has `expectedHash`. If client verifies bundles against the list, a naive byte-swap fails → must also rewrite + re-encrypt that one octo list row so hash/size match the modded bytes. Determines: pure proxy byte-swap vs patched-list flow.

## Phase 1 — Bundle authoring tooling

- Unity **2022.3.57f1** (from base.apk). AssetBundle extract/edit (AssetStudio-class tooling) on the real `smr-idol-02` body bundle → re-texture PBR/albedo materials → rebuild.
- Octo AES encrypt/decrypt CLI to wrap/unwrap bundles in the app's expected format (note `IsLastUsedUnity2020OctoVersion` static, dump.cs L399893/400017 — Unity 2022 path differs from the 2020 path).
- Keep a stock copy for the toggle.

## Phase 2 — Server interception (per-player toggle)

- Config + DB: `moddedOutfit` per-player flag, default off.
- In `proxyHandler`: when the path matches `smr-idol-02` asset names (body `smr-idol-02*`, hair `hair-smr-idol-02*`) **and** the requesting player has the flag → serve local modded bytes; else proxy upstream.
- **Open:** `/v2/*` asset requests are not player-authenticated — toggle may need to key off octo revision/device cache, a query param, or our request context. Resolve in Phase 0 once real request headers are seen.
- If hash-verification is real, extend to serve a patched octo list row.

## Phase 3 — Client-visible selection + E2E

- Per-player toggle via a lightweight endpoint (or frida flag for E2E).
- On-device: equip idol-02 → 3D live → modded textures render; toggle off → stock returns (cache cleared).

## Phase 4 — Docs + tests

- dbtest for the toggle persistence.
- Update `PLANS.md`.

## Key risks

1. Octo AES key extraction and bundle rebuild fidelity (largest risk).
2. Per-player gating with unauthenticated asset requests (may fall back to device/toggle hybrid).
3. Pre-rendered MV (`PhotographyLiveMvPresenter`) is a video — mod shows only in 3D live (in scope).

## Related references

- Server proxy: `fastify-api/src/server.ts` (`proxyHandler` L21, routes L221-223), `src/config.ts` (apiHost `api.octo-cloud.com`).
- Costume equip: `fastify-api/src/services/costume.ts` (`SetCostume`/`SetLiveCostume`/`CheckCostume`/`CheckBulk`, Hair:CheckHair).
- Master: `phaseA2/out/structured/{Costume,CostumeType,CharacterCostumeGroup,ExerciseCostume,Music,AdvLiveMovie,Stage,Character,Hair}.json`.
- dump.cs: OctoAPI/OctoBaseLoader/OctoManager/OctoAssetBundleLoader L1620xxx, LiveAssetListUtility L27427-28165, AssetNames.Costume L775358, Hair L16656, Music L16736, IsLastUsedUnity2020OctoVersion L399893/400017.
- Frida: `frida/e2e_hooks.js` already maps `api.octo-cloud.com` → 127.0.0.1 (L249-251) + installs server CA for rustls/YAHA (L502).
- No octo `/v2` URLs or bundle paths in `~/privateserver/captures/` — capture is a required discovery step.
