# client — local conventions

Read [`../AGENTS.md`](../AGENTS.md) first. This directory contains Frida scripts and emulator helpers that point the game client at a local server.

## Rules

- **Never commit game builds, APKs, certificates, private keys, captures, or device dumps.** These are covered by the root `.gitignore`, but verify `git status` before committing.
- **No personal or device-specific values in scripts.** Device serials, IP addresses, hostnames, account names, and local paths must be passed as arguments or environment variables. Do not default to a specific device.
- **Pin the target explicitly.** Callers select the device/serial; scripts must not fall back to a bare `adb` or an arbitrary attached device.
- **Keep scripts idempotent and reversible.** Starting a redirect must have a matching stop/restore path, and failures must be reported clearly.
- **Do not leave background processes running.** Long-lived helpers are the caller's responsibility and must be stoppable.
- **TLS material is local-only.** Generate development certificates on the machine; never commit `*.pem`, `*.key`, or a private CA.
- **Official servers are off-limits by default.** A script that talks to the official service must require an explicit opt-in and must be documented as diagnostic-only.
- **Captures are private data.** Write them to an ignored directory and never attach them to an issue or pull request.
- **Document the client version and prerequisites** in the script header or the adjacent README. Unsupported client builds fail with a clear message.

## Scope

This directory is for client-side plumbing, not server behaviour. If a change needs a server response, implement it in `packages/server` and keep the client script limited to redirect/transport concerns.

## Testing

Run the script against a local server in sandbox mode first. Verify that stopping the script restores the normal client path. Do not require game data to run syntax checks; gate data-dependent checks on `SUMIRE_DATA_DIR`.
