#!/usr/bin/env bash
# emu_client.sh — put the LSPatch local-mode HoshimiLocalify-sr (tokanada fork) client on the
# emulator (the rootless, Moto G-style path; no frida). See docs/EMULATOR_RUNBOOK.md.
#
# Usage:
#   bash tools/emu_client.sh install   # manager + patched game + mod, seed assets, write config
#   bash tools/emu_client.sh fresh     # wipe game data (new account on next start), re-seed assets
#   bash tools/emu_client.sh config     # write mod config (server picker)
#   bash tools/emu_client.sh start     # launch the game from the mod app (passes the config)
#
# After `install`, enable the mod once in the LSPatch manager:
#   Manage → アイプラ → From installed modules → Hoshimi Localify → Add.
#
# Inputs (override with env):
#   LSPATCH_DIR  tools/emulator/lspatch-492 (lspatch-*.jar, manager-*.apk, out/*-lspatched.apk)
#   MOD_APK      ../HoshimiLocalify-sr/app/build/outputs/apk/full/debug/app-full-debug.apk
#   CACHE_DIR    tools/emulator/pixel-6.0.3 (idoly_octo.tar, idoly_ext.tar pulled from the Pixel)
#   SERVER_URL   https://127.0.0.1:8443 (adb reverse to the host; the cert has IP:127.0.0.1)
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SERIAL="${EMU_SERIAL:-emulator-5580}"
ADB="${ANDROID_SDK_ROOT:?set ANDROID_SDK_ROOT}/platform-tools/adb"
PKG=game.qualiarts.idolypride
MOD="${MOD:-io.github.tokanada.hoshimi.localify}"
LSPATCH_DIR="${LSPATCH_DIR:-$REPO/tools/emulator/lspatch-492}"
MOD_APK="${MOD_APK:-$REPO/../HoshimiLocalify-sr/app/build/outputs/apk/full/debug/app-full-debug.apk}"
CACHE_DIR="${CACHE_DIR:-$REPO/tools/emulator/pixel-6.0.3}"
SERVER_URL="${SERVER_URL:-https://127.0.0.1:8443}"
CA_PEM="${CA_PEM:-$REPO/tls/ca.crt}"

adbs() { "$ADB" -s "$SERIAL" "$@"; }
die() { echo "[FAIL] $*"; exit 1; }

# Only asset caches are seeded. The ext-storage dirs 43781DB5…/2C509CCD… and
# octo/user hold the Pixel account's save; copying them makes the game ask to
# restore a changed device instead of creating a new account.
seed_assets() {
  [ -f "$CACHE_DIR/idoly_octo.tar" ] && [ -f "$CACHE_DIR/idoly_ext.tar" ] || die "missing tarballs in $CACHE_DIR"
  adbs root >/dev/null 2>&1
  adbs push "$CACHE_DIR/idoly_octo.tar" "$CACHE_DIR/idoly_ext.tar" /data/local/tmp/ >/dev/null || die "push failed"
  # restorecon the ext copy through /data/media: via the /sdcard FUSE path it gets
  # storage_file and Unity fails with "Not enough storage space to install required resources"
  adbs shell "set -e
    U=\$(stat -c %u /data/data/$PKG)
    mkdir -p /data/data/$PKG/files
    tar -C /data/data/$PKG/files -xf /data/local/tmp/idoly_octo.tar
    rm -rf /data/data/$PKG/files/octo/user
    chown -R \$U:\$U /data/data/$PKG/files; chmod 771 /data/data/$PKG/files
    restorecon -R /data/data/$PKG/files
    E=/data/media/0/Android/data/$PKG
    mkdir -p \$E
    tar -C \$E -xf /data/local/tmp/idoly_ext.tar files/EB0A191797624DD3A48FA681D3061212 files/il2cpp
    chown -R \$U:1078 \$E; chmod -R g+w \$E; restorecon -R \$E
    rm -f /data/local/tmp/idoly_octo.tar /data/local/tmp/idoly_ext.tar" >/dev/null 2>&1 || die "seeding failed"
  echo "[OK] seeded asset caches (octo, EB0A…, il2cpp)"
}

write_config() {
  local tmp cur
  tmp="$(mktemp -d)"
  adbs shell am force-stop "$MOD"
  # the mod creates ipr-config.json on its first start
  if ! adbs shell run-as "$MOD" cat files/ipr-config.json >"$tmp/cur.json" 2>/dev/null || [ ! -s "$tmp/cur.json" ]; then
    adbs shell am start -W -n "$MOD/.MainActivity" >/dev/null 2>&1
    sleep 3
    adbs shell am force-stop "$MOD"
    adbs shell run-as "$MOD" cat files/ipr-config.json >"$tmp/cur.json" 2>/dev/null || die "cannot read $MOD config (debug build needed for run-as)"
  fi
  # Leave the server choice to the in-game Switch server picker: privateServerEnabled=true makes the mod app-managed and the button refuses to switch.
  python3 -I - "$tmp/cur.json" "$tmp/new.json" "$SERVER_URL" "$CA_PEM" <<'EOF'
import json, sys
cur, new, url, ca = sys.argv[1:5]
c = json.load(open(cur))
c.update(enabled=True, privateServerEnabled=False, privateServerUrl="", privateServerCaPem="")
json.dump(c, open(new, 'w'), separators=(',', ':'))
EOF
  adbs exec-in run-as "$MOD" sh -c 'cat > files/ipr-config.json' <"$tmp/new.json" || die "config write failed"
  rm -rf "$tmp"
  cur="$(adbs shell run-as "$MOD" cat files/ipr-config.json | python3 -c 'import json,sys; c=json.load(sys.stdin); print(c["privateServerEnabled"], c["privateServerUrl"])')"
  echo "[OK] mod config: $cur"
}

reverse() {
  adbs reverse tcp:8443 tcp:8443 >/dev/null && adbs reverse tcp:443 tcp:8443 >/dev/null || die "adb reverse failed"
  echo "[OK] adb reverse tcp:443,8443 -> host :8443"
}

case "${1:-}" in
  install)
    mgr="$(ls "$LSPATCH_DIR"/manager-*.apk 2>/dev/null | head -1)"
    game="$(ls "$LSPATCH_DIR"/out/*-lspatched.apk 2>/dev/null | head -1)"
    [ -n "$mgr" ] && [ -n "$game" ] || die "need manager-*.apk and out/*-lspatched.apk in $LSPATCH_DIR"
    [ -f "$MOD_APK" ] || die "mod APK not found: $MOD_APK"
    # LSPatch re-signs, so a Play-signed install must go first
    if adbs shell pm list packages "$PKG" | grep -q "$PKG" && ! adbs install -r "$game" >/dev/null 2>&1; then
      adbs uninstall "$PKG" >/dev/null 2>&1
    fi
    adbs install -r "$mgr" >/dev/null || die "manager install failed"
    adbs install -r "$game" >/dev/null || die "game install failed"
    adbs install -r "$MOD_APK" >/dev/null || die "mod install failed"
    adbs shell dumpsys deviceidle whitelist +org.lsposed.lspatch >/dev/null
    echo "[OK] installed LSPatch manager, local-patched game, HoshimiLocalify-sr"
    seed_assets
    write_config
    reverse
    echo "Next (once): enable the mod in the LSPatch manager — Manage → アイプラ → From installed modules → Hoshimi Localify → Add"
    ;;
  fresh)
    adbs shell am force-stop "$PKG"
    adbs shell pm clear "$PKG" >/dev/null || die "pm clear failed"
    adbs root >/dev/null 2>&1
    adbs shell rm -rf "/data/media/0/Android/data/$PKG"
    seed_assets
    ;;
  config)
    write_config
    ;;
  start)
    reverse
    adbs shell am force-stop "$PKG"
    # explicit activity: monkey can leave another app (e.g. Chrome) in front
    adbs shell am start -W -n "$MOD/.MainActivity" >/dev/null 2>&1
    # "StartGame" in the mod app launches the game with the iprData config extra.
    # Compose exposes it as content-desc, not text; poll while the UI settles.
    xy=""
    for _ in 1 2 3 4 5; do
      sleep 2
      adbs shell uiautomator dump /data/local/tmp/ui.xml >/dev/null 2>&1
      xy="$(adbs shell cat /data/local/tmp/ui.xml | python3 -c '
import re, sys
for n in re.findall(r"<node [^>]*>", sys.stdin.read()):
    if "text=\"StartGame\"" in n or "content-desc=\"StartGame\"" in n:
        b = [int(v) for v in re.findall(r"\d+", re.search(r"bounds=\"([^\"]*)\"", n).group(1))]
        print((b[0]+b[2])//2, (b[1]+b[3])//2)
        break')"
      [ -n "$xy" ] && break
    done
    [ -n "$xy" ] || die "StartGame button not found in the mod app"
    # shellcheck disable=SC2086
    adbs shell input tap $xy
    echo "[OK] game started from the mod app"
    ;;
  *)
    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
    [ "${1:-}" = help ] || [ "${1:-}" = -h ]
    ;;
esac
