# AGENTS.md

Canonical guide for LLM coding agents and human contributors. `CLAUDE.md` points here. Read this file before changing code.

## Layout

| Path | What lives there |
|---|---|
| `packages/protocol/` | `@sumire-sr/protocol`: JSON schema descriptors in `schemas/`, generated TypeScript in `src/gen/` (never hand-edited), codec runtime in `src/runtime/proto.ts`, wire crypto in `src/crypto.cjs`, codegen in `codegen/`, and the capture decoder. |
| `packages/server/` | Fastify 5 + TypeScript server, PostgreSQL 18 + Drizzle. Services in `src/services/*.ts`; router in `src/services/router.ts`; profile switch in `src/profile.ts`; sandbox overrides in `src/profiles/sandbox/`. |
| `toolchain/` | il2cpp schema extraction, master-data harvest, and generated artefacts. Needs private game data. |
| `client/` | Frida scripts and emulator helpers for pointing the game client at a server. |
| `docs/` | Curated docs. `docs/ENDPOINTS.md` is generated; do not edit it by hand. |

Server stack facts: Node.js 22+ runs the TypeScript directly via type stripping, so there is no build step. Fastify 5 serves HTTP/2 + TLS. PostgreSQL 18 is the only datastore. There is no Redis, no gRPC framework, and no FastAPI.

## Request flow

1. `buildServer()` in `packages/server/src/server.ts` registers the RPC catch-all routes: `app.all('/api/*', handler)` and `app.all('/:service/:method', handler)`.
2. `handler(req, reply)` strips the optional 5-byte gRPC frame (`[compressed:1][length:4 BE][envelope]`), then calls `decrypt(inner)` from `packages/server/src/gateway/crypto.ts`.
3. The URL `/api.<Service>/<Method>` (or `/<Service>/<Method>`) becomes `name = "<Service>:<Method>"`.
4. `dispatchRpc(name, plain, req)` in `packages/server/src/services/router.ts` looks up `endpoints[service]?.[method]`, decodes the request with `decodeMessage(shape, new Reader(...))`, and resolves the handler with `getHandler(name)` from `packages/server/src/services/handlers.ts`.
5. The handler receives an `RpcContext` (`name`, `service`, `method`, `requestShape`, `responseShape`, `request`, `requestBytes`, `fastifyReq`, `auth`) and returns either a decoded object or final wire bytes. Authentication comes from `authenticate(...)` over the `x-auth-token` / `authorization` header.
6. The router encodes decoded output with `encodeMessage(shape, output, new Writer())`. If the handler did not declare `{ ownsState: true }`, `materializeState()` decodes any `CommonResponse` and applies it with `applyCommonResponse(...)` inside `withPlayerTx(...)`.
7. The gateway calls `encrypt(resp, ...)`, re-frames if the request was framed, and writes the response with `x-server-time` and gRPC trailers.

Handlers are registered at import time with `register('Service:Method', handler, opts?)`. `packages/server/src/services/all.ts` imports every service module, then calls `registerReplayHandlers()` for captured fallbacks. Duplicate registration throws.

## Add or implement an endpoint

1. **Confirm the schema.** Find the RPC's request/response messages in `packages/protocol/schemas/`. If the descriptor is missing, extract it from the il2cpp dump with `toolchain/`; do not hand-write wire layouts from guesses.
2. **Regenerate.** Run `npm run gen`. It rewrites `packages/protocol/src/gen/` deterministically. Never edit generated files.
3. **Write the handler.** Add it to the matching `packages/server/src/services/<area>.ts`:

   ```ts
   register('Service:Method', async (ctx) => {
     // read ctx.request, ctx.auth, and the database
     return decodedResponse;
   });
   ```

   If you created a new service file, import it from `packages/server/src/services/all.ts` before `registerReplayHandlers()`.
4. **Guard sandbox behaviour.** Sandbox-only changes must be guarded with `isSandbox()` from `packages/server/src/profile.ts`. The official path must stay unchanged when `SUMIRE_PROFILE` is unset or `official`.
5. **Persist correctly.** Mutations use `withPlayerTx(...)`. Return a `CommonResponse` (`UpdatedData` / `DeletedData`) unless the handler declares `{ ownsState: true }` and writes state itself.
6. **Test.** Add a focused test for the handler and, where possible, a capture or fixture-based assertion. Tests that need game data check `SUMIRE_DATA_DIR` and skip when it is unset.
7. **Check.** Run `npm run check`. For schema or generated-code changes, also run `npm run gen && git diff --exit-code packages/protocol/src/gen`.
8. **Report.** Fill in the pull-request template: endpoint(s), track, verification method, capture used, and AI tools used.

## Hard rules

- **Never hand-edit `packages/protocol/src/gen/`.** It is generated. Change `packages/protocol/schemas/` or `packages/protocol/codegen/`, then run `npm run gen`.
- **Never commit game data, captures, keys, or `.env`.** This includes APKs, dumps, master blobs, `*.db`, `*.dump`, `*.pem`, `*.key`, and anything under `captures/`, `keys/`, `backups/`, `phase3d*/`, or `phaseA2/`.
- **Never hardcode `WIRE_SEC_KEY`.** Read it from the environment. The key is distributed privately by maintainers and must never appear in source, tests, fixtures, logs, or CI.
- **Do not change official behaviour while adding sandbox overrides.** Default profile is `sandbox` (`official` must be set explicitly), but every sandbox branch is still guarded with `isSandbox()` so the official path stays untouched.
- **Do not change wire shapes without schema and capture evidence.** Field numbers, wire types, and enum values are compatibility surfaces.
- **Do not add Redis, gRPC frameworks, or FastAPI.** The stack is Fastify + PostgreSQL + Drizzle.
- **Keep Node 22 type stripping working.** Use erasable TypeScript only: no `enum`, `namespace`, or parameter properties in server code; use `import type` for type-only imports.
- **No personal data in the repository.** No personal paths, device serials, IP addresses, hostnames, emails, or account names in code, docs, tests, fixtures, or commit messages.
- **Data-gated tests must skip, not fail,** when `SUMIRE_DATA_DIR` is unset. CI runs without game data.

## Environment

| Variable | Purpose |
|---|---|
| `SUMIRE_DATA_DIR` | Path to private game data used by the server and toolchain. Required for a functional server; optional for data-free checks and CI. |
| `SUMIRE_PROFILE` | `sandbox` or `official`. Unset means `official`. |
| `WIRE_SEC_KEY` | Wire-crypto secret from a maintainer. Never committed. |
| `JWT_PRIVATE_KEY_PATH` | RS256 signing key path. Generated on first boot if missing. |
| `DATABASE_URL` | PostgreSQL 18 connection string. |

## Commands

| Command | Purpose |
|---|---|
| `npm install` | Install the workspace. |
| `npm run check` | Typecheck and run the data-free test suite. The required pre-PR gate. |
| `npm run check:full` | `check` plus the data/PostgreSQL-dependent server tests. |
| `npm run gen` | Regenerate `packages/protocol/src/gen/` from schema descriptors. |
| `npm run docs:endpoints` | Regenerate `docs/ENDPOINTS.md` from schemas and registered handlers. |
| `npm run -w packages/server dev` | Run the server with Node's watcher, no build step. |

Run the server in sandbox mode with `SUMIRE_PROFILE=sandbox npm run -w packages/server dev`.

## Where to look first

- Wire format and codec: `packages/protocol/src/runtime/proto.ts`, `packages/protocol/src/crypto.cjs`.
- Routing and state materialisation: `packages/server/src/services/router.ts`, `packages/server/src/services/playerState.ts`.
- Handler registration: `packages/server/src/services/handlers.ts`.
- Profile switch: `packages/server/src/profile.ts`.
- Sandbox seeding and overrides: `packages/server/src/profiles/sandbox/`.
- Database schema and transactions: `packages/server/src/db/schema.ts`, `packages/server/src/db/tx.ts`.
