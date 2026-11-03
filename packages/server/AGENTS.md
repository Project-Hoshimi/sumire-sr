# packages/server — local conventions

Read [`../../AGENTS.md`](../../AGENTS.md) first. This file only covers rules specific to the server package.

## Layout

- `src/server.ts` — HTTP/2 + TLS gateway and RPC catch-all routes.
- `src/services/router.ts` — `dispatchRpc`, request decoding, output encoding, `CommonResponse` materialisation.
- `src/services/handlers.ts` — `register`, `getHandler`, `hasHandler`, `handlerOwnsState`, `RpcContext`, `RpcOutput`.
- `src/services/all.ts` — import list for every service module; ends with `registerReplayHandlers()`.
- `src/services/<area>.ts` — one domain per file (`card.ts`, `gacha.ts`, `photo.ts`, …).
- `src/db/schema.ts`, `src/db/tx.ts`, `src/db/client.ts` — Drizzle schema, `withPlayerTx`, database client.
- `src/profile.ts` — `PROFILE`, `parseProfile`, `isSandbox`.
- `src/profiles/sandbox/` — sandbox-only seeding, gacha overrides, and tests.

## Handler rules

- Register at module load with `register('Service:Method', handler, opts?)`. Registration is idempotent only in the sense that a duplicate throws; do not register the same name twice.
- Use `ctx.auth.claims.sub` for the account id and reject unauthenticated requests explicitly.
- Return a decoded object when possible so the router validates and encodes against the response schema. Return `Buffer` only for captured/replay responses or when you are reproducing exact bytes.
- Mutations go through `withPlayerTx(...)`; do not issue ad-hoc multi-statement writes outside a transaction.
- Return a `CommonResponse` with `UpdatedData`/`DeletedData` so the generic materialiser can persist player state. Declare `{ ownsState: true }` only when the handler persists its own state and must suppress the generic path.
- Throw `Error` with the RPC name in the message for invalid requests. Do not swallow errors silently.
- Log through `ctx.fastifyReq.log` with structured fields; never log tokens, keys, or player-identifying data.

## Sandbox rules

- `SUMIRE_PROFILE` unset means `official`; `isSandbox()` is the only switch.
- Every sandbox branch must leave the official path byte-for-byte unchanged.
- Sandbox-only code belongs in `src/profiles/sandbox/` or behind an `isSandbox()` guard in the existing service. Do not fork a service file.
- Unimplemented features in sandbox mode must return a graceful "not implemented" response/toast rather than a 500 that traps the client.

## TypeScript and tests

- Node 22 strips types directly. There is no `tsc` emit step. Avoid `enum`, `namespace`, parameter properties, and other non-erasable syntax; use `import type` for type-only imports.
- Keep imports explicit and relative with the `.ts` extension where the existing code does.
- Tests must run with plain `node` and the package's configured test command. Wire new tests into the root `npm run check`.
- Data-dependent tests check `process.env.SUMIRE_DATA_DIR` first and skip when it is unset.
- Use the Drizzle scripts declared in this package's `package.json` for schema generation and migrations; do not invent new migration commands.

## Before opening a PR

Run `npm run check` from the repository root and confirm `npm run gen` leaves `packages/protocol/src/gen/` unchanged.
