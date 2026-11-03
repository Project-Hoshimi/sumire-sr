# Contributing to sumire-sr

Thanks for helping build a community private server for IDOLY PRIDE. This project has two tracks (`sandbox-v1` and `parity`); see [ROADMAP.md](ROADMAP.md) for what that means and [AGENTS.md](AGENTS.md) for the code-level workflow.

## Setup

Requirements: Node.js 22+, npm, Docker (for PostgreSQL), and git.

```sh
git clone https://github.com/project-hoshimi/sumire-sr.git
cd sumire-sr

npm install
cp .env.example .env
# Edit .env:
#   WIRE_SEC_KEY=...          (ask a maintainer; never commit it)
#   SUMIRE_DATA_DIR=...       (required for a functional server; not needed for data-free checks)

docker compose up -d postgres
npm run check
```

Run the server locally with:

```sh
SUMIRE_PROFILE=sandbox npm run -w packages/server dev
```

`npm run check` is the required pre-PR gate. It typechecks and runs the test suite. Data-dependent tests skip when `SUMIRE_DATA_DIR` is unset, so you can contribute server and protocol code without game data.

## Game data and captures

This repository does **not** distribute game data, captures, master blobs, APKs, or a working `WIRE_SEC_KEY`.

- Request data access from the maintainers in [GitHub Discussions](https://github.com/project-hoshimi/sumire-sr/discussions). Access is granted privately and is not a public download.
- Point `SUMIRE_DATA_DIR` at your local copy. Never commit it or paste it into an issue, PR, chat, or LLM prompt.
- Captures are evidence, not distributable content. Keep them out of git and describe the relevant bytes or decoded fields in the PR instead.
- Do not ask for or share keys in public channels.

If you are unsure whether a file is safe to commit, treat it as private and ask first.

## DCO sign-off

All commits must carry a Developer Certificate of Origin sign-off. Use:

```sh
git commit -s
```

The sign-off certifies that you wrote the contribution or have the right to submit it under the project's license (AGPL-3.0). Pull requests without sign-off will be asked to amend.

## LLM-assisted contributions

LLM-assisted PRs are welcome. You are responsible for the result:

- Test it yourself. "The model said it works" is not verification.
- Explain how you verified it in the PR template, including the commands, captures, or manual steps you used.
- Disclose the tools you used in the "AI tools used" field.
- Do not paste private game data, captures, keys, player data, or non-public logs into an LLM.
- Review generated code for invented APIs, hardcoded secrets, and changes to official behaviour.

## Pull requests

Keep PRs focused. One endpoint, one refactor, or one clearly related group of changes. Fill in [the PR template](.github/PULL_REQUEST_TEMPLATE.md).

Checklist:

- [ ] The endpoint(s) and track are stated.
- [ ] `npm run check` passes.
- [ ] `npm run gen && git diff --exit-code packages/protocol/src/gen` is clean when schemas or codegen changed.
- [ ] No game data, captures, keys, `.env`, `*.pem`, `*.key`, `*.db`, or dumps are included.
- [ ] No personal paths, device serials, IPs, hostnames, emails, or account names are included.
- [ ] Official behaviour is unchanged when adding sandbox overrides; overrides are guarded with `isSandbox()`.
- [ ] Tests cover the change, and data-gated tests skip without `SUMIRE_DATA_DIR`.
- [ ] Commits are signed off with `git commit -s`.
- [ ] Documentation is updated when behaviour or status changes.

## Endpoint work

Read the endpoint workflow in [AGENTS.md](AGENTS.md). In short: schema descriptor → `npm run gen` → handler in `packages/server/src/services/` → test → `npm run check`. Never hand-edit `packages/protocol/src/gen/`.

## Issues and prioritisation

- Use the `implement-endpoint` template to request or claim an RPC.
- Use the bug template for reproducible defects.
- Use [Discussions](https://github.com/project-hoshimi/sumire-sr/discussions) for feature requests, prioritisation polls, and data-access requests.
- Report security issues privately via [SECURITY.md](SECURITY.md), never in a public issue.

## License

By contributing, you agree that your contribution is licensed under the GNU Affero General Public License v3.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
