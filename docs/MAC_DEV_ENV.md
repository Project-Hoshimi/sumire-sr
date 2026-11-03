# Mac dev environment (agent bring-up)

How to start the dev environment on this Mac (Apple Silicon, macOS). The user's
shutdown steps are in the README, under "Shutting down the dev environment".
The systemd and `journalctl` commands in `SESSION_STATE.md` and
`DEVICE_RUNBOOK.md` are for the old Linux host. Do not use them here.

## Pieces

| Piece | Runs as | Port | Log |
|---|---|---|---|
| Docker runtime | colima (`colima start`) | — | `colima status` |
| Postgres | Docker container `sumire-postgres` (`postgres:18`, volume `sumire-pgdata`, no restart policy) | `127.0.0.1:5432` | `docker logs sumire-postgres` |
| Game server | screen session `idoly.server`: `node src/server.ts` in `fastify-api/` | `*:8443` (TLS, HTTP/2) | `tools/emulator/idoly.server.log` |
| Emulator | screen session `idoly.emulator`: AVD `idoly33`, serial `emulator-5580` | — | `tools/emulator/idoly.emulator.log` |
| frida attach (RE path only) | screen session `idoly.frida`, started by `emu_up.sh private` | — | `tools/emulator/idoly.frida.log` |

Long-lived processes go in detached `screen` sessions started from the shell.
launchd jobs cannot read `~/Documents` because of TCC. Never leave a bare
`node` in the background: nothing would manage it and its output would be lost.

## Bring-up

Each step checks first, so the sequence can be rerun safely. Run from the repo root.

1. **Docker + Postgres**
   ```sh
   colima status >/dev/null 2>&1 || colima start
   docker start sumire-postgres
   docker exec sumire-postgres pg_isready -U idoly -d idoly
   ```
   Do not use `docker compose up postgres`. It creates a second container
   with an empty volume. After schema changes, also run
   `npm run db:migrate && npm run db:seed-master` in `fastify-api/`.

2. **Game server.** First check that nothing else holds `:8443`:
   ```sh
   lsof -nP -iTCP:8443 -sTCP:LISTEN
   ```
   If a `node src/server.ts` is listening, check where it runs
   (`lsof -p <pid> | grep cwd`). Another session's worktree may own it. Ask
   the user before killing a server that isn't in this checkout. Then:
   ```sh
   cd fastify-api && screen -dmS idoly.server /bin/bash -c \
     'SUMIRE_PROFILE=sandbox PORT=8443 TLS=1 HTTP2=1 DEBUG_RPC=1 exec node src/server.ts >>../tools/emulator/idoly.server.log 2>&1'
   curl -sk -o /dev/null -w '%{http_code}\n' --max-time 5 https://127.0.0.1:8443/   # anything but 000
   ```
   `PUBLIC_BASE_URL` stays unset. The default `https://api.game-idolypride.jp`
   works because the mod redirects that host. Restart the server after code
   changes: `screen -S idoly.server -X quit`, then start it again. The quit
   can leave the node process running and holding the port, and the new
   server then dies with `EADDRINUSE` while the old one keeps serving stale
   data. Before starting, check `lsof -nP -iTCP:8443 -sTCP:LISTEN` and `kill`
   any PID it lists.

3. **Emulator.** Boot it only if `emulator-5580` is not already attached:
   ```sh
   A=$ANDROID_SDK_ROOT
   $A/platform-tools/adb devices | grep -q '^emulator-5580\s*device' || \
     screen -dmS idoly.emulator /bin/bash -c \
       "exec env ANDROID_HOME=$A $A/emulator/emulator -avd idoly33 -port 5580 -no-boot-anim -writable-system >>tools/emulator/idoly.emulator.log 2>&1"
   $A/platform-tools/adb -s emulator-5580 wait-for-device
   ```
   Wait until `getprop sys.boot_completed` is `1`. To return to the saved
   post-tutorial account, run
   `adb -s emulator-5580 emu avd snapshot load lspatch-home` with the game stopped.

4. **Client, using one of the two paths** (details in `EMULATOR_RUNBOOK.md`):
   - Play and accounts (LSPatch, default): `bash tools/emu_client.sh start`.
     It sets `adb reverse` and launches through the mod app. Use
     `emu_client.sh fresh` first for a new account.
   - Hooks and RE (frida): `bash frida/emu_up.sh private`. It also boots
     the emulator if step 3 was skipped.

5. **Check:** `bash frida/emu_up.sh status` lists the emulator, reverse and
   `:8443` listener without changing anything.

## Physical devices

The Pixel 6 (`$ANDROID_SERIAL`) and the Moto G are attached too. Always pin
the serial. `frida/device_up.sh` runs its server and frida jobs as systemd
units, so it does not work on this Mac. Start the server with step 2 above and
run the device steps from `DEVICE_RUNBOOK.md` by hand.

## Backups

Postgres runs in the `sumire-postgres` container (database `idoly`, user `idoly`).
Take a custom-format dump before migrations or account surgery, and keep a
nightly copy:

```sh
mkdir -p backups
docker exec sumire-postgres pg_dump -U idoly -d idoly -Fc > backups/idoly-$(date +%F).dump
```

Restore into the live database (drops the dumped objects first):

```sh
docker exec -i sumire-postgres pg_restore -U idoly -d idoly --clean --if-exists \
  < backups/idoly-2026-11-01.dump
```

To inspect a dump without touching the live database, restore into a scratch one:

```sh
docker exec sumire-postgres createdb -U idoly idoly_restore
docker exec -i sumire-postgres pg_restore -U idoly -d idoly_restore < backups/idoly-2026-11-01.dump
```

Then point `DATABASE_URL` at `idoly_restore` for the server or the CLI.
