# Runbook: redirect IDOLY PRIDE to sumire-sr from a HoshimiLocalify fork (replacing Frida)

## Outcome (2026-10-25)

Phases 1 and 2 are done and verified:

- Pixel 6 rooted: login, 202/202 master downloads and Octo via the mod, with no Frida.
- Without the system CA: verified through the Java `getAcceptedIssuers` hook.
- Toggle off reaches the official servers.
- Unrooted Moto G (LSPatch) over Wi-Fi with no tunnel: the redirect and trust work.
- New-player sign-up was handled separately in PR #6.

Deviations from the plan:

- preserve-host mode instead of URL rewriting, because Unity checks the CN only.
- The `CertificateHandler` attach is unavailable on 6.0.3, so trust goes through the Java issuer list instead.
- `connect` 443→8443 is needed because Rust's resolver ignores the getaddrinfo port.

---

This runbook is for an agent who is new to this work. It assumes no earlier context. Work the phases in order. Each step says what "done" means. **Stop and ask the user** at every point marked ⛔.

---

## 0. Background (read first)

### Repos (all under `<repo>/`)

| Path | What it is |
|---|---|
| `sumire-sr/` | Private server for IDOLY PRIDE: Fastify + TypeScript in `fastify-api/`, docs in `docs/`, Frida scripts in `frida/`, TLS material in `tls/`, IL2CPP dump at `phase3d/dump/dump.cs` (client 6.0.2) |
| `HoshimiLocalify-en/` | English localization mod for the game. Remote is `origin https://github.com/project-hoshimi/HoshimiLocalify-en`, branch `main`. **Do not commit to it.** It is the upstream of the new fork. |
| `HoshimiLocalify-sr/` | **New fork, created in Phase 0.** All mod changes go here. |

### Current setup (what this work replaces)
The game is `game.qualiarts.idolypride`, client 6.0.2, arm64, running on a rooted Pixel 6 (Android 16, Magisk, LSPosed). It is pointed at sumire-sr by `sumire-sr/frida/e2e_hooks.js`, loaded through `frida/attach_e2e.sh`. Three parts of that script carry the redirect; everything else in it is diagnostics:
1. **§3/§4 (lines ~250–359):** rewrites the result of `getaddrinfo`, and rewrites `connect()` on IPv4:443 to 127.0.0.1 for the game IPs (35.221.155.103 api, 34.120.154.49 climaster, 34.102.172.238 stat, 130.211.5.37 octo) and for any :443 connect made by YAHA. `adb reverse tcp:443 tcp:8443` then carries the traffic to the host.
2. **§7 (lines 523–574):** hooks `Solis.Common.Network.Api.GetSSLRootCertificates()` (RVA 0x46E9F8C) and returns `OUR_CA_PEM + '\n' + orig + '\n'`. The dev CA's PEM is embedded at lines 523–541.
   - **The CA must go FIRST.** The game's bundle is missing an END line, so a CA appended at the end is silently dropped (`docs/ARCHIVE.md:16`).
   - It skips the change if the CA is already present.
3. **Outside Frida:** the dev CA is also installed in the system trust store through a Magisk module (`mitmproxy-cacert`). UnityWebRequest (libcurl + mbedTLS inside libunity) validates against that store.

Other things the Frida script does that are **not** part of this work: the love-story replay patch (lines 746–761) stays in Frida for now. The YAHA verifier blinds, the BoringSSL hooks and the mbedTLS probes are dormant or diagnostic and are not ported.

### Network facts (verified)
- **gRPC** (the main API) runs over HTTP/2 through YAHA (Rust: hyper + rustls). Capture logs show `Api.GetHost() -> https://api.game-idolypride.jp`, and the same string goes to `ApiBase.CreateChannel(host)` (`sumire-sr/captures/2026-10-08_slice18_polish/capture_e2e.log:784`).
- **`Solis.Common.Network.Api`** (`dump.cs` ~440080–440120):
  - `protected override string GetHost()`: RVA 0x46E9EB0, slot 25.
  - `protected override string GetSSLRootCertificates()`: RVA 0x46E9F8C, slot 31.
  - `public static void ChangeInReviewHost(string host)`: a built-in host override. Note it for reference; we hook `GetHost` instead.
- **Octo** asset catalog: `api.octo-cloud.com`, `/v2/pub/a/212/v/205051/list/{rev}`. The URL comes from `OctoSettings` (a `ScriptableObject` with field `public string url; // 0x18` and getter `Octo.IOctoSettings.get_Url()`, `dump.cs` ~1620400). sumire-sr proxies `/v2/*` upstream to the real Octo (`fastify-api/src/server.ts:13-60`).
- **Master data:** the server's `MasterGet` response hard-codes `DownloadUrl: https://api.game-idolypride.jp/master/<type>/<file>` (`fastify-api/src/services/master.ts:50`), served by `server.ts:231`. The client downloads it with UnityWebRequest over HTTP/1.1. The server sets `allowHTTP1: true` for this; without it the client gets 403 "Missing ALPN".
- **`UnityEngine.Networking.UnityWebRequest`** (`dump.cs` 2042201): field `m_CertificateHandler` at +0x28, `SendWebRequest()` at 2042310, `set_url` at 2042347, `get_certificateHandler` at 2042419. No `set_certificateHandler` turned up in a grep; check again in Phase 2.
- **`UnityEngine.Networking.CertificateHandler`** (`dump.cs` 2041913): **not abstract**. `m_Ptr` at +0x10. `protected virtual bool ValidateCertificate(byte[])` at RVA 0x91DED94, slot 4. `internal bool ValidateCertificateNative(byte[])` at 0x91DED9C.
- **Leave these alone:** `id.qseed.jp`, Google `identitytoolkit` / `securetoken` (Firebase auth), Firebase Storage, and the asset CDN `d2ilil7yh5oi1v.cloudfront.net`. A blanket :443 redirect breaks Firebase.
- **Server TLS:** sumire-sr runs `TLS=1 HTTP2=1 PORT=8443`, binds `HOST` (default `0.0.0.0`), and loads `tls/api.key` + `tls/api.crt` (`fastify-api/src/tls.ts`).
  - `tls/api.crt` is signed by `tls/ca.crt` (CN "Idoly Pride Dev CA").
  - Current SANs (`tls/api.ext`): `DNS:api.octo-cloud.com,DNS:api.game-idolypride.jp,DNS:0.0.0.0,IP:127.0.0.1`.
  - **`ca.key` is not in `tls/`.**

### HoshimiLocalify architecture (verified)
- **Injection:** an Xposed/LSPosed module (API 82) that also works under LSPatch. Entry point: `app/src/main/java/io/github/cylear/hoshimi/localify/HoshimiHookMain.kt`. It calls `System.loadLibrary` (~line 591) and then JNI `initHook(libil2cpp path, filesDir)` (~line 198).
- **Native code:** `app/src/main/cpp/`, built with CMake and C++23. It uses ShadowHook (`shadowhook_hook_func_addr`) and xDL. The Android `HookInstaller` is in `libHoshimiLocalify.cpp:40-48`.
- **Hook entry:** `Hook::Install()` (`HoshimiLocalify/Hook.cpp:6310`) hooks `il2cpp_init`. That hook waits for `Config::isConfigInit` and then runs `StartInjectFunctions()` (`Hook.cpp:5714`), which installs every other hook.
- **Macros** (`Hook.cpp:30-53`): `DEFINE_HOOK(ret, Name, (params))` defines `Name_Hook`, `Name_Orig` and `Name_Addr`. `ADD_HOOK(Name, addr)` needs a local `hookInstaller` in scope.
  - Instance methods take `(void* self, ..., void* mtd)`.
  - Static methods leave out `self`.
- **IL2CPP lookup** (`HoshimiLocalify/Il2cppUtils.hpp`):
  - `Il2cppUtils::GetMethodPointer(assembly, ns, cls, method, {argTypeNames})` (line 187).
  - `GetClass` (121) and `GetMethod` (160).
  - Nested classes use `/`, e.g. `"Api/Photo/<>c"`.
  - `UnityResolve::Invoke<T>("il2cpp_xxx", ...)` calls raw il2cpp exports.
  - `il2cpp_resolve_icall` (196).
- **Strings:** `using Il2cppString = UnityResolve::UnityType::String;` Read with `str->ToString()` (UTF-8, null-safe). Create with `Il2cppString::New(std::string)`.
- **Template to copy:** the `ApiBase_GetPlatformString` hook (`Hook.cpp:5569`). It is installed ~6210–6219 and resolves `Solis.Common.Network.Api` in `Assembly-CSharp.dll`, then its parent through `il2cpp_class_get_parent`.
- **Config:** globals in `HoshimiLocalify/config/Config.hpp` / `Config.cpp`, loaded by `LoadConfig(json)` using `GetConfigItem(name)` (Config.cpp:86).
  - Kotlin mirror: `models/IdolyprideConfig.kt` (`@Serializable`), saved to `filesDir/ipr-config.json`.
  - It reaches the game process as the intent extra `iprData`.
  - UI: `ui/pages/subPages/AdvancedSettingsPage.kt`, with listeners in `ConfigUpdateListener.kt`. Strings go in `res/values/strings.xml` and `res/values-ko/strings.xml`.
  - Use the `loginAsIOS` option as the end-to-end example of adding a field; it appears in all six places.
- **Logging:** use the existing `Log::*` helpers seen in `Hook.cpp`, and read them with `adb logcat`. Find the tag by grepping `Log.h` / `Log::Info`.

---

## Phase 0: create the fork ⛔ (outward-facing: confirm the repo name and visibility with the user before creating it)

Goal: a separate repo that can pull from `-en` and later merge back into it.

1. Create a **private** GitHub repo. The default name is `project-hoshimi/HoshimiLocalify-sr`; GitHub won't fork a repo into the account that already owns it, so create it empty:
   ```bash
   gh repo create project-hoshimi/HoshimiLocalify-sr --private --description "HoshimiLocalify + sumire-sr private-server support"
   ```
2. Clone and wire up the remotes:
   ```bash
   git clone https://github.com/project-hoshimi/HoshimiLocalify-en <repo>/HoshimiLocalify-sr
   ```
   ```bash
   git -C <repo>/HoshimiLocalify-sr remote rename origin upstream
   ```
   ```bash
   git -C <repo>/HoshimiLocalify-sr remote add origin https://github.com/project-hoshimi/HoshimiLocalify-sr
   ```
   ```bash
   git -C <repo>/HoshimiLocalify-sr push -u origin main
   ```
   Also push the upstream feature branches only if the user asks.
3. Check submodules and dependencies: run `git submodule status`, and `git submodule update --init --recursive` if needed.
4. Add `FORK.md` at the repo root covering:
   - Purpose: private-server redirect support for sumire-sr.
   - How to sync: `git fetch upstream && git merge upstream/main`. Use **merge, not rebase**, to keep a clean PR back to upstream.
   - The plan to open a PR into `project-hoshimi/HoshimiLocalify-en` once sumire-sr is public.
   - Rule: keep the changes isolated (see below).
5. Commit it with a message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Rules for keeping the fork easy to merge (follow them in every phase):**
- Put all new logic in **new files**:
  - `app/src/main/cpp/HoshimiLocalify/PrivateServer.hpp`
  - `app/src/main/cpp/HoshimiLocalify/PrivateServer.cpp`
  - `app/src/main/java/io/github/cylear/hoshimi/localify/ui/pages/subPages/PrivateServerPage.kt`, or a section composable in its own file
- Changes to upstream files are small and additive only:
  - a `#include` and a single `PrivateServer::Install(hookInstaller);` call in `StartInjectFunctions`
  - config fields
  - one navigation entry or section in the settings UI
  - the new `.cpp` in `CMakeLists.txt`, if sources are listed explicitly rather than globbed
- Keep the same `applicationId` and package. The fork's APK replaces the `-en` build on the device, so two modules never hook the game at once.
- Don't reformat or reorder upstream code.

Done when: the fork exists with both remotes, `FORK.md` is pushed, and `./gradlew assembleDebug` (or whatever task `-en` uses; check its README or CI workflow) builds unchanged.

---

## Phase 1: gRPC + Octo redirect in the mod (rooted dev; drops Frida)

### 1.1 Config fields (fork)
Add the following, using the same pattern as `loginAsIOS`:

| Name | Type | Default | Meaning |
|---|---|---|---|
| `privateServerEnabled` | bool | `false` | Master switch |
| `privateServerUrl` | string | `""` | e.g. `https://sumire.lan:8443`: scheme, host and port, no trailing slash |
| `privateServerCaPem` | string | `""` | PEM of the server's CA; one or more certs |

Touch these places:
- `Config.hpp`: the externs.
- `Config.cpp`: definitions plus `GetConfigItem`.
- `IdolyprideConfig.kt`: the fields with defaults.
- `ConfigUpdateListener.kt`: the setters, each calling `saveConfig()`.
- `PrivateServerPage.kt`: a switch, a URL text field, and a multiline PEM field. Linked from `AdvancedSettingsPage.kt` or the settings nav.
- strings in `values/` and `values-ko/`. The Korean strings may be English placeholders.

Normalize the URL when saving: trim it and drop any trailing `/`.

### 1.2 Native hooks: `PrivateServer.cpp`
Expose `namespace HoshimiLocal::PrivateServer { void Install(HookInstaller* hookInstaller); }`. Reuse the `DEFINE_HOOK` / `ADD_HOOK` macros; if they are defined only inside `Hook.cpp`, move them to a small shared header and keep the upstream diff minimal.

1. **`Api_GetHost(void* self, void* mtd) -> Il2cppString*`**
   - When `Config::privateServerEnabled && !privateServerUrl.empty()`, return `Il2cppString::New(Config::privateServerUrl)`.
   - Otherwise return the original.
   - Log the original and the effective host once.
   - Resolve with `GetMethodPointer("Assembly-CSharp.dll", "Solis.Common.Network", "Api", "GetHost")`.
2. **`Api_GetSSLRootCertificates(void* self, void* mtd) -> Il2cppString*`**
   - Call the original. If the feature is off, the PEM is empty, or the original is null or has no `BEGIN CERTIFICATE`, return it unchanged.
   - If the original already contains the first line of our PEM body, return it unchanged.
   - Otherwise return `Il2cppString::New(pem + "\n" + orig + "\n")`, with **our CA first**.
3. **`OctoSettings_get_Url(void* self, void* mtd) -> Il2cppString*`**
   - The method is the explicit interface implementation `Octo.IOctoSettings.get_Url` on `OctoSettings`. Find its assembly and namespace in `dump.cs` around line 1620400; the `// Namespace:` line above the class, together with the dll the class sits under, gives the assembly. The il2cpp method name will be `Octo.IOctoSettings.get_Url`.
   - When enabled, replace the scheme and authority of the original URL (`https://api.octo-cloud.com`) with `privateServerUrl` and keep the path.
   - If resolution fails, log it and carry on; it must not be fatal.
4. Call `PrivateServer::Install(hookInstaller)` from `StartInjectFunctions` (`Hook.cpp:5714`), near the `ApiBase_*` installs (~6210). Install only when `Config::privateServerEnabled` is set, so the hooks cost nothing when the feature is off.

### 1.3 sumire-sr changes (in `sumire-sr`, on a branch off `main`)
1. `fastify-api/src/config.ts`: add `publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'https://api.game-idolypride.jp'`.
2. `fastify-api/src/services/master.ts:50`: build `DownloadUrl` as `` `${config.publicBaseUrl}/master/${p.type}/${p.fileName}` ``. The default keeps the Frida setup working byte for byte.
3. Certificate ⛔ (ask the user where `ca.key` is; it is not in `tls/`):
   - Ask the user for the LAN DNS name (preferred) and/or IP of the server host.
   - Add them to `tls/api.ext`, e.g. `DNS:sumire.lan,IP:192.168.x.y`.
   - Re-sign: `openssl x509 -req -in tls/api.csr -CA tls/ca.crt -CAkey <ca.key> -CAserial tls/ca.srl -out tls/api.crt -days 3650 -sha256 -extfile tls/api.ext`.
   - If `ca.key` is lost, generate a new CA. Then the Magisk CA module, the PEM in `frida/e2e_hooks.js` §7, and the mod config **all** need the new CA; tell the user before going ahead.
   - A DNS name must resolve on the phone, through the router's DNS or a hosts entry. Whether YAHA's rustls accepts IP SANs depends on its version, so test it in 1.4.
4. Docs: add `docs/CLIENT_SETUP.md` with a "HoshimiLocalify-sr redirect (no Frida)" section covering env vars, cert SANs, mod settings and troubleshooting. Link it from `docs/SESSION_STATE.md`. Keep the Frida path documented as the fallback.

### 1.4 Verify Phase 1 on the device
1. Stop Frida (`systemctl --user stop idoly-frida` if the unit is used; see `docs/ARCHIVE.md:858`) and remove the tunnel with `adb reverse --remove tcp:443`. Leave the Magisk CA module **on** for this phase.
2. Start the server: `TLS=1 HTTP2=1 PORT=8443 PUBLIC_BASE_URL=https://<name>:8443 DEBUG_RPC=1`, with the usual start command from `docs/SESSION_STATE.md:60-92`.
3. Build and install the fork's debug APK, then enable it in LSPosed for the game.
4. In the app, turn on the private server, set the URL, and paste `tls/ca.crt`. Force-stop the game and launch it **from the module app**, so the config travels with the `iprData` extra.
5. Expected:
   - logcat shows the hooks installed and `GetHost` rewritten to the configured URL.
   - The server log shows the `Auth:Login` gRPC call.
   - The game reaches the home screen.
   - `/master/...` downloads are served by the server.
   - Octo `/v2/...` requests are proxied.
   - Nothing appears in the server log as a failed TLS handshake.
6. Regression: turn the switch off and relaunch. The game should reach the official servers normally, with logcat showing no hooks installed.
7. If gRPC fails the TLS handshake:
   - Check that the CA comes first in the returned roots (log its length and first line).
   - Check that the SAN matches the configured host.
   - Try a DNS name instead of an IP.

---

## Phase 2: rootless (remove the dependence on the system CA)

Goal: everything works with the Magisk CA module turned off, and under LSPatch.

1. Turn the Magisk CA module off and reboot. Confirm what breaks; it should be the UnityWebRequest traffic (master downloads, and Octo too if Octo uses UWR).
2. In `PrivateServer.cpp`, hook `UnityWebRequest.SendWebRequest()`:
   - Assembly: `UnityEngine.UnityWebRequestModule.dll`. Check it in `dump.cs`.
   - Read the URL with `get_url`. If the host is `api.game-idolypride.jp`, `climaster.game-idolypride.jp`, `api.octo-cloud.com`, or already the configured server's host, rewrite the scheme and authority to `privateServerUrl` with `set_url`.
   - If the field at +0x28 (`m_CertificateHandler`) is null, create a handler:
     - `il2cpp_object_new(CertificateHandler class)` and call its `.ctor`, which creates the native side through the `Create` icall. Check the `.ctor` in `dump.cs`.
     - Attach it with `set_certificateHandler` if it exists. If not, write the field and call the native setter icall, found with `il2cpp_resolve_icall("UnityEngine.Networking.UnityWebRequest::SetCertificateHandler(...)")`. Get the exact signature from `dump.cs` or the Unity reference source.
     - Record the handler pointer in a mutex-guarded `std::unordered_set` of handlers we created.
3. Hook `CertificateHandler.ValidateCertificate(byte[])` (virtual, slot 4):
   - If `self` is in our set, run the check below and return its result.
   - Otherwise call the original.
   - **Check:** parse the leaf certificate (DER) and verify it was issued by the configured CA. Use mbedTLS if it is linkable; otherwise compare the issuer DN plus a pinned SHA-256 of the server cert, taken from config.
   - Returning true for every cert is acceptable **only** as a temporary debug step. Don't ship it.
   - Remove handlers from the set when the request is disposed, or accept a small leak and log it.
4. Repeat 1.4 with the Magisk CA off.
5. **LSPatch:** patch the stock APK with the fork's module embedded (local mode) and install it on an unrooted test device or emulator. ⛔ Ask the user which device to use. Repeat 1.4.

Done when: the game logs in, finishes the master download and loads home on sumire-sr with no root, no Frida, no system CA and no `adb reverse`.

---

## Phase 3: wrap-up
- In the fork: update `FORK.md` with the setup steps for players (server URL + CA). Keep the settings UI clear that this is for private servers only.
- In sumire-sr: mark the Frida redirect as legacy in the docs, and keep `e2e_hooks.js` for diagnostics and the love-replay patch.
- Commit in small, focused commits in each repo, ending each with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. ⛔ Push and open PRs only when the user approves.
- Report to the user:
  - what was verified on the device, with the logcat and server-log evidence
  - what was not verified
  - any RVAs or names that differed from this runbook

## Known risks / pitfalls
- Client updates rename or strip methods. Every hook must fail soft: log and skip, never crash.
- `OctoSettings` may be read before `StartInjectFunctions` runs, which happens after `il2cpp_init`. If the Octo URL isn't rewritten, hook `OctoManager` setup instead, or rewrite the URL in the UWR hook (Phase 2 step 2 already covers the Octo host).
- The config has to reach the game process. Launching from the module app passes `iprData`; launching from the home screen falls back to `requestConfig` (`HoshimiHookMain.kt:520`). Test both.
- The `stat` host (34.102.172.238), which Frida used to redirect, is left on the real server. That is fine unless the game then blocks; if it does, add it to the UWR host list.
