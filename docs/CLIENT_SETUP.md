# Client setup — private server (HoshimiLocalify-sr redirect)

For players/devices pointing the game at a sumire-sr instance. The **primary** path is the [HoshimiLocalify-en](https://github.com/Project-Hoshimi/HoshimiLocalify-en) mod; it needs no Frida and no system CA. The Frida redirect (`frida/attach_e2e.sh` + `frida/e2e_hooks.js`) is **legacy** and kept only for diagnostics and the love-story replay patch (see §3).

## 1. Mod settings

Install the fork's APK and enable it in LSPosed for `game.qualiarts.idolypride`. In the module app, open **Settings → Private Server** and configure:

- **Enable** toggle — master switch (`privateServerEnabled`).
- **Server URL** — `https://<server-lan-ip>:8443`, **no trailing slash** (e.g. `https://<server-lan-ip>:8443`). It must be an **IPv4 address** for the mod's preserve-host mode: the game keeps its own hostnames, and only their DNS answers and connections are pointed at this address and port.
- **Server CA PEM** — paste **all** of the private server's `tls/ca.crt`.

Force-stop the game and launch it **from the module app** the first time, so the config travels with the `iprData` extra.

Without root: LSPatch-patch the game with the module embedded (see the fork's `FORK.md`). No Magisk CA module is needed — the mod injects the CA into the gRPC roots and into the Android accepted-issuer list that Unity reads.

## 2. Server side

Run with TLS + HTTP/2 on the port the phone can reach:

```
cd fastify-api
TLS=1 HTTP2=1 PORT=8443 node src/server.ts
```

- **Leave `PUBLIC_BASE_URL` unset** (default `https://api.game-idolypride.jp`). The mod keeps the game's real hostnames and steers them to the server address at the DNS/connect level. Unity's TLS checks the certificate CN only (CN=`api.game-idolypride.jp`), so a master `DownloadUrl` pointing at an IP fails with `Curl error 60: Cert verify failed. Certificate Common Name(CN) does not match`. `PUBLIC_BASE_URL` is only for setups that rewrite URLs (none currently).
- The server binds `0.0.0.0`, so the phone must reach it directly over the LAN. An `adb reverse tcp:8443 tcp:8443` tunnel with Server URL `https://127.0.0.1:8443` also works for USB testing.
- The server TLS cert (`tls/api.crt`, signed by `tls/ca.crt`) carries CN `api.game-idolypride.jp`; its SANs are in `tls/api.ext`.
- `tls/ca.crt` is the CA to paste (subject `CN=Idoly Pride Dev CA`).
- `allowHTTP1: true` is kept on (see `fastify-api/src/tls.ts`); without it UnityWebRequest master downloads get `403 "Missing ALPN"`.
- The config entry is `publicBaseUrl` in `fastify-api/src/config.ts`, read from `PUBLIC_BASE_URL` (default `https://api.game-idolypride.jp`).

## 3. Frida fallback (legacy — diagnostics and love-story replay patch)

```
adb reverse tcp:443 tcp:8443
bash frida/attach_e2e.sh captures/<session>
```

Uses `frida/e2e_hooks.js` to rewrite `getaddrinfo`/`connect` and `Solis.Common.Network.Api.GetSSLRootCertificates()`. Keep the Magisk CA module on for this path. Not the normal way to play.

## 4. Verification

1. Launch the game; logcat shows `PrivateServer: mode=preserve-host` and the `resolve`/`connect` lines in §6.
2. Server log shows the `Auth:Login` RPC.
3. Game reaches the home screen.
4. Master downloads hit `/master/:type/:file` (server log / route in `fastify-api/src/server.ts`).
5. Octo `/v2/*` requests are proxied upstream.
6. No failed TLS handshakes in the server log.

Regression: turn the switch off and relaunch — the game should reach the official servers, with no hooks installed.

## 5. Troubleshooting

- **Curl 60 CN mismatch** — `PUBLIC_BASE_URL` is set to an IP; unset it.
- **gRPC "Connection refused (os error 111)"** — the server is not reachable on 8443, or the mod build is too old (it needs the `connect` 443→port rewrite).
- **"Certificate is not correctly signed by a trusted CA"** — the CA PEM is missing or wrong in the mod, or the game was launched before the config arrived (launch once from the mod app).
- **A fresh install making a new account** — expected; accounts are keyed by Firebase UID (see `fastify-api/src/services/auth.ts`).

## 6. Logcat checks

- `PrivateServer: mode=preserve-host …`
- `PrivateServer: resolve api.game-idolypride.jp… -> <ip>:8443`
- `PrivateServer: connect <ip>:443 -> <ip>:8443`
- `PrivateServerTrust: getAcceptedIssuers … augmented N -> N+1`

## Related files

- `fastify-api/src/config.ts` (`publicBaseUrl`)
- `fastify-api/src/services/master.ts` (`DownloadUrl`)
- `fastify-api/src/server.ts` (`/master/:type/:file`, `/v2/*`)
- `fastify-api/src/tls.ts` (`allowHTTP1`)
- `tls/ca.crt`, `tls/api.ext`
- `frida/attach_e2e.sh`, `frida/e2e_hooks.js` (legacy)
- `sumire-sr/HoshimiLocalify-sr` (`feat/private-server` branch, `FORK.md`)
