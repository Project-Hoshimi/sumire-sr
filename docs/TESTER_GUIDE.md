# Tester guide

This guide is for people who want to try a sumire-sr server with the IDOLY PRIDE client and report what breaks. You do not need to be a developer for Path A.

## 1. What this is, and what works today

sumire-sr is a community private-server reimplementation for IDOLY PRIDE. It is in early development. The near-term focus is the **sandbox** profile; full official parity is not complete (see [ROADMAP.md](../ROADMAP.md)).

A new account on a sandbox server gets:

- A maxed account: every card and every cosmetic.
- Every card on every gacha banner, with free pulls.
- Photo mode: shooting, recipes, poses and saved photos.
- Story mode: card stories and event story playback.

Features that are not implemented yet (for example PvP, rankings or guilds) answer with a "not implemented" message and return you to home.

## 2. What you need

- An Android device or emulator that can run IDOLY PRIDE.
- The game with the module applied. You can patch your own copy or download a pre-patched APK (see below). This repository does not host the game or any APK.
- The **HoshimiLocalify-en** module, if you patch the game yourself. Download `HoshimiLocalify-en-lite-<ver>.apk` from its [releases](https://github.com/Project-Hoshimi/HoshimiLocalify-en/releases).
- The [LSPatch manager](https://github.com/JingMatrix/LSPatch), if you patch the game yourself. Rooted devices need no computer. Non-rooted devices use Shizuku with LSPatch.
- A server to connect to: one that someone else hosts (Path A) or one you run yourself (Path B).

There are two ways to get a patched game:

- **Patch your own copy with LSPatch.** The store version of the game must be installed on the device; LSPatch patches that copy. Follow the [HoshimiLocalify-en README](https://github.com/Project-Hoshimi/HoshimiLocalify-en#readme).
- **Download a pre-patched APK from [ipr-patcher-en](https://github.com/tokanada/ipr-patcher-en).** This is the quicker option: install the APK and skip LSPatch and the separate module download. Uninstall the store version first, because the pre-patched APK is signed with a different key and cannot install over it. It is maintained outside this organization; follow its README.

Before you start: your official account lives on the official server. Note your account ID and transfer code before you uninstall or switch servers.

## 3. Path A: connect to a server someone else hosts

Ask the host for the server URL. If the server requires invites, also ask for an invite link.

1. Open the game and wait for the title screen.
2. Tap **Switch server** (top-right corner).
3. Tap **Add private server…** and enter the address from the host. Later you can pick it from the saved list.
4. The game closes. Reopen it to connect to the new server.

Switching servers clears the game's local account data. Note your account ID and transfer code first.

If the host gave you an invite link:

1. Open the link in a browser and choose a link password of 8-16 letters and digits.
2. The page shows a title ID.
3. In the game, go to the title screen, then **Account**, then **Enter Link Password**, and enter the title ID and password.

You do not install a certificate. When you add a server, the module fetches the server's certificate authority (CA) and asks you to confirm its fingerprint:

- Compare the fingerprint in the dialog with the one the host gave you, then confirm.
- If the host gave you an address that ends in `#sha256=…`, the fingerprint is checked for you and no dialog appears.
- If the host uses its own domain with a public certificate, no dialog appears either.

Hosts: [CLIENT_CONNECT.md](CLIENT_CONNECT.md) explains where to find the fingerprint and how to set up each case.

> **Not yet verified by an outside tester:** the public-domain case. If the game cannot connect after you add a server, tell the host and include the error text.

## 4. Path B: run your own server

You need Node.js 22+, npm, git and Docker (for PostgreSQL). These are the [README](../README.md) quickstart steps:

```sh
git clone https://github.com/project-hoshimi/sumire-sr.git
cd sumire-sr

npm install
cp .env.example .env

# No `docker compose` plugin? Use the standalone `docker-compose` instead.
docker compose up -d postgres
npm run data:fetch
npm run -w packages/server db:migrate
npm run -w packages/server db:seed-master
npm run check

SUMIRE_PROFILE=sandbox npm run -w packages/server dev
```

`npm run data:fetch` downloads the game data the server needs into `./data`.

For a phone to connect, the server must be reachable with TLS and HTTP/2. See [CLIENT_SETUP.md](CLIENT_SETUP.md) §2 for those settings and §5 for troubleshooting. To hand out accounts, see "Invite links" in the [README](../README.md).

> **Windows:** the commands above are for a POSIX shell (macOS, Linux). Running the server on Windows has not been fully tested, and no Windows path is confirmed yet. If you try it, please report what worked and what failed.

## 5. First-run check

1. Launch the game. The title screen appears.
2. Tap to start. A fresh account logs in and reaches the home screen.
3. Open the gacha and do one pull. It costs nothing.

If you host the server, its log should show the `Auth:Login` RPC and no failed TLS handshakes.

## 6. Known limits

- Unimplemented features show a "not implemented" message and return home.
- [ENDPOINTS.md](ENDPOINTS.md) lists every RPC and whether it is implemented.
- Accounts on a private server are separate from your official account.

## 7. Reporting a bug

Use the [bug report form](https://github.com/project-hoshimi/sumire-sr/issues/new?template=bug.yml). Include:

- What you did, step by step.
- What you expected and what happened, with any error text shown in the game.
- The server version or commit (ask the host) and the profile (sandbox or official).
- Your device or emulator, Android version, and module version.

Never paste account tokens, transfer codes, captures, game data, keys, device serials or IP addresses into an issue, PR or chat. Report security problems privately as described in [SECURITY.md](../SECURITY.md).

## 8. Switching back to the official server

1. On the title screen, tap **Switch server** and pick **Official**.
2. The game closes. Reopen it.

This clears the local account data again, so sign back in to your official account with your account ID and transfer code.
