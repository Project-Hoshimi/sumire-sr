# solis-server: positioning, interop harness, and what to keep

Status: plan (2026-10-25). Not started. Facts below were read from `solis-server` @ `9b67c06` and
`HoshimiLocalify-sr` @ `420aa2a`.

## 1. Decision

**sumire-sr stays the production server.** The goal is a small public community of EN players with
multiplayer, and solis is ruled out for that:

- Its README says many multiplayer features are "intentionally single-player: you see only yourself",
  and tells you not to put it on the public Internet (`README.md:141`).
- Its game HTTP and `/admin/*` (user create/delete/"god", master import) share one plain-HTTP port
  (`internal/server/http/http.go:46-50`), guarded only by a bearer string.
- Its login model is "the admin creates an account with `makino`, then the player uses the data
  transfer screen". `Auth:Create` isn't implemented, so players can't sign up themselves.
- **License: AGPL-3.0.** Copying solis code into sumire-sr would put sumire-sr under AGPL, and because
  we serve it over a network, we'd have to offer the full source to every player. Treat solis as a
  **behavioral reference only**: read it, run it, diff its responses, and write our own code. Don't
  copy or translate files. If code ever is ported, decide on the AGPL question first, deliberately.

solis is still useful to us in two ways:
1. **Oracle.** For the ~185 RPCs we only replay or stub, solis is a second, running implementation
   that shows what plausible server-authoritative responses look like. That's especially valuable for
   Quest/Live, where it has a scoring engine (`internal/makino/live/`).
2. **Map of gaps.** Its `coverage.md` and `docs/unimplemented.md` give a per-service list we can
   check our own coverage against.

## 2. Interop harness: run the 6.0.2 client against solis (dev only, LAN only)

Purpose: capture solis's responses on device so we can compare them against ours. This must never be
exposed beyond the dev machine.

### 2.1 What solis expects that our redirect doesn't do yet

| Concern | sumire-sr today | solis expects |
|---|---|---|
| gRPC | TLS on one port (`:8443`) | TLS on `:50051` (`SOLIS_GRPC_CERT_*`) |
| Master / Octo / CDN / Firebase HTTP | same port as gRPC | **plain HTTP** on `:50052`, path-routed, host-agnostic |
| Firebase auth (`identitytoolkit`, `securetoken`, `firebaseinstallations`, `id.qseed.jp`) | left on real Google; we mint our own JWT | **emulated by solis** (`docs/auth.md`); it must receive these calls |
| Firebase Storage (photos) | not redirected (photos come out blank) | emulated (`/v0/b/udc-idolypride/o`) |
| Asset CDN `d2ilil7yh5oi1v.cloudfront.net` | left on the real CDN | served from `resources/assets/` (optional, see 2.4) |
| `x-app-version` | 6.0.2 today, not enforced; target 6.0.3 (`PLANS.md` §1.6) | seed is **6.0.3**, exact match (`interceptor.go:279`) |
| Master data | `phaseA2/blobs/<Type>` + `phaseA2/out/manifest.json` | `resources/db/<fileName>` + `resources/manifest/mastertag.json` |

The fork's redirect list is `{api.game-idolypride.jp, climaster.game-idolypride.jp, api.octo-cloud.com}`
(`PrivateServer.cpp:301`), and all three go to one `privateServerUrl`. To keep the fork unchanged,
put a TLS front door in front of solis.

### 2.2 Front door (Caddy on the dev host, `:8443`, our `tls/api.crt`)

- `Content-Type: application/grpc*` → `https://127.0.0.1:50051` (h2, skip upstream verify), or give
  solis our `tls/api.crt`/`api.key` as its gRPC cert and proxy without skipping verification.
- `/admin/*` → **403**. This is non-negotiable, even on a LAN.
- Everything else → `http://127.0.0.1:50052`.
- The fork stays pointed at `https://127.0.0.1:8443` through `adb reverse tcp:8443 tcp:8443`. That
  keeps the existing SAN `IP:127.0.0.1` valid. **`ca.key` isn't in `tls/`**, so we can't issue a new
  cert with a LAN IP until we find it or rotate the CA.

### 2.3 Data setup

1. `mastertag.json`: convert `phaseA2/out/manifest.json` by renaming `partitions` → `masterTagPacks`.
   The fields (`type`, `fileName`, `fileSize`, `cryptoKey`, `downloadUrl`) already match
   `ptransaction.MasterTagPack`. Keep the `climaster.game-idolypride.jp/<Type>/<fileName>` URLs as
   they are. solis's route `/:db/:filename` matches them, and the client reaches them through the
   fork's climaster redirect.
2. `resources/db/`: copy each `phaseA2/blobs/<Type>` to `resources/db/<fileName>`. The blobs are the
   still-encrypted SQLCipher packs. `downloadMasterTagPack` skips any file whose size already
   matches, so solis **won't** contact the official server. Use the encrypted blobs, not
   `master.db`: solis decrypts the packs itself with `cryptoKey`.
3. Version: sumire-sr is moving to 6.0.3 (`PLANS.md` §1.6), which matches solis's seeded
   `appVersion: "6.0.3"`. Until the device is on 6.0.3, set `appVersion: "6.0.2"` in
   `internal/db/internal/migration/initdata/server_profile.yaml` before first boot, or patch
   `serverProfile` in Mongo afterwards. Use the master set from the same re-harvest the device runs.
4. `OctoManifest.json`: solis refuses to start without one. We don't keep a local copy because we
   proxy Octo upstream. Either fetch and decrypt it once (solis seeds `octoManifestKey`), or patch
   solis locally to skip the check and leave `api.octo-cloud.com` out of the redirect so the client
   uses the real Octo.

### 2.4 Fork change needed (small, additive)

Add an opt-in **"emulated Firebase"** host set to the fork's redirect: `www.googleapis.com`
(identitytoolkit), `securetoken.googleapis.com`, `firebaseinstallations.googleapis.com`,
`id.qseed.jp`, and optionally `firebasestorage.googleapis.com`. The open question is which network
stack these calls use: the Firebase Unity SDK goes through Java/OkHttp on Android, not
UnityWebRequest. If so, the hook belongs on the Kotlin/Xposed side (`HoshimiHookMain.kt`), not in
`PrivateServer.cpp`. Check this first with a logcat/Frida trace of a cold login.

The same switch helps sumire-sr too: it's how we'd fix blank taken-photos (PLANS §1.5), once we
emulate Firebase Storage ourselves.

### 2.5 Login on solis

`makino user create`, then in game: data transfer → enter the ID and password. Account creation on a
fresh install won't work (no `Auth:Create`).

### Done when
The 6.0.2 device boots to HOME on solis through the front door, and a `captures/<date>_solis/` corpus
of solis responses exists for diffing.

## 3. What from sumire-sr to keep (all of it, but in priority order)

| Keep | Why it matters for a community server |
|---|---|
| `fastify-api/` | The server. Postgres + Drizzle suits multi-user concurrency and migrations. It has real auth (RS256 JWT) and can grow toward hardening. |
| `HoshimiLocalify-sr` + `tls/` + `CLIENT_SETUP.md` | How players reach us without root (APK path). solis has nothing comparable. |
| `phaseA2` (blobs, `master.db`, map) | The game content. solis expects you to bring it. |
| `phaseA1` + `phase3d`/`phase3f` | How we re-baseline on an app update. solis ships generated protos with no visible extraction pipeline. |
| `captures/` | Ground truth from official traffic. Better than solis for exact behavior. |
| Our ahead-of-solis features | `Card:RankUp`, PhotoContest (7), Shelf (6), Photo special/story-episode shooting. These are what you'd contribute upstream (see §5). |

Retire: the Frida redirect (already marked legacy). Keep `frida/` only for diagnostics and captures.

## 4. Multiplayer + hardening backlog (what solis doesn't give us)

These are sumire-sr's real work items. solis doesn't help here, because it deliberately doesn't
solve them.

1. **Self-service accounts:** `Auth:Create` / `Recreate` / `Delete`, plus a transfer-code flow
   (`Migration:*` password) for device changes. Rate-limit and add an invite or allowlist gate for a
   closed community.
2. **Real social graph:** Friend, Guild, Profile search, Showcase gallery and "like", and PhotoContest
   rankings across users. We already have the RPC shapes; they need cross-user queries.
3. **Competitive modes (M4–M5):** Pvp/League/Gvg/Ladder/Race need the missing master partitions
   (`IPR_MASTER_DIFF.md`) and a server-authoritative scoring sim. Use solis's live engine to check
   outputs, and the VENUS reference for the rules.
4. **Server authority / anti-cheat:** validate every client-reported result (Quest:Finish, Live
   scores, gacha currency). Never trust client totals in shared rankings.
5. **Ops hardening:**
   - No admin surface on the public listener.
   - Secrets out of the repo.
   - Per-account and per-IP rate limits.
   - Structured audit logs for currency and gacha.
   - Backups.
   - Unknown RPCs should return a deliberate error rather than an empty success (`router.ts`
     currently returns empty).
6. **Replace replay with logic** for the 22 replayed RPCs (Activity, Quest, Message, Mission,
   LoginBonus, Home). Replayed data is one capture's player state, which is wrong for every other
   player.

## 5. Upstreaming to solis (optional)

Contributing our ahead-of-solis handlers as Go PRs to `vertesan/solis-server` helps the
single-player community. A contribution is our own code under their AGPL, which is fine, but keep
the two codebases from mixing in the other direction. It's low priority next to §4.
