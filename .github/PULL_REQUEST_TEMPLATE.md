## Endpoint(s)

<!-- List the RPCs, e.g. `Card:Enhance`. Write "n/a" for non-endpoint changes. -->

## Track

- [ ] `sandbox-v1`
- [ ] `parity`
- [ ] Tooling / docs / CI

## How verified

<!-- Commands run, tests added, manual steps, client behaviour observed. Be specific. -->

## Capture used

<!-- Capture id/date and the endpoint, or "none". Do not attach game data or raw captures. -->

## Checks

- [ ] `npm run check` passes.
- [ ] `npm run gen && git diff --exit-code packages/protocol/src/gen` is clean (if schemas or codegen changed).
- [ ] No game data, captures, keys, `.env`, `*.pem`, `*.key`, `*.db`, or dumps are included.
- [ ] No personal paths, device serials, IPs, hostnames, emails, or account names are included.
- [ ] Commits are signed off (`git commit -s`).

## AI tools used

<!-- List tools/models, or "none". You are responsible for testing LLM-assisted code. -->

## Notes

<!-- Anything reviewers should know: official-behaviour impact, sandbox guards, follow-ups. -->
