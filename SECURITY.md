# Security policy

## Reporting a vulnerability

Please report security vulnerabilities privately through GitHub Security Advisories:

**https://github.com/project-hoshimi/sumire-sr/security/advisories/new**

Do **not** open a public issue, discussion, or pull request for a vulnerability. Do not include real player data, game data, captures, private keys, or `WIRE_SEC_KEY` values in a report; redact them.

## What to include

- The affected component (`packages/server`, `packages/protocol`, `toolchain`, `client`, CI, or deployment files).
- The affected commit, version, or branch.
- A description of the issue and its impact.
- Reproduction steps or a proof of concept, using synthetic data where possible.
- Any suggested fix or mitigation.

## Scope

In scope:

- Authentication, authorization, and session handling in `packages/server`.
- Wire-crypto and codec issues in `packages/protocol`.
- Injection, deserialization, path traversal, and denial-of-service issues in the server or toolchain.
- Secret leakage or unsafe defaults in the repository, Docker setup, CI, or client helpers.

Out of scope:

- Vulnerabilities in the official game client or official servers.
- Vulnerabilities in third-party dependencies; report those upstream and notify us if the impact is specific to this project.
- Social engineering, physical access, and issues that require a compromised host.

## Response

Maintainers will acknowledge the report as soon as practical, investigate, and coordinate a fix and disclosure timeline with the reporter. This is a volunteer project, so response times are best-effort.

## Supported versions

The project is pre-1.0. Security fixes land on `main`; there are no long-lived release branches yet.
