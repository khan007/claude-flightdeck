# Flightdeck re-architecture plan (draft 1, 2026-10-12)

Status: **decisions taken (see section 5), nothing built.** Goal: a pane that is more informative at a glance, on a code base that is easier to change. Rule that stays: **real data only** (every number comes from a session event; inferred things are labelled).

## 1. Why re-architect

- `hooks/register.tsx` is ~1540 lines: event hooks, state writes, config, all panel drawing, desktop SVG helpers and layout live in one file. Every restyle this month touched it; two panels' markup is duplicated for desktop and terminal.
- `hooks/core.ts` (~650 lines) holds the pure logic and is well tested, but also SVG builders, palettes and formatters.
- The pane shows *counters* (checks, requests, cost) but little about **what is happening now and why**: no current activity, no time-to-reset, no history, no breakdown.
- Surface differences (terminal vs desktop) are handled with `isDesk` branches inside each panel, so each panel is really two panels.

## 2. Target architecture

```
hooks/
  register.tsx        thin: parseConfig, register events, register the Pane render
  state/              atoms + reducers (pure): main, usage, gate, agents, turn, log, fleet, view
  events/             one file per event family: turn.ts, tools.ts, agents.ts, usage.ts, session.ts
  panels/             one file per panel: core.tsx, gate.tsx, agents.tsx, fleet.tsx, buffer.tsx, turn.tsx
                      each exports  desktop(props) and terminal(props)  over the same view-model
  viewmodel.ts        pure: turns state into view-models (strings, numbers, colours), no JSX
  theme/              palettes, hexOf/tint, SVG builders (chip, tab, bars, strip, accent)
  core.ts             stays the home of pure helpers that are already tested (shrinks over time)
tests/                one test file per module; render tests stay for each surface
```

Principles:
- **View-model first.** A panel's numbers and wording are computed in `viewmodel.ts` (pure, unit-tested); `desktop` and `terminal` renderers only lay them out. This removes the duplicated logic and makes "informative" changes one-place edits.
- **Events never draw, panels never write state.**
- **Behaviour-preserving first:** phase 1 moves code without changing output (tests + screenshots prove it); new information comes after.
- Keep `claude plugin validate`, `claude plugin test` and the rendering rules (`TODO.md`, memory `claude_mod_pane_rendering_limits.md`) as the gates.

## 3. New information to add (all from data the engine already gives)

| Block | Shows | Source | Notes |
| --- | --- | --- | --- |
| **Now** | what the main model is doing this second: current tool + target, elapsed in this step, last error | `tool.check`, `tool.call`, `turn.step` | answers "is it stuck or working?" |
| **Limits with reset** | 5h / 7d use plus *time until the window resets* ("resets in 2h10m") and a "at this pace you hit it in X" hint (inferred, labelled) | `rateLimits[].resetsAt`, `percentUsed` over time | `resetsAt` is not used today |
| **Context breakdown** | what fills the context: system prompt, tools, MCP, messages, memory (as `/context` counts it) | `$.session.usage({ breakdown: 'full' })` | estimates, labelled; fetch on demand (press / hover), not every tick |
| **Turn history** | last N turns as rows or a sparkline: duration, cost added, edits, errors | `turn.complete` receipt (keep the last ~10) | today only the last turn is kept |
| **Cache health** | cache hit % per turn / session (cache read vs uncached input), cost saved is *not* claimed | `turn.step` usage fields | already parsed for agents |
| **Work done** | files edited this session (count + list on press), tests/commands that failed | `tool.call` (edits, shell failures) | list is per session, masked |
| **Fleet** | keep waiting/idle logic; add per-session "last activity" | `fleet.py` | already partly done |
| **Live buffer** | already: full text, press/hover, paging; add filters (errors only / me / agents) | log | cheap once panels are split |

## 4. Phases

1. **Characterise.** Add render tests that snapshot each panel's view-model on a fixed state (terminal + desktop) so refactors are provably neutral. Fix any gap found.
2. **Extract** theme/ (SVG, palettes), then state/ + events/, no output change. Ship as 0.4.0-alpha steps; screenshots must match 0.3.43.
3. **View-models** for core, gate, agents, fleet, buffer, turn; renderers become thin.
4. **New blocks**, one release each: Now → Limits with reset → Turn history → Context breakdown. (Cache health, Work done and buffer filters wait.)
5. **Polish and docs:** README screenshots (they are v0.3.13), SECURITY.md (out of date: it says no processes/files), remove dead `rail.tsx` and the `motion` setting, CHANGELOG, TODO.

Each phase ends with: validate, test, `claude plugin update`, a new session, a screenshot from you, then commit/push on your word.

## 5. Decisions (2026-10-12)

1. **Blocks to build, in this order:** Now strip → Limits with reset → Turn history → Context breakdown. *Deferred (not chosen):* Cache health, Work done, buffer filters.
2. **Structure:** split into modules (state/, events/, panels/, theme/, view-model layer).
3. **Surfaces:** same information on desktop and terminal; desktop only draws it richer (SVG, hover).
4. **Still open:** the row budget (how many rows the pane may use; the log gets 4-8 today).

## 6. Risks

- Every visual check needs a new session and your screenshot; plan phases small.
- The engine refuses some props silently (empty Svg alt, non-integer % widths); `claude plugin test` catches most, not all of what the desktop draws.
- More information costs rows and clutter: each block must earn its place or be hidden when quiet (as agents and fleet now are).
- State size: history and full texts live in session state; cap them (400-char lines, 150 lines, ~10 turns).
- `session.usage({ breakdown })` may be expensive or absent; fetch lazily and degrade to nothing.
