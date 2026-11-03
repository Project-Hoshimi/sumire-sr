# VenusSysLib / HoshimiStage reference for Live-scoring work — REFERENCE

> Handoff reference for a later session. Saved 2026-10-08. Main project plan: `docs/PLANS.md`. Handoff: `docs/SESSION_STATE.md`.
> Status: ⏳ **REFERENCE — nothing consumed yet.** For use when M2 High-Score Live / M4 VENUS Battle/League point-calc work starts.

## What is `~/VenusSysLib` ("hoshimi-desk")

- Node.js/TypeScript library that **simulates IDOLY PRIDE in-game Live** (concert/quest scoring): skill efficacy, triggers, targets, charts, combos, stamina, action order.
- npm `hoshimi-desk` v0.22.0, author vibbit, **Apache-2.0**, project **ceased development**.
- Built against a **pre-6.0.2 client** — formulas are NOT validated against our 6.0.2 baseline.
- Same author ecosystem as `~/ipr-master-diff` (already referenced in `docs/IPR_MASTER_DIFF.md`).

## Relevance to sumire-sr

| Piece | Location | Use |
|---|---|---|
| Concert engine | `concert/` (`concert.ts`, `efficacy_analyze/impl`, `trigger_proc`, `target_proc`, `perform_skill`, `perform_beat`, …) | Reference implementation of the live/points algorithm M4 needs to extract from `libil2cpp.so` + master point tables |
| RE write-ups | `doc/concert.md`, `doc/beat_order.md`, `doc/perform_order.md`, `doc/overall.drawio.svg` | Reverse-engineering notes on action order & scoring |
| Deck/live transforms | `satomi/` (`deck.ts`, `live.ts`, `card.ts`) — `TransDeck` | Maps onto our generated deck wire types |
| Core sim entry | `index.ts` `simulate(questId, transDeck, transOpntDeck?, customNodes?)` | Battle (vs) quests supported → VENUS Battle ghost model |

**Currently no `Quest`/`Live` service in `fastify-api/src/services/`** — `Quest:*` is handled only via replay. Live scoring will need a home here.

## Not relevant

- `types/proto/*` (`proto_api.ts` 8.4k, `proto_enum.ts` 2.4k, `proto_master.ts` 3.1k, `proto_transaction.ts`) — hand-written, partial, **stale vs our byte-exact `phaseA1` codegen**. Do not use; would conflict.
- Master data — loads partial/older dataset from its own DB; our A2 master (236k rows, byte-exact) supersedes it.
- **`~/HoshimiStage`** — pure Next.js web GUI on top of VenusSysLib (card search, formation, notemap, quest). No server overlap; only relevant if a web admin/companion tool is ever wanted.

## License

- Apache-2.0 → portable into `fastify-api`; keep attribution if code is adapted.
- `~/HoshimiStage` also Apache-2.0; image resources from `info-pride` (outloudvi).

## M4 validation checklist (before reuse)

1. Verify scoring/action-order formulas against `libil2cpp.so` (sha256 `e4b14843…`) + 6.0.2 master point tables.
2. Engine is Node/TS — same stack as `fastify-api`; either port `concert/` or vendor as dependency.
3. Battle/ghost path (`simulate(..., transOpntDeck, ...)`) maps to VENUS Battle opponent-deck/ghost model in PLANS.md §5 M4.
4. Confirm license attribution if vendoring code rather than notes-only reference.
