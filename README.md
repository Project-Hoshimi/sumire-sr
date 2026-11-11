# sumire-sr

Community private-server reimplementation for **IDOLY PRIDE**, plus the reverse-engineering and data pipelines used to derive its wire schema, master data, and client captures.

> **Status:** early development. The sandbox track is the near-term focus; official parity is incomplete. See [ROADMAP.md](ROADMAP.md) for milestones and [docs/ENDPOINTS.md](docs/ENDPOINTS.md) for generated per-endpoint status.

## Two tracks, one codebase

`sumire-sr` serves two related goals from the same source tree. The difference is a runtime profile flag (`SUMIRE_PROFILE`), not a fork.

| Track | Milestone | What it means |
|---|---|---|
| **Sandbox** (fast track) | `sandbox-v1` | A playable private sandbox: full photo mode, story mode, a maxed account with all cosmetics and cards, every card on every banner, and free pulls. Features that are not implemented yet respond gracefully with a "not implemented" toast instead of breaking the client. Run with `SUMIRE_PROFILE=sandbox`. |
| **Official parity** | `parity` | A full reimplementation of the official servers: correct auth, economy, progression, social, rankings, and event behaviour with server-authoritative state. This is the long-term target. |

Feature work is prioritised with community feedback through GitHub Discussions polls. If you want to influence what gets built next, vote there.

## What is in the box

| Path | Purpose |
|---|---|
| `packages/protocol` | `@sumire-sr/protocol`: JSON schema descriptors (`schemas/`), generated TypeScript message/enum/endpoint code (`src/gen/`, never hand-edited), the codec runtime (`src/runtime/proto.ts`), wire crypto (`src/crypto.cjs`), codegen (`codegen/`), and the capture decoder. |
| `packages/server` | Fastify 5 + TypeScript server, run directly by Node 22 type stripping. RPC handlers live in `src/services/*.ts`; PostgreSQL 18 + Drizzle own persistence; the sandbox profile lives in `src/profile.ts` and `src/profiles/sandbox/`. |
| `toolchain/` | Reverse-engineering and data pipeline: schema extraction from an il2cpp dump, master-data harvest, and generated artefacts. Uses the data fetched into `./data`; extraction additionally needs a private il2cpp dump. |
| `client/` | Frida scripts and emulator helpers used to point the game client at a server. |
| `docs/` | Curated documentation, including the generated endpoint status. |

Stack: Node.js 22.18+, Fastify 5, PostgreSQL 18, Drizzle ORM. There is intentionally no Redis, no gRPC server framework, and no FastAPI.

## Quickstart

Requirements: Node.js 22.18 or newer, npm, git, and Docker with Compose (for PostgreSQL). If your Docker has no `docker compose` plugin, use the standalone `docker-compose` command wherever `docker compose` appears below.

```sh
git clone https://github.com/project-hoshimi/sumire-sr.git
cd sumire-sr

npm install
cp .env.example .env
# .env.example already contains the static client WIRE_SEC_KEY and points
# SUMIRE_DATA_DIR at ./data.

docker compose up -d postgres
npm run data:fetch
npm run -w packages/server db:migrate
npm run -w packages/server db:seed-master
npm run check

SUMIRE_PROFILE=sandbox npm run -w packages/server dev
```

Testing rather than developing? See the [tester guide](docs/TESTER_GUIDE.md).

To run the server in the container instead of on the host:

```sh
cp .env.example .env
docker compose up -d
docker compose exec server npm run data:fetch
docker compose exec server npm run -w packages/server db:migrate
docker compose exec server npm run -w packages/server db:seed-master
docker compose restart server
```

`docker compose up` only starts PostgreSQL and the server; it does not fetch game data, run migrations or seed the master tables, so a fresh clone needs the `exec` steps once. The devcontainer uses the same `server` service, so run the same three `npm run` commands in its terminal after it opens.

The compose stack publishes the server on port `8080` and PostgreSQL on port `5432`. If either port is already taken on your machine (a local PostgreSQL, for example), stop that service or remap the port in a compose override file. See `docker-compose.yml` and `.env.example` for the full set of settings.

### Game data

Game data is published from a separate repository, [`sumire-sr-data`](https://github.com/project-hoshimi/sumire-sr-data). Fetch the tag this server expects with:

```sh
npm run data:fetch
```

That shallow-clones the data into `./data` (already the value of `SUMIRE_DATA_DIR` in `.env.example`). Re-running is safe; set `SUMIRE_DATA_REPO` to clone a local path instead. The data repo is unofficial and is not affiliated with QualiArts, CyberAgent, or the IDOLY PRIDE rights holders; it contains master data and scrubbed captures, not APKs, assets, raw logs, account tokens, or personal data.

The wire-crypto value in `.env.example` is a static client constant shared by every user, not a secret. Tests that need game data skip automatically when `SUMIRE_DATA_DIR` is unset; they do not fail CI.

On an empty database with no game data the server boots and sandbox `Auth:Create` works after `npm run -w packages/server db:migrate`. After `npm run data:fetch` and `npm run -w packages/server db:seed-master`, the full new-player flow (`User:Get`, `Home:Login`, `Home:Enter`) works. `Diary:GetInfos` returns an empty list unless a catalog is at `$SUMIRE_DATA_DIR/diaries.json`.

Never commit real account tokens, captures, or personal data into this repository.

### Invite links

`SUMIRE_REGISTRATION` sets who may get an account: `open` (default) lets new players sign in without a link, `invite` requires an invite link, and `closed` refuses invite pages with 403.

Admin routes need `Authorization: Bearer $SUMIRE_ADMIN_TOKEN`. With no token configured, or a wrong one, they answer 404. To create a link:

```sh
curl -s -X POST https://sumire.example/sumire/admin/invites \
  -H "Authorization: Bearer $SUMIRE_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"uses":1,"expiresDays":7,"note":"for a friend"}'
```

Body fields are optional: `uses` (integer 1-1000, default 1), `expiresDays` (greater than 0, up to 3650; omitted means no expiry), and `note` (string). The response is JSON with `id` and `url`. The URL uses `SUMIRE_PUBLIC_URL` when set, otherwise `https://` plus the request's host.

The player opens the URL in a browser and chooses a link password of 8-16 letters and digits. The page shows a title ID. In the game, they go to the title screen, then Account, then Enter Link Password, and enter the title ID and password.

List invites with `GET /sumire/admin/invites`, and revoke one with `POST /sumire/admin/invites/<id>/revoke`, using the same header. Treat an invite URL like a password until it is used or expires.

## Documentation

- [AGENTS.md](AGENTS.md) — canonical guide for contributors and LLM coding agents: layout, request flow, endpoint workflow, hard rules.
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, data fetching, DCO sign-off, PR checklist.
- [ROADMAP.md](ROADMAP.md) — tracks, milestones, and endpoint status levels.
- [SECURITY.md](SECURITY.md) — private vulnerability reporting.
- [Discussions](https://github.com/project-hoshimi/sumire-sr/discussions) — feature requests, prioritisation polls, and questions.

## Acknowledgements

Parts of the server are derived from [solis-server](https://github.com/vertesan/solis-server), an earlier open-source IDOLY PRIDE private server also licensed under AGPL-3.0. Thank you to its authors. [NOTICE](NOTICE) has the details.

## License and disclaimer

`sumire-sr` is licensed under the **GNU Affero General Public License v3.0**. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

This project is not affiliated with, endorsed by, or sponsored by QualiArts, CyberAgent, or the IDOLY PRIDE rights holders. IDOLY PRIDE and all related trademarks, game assets, and content belong to their respective owners. Game APKs, assets, and raw logs are not distributed here; optional master data and scrubbed captures live in the separate `sumire-sr-data` repository.
