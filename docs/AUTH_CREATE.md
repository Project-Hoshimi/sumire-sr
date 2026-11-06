# Auth:Create — self-service accounts on a fresh install

Status: done (2026-10-25). Server and mod are both implemented; a fresh install on the Moto G created an account and reached HOME (§6). The new account was seeded from the corpus account, so it skipped the tutorial; see `captures/2026-10-25_fresh_official/README.md` for the real fresh-account flow.

## 1. What the client does (from `phase3d/dump/dump.cs`, captures)

Messages (`fastify-api/src/gen/Solis_Common_Proto_Api_Auth*.ts`):

| RPC | Request | Response |
|---|---|---|
| `Auth:Create` | `FirebaseUID` | `FirebaseCustomToken` |
| `Auth:Login` | `FirebaseIDToken` | `GameAuthToken`, `UserPublic`, `RequiredFirebaseReauthenticate` |
| `Auth:Recreate` | `FirebaseIDToken` | `FirebaseCustomToken` |
| `Auth:Delete` | `Empty` | (empty) |

Fresh install (inferred from `AccountManager` state machines, dump.cs ~788050–788290; no IL bodies, so the order is inferred, not confirmed):

1. `Auth:Create(FirebaseUID)` → server returns a **Firebase custom token**.
2. `SeedWrapper.Auth.SignInWithCustomTokenAsync` → the Firebase SDK posts it to
   identitytoolkit `signInWithCustomToken` and gets an ID token plus a refresh token.
3. `Auth:Login(FirebaseIDToken)` → `GameAuthToken`.
4. Later ID tokens come from `securetoken.googleapis.com/v1/token` (refresh);
   `FirebaseRestApi.GetIdTokenAsync` also calls it directly as a backup.

Recovery (`LoginWithRecoveryIdTokenAsync`) is `Auth:Recreate` → custom token → step 2 → step 3.

The captured official ID token (`captures/2026-10-09_photo_official`) has
`iss=https://securetoken.google.com/solis-firebase`, `aud=solis-firebase`,
`firebase.sign_in_provider=custom`. So official accounts are made this way: the server mints a custom token, and Firebase exchanges it.
`Auth:Create` / `Recreate` were never captured.

## 2. The blocker

A custom token is accepted only if it's signed by a service account of the Firebase project `solis-firebase`. We don't have that key, and the server can't get it. Today the mod redirects only
`api.game-idolypride.jp`, `climaster.game-idolypride.jp`, `api.octo-cloud.com`
(`HoshimiLocalify-sr/app/src/main/cpp/HoshimiLocalify/PrivateServer.cpp:682`), so step 2 goes to real Google, which rejects any token we mint. Returning an empty token, as the server does now, fails at `SignInWithCustomTokenAsync` with "Given String is empty or null".

Existing accounts still work only because their Firebase session (refresh token) predates the private server and real Google keeps refreshing it.

## 3. Options

| | Option | Client change | Verdict |
|---|---|---|---|
| A | **Emulate Firebase Auth on sumire-sr.** The mod also redirects the Firebase Auth hosts; the server implements `signInWithCustomToken`, token refresh and account lookup, and signs its own ID tokens. | Add hosts to the redirect list, plus a cert with those SANs | **Recommended** |
| B | Hook the client's C# layer (`AccountManager.SignInAsync` / `GetFirebaseIdTokenAsync`) to skip Firebase and pass the server's token straight through. | IL2CPP hooks that build fake `AuthResult`/`FirebaseUser` objects | Fragile. It breaks on every app update, and other Firebase calls still see a signed-out user. |
| C | Server-only: mint a token real Google accepts. | none | Impossible without the `solis-firebase` service-account key. |
| D | No self-service: an admin creates accounts and the player uses data transfer (solis's model). | none | Needs `Migration:*` anyway; it's a fallback, not sign-up. |

### Recommended: A

Server (no client change, safe to land now):
- `Auth:Create`: accept the `FirebaseUID` (generate one if it's empty), create the account through `findOrCreateIdentity`, and return a custom token signed with our RS256 key. Its claims follow the Firebase custom-token format (`uid`, `aud=…IdentityToolkit`, 1 h expiry).
- `Auth:Recreate`: take the UID from the ID token and return a new custom token.
- Firebase Auth REST emulation on the same `:8443` listener, routed by path and host-agnostic:
  - `POST /v1/accounts:signInWithCustomToken` (identitytoolkit.googleapis.com) and the legacy
    `POST /identitytoolkit/v3/relyingparty/verifyCustomToken` (www.googleapis.com). Verify our signature,
    then return `idToken`, `refreshToken`, `expiresIn`, `isNewUser`.
  - `POST /v1/token` (securetoken.googleapis.com, `grant_type=refresh_token`) → `id_token`,
    `refresh_token`, `expires_in`, `user_id`, `project_id`. The JSON form uses snake_case.
  - `POST /v1/accounts:lookup` and `/identitytoolkit/v3/relyingparty/getAccountInfo`, which the SDK calls after sign-in.
  - ID tokens copy the official claim shape (`iss=https://securetoken.google.com/solis-firebase`,
    `aud=solis-firebase`, `user_id`, `sub`, `firebase.sign_in_provider=custom`), signed RS256 by us. Refresh tokens are opaque and stored per account.
- `Auth:Login` keeps reading `user_id` as it does today. Hardening follow-up: verify the signature on our own ID tokens, and accept unverified legacy Google tokens only for accounts that already exist.

Client (HoshimiLocalify-sr, approved 2026-10-25; as built, see §6):
- Add `identitytoolkit.googleapis.com`, `securetoken.googleapis.com` and `www.googleapis.com` to the redirect list. `www.googleapis.com` is also used by other Google APIs, so that redirect should apply only to the game process, which it already does.
- The Firebase Android SDK resolves through Java (`InetAddress` → `android_getaddrinfo`), which may bypass the native `getaddrinfo` hook. Confirm with a logcat trace on a cold start. If it does bypass it, add a Kotlin-side hook (e.g. `InetAddress.getAllByName`) in `HoshimiHookMain.kt`.
- Java TLS already trusts the dev CA (`PrivateServerTrust.kt`), but `tls/api.crt` lacks these SANs. Re-issue it from `tls/ca.key` with the three googleapis names added.
- Leave `id.qseed.jp/getId` on the real host unless it turns out to block (it issues the seed id, not an auth token).

## 4. Risks / open questions
- Is the call order in §1 right? Check it on device: the server logs every RPC.
- Does the SDK call any other endpoint on first sign-in (`firebaseinstallations`, App Check)? The emulator logs and 404s anything unknown, which is how we find out.
- Existing accounts (such as account A) keep their real Google session. Once Firebase is redirected, their refresh goes to us and fails. The fix is for `/v1/token` to accept unknown refresh tokens, or to recover through `Auth:Recreate`. Test this before redirecting on a device whose account matters.

## 5. Implemented (server side)
- `Auth:Create` and `Auth:Recreate` are registered in `fastify-api/src/services/auth.ts`; identity lookup is shared through `findOrCreateIdentityByUid(uid)`. `Auth:Create` generates a 28-char base62 uid when `FirebaseUID` is empty.
- Firebase Auth emulation lives in `fastify-api/src/firebaseEmu.ts` (`registerFirebaseEmu`, wired in `src/server.ts` before the gRPC routes) and covers `signInWithCustomToken`, legacy `verifyCustomToken`, `/v1/token`, `lookup`, and legacy `getAccountInfo`, accepting JSON or form bodies on every route.
- Token minting/verification is in `fastify-api/src/auth/firebaseTokens.ts` on the existing RS256 key pair (`src/auth/jwt.ts` now exposes generic `signJwt`/`verifyJwt`). Deviation from §2: refresh tokens are stateless signed JWTs (`{typ:'refresh',uid}`, one-year expiry) instead of opaque stored tokens, so no migration is needed.
- `npm run test:authcreate` (`src/authcreatetest.ts`) covers the pure token functions and all emulator routes; the `Auth:Create`/`Auth:Recreate` handler tests run only when Postgres is reachable.

## 6. Client side as built, and verification

HoshimiLocalify-sr `feat/private-server` (merged from `swarm/deepseek-builder/firebase-redirect`, 549b4e3..e9f979a). Each layer was needed; the device logs showed every earlier attempt failing at the next one:
1. **Hosts:** `identitytoolkit`, `securetoken` and `www.googleapis.com` were added to `g_redirectHosts`. Firebase actually uses `www.googleapis.com/identitytoolkit/v3/relyingparty/*` first.
2. **Java DNS:** hooking `InetAddress.getAllByName` alone missed framework okhttp. The hook that fires is `Inet6AddressImpl.lookupAllHostAddr`, plus libcore `android_getaddrinfo` and native `android_getaddrinfofornet[context]`.
3. **Port 443→8443:** Java sockets are dual-stack, so they connect to `::ffff:a.b.c.d`. The fix: the native `connect` hook now handles v4-mapped `AF_INET6`, and there is a Java `IoBridge`/libcore `connect` hook, which is the one that fires.
4. **Java TLS:** Android's network security config ignores `getAcceptedIssuers`. The dev CA is now added as an anchor through `NetworkSecurityConfig.findTrustAnchor*` / `findAllCertificatesByIssuerAndSignature`, with a dev-CA-only fallback on `RootTrustManager` / `NetworkSecurityTrustManager` / Conscrypt `checkServerTrusted`. Pins are not overridden, and hostname verification is unchanged.
5. **Server cert:** `tls/api.crt` was re-issued from the same key. It adds SANs for the three googleapis hosts, `climaster.game-idolypride.jp` and `IP:<server-lan-ip>`.

Verified 2026-10-25 on the Moto G (LSPatch, `https://<server-lan-ip>:8443`) after `pm clear`. The server saw `System:Check` → `Auth:Create` (generated uid) → `verifyCustomToken` → `signInWithCustomToken` → `getAccountInfo` → `/v1/token` → `Auth:Login` → `User:Get` → `Home:Login`/`Enter` → `Tutorial:Progress`, with no unhandled RPCs. The device reached HOME at manager level 1, but with the corpus account's state and the tutorial skipped, because `User:Get` seeds every new account from the corpus template.

Fresh-account state (2026-10-25): new accounts are marked `players.data.seed = 'fresh'` and start from the official fresh capture (`captures/2026-10-25_fresh_official`). Retested on the Moto G after `pm clear`: the server saw the official tutorial sequence in order (Tutorial:Init, Progress 10/100/120/130/140/150, both StartQuest, ReceiveLessonReward, Card:Enhance, Deck:Save, Message:*), and the device reached HOME at manager level 2. The fresh capture's `Home:Enter`, `Dokan:List` and `Story:ListEvent` reference October content missing from our September master, which crashes the client, so fresh players get the corpus versions of those with only the progress fields overlaid.

Still open:
- `Activity:ReceiveLessonReward` (collecting the home-screen lesson reward) is unhandled; the empty reply throws a NullReferenceException in `ActivityLessonProgressWrapper`. `Migration:List` is also unhandled (harmless so far).
- Existing account A (real Google session) on a redirected client: see §4. Not tested.
- `Auth:Login` still trusts `user_id` without verifying the signature. Verify our own ID tokens before any public exposure.
- Rate limiting and an invite gate on `Auth:Create` (`SOLIS_INTEROP.md` §4.1).
