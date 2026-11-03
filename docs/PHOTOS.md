# PHOTOS.md — Photo Taking System (撮影) — ✅ DONE

> **Status: COMPLETE** (implemented 2026-10-09 → 2026-10-10 on `feat/photo-taking`, merged to `main` @ `8f20206`; full on-device E2E cleared). The complete feature write-up — capture analysis, rarity table, all 17 shooting handlers + Panorama/PhotoContest/Shelf/Showcase/Dream/special/story-episode/excursion variants, and Phase 4 reward integration — now lives in **`docs/ARCHIVE.md` §11**.

## Residuals (still live — mirrored in `PLANS.md` §1.5)

- **Taken-photo images are blank on-device.** The client uploads the texture to Google Firebase Storage; bytes never reach us. `Photo:GetImageURL` returns placeholder `cdn.idoly.pride.local` URLs. Full fix = redirect the Firebase storage host to our server + implement upload/readback — **deferred until the asset CDN is built**. Predefined location-asset images render fine.
- **Feature request (2026-10-10):** give the player access to **all poses and facial reactions** in pose photo mode (currently only a subset). Revisit once the asset CDN is built.
- **Card Gacha cosmetics:** ✅ FIXED 2026-10-10 — pulled cards now grant their tied costume + hairs and surface them in `UpdatedData` (see PLANS §1.5).

## Reference

- Service: `fastify-api/src/services/photo.ts` (management + shooting surface).
- Master tables: PhotoActivity 29, PhotoExpression 26, PhotoPose 146, PhotoFacial 5, PhotoAbilitySet 3813, PhotoAllInOne 262, PhotoContest* (45/64/36/33/798). Harvest gaps: `PhotoSituation`, `PhotoShootingCharacterMotion` (0 rows).
- Rarity roll table is a documented approximation (real odds live in the client asset bundle).