# Client modding / localization reference — REFERENCE

> Handoff reference for a later session. Saved 2026-10-08. Main project plan: `docs/PLANS.md`. Handoff: `docs/SESSION_STATE.md`.
> Status: ⏳ **REFERENCE — nothing consumed yet.** Client-modding repos are a watch list, not implementation inputs.

## Bottom line

None of these are needed to **implement** the server. `sumire-sr` reimplements the wire side and serves the unmodified 6.0.2 client through our gateway proxy (`fastify-api/src/server.ts` `proxyHandler`, `app.all('/v2/*', ...)`). Relevance is indirect:

1. **They target the exact client we serve** (verified for 6.0.2) — if we ever distribute a modded build, compatibility is already proven.
2. Their **runtime-loaded translation UI assets** (fonts, localized images) are a data point for our asset pipeline (`ASSET_MIRROR.md`).
3. Their **LSPatch/Xposed approach** is the same hooking surface `frida/` already covers server-side for capture work — no new capability.

## Projects

| Repo | What it is | Notes |
|---|---|---|
| `CyleAR/Hoshimi-localify` (C++, ★2) | **Xposed/LSPatch plugin** for IPR; fork lineage from `chinosk6/gakuen-imas-localify`; credits `vilebbit/HoshimiToolkit` + `SolisClient` | The plugin that patches the running client in place (no server involvement) |
| `DreamGallery/Idoly-localify-translations` (Python) | CN translation patches + update workflows for the above plugin | Translation content only |
| `DreamGallery/Idoly-Patcher` (Python, ★2) | **No-root APK packer**: wraps game APK + localify plugin via LSPatch, GitHub Actions workflow; **verified against 6.0.2**; ARM64/x86-AT note | The distributable modded-APK builder |
| `DreamGallery/Hoshimi_Teleprompter` (Python) | Configurable translation workflows (subtitle/prompter) | Content-creation tooling |
| `DreamGallery/Idoly-Viewer` (Python) | Story preview / translation collaboration | Frontend for translated ADV text |

## When to revisit

- Only if a future goal is **distributing a localized/modded client build** to players — then `Idoly-Patcher` is the packager and `Hoshimi-localify` the runtime hook.
- If M3 (ADV drama) needs translated subtitles as a feature, the workflow repos are reference for subtitle pipeline; the ADV **format** itself is covered by `docs/EXTERNAL_PROJECTS.md`.
- Do **not** consume their modified client behavior as server truth — wire behavior must match the captured 6.0.2 corpus.

## Planned client-side mods

- **Original title art in the sandbox title rotation.** The sandbox FAQ button steps the title screen through the anniversary `TitleBackground` rows (23-0624 … 26-0624). The original art is not one of them. It is the prefab RawImage `TitleView._defaultBackGround`, which has no asset id, so no master row can select it. The client shows it only when it has no active title. Two server-side tries failed, and the client kept the last anniversary art each time: serving an empty `TitleBackground` list (43230e9), and serving a single expired row (7e6189f). Both were reverted. To get the original art back, a client hook would make `GetActiveTitleBackgroundFromLocalStorage` (used by `TitlePresenter.Start` and `ChangeTitleBackGroundAsync`) return null on demand.
