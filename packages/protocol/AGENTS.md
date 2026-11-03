# packages/protocol — local conventions

Read [`../../AGENTS.md`](../../AGENTS.md) first. This file only covers rules specific to the protocol package.

## Layout

- `schemas/` — JSON descriptors extracted from the il2cpp dump: messages, enums, and endpoints. This is the source of truth.
- `src/gen/` — generated TypeScript message/enum/endpoint modules and `registry.ts`. Never hand-edit.
- `src/runtime/proto.ts` — codec runtime: shape registration, `Reader`, `Writer`, `decodeMessage`, `encodeMessage`, `msgRegistry`.
- `src/crypto.cjs` — wire crypto primitives. The key is supplied by the caller; never embed a real key.
- `codegen/` — deterministic generator that turns `schemas/` into `src/gen/`.
- Capture decoder — turns captured frames into decoded messages for comparison; fixtures must stay out of the public repo unless they contain no game data.

## Rules

- **Schema first.** Change `schemas/`, then run `npm run gen`. A pull request that edits `src/gen/` without a matching schema/codegen change is rejected.
- **Keep codegen deterministic.** No timestamps, random ordering, absolute paths, or environment-dependent output. CI runs `npm run gen && git diff --exit-code packages/protocol/src/gen`.
- **Preserve wire compatibility.** Do not renumber fields, change wire types, or reuse enum values. Unknown or removed fields stay reserved according to the dump.
- **Do not hand-edit generated files.** This includes `src/gen/registry.ts`, `endpoints.ts`, `enums.ts`, and every generated message module.
- **Never commit `WIRE_SEC_KEY`.** `src/crypto.cjs` exposes primitives; the server obtains the secret from the environment. Tests use an obviously fake key and never a real one.
- **No game data in fixtures.** Captures, master blobs, and extracted assets are private data. If a test needs them, gate it on `SUMIRE_DATA_DIR` and skip when unset.
- **Byte-exact means byte-exact.** When a codec change is justified by a capture, include the before/after hex or a decoder assertion. Do not "fix" a field based on intuition.
- **Keep generated code readable enough to diff.** The generator's output is reviewed by humans; stable ordering matters more than compactness.

## Workflow

1. Update or add descriptors in `schemas/`.
2. Run `npm run gen`.
3. Inspect the generated diff for only the expected files.
4. Add or update codec tests.
5. Run `npm run check`.
6. Confirm the drift check is clean.
