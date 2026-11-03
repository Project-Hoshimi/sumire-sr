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
| `toolchain/` | Reverse-engineering and data pipeline: schema extraction from an il2cpp dump, master-data harvest, and generated artefacts. Requires private game data. |
| `client/` | Frida scripts and emulator helpers used to point the game client at a server. |
| `docs/` | Curated documentation, including the generated endpoint status. |

Stack: Node.js 22+, Fastify 5, PostgreSQL 18, Drizzle ORM. There is intentionally no Redis, no gRPC server framework, and no FastAPI.

## Quickstart

Requirements: Node.js 22+, npm, and Docker (for PostgreSQL).

```sh
git clone https://github.com/project-hoshimi/sumire-sr.git
cd sumire-sr

cp .env.example .env
# Edit .env:
#   WIRE_SEC_KEY=...          (ask a maintainer; never commit it)
#   SUMIRE_DATA_DIR=...       (your private game data; required for a functional server)

npm install
docker compose up -d postgres
npm run check

SUMIRE_PROFILE=sandbox npm run -w packages/server dev
```

To run the server in the container instead of on the host:

```sh
docker compose up
```

The compose stack publishes the server on port `8080` and PostgreSQL on port `5432`. See `docker-compose.yml` and `.env.example` for the full set of settings.

### Bring your own game data

This repository does **not** ship game data, captures, or a working `WIRE_SEC_KEY`. The one exception is the crypto test in `packages/protocol/test/test_crypto.cjs`: it includes the AES key and IV from a single captured request as known-answer vectors. Those vectors check the key derivation, but they are not `WIRE_SEC_KEY` and cannot run the server. You must supply data you are entitled to use:

- Point `SUMIRE_DATA_DIR` at your local master-data directory (schema descriptors, master database, and related artefacts).
- Ask the maintainers in GitHub Discussions for data access. Data is distributed privately, not through the public repository.
- Tests that need game data skip automatically when `SUMIRE_DATA_DIR` is unset; they do not fail CI.

Never paste game data, captures, credentials, or keys into an issue, pull request, or LLM prompt.

## Documentation

- [AGENTS.md](AGENTS.md) — canonical guide for contributors and LLM coding agents: layout, request flow, endpoint workflow, hard rules.
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, data access, DCO sign-off, PR checklist.
- [ROADMAP.md](ROADMAP.md) — tracks, milestones, and endpoint status levels.
- [SECURITY.md](SECURITY.md) — private vulnerability reporting.
- [Discussions](https://github.com/project-hoshimi/sumire-sr/discussions) — feature requests, prioritisation polls, and data-access requests.

## Acknowledgements

Parts of the server are derived from [solis-server](https://github.com/vertesan/solis-server), an earlier open-source IDOLY PRIDE private server also licensed under AGPL-3.0. Thank you to its authors. [NOTICE](NOTICE) has the details.

## License and disclaimer

`sumire-sr` is licensed under the **GNU Affero General Public License v3.0**. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

This project is not affiliated with, endorsed by, or sponsored by QualiArts, CyberAgent, or the IDOLY PRIDE rights holders. IDOLY PRIDE and all related trademarks, game assets, and content belong to their respective owners. Game assets and master data are not distributed here.
