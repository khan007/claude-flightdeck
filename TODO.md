# TODO — Flightdeck restyle (fork khan007/claude-flightdeck, branch `strip-fix`)

Last updated: 2026-10-10 (end of day). Plugin version **0.3.40** (0.3.39 and earlier pushed). Working tree clean when this was written.

## Setup (done)
- Cloned `khan007/claude-flightdeck` (branch `strip-fix`) and `khan007/fleet` into `~/git`; both validated and installed from those local folders (user scope: `flightdeck@claude-flightdeck`, `fleet@fleet`).
- Never push to / open PRs against `scasella/claude-flightdeck`. Push to the fork only when told "push it".
- Desktop app runs cached copies: after every edit bump `version` in `.claude-plugin/plugin.json`, add a CHANGELOG entry, run `claude plugin validate .`, `claude plugin test .`, `claude plugin update flightdeck@claude-flightdeck`, then start a NEW session / restart the app.

## Goal
Improve on the initial design (v0.3.13 look) so that **desktop** looks like the rounded-card mockup and **terminal** like the boxed mockup. Rule from the repo: real data only (no fake NET / UP / TIME / latency / burn figures).

## Done (0.3.14 – 0.3.39)
- Panels: AGENT CORE, GATEWAY, AGENTS, THIS/LAST TURN (receipt), FLEET, LIVE BUFFER. Numbering added then removed.
- Desktop: tinted cards, dark borders, bright accent line inside the left border with curved ends, SVG title tabs on the card's top edge (solid fill), header card with logo + `agents (N)` + `N waiting` pills, SVG segmented context/quota bars, SVG gate strip, tinted state chips, grey live buffer, agents panel as a card, receipt as a card.
- Terminal: boxed sections, titles as first row inside the box (titles on the border DO NOT draw in the terminal), context ruler, all four gate pills, gate strip + OK on one row, fleet cost column sized to its numbers, fleet title/border in fleet colour.
- Removed the dotted connectors between panels and in the agents panel.
- Waiting sessions: `fleet.py` reports `waitingFor`; pane shows `N waiting` pill, `· N WAITING` in the fleet title, amber `WAIT` chip and the reason beside the name.

## Not yet verified on screen (no screenshot after the change)
- Terminal 0.3.38/0.3.39: gate strip + `N OK` on one row, fleet cost no longer wraps, fleet colour.
- Desktop receipt card tab (`THIS TURN` / `LAST TURN`) and agent cards filling the agents card (`iw = w - 3`).
- Context bar width estimate (`(w - 4) * 8.3` px) — could be slightly short or long.

## Open ideas / to do tomorrow
- (done in 0.3.40) Fleet `IDLE` chip softened; check how it looks on screen.
- Tab placement: `TAB_DROP = 7` px, `TAB_BG = '#1b1a19'` (assumes a dark pane; a light theme would show dark tabs). Make it theme-aware if needed.
- Desktop: restyle the "other loops" line and the expanded-agent detail box (still old plain style).
- Terminal still differs from the mockup: title not on the border, pills are bracketed text, no bordered model chip in the header, bar colour orange vs green+hatched. Decide if any of that is worth doing (colour is easy).
- Header: mockup TIME/UP/NET row not shown (no real data). Could show a real clock or session uptime only if a real source exists.
- Waiting sessions: could show a desktop notification or sort waiting rows first; `fleet.py` in the separate `khan007/fleet` plugin does not have `waitingFor` yet.
- Cleanup: `hooks/rail.tsx` is unused now; the `motion` setting animates nothing; README still describes connectors/animation and the screenshots in `docs/media` are old; `SECURITY.md` says "runs no processes, reads no files" which is out of date (python3 fleet script, `open` deep link, reads plugin.json).
- The Stitch design (project 7271743611786308475, screen 621977670121794063) could not be opened (no Stitch tool). Export it as an image to compare.
- The bottom strip "Two-minute pane demo…" with a green bar is the Claude desktop app's own background-task tray, not Flightdeck.

## Pane rendering rules learned (also saved to memory: `claude_mod_pane_rendering_limits.md`)
- `Svg` with `alt=""` draws nothing. Always give a real `alt`.
- Box `width` must be a number (cells) or a WHOLE-number percent; `"3px"`, `"0.4%"`, `flexBasis` are refused (the engine then draws its own pane; `claude plugin test` shows it).
- A Box has one border colour, no radius. Accent = absolute Box `top=0 bottom=0 left=0 width=1` with SVG arc caps + a 17%-wide stretching Box. Absolute boxes render on desktop; negative `top=-1` works on desktop but not in the terminal.
- SVG needs hex colours; theme names are mapped in `core.ts` (`hexOf`). 8-digit hex (alpha) works for desktop Box backgrounds/borders.
- `margin` of 1 row ≈ 22px on desktop; a tab chip needs a 2-row gap above its card.
- Tests: `find({text})` does not see Svg alt; use `JSON.stringify(await ui.drawn())`. Anchor regexes or `find` returns the root box.

## Reference: what each value in the original design means
See the answer given at the end of this session; summary: header = model + working/idle; main = effort, permission mode, request count, context % and tokens, compactions, session cost, 5h/7d rate-limit use; gate = per-check verdict strip, totals (allowed / classifier-or-you / pending / denied), file/shell/other families with drill-down (f s o); receipt = last turn duration, agents, edits, errors, cost added; fleet = running sessions with run/today/all cost estimates from `fleet.py` (list prices × tokens); log = timeline of prompts, spawns, completions, edits, errors, denials.
