# Roadmap

`sumire-sr` has two delivery tracks that share one codebase. The active track is selected with `SUMIRE_PROFILE` (`sandbox` or `official`; unset defaults to `sandbox`; `official` is the full mode and must be set explicitly). Profiles are configuration, not forks.

## Endpoint status levels

Every RPC endpoint moves through the same ladder. The generated [docs/ENDPOINTS.md](docs/ENDPOINTS.md) records the current level per endpoint.

| Level | Meaning |
|---|---|
| `missing` | No handler and no response. The client should not depend on it. |
| `stub` | The endpoint is registered but returns an empty/default response, a captured replay, or an explicit "not implemented" path. Enough to keep the client alive, not enough to be correct. |
| `sandbox-ok` | Works correctly in `SUMIRE_PROFILE=sandbox` (including sandbox-only overrides). Official behaviour may still differ. |
| `parity` | Matches the official server's observable behaviour closely enough to pass capture-based and behavioural tests. This is the highest level. |

`docs/ENDPOINTS.md` is generated from the protocol schema and handler registry. Do not edit it by hand; regenerate it with `npm run docs:endpoints`.

## Track 1 — Sandbox (`sandbox-v1`)

Goal: a fast, self-contained private server that is fun to play and useful for testing the client.

Milestone scope:

- Full photo mode, including shooting, recipes, poses, and saved photos.
- Story mode, including card stories and event story playback.
- A maxed account seeded with every cosmetic and every card.
- Every card available on every banner.
- Free pulls (no currency or ticket consumption in sandbox mode).
- Graceful degradation: features that are not implemented (for example PvP, rankings, or guilds) must respond with a "not implemented" toast rather than an error that traps the client.

Run it with:

```sh
SUMIRE_PROFILE=sandbox npm run -w packages/server dev
```

Sandbox-only behaviour must be guarded with `isSandbox()` and must not change the official code path.

## Track 2 — Official parity (`parity`)

Goal: a full reimplementation of the official servers.

Work is ordered by player impact and by what blocks other endpoints:

1. Auth, account lifecycle, and session integrity.
2. Master data, home, user, and bootstrap flows.
3. Economy: currency, inventory, shop, gacha, gifts, and purchases with server-authoritative validation.
4. Progression: cards, decks, missions, login bonuses, stories, and activities.
5. Social and competitive systems: friends, guilds, profiles, rankings, PvP, and events.
6. Operational hardening: rate limits, audit logs, backups, and deliberate errors for unknown RPCs.

Official parity work must be justified by captures or other observable evidence. "It works in sandbox" is not parity.

## Prioritisation

Both tracks are prioritised with community feedback. Feature proposals and polls live in [GitHub Discussions](https://github.com/project-hoshimi/sumire-sr/discussions). Maintainers use the polls, issue demand, and blocker analysis to order the next milestone.

## How status is reported

- Open an endpoint request with the `implement-endpoint` issue template.
- Pull requests state the endpoint(s), the track, how the change was verified, and whether a capture was used.
- Status changes are reflected in `docs/ENDPOINTS.md` after regeneration.
