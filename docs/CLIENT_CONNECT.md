# Client connect — Add private server

How a player points the game at a sumire-sr instance from the in-game **Add
private server** dialog. The client fetches the private dev CA over the same
HTTPS listener the game uses (8443) and trusts it for the game's hostnames.

## URL forms

The dialog accepts all of these:

| Form | Example | Use |
|---|---|---|
| HTTPS URL | `https://<server-ip>:8443` | Normal entry; the player confirms the CA fingerprint |
| Host and port | `<server-ip>:8443` | Same as above, scheme implied |
| Invite URL | `https://<server-ip>:8443#sha256=AA:BB:…` | Pre-confirms the CA fingerprint; no prompt |

The `#sha256=` value is the full SHA-256 fingerprint of the server CA, uppercase
hex with colons. The server prints it at startup:

```
CA fingerprint (SHA-256): <full>  short: <short>
```

The same values are available without auth at:

- `GET /.well-known/sumire/ca.pem` — the CA PEM (`application/x-pem-file`)
- `GET /.well-known/sumire/server.json` — `{ "name", "caSha256", "caSha256Short" }`

## Local instances (LAN or IP)

The instance uses the private dev CA (`tls/ca.crt`) and a leaf for the game's
hostnames, which no public CA can issue. The client cannot trust that CA in
advance, so the player either:

1. confirms the fingerprint shown at server startup matches the one in the
   dialog, or
2. opens an invite URL with `#sha256=<fingerprint>` so confirmation is skipped.

Start the server as usual, from the server package directory (`packages/server` in the public repository):

```sh
TLS=1 HTTP2=1 PORT=8443 node src/server.ts
```

## Public instances (your own domain)

If the server is reachable through a real domain with a public certificate
(for example Let's Encrypt), point the client at that domain. The CA is then
fetched over TLS the device already trusts, so no fingerprint confirmation is
needed. The game's redirected hostnames still get the private-CA leaf: the
public certificate is only used when the TLS SNI name matches
`TLS_PUBLIC_HOSTNAME`.

```sh
TLS=1 HTTP2=1 PORT=8443 \
TLS_PUBLIC_HOSTNAME=sumire.example.com \
TLS_PUBLIC_CERT=/etc/letsencrypt/live/sumire.example.com/fullchain.pem \
TLS_PUBLIC_KEY=/etc/letsencrypt/live/sumire.example.com/privkey.pem \
node src/server.ts
```

The player then enters `https://sumire.example.com:8443` (or `sumire.example.com:8443`).

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `TLS_CA_CERT` | `<repo>/tls/ca.crt` | CA served by the bootstrap endpoints and fingerprinted at startup. Missing file → both endpoints return 404 and startup logs a warning. |
| `SUMIRE_SERVER_NAME` | `sumire-sr` | Value of `name` in `server.json`. |
| `TLS_PUBLIC_HOSTNAME` | unset | SNI name that selects the public certificate. |
| `TLS_PUBLIC_CERT` | unset | Public certificate chain (PEM) for `TLS_PUBLIC_HOSTNAME`. |
| `TLS_PUBLIC_KEY` | unset | Private key (PEM) for the public certificate. |

All three `TLS_PUBLIC_*` variables must be set to enable SNI selection.
Otherwise the server behaves exactly as before and serves the game leaf for
every connection.
