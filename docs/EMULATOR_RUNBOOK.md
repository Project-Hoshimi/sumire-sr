# Emulator runbook (macOS, Apple Silicon)

An Android emulator on the Mac stands in for the Pixel 6 and the Moto G for
debugging and patching. There are two client paths:

- **LSPatch local mode (use this for accounts and play).** It is rootless, the
  same as the Moto G. The game is patched with `--manager`, the LSPatch manager
  serves the HoshimiLocalify-sr mod, and the mod redirects the game and Firebase
  Auth hosts to the server. Script: `tools/emu_client.sh`.
- **frida (use this for hooks and RE).** `frida/emu_up.sh` with
  `e2e_hooks.js`, as on the Pixel. It does not redirect Firebase Auth, so
  it cannot create a new account.

Status (2026-10-25): **fresh account to HOME verified on the LSPatch path.**
A new account (ID `1BZMA5CL`, `seed: fresh`) went through Firebase Auth
emulation and the full opening tutorial (`Tutorial:Progress` steps 10 → 150)
to HOME at Manager Lv 2, with no server errors. Snapshot `lspatch-home` holds
that state. The frida path (`emu_up.sh private`) boots and hooks, but cannot
create accounts.

## Why it works here

- The host is arm64, so the `arm64-v8a` system image runs natively under
  Hypervisor.framework. The game ships only `arm64-v8a`
  (`phase3d/apk/split_config.arm64_v8a.apk`), so no translation layer is needed.
  An x86 Linux host could not run it the same way.
- The `google_apis` image (not `google_apis_playstore`) allows `adb root` and
  `-writable-system`. That replaces Magisk for frida-server and the CA install.
- Snapshots give a clean, already-rooted device back in seconds after a bad
  patch.

## Fixed values

| Thing | Value |
|---|---|
| SDK | `$ANDROID_SDK_ROOT` |
| System image | `system-images;android-33;google_apis;arm64-v8a` (Android 13) |
| AVD name | `idoly33` |
| Console port / serial | `-port 5580`, so the serial is **`emulator-5580`** |
| Package | `game.qualiarts.idolypride` (client 6.0.3) |
| APKs | `phase3d/apk/base.apk` + `split_config.arm64_v8a.apk` (LFS) |
| frida | host `frida` (Python package) and device `frida-server` both **17.18.0**; `frida-tools` is unpinned (own version series, 14.x) |
| frida-server on device | `/data/local/tmp/frida-server` |
| Host frida venv | `.venv-frida/` (gitignored) |
| Downloaded binaries | `tools/emulator/` (gitignored) |
| Snapshots | `lspatch-home` (LSPatch client, fresh account at HOME, game stopped). `clean-rooted` (used by `emu_up.sh reset`) is not created yet |

Android 13 is used because its CA store is still
`/system/etc/security/cacerts`. Android 14 moved it into the conscrypt APEX,
which needs a bind-mount on every boot.

Always pin the serial: `adb -s emulator-5580`, `frida -D emulator-5580`, or
`ANDROID_SERIAL=emulator-5580`. Never use bare `adb` or `frida -U`. The Moto G
(and sometimes the Pixel) stay attached.

## Differences from the Pixel workflow

| Pixel 6 (`DEVICE_RUNBOOK.md`) | Emulator |
|---|---|
| Magisk `su -c`; `adb root` forbidden | `adb root`; no Magisk |
| CA via the `mitmproxy-cacert` Magisk module | CA pushed to `/system/etc/security/cacerts/<hash>.0` on a `-writable-system` boot |
| `systemd-run --user` for long processes (Linux host) | detached `screen -dmS <label>` sessions (macOS host), logs in `tools/emulator/<label>.log`. launchd cannot be used: its jobs cannot read `~/Documents` (TCC) |
| `frida/device_up.sh` | `frida/emu_up.sh` (same modes and `[OK]/[FIXED]/[WARN]/[FAIL]` output) |
| Reset = reinstall / clear data | Reset = `adb -s emulator-5580 emu avd snapshot load clean-rooted` |
| Blind flag `/tmp/a4e2e_blind` | `/data/data/game.qualiarts.idolypride/files/a4e2e_blind` (no `/tmp`, rootfs stays read-only even after remount); `e2e_hooks.js` polls both |

## One-time provisioning

1. Install the emulator and image:
   `sdkmanager "emulator" "system-images;android-33;google_apis;arm64-v8a"`
2. Create the AVD:
   `avdmanager create avd -n idoly33 -k "system-images;android-33;google_apis;arm64-v8a" -d pixel_6`
   Then set these in `~/.android/avd/idoly33.avd/config.ini`:
   `hw.ramSize=4096`, `disk.dataPartition.size=16G`, `hw.gpu.enabled=yes`,
   `hw.gpu.mode=host`, `hw.keyboard=yes`.
3. First boot with a writable system:
   `emulator -avd idoly33 -port 5580 -writable-system -no-snapshot-load`
4. Root and make `/system` writable:
   `adb -s emulator-5580 root`, then
   `adb -s emulator-5580 shell avbctl disable-verification`, reboot, then
   `adb -s emulator-5580 root && adb -s emulator-5580 remount`.
5. Install the CA: `tls/ca.crt` ("Idoly Pride Dev CA", hash `6eed9ffc`; it signs
   `tls/api.crt`, whose SANs include `api.octo-cloud.com`). `emu_up.sh` uses it by default. Name it `$(openssl x509 -subject_hash_old -noout -in ca.pem).0`,
   push it to `/system/etc/security/cacerts/`, `chmod 644`, and reboot.
6. Install the game:
   `adb -s emulator-5580 install-multiple phase3d/apk/base.apk phase3d/apk/split_config.arm64_v8a.apk`
7. Install frida. Create `.venv-frida` with `pip install frida==17.18.0 frida-tools`.
   Download `frida-server-17.18.0-android-arm64.xz` from the official frida
   GitHub releases into `tools/emulator/`, push it to
   `/data/local/tmp/frida-server`, and `chmod 755` it.
8. Launch the game once and get past the first-run download, so the asset
   cache is warm. Then save the snapshot:
   `adb -s emulator-5580 emu avd snapshot save clean-rooted`

`bash frida/emu_up.sh provision` runs steps 1–7 idempotently. Step 8 is manual.

## Daily use

```bash
bash frida/emu_up.sh private      # boot if needed, root, frida-server, reverse, attach hooks
bash frida/emu_up.sh status       # check only
bash frida/emu_up.sh reset        # load the clean-rooted snapshot
bash frida/emu_up.sh down         # stop frida jobs, force-stop game (emulator keeps running)
bash frida/emu_up.sh kill         # also shut down the emulator
```

`emu_up.sh private` checks these in order:
1. emulator running as `emulator-5580`, otherwise start it in a detached screen session
2. `adb root`, `/system` CA present
3. frida-server running and matching the host version
4. `adb reverse tcp:443 tcp:8443` and `tcp:8443 tcp:8443`
5. something listening on host `:8443` (the private server). The script checks
   this but does not start the server.
6. blind flag file present
7. force-stop, launch, then attach `e2e_hooks.js` via the `attach_e2e.sh`
   flow with `-D emulator-5580`, waiting for `e2e_hooks loaded`

## LSPatch local-mode client (`tools/emu_client.sh`)

Pieces, all gitignored under `tools/emulator/`:

| Piece | Where it comes from |
|---|---|
| LSPatch `lspatch-v1.2-492-release.jar` + `manager-v1.2-492-release.apk` | github.com/JingMatrix/LSPatch release `canary-492` → `lspatch-492/` (jar and manager must be the same build) |
| Patched game | `java -jar lspatch-v1.2-492-release.jar -l 2 --manager ../ipr-patcher-en/IdolyPride_6.0.3_fontpatched.apk -o lspatch-492/out` |
| Mod | `HoshimiLocalify-sr` `feat/private-server`, `./gradlew assembleFullDebug` (debug, so `run-as` can write its config) |
| Asset caches | `pixel-6.0.3/idoly_octo.tar` (`files/octo`) and `idoly_ext.tar` (`/sdcard/Android/data/<pkg>/files`), tarred from the Pixel |

Steps:
1. `bash tools/emu_client.sh install` installs the manager, patched game and mod.
   It then seeds the asset caches, writes the mod config
   (`privateServerEnabled`, `privateServerUrl=https://127.0.0.1:8443`,
   `privateServerCaPem=tls/ca.crt`) via `run-as`, and sets
   `adb reverse tcp:443,8443`.
2. Once, in the LSPatch manager: Manage → アイプラ → From installed modules →
   Hoshimi Localify → Add. The app row then shows `1` module. Shizuku
   (`moe.shizuku.privileged.api`) is installed and started on the emulator too.
   It is required for the manager to install and re-patch on-device, which is the
   path real phone users take. The adb-driven install above works without it.
3. The server must listen on host `:8443` with the cert from `main` (SANs for
   googleapis, `IP:127.0.0.1`).
4. `bash tools/emu_client.sh start` launches via the mod app's StartGame.
   That is required, because the config reaches the game as the `iprData` intent
   extra. Verified 2026-10-25: `start` → TAP TO START → `System:Check` →
   `Auth:Login` → `Master:Get` → `User:Get` → `Home:Login` → `Home:Enter`, all 200.
5. New account: `bash tools/emu_client.sh fresh`, then `start`.

Verified 2026-10-25 on a fresh account: the server saw `System:Check` →
`Auth:Create` (`seed: fresh`) → `verifyCustomToken` → `getAccountInfo` →
`Auth:Login` → `Master:Get` (+ `/master/*` downloads) → `User:Get` → Octo list →
`Tutorial:Init` → `Home:Login` → `Story:ListEvent`, then the opening story.

Snapshots: `adb -s emulator-5580 emu avd snapshot load lspatch-home`. Save
only with the game stopped. While it runs, the emulator refuses with
`KO: Snapshot save is skipped. Reason: UNSUPPORTED_VK_APP`.

Gotchas:
- **Seed only asset caches.** The ext-storage dirs `43781DB5…`/`2C509CCD…` and
  `files/octo/user` hold the Pixel account's save. With them, the title shows the
  old ID, `/v1/token` gets 400, and the game shows "機種変更をした場合はアカウント
  からデータを復元させてください…". `emu_client.sh` copies only `octo`, `EB0A…`
  and `il2cpp`.
- **SELinux labels.** restorecon the ext copy through `/data/media/0/...`. Via
  `/sdcard` it gets `storage_file`, and Unity says "Not enough storage space to
  install required resources".
- **Build 439.** The older patch `ipr-patcher-en/ls_patched/*-439-lspatched.apk`
  has no matching manager available any more. Use the 492 pair.

## Patching workflows

- **frida hooks**: edit `frida/*.js`, then `emu_up.sh down && emu_up.sh private`.
- **LSPatch / HoshimiLocalify**: patch the APK on the host with LSPatch CLI
  (`java -jar lspatch.jar -l 2 -m <module.apk> base.apk split...`), then
  `install-multiple` the patched files. Load the clean snapshot first if the
  signature changed (otherwise uninstall first).
- **il2cpp / native**: `frida -D emulator-5580 -p <pid> -l frida/il2cpp_hooks.js`.
  Pull `libil2cpp.so` with `adb -s emulator-5580 shell` as root from
  `/data/app/.../lib/arm64`.
- **Bisecting a bad state**: save named snapshots
  (`emu avd snapshot save before-x`) instead of reinstalling.

## Known risks and failure modes

- **Fresh accounts need the LSPatch path.** Past `Auth:Create` the client signs in
  through Firebase Auth (`www.googleapis.com` / `identitytoolkit` /
  `securetoken`). The server emulates that (`docs/AUTH_CREATE.md`), but only the
  HoshimiLocalify-sr mod redirects those hosts. On the frida path a fresh
  account goes to real Google and hangs on LOADING.
- **What was already fixed on the way.** The `phase3d/apk` 6.0.2 APKs are stale.
  Install 6.0.3 pulled from the Pixel (`tools/emulator/pixel-6.0.3/`). Asset
  caches copied from the Pixel (`files/octo` and `/sdcard/Android/data/<pkg>/files`)
  work, but restorecon the external copy through `/data/media/0/...`. Through
  the `/sdcard` FUSE path it gets `storage_file`, and Unity then fails with "Not
  enough storage space to install required resources". The `/tmp` dev flags in
  `e2e_hooks.js` are also read from the app files dir.
- **Emulator detection.** None seen so far: the game boots to TAP TO START and
  logcat shows no detection messages. If the game exits early, check
  `adb -s emulator-5580 logcat -d | grep -i -E 'qualiarts|unity|il2cpp' | tail -50`
  and look for `ro.kernel.qemu` or `Build.FINGERPRINT` probes. Spoof them with
  a frida hook if needed.
- **Snapshots with `-writable-system`.** Quickboot can be refused on a
  writable-system boot on some emulator builds. If `snapshot save` fails, keep
  the `-writable-system` boot for CA work only, and boot normally afterwards.
  The CA survives in the system overlay qcow2.
- **GPU.** If Unity renders black, switch to `-gpu swiftshader_indirect`.
- **Version drift.** frida-server must match host frida exactly. Bump both
  together and update the table.
- **Pixel-only scripts.** `device_up.sh`, `launch_e2e.sh` (hardcoded
  $SERVER_HOST, `frida -U`), and the systemd units are Linux/Pixel only. Do not
  run them against the emulator.
