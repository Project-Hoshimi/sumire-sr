# toolchain — local conventions

Read [`../AGENTS.md`](../AGENTS.md) first. This file only covers the reverse-engineering and data pipelines.

## What this package does

- Extracts schema descriptors from an il2cpp dump and writes them to `packages/protocol/schemas/`.
- Harvests master data (manifest → encrypted blobs → decoded rows → master database).
- Produces generated artefacts consumed by the server and protocol packages.

The pipeline needs private game data. It cannot run from a clean public clone.

## Inputs and data handling

- Set `SUMIRE_DATA_DIR` to the directory containing your private data. Never hardcode a developer-specific path.
- Do not commit APKs, `libil2cpp.so`, `global-metadata.dat`, dumps, decoded JSON, master blobs, `master.db`, captures, certificates, or keys. The root `.gitignore` covers the usual names; do not rely on it as a substitute for checking `git status`.
- Keep large intermediates outside the repository or in an ignored directory.
- Do not redistribute game assets. The repository contains tooling and descriptors, not game content.
- Scrub logs and fixtures of device serials, IP addresses, hostnames, account names, and tokens.

## Reproducibility

- Record the client version and tool versions used for every extraction in the output's metadata or the PR description.
- Keep steps deterministic: stable ordering, no timestamps in generated descriptors, no absolute paths.
- Write outputs atomically and make re-runs idempotent.
- Prefer explicit CLI arguments and environment variables over interactive prompts so CI and other contributors can reproduce the step.

## Changing generated artefacts

If a toolchain change alters `packages/protocol/schemas/` or generated code, run `npm run gen` and commit the regenerated files together with the tool change. Keep the drift check green.

## Tests

- Unit-test parsers and transforms with small synthetic inputs that contain no game data.
- Gate end-to-end tests on `SUMIRE_DATA_DIR`; skip when it is unset.
- Run `npm run check` before opening a pull request.
