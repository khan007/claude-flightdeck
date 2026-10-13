# Decisions

## 2026-10-12 — Flightdeck re-architecture
- **What:** split `hooks/register.tsx` (~1540 lines) into `state/`, `events/`, `panels/` (a desktop and a terminal renderer per panel over one view-model), `theme/`, and a pure `viewmodel.ts`. Phase 1 changes no output; new blocks follow one release each.
- **New information, in order:** Now strip, Limits with reset countdown, Turn history, Context breakdown. Same information on desktop and terminal.
- **Why:** every restyle touched one giant file with `isDesk` branches inside each panel; the pane shows counters but not what is happening now. The engine already provides unused data (`rateLimits[].resetsAt`, `$.session.usage({ breakdown })`, per-turn results).
- **Rejected / deferred:** keeping one big file (faster start, harder to change); a desktop-only richer pane; Cache health, Work done and buffer filters (deferred, not rejected).
- **Rule kept:** real data only; inferred values are labelled.
- Plan: `docs/rearchitecture-plan.md`.
