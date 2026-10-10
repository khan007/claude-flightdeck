import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentCard, Architect, Bucket, Check, Fleet, FleetRow, Gate, Layout, LogLine, Loop, Main, Roster, Turn, Usage, View } from '../types'
import {
  DEFAULT_ARCHITECT,
  DEFAULT_GATE,
  DEFAULT_MAIN,
  DEFAULT_ROSTER,
  DEFAULT_TURN,
  DEFAULT_USAGE,
  DEFAULT_VIEW,
  EDIT_TOOLS,
  SCHEMA_VERSION,
  afterCall,
  applyStep,
  blocks,
  bucketOf,
  barCapSvg,
  checkStripSvg,
  chipSvg,
  hexOf,
  logoSvg,
  segBarSvg,
  tintOf,
  cardTitle,
  titleLines,
  consultTimeline,
  describeInput,
  endConsult,
  fmtClock,
  fmtDuration,
  fmtTimer,
  fmtUsd,
  plural,
  gateSummary,
  gauge,
  isAdvising,
  isLoopActive,
  kTokens,
  lanes,
  limitLabel,
  listOf,
  logRows,
  momentOf,
  normalize,
  normalizeCard,
  normalizeGate,
  normalizeLog,
  noteTool,
  PALETTES,
  SVG_COLORS,
  parseConfig,
  prettyModel,
  quotaName,
  promptLine,
  handbackOf,
  adviceLine,
  receiptOf,
  recordCheck,
  settleCheck,
  shorten,
  startConsult,
  stateOf,
  stepLoop,
} from './core'
import type { Config, Panel } from './core'

const PANE = 'flightdeck'
const TITLE = 'Flightdeck'
const PANE_COLUMNS = 66


// ---------------------------------------------------------------- state

const meta = atom({ plugin: 'flightdeck', key: 'meta' } as const, { schemaVersion: SCHEMA_VERSION })
const main = atom({ plugin: 'flightdeck', key: 'main' } as const, DEFAULT_MAIN)
const usage = atom({ plugin: 'flightdeck', key: 'usage' } as const, DEFAULT_USAGE)
const architect = atom({ plugin: 'flightdeck', key: 'architect' } as const, DEFAULT_ARCHITECT)
const gate = atom({ plugin: 'flightdeck', key: 'gate' } as const, DEFAULT_GATE)
const agents = atom({ plugin: 'flightdeck', key: 'agents' } as const, [])
const loops = atom({ plugin: 'flightdeck', key: 'loops' } as const, [])
const log = atom({ plugin: 'flightdeck', key: 'log' } as const, [])
const turn = atom({ plugin: 'flightdeck', key: 'turn' } as const, DEFAULT_TURN)
const receipt = atom({ plugin: 'flightdeck', key: 'receipt' } as const, null)
const view = atom({ plugin: 'flightdeck', key: 'view' } as const, DEFAULT_VIEW)
const roster = atom({ plugin: 'flightdeck', key: 'roster' } as const, DEFAULT_ROSTER)
const fleet = atom({ plugin: 'flightdeck', key: 'fleet' } as const, { rows: [], todayUsd: null, error: null } as Fleet)

const version = atom({ plugin: 'flightdeck', key: 'version' } as const, '')

const FLEET_POLL_MS = 5000

// Runs the user's fleet script (python3, read-only, JSON on stdout) and keeps the rows for the panel.
// The desktop app only accepts its own ids (local_<uuid>) on claude://code/continue.
const HOST_ID = /^local_[A-Za-z0-9-]{1,64}$/

// Opens a desktop-app session in the Claude desktop app through its claude:// deep link.
async function openSession($: EngineInterface, id: string) {
  if (!HOST_ID.test(id)) return
  try {
    await $.process.run(['open', `claude://code/continue?session=${id}&source=flightdeck`], { timeoutMs: 10000 })
  } catch (err) {
    $.ui.log(`flightdeck: open session ${id} failed: ${String(err)}`, { to: 'debug' })
  }
}

async function refreshFleet($: EngineInterface, script: string) {
  try {
    const run = await $.process.run(['python3', '-I', script, '--json'], { timeoutMs: 20000 })
    if (run.exitCode !== 0) throw new Error(run.stderr.trim().split('\n').pop() || `exit ${run.exitCode}`)
    const out = JSON.parse(run.stdout) as { sessions: FleetRow[]; todayUsd: number }
    await update($, fleet, () => ({ rows: out.sessions, todayUsd: out.todayUsd, error: null }))
  } catch (err) {
    $.ui.log(`flightdeck: fleet refresh failed: ${String(err)}`, { to: 'debug' })
    await update($, fleet, x => ({ ...x, error: String(err) }))
  }
}

type ServerBlock = { type: string; id?: string; name?: string; tool_use_id?: string }

// Every read goes through these, so a value saved under an older shape still reads.
async function getMain($: EngineInterface): Promise<Main> {
  return normalize(DEFAULT_MAIN, await read($, main))
}
async function getUsage($: EngineInterface): Promise<Usage> {
  return normalize(DEFAULT_USAGE, await read($, usage))
}
async function getArchitect($: EngineInterface): Promise<Architect> {
  const a = normalize(DEFAULT_ARCHITECT, await read($, architect))
  return { ...a, consults: listOf(a.consults), ids: listOf(a.ids), seen: listOf(a.seen) }
}
async function getGate($: EngineInterface): Promise<Gate> {
  return normalizeGate(await read($, gate))
}
async function getCards($: EngineInterface): Promise<AgentCard[]> {
  return listOf<unknown>(await read($, agents)).map(normalizeCard)
}
async function getLoops($: EngineInterface): Promise<Loop[]> {
  return listOf<Loop>(await read($, loops))
}
async function getLog($: EngineInterface): Promise<LogLine[]> {
  return normalizeLog(await read($, log))
}
async function getTurn($: EngineInterface): Promise<Turn> {
  return normalize(DEFAULT_TURN, await read($, turn))
}
async function getView($: EngineInterface): Promise<View> {
  return normalize(DEFAULT_VIEW, await read($, view))
}
async function getRoster($: EngineInterface): Promise<Roster> {
  const r = normalize(DEFAULT_ROSTER, await read($, roster))
  return { architectTypes: listOf(r.architectTypes) }
}

/** A stored shape older than this build's: drop what cannot be read, keep the rest. */
async function migrate($: EngineInterface) {
  const m = await read($, meta)
  if ((m?.schemaVersion ?? 0) >= SCHEMA_VERSION) return
  await update($, log, list => normalizeLog(list))
  await update($, agents, list => listOf<unknown>(list).map(normalizeCard))
  await update($, gate, g => normalizeGate(g))
  await update($, meta, () => ({ schemaVersion: SCHEMA_VERSION }))
}

async function say($: EngineInterface, who: string, text: string, kind: LogLine['kind'] = 'info', agentId: string | null = null) {
  const line: LogLine = { at: await $.clock.now(), who, text, kind, agentId }
  await update($, log, list => [...normalizeLog(list), line].slice(-60))
}

async function refreshStatus($: EngineInterface, cfg: Config) {
  if (!cfg.statusLine) return $.ui.status(undefined)
  const [u, a, g, cards] = await Promise.all([getUsage($), getArchitect($), getGate($), getCards($)])
  const running = cards.filter(c => c.status === 'running').length
  const s = gateSummary(g)
  const parts = [
    u.pct !== null ? `ctx ${Math.round(u.pct)}%` : null,
    cards.length > 0 ? `agents ${running}/${cards.length}` : null,
    a.consults.length > 0 || a.ids.length > 0 ? `${cfg.architectLabel.toLowerCase()} ${isAdvising(a) ? 'advising' : a.consults.length}` : null,
    s.deny > 0 ? `denied ${s.deny}` : null,
  ]
  // Only fields with something to say; with none, no status entry at all.
  const shown = parts.filter(Boolean)
  $.ui.status(shown.length > 0 ? shown.join(' · ') : undefined)
}

async function whoIs($: EngineInterface, agentId: string | undefined) {
  if (!agentId) return 'main'
  const card = (await getCards($)).find(c => c.id === agentId)
  return card ? shorten(cardTitle(card), 14) : 'agent'
}

async function consultStarted($: EngineInterface, cfg: Config, id: string, via: string) {
  const t = await getTurn($)
  const moment = momentOf(t)
  const at = await $.clock.now()
  await update($, architect, a => startConsult(normalize(DEFAULT_ARCHITECT, a), { id, at, moment, via }))
  if (moment === 'before done') await update($, turn, x => ({ ...normalize(DEFAULT_TURN, x), isReviewing: true }))
  await say($, cfg.architectLabel.toLowerCase(), cfg.moments ? `${moment} · ${via}` : `consulted · ${via}`, 'consult')
  await refreshStatus($, cfg)
}

async function consultEnded($: EngineInterface, cfg: Config, advice: string | null, id?: string) {
  const at = await $.clock.now()
  const first = advice?.split('\n').find(l => l.trim()) ?? null
  const text = first ? shorten(first.replace(/^[#>*\s-]+/, ''), 160) : null
  await update($, architect, a => endConsult(normalize(DEFAULT_ARCHITECT, a), at, text, id))
  await update($, turn, t => ({ ...normalize(DEFAULT_TURN, t), isReviewing: false }))
  await say($, cfg.architectLabel.toLowerCase(), text ? `advice: ${shorten(text, 60)}` : 'advice returned', 'consult')
  await refreshStatus($, cfg)
}

async function noteAdvice($: EngineInterface, cfg: Config, advice: string) {
  await update($, architect, x => ({ ...normalize(DEFAULT_ARCHITECT, x), lastAdvice: advice }))
  await say($, cfg.architectLabel.toLowerCase(), `advice: ${shorten(advice, 60)}`, 'consult')
}

async function isArchitectType($: EngineInterface, cfg: Config, type: string) {
  return cfg.architect.test(type) || (await getRoster($)).architectTypes.includes(type)
}

async function openPane($: EngineInterface) {
  // columns apply when docked beside the transcript, rows when seated inline above the prompt.
  return $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS, rows: 8 })
}

async function resetAll($: EngineInterface) {
  await update($, main, m => ({ ...DEFAULT_MAIN, model: normalize(DEFAULT_MAIN, m).model, mode: normalize(DEFAULT_MAIN, m).mode }))
  await update($, architect, () => DEFAULT_ARCHITECT)
  await update($, gate, () => DEFAULT_GATE)
  await update($, agents, () => [])
  await update($, loops, () => [])
  await update($, log, () => [])
  await update($, turn, () => DEFAULT_TURN)
  await update($, receipt, () => null)
  await update($, view, () => DEFAULT_VIEW)
  // The context gauge waits for the next measurement rather than showing the pre-clear fill.
  await update($, usage, x => ({ ...normalize(DEFAULT_USAGE, x), pct: null, tokens: null }))
}

/** The session's cost read fresh, not from the last measurement: the receipt subtracts two of these. */
async function costNow($: EngineInterface): Promise<number | null> {
  const u = await $.session.usage().catch(() => null)
  return u?.cost?.usd ?? null
}

async function noteMode($: EngineInterface, mode: string | undefined) {
  if (mode) await update($, main, m => (normalize(DEFAULT_MAIN, m).mode === mode ? normalize(DEFAULT_MAIN, m) : { ...normalize(DEFAULT_MAIN, m), mode }))
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)
  const C = PALETTES[cfg.palette]
  // tool.check carries no loop id; the tool.call around it does, keyed by the call's id.
  const callLoop = new Map<string, string | null>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'flightdeck',
      description: 'Flightdeck, the live agent dashboard: open, close, reset, or set the layout',
      argumentHint: '[open|close|reset|layout auto|compact|wide|mini]',
    })
    await migrate($)
    // The pane shows the plugin's own version, read from its manifest so it never drifts from a release.
    try {
      const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }
      await update($, version, () => String(manifest.version ?? ''))
    } catch (err) {
      $.ui.log(`flightdeck: could not read its version: ${String(err)}`, { to: 'debug' })
    }
    // A host without usage (headless, an SDK host, a session not yet bound) just starts without it.
    const u = await $.session.usage().catch(() => null)
    if (u) {
      await update($, usage, x => ({
        ...normalize(DEFAULT_USAGE, x),
        pct: u.context.percent ?? null,
        tokens: u.context.tokens ?? null,
        window: u.context.window,
        costUsd: u.cost?.usd ?? null,
        limits: u.rateLimits.map(r => ({ kind: r.kind, pct: r.percentUsed })),
      }))
    }
    if (cfg.openOnStart) void openPane($).catch(() => undefined)
    if (cfg.fleet) {
      const script = cfg.fleetScript || `${$.plugin.root}/fleet.py`
      void refreshFleet($, script)
      $.clock.every(FLEET_POLL_MS, () => refreshFleet($, script))
    }
    await refreshStatus($, cfg)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await resetAll($)
      await refreshStatus($, cfg)
    }
    return next(e)
  })

  on('command.run', { command: 'flightdeck' }, async ($, e) => {
    const [verb = 'open', arg = ''] = e.args.trim().split(/\s+/)
    if (verb === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Flightdeck closed.' }
    }
    if (verb === 'reset') {
      await resetAll($)
      await refreshStatus($, cfg)
      return { text: 'Flightdeck reset.' }
    }
    if (verb === 'layout') {
      const layout: Layout | null = arg === 'compact' || arg === 'wide' || arg === 'auto' || arg === 'mini' ? arg : null
      if (!layout) return { text: 'Usage: /flightdeck layout auto|compact|wide|mini' }
      await update($, view, v => ({ ...normalize(DEFAULT_VIEW, v), layout }))
      const opened = await openPane($)
      return { text: opened.isPlaced ? `Flightdeck layout: ${layout}.` : `Layout set to ${layout}; the pane is not shown yet: ${opened.reason}` }
    }
    const opened = await openPane($)
    if (!opened.isPlaced) return { text: `Flightdeck is not shown yet: ${opened.reason}` }
    return { text: 'Flightdeck opened. Focus it with ctrl+x tab; 1-6 expand cards, f/s/o open the gate rows.' }
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await noteMode($, e.permission_mode)
    return next(e)
  })

  on('agent.offer', async ($, e, next) => {
    const offered = await next(e)
    if (cfg.architect.test(e.agent) || (cfg.matchDescriptions && cfg.architect.test(e.description))) {
      await update($, roster, r => {
        const x = normalize(DEFAULT_ROSTER, r)
        return x.architectTypes.includes(e.agent) ? x : { architectTypes: [...listOf<string>(x.architectTypes), e.agent].slice(-20) }
      })
    }
    return offered
  })

  on('turn.start', async ($, e, next) => {
    const [now, cost] = await Promise.all([$.clock.now(), costNow($)])
    await update($, turn, () => ({ ...DEFAULT_TURN, startedAt: now, costAtStart: cost }))
    await update($, main, m => ({ ...normalize(DEFAULT_MAIN, m), isRunning: true }))
    // A background architect's report reaches the main loop as the text opening this turn. The
    // SubagentHandback tool call (in tool.call) normally carries it first; this is the fallback.
    const back = e.text ? handbackOf(e.text) : null
    const a = back ? await getArchitect($) : null
    if (back && a && a.ids.includes(back.from)) {
      const advice = adviceLine(back.body)
      if (advice && advice !== a.lastAdvice) await noteAdvice($, cfg, advice)
    } else if (e.text) {
      const p = promptLine(e.text)
      await say($, p.who, p.text)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // The main loop's model is known when its request starts; a long first request shouldn't read "—".
    if (!e.agentId) {
      await update($, main, m => {
        const x = normalize(DEFAULT_MAIN, m)
        return { ...x, model: e.model, effort: String(e.effort ?? x.effort), steps: x.steps + 1 }
      })
      return yield* next(e)
    }
    const result = yield* next(e)
    const id = e.agentId
    const [cards, a] = await Promise.all([getCards($), getArchitect($)])
    if (cards.some(c => c.id === id)) {
      const step = { model: e.model, usage: result.usage, stopReason: result.stopReason }
      await update($, agents, list => listOf<unknown>(list).map(normalizeCard).map(c => (c.id === id ? applyStep(c, step) : c)))
      if (result.stopReason === 'max_tokens') await say($, await whoIs($, id), 'hit max_tokens', 'error', id)
    } else if (!a.ids.includes(id)) {
      const now = await $.clock.now()
      await update($, loops, l => stepLoop(listOf<Loop>(l), id, now))
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, x => ({
      ...normalize(DEFAULT_USAGE, x),
      pct: e.context.percent ?? null,
      tokens: e.context.tokens ?? null,
      window: e.context.window,
      costUsd: e.cost?.usd ?? null,
      limits: e.rateLimits.map(r => ({ kind: r.kind, pct: r.percentUsed })),
    }))
    if (e.changed.includes('context')) await refreshStatus($, cfg)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && e.trigger !== 'precompute') {
      const now = await $.clock.now()
      await update($, usage, x => {
        const u = normalize(DEFAULT_USAGE, x)
        return { ...u, compactions: u.compactions + 1, lastCompactAt: now }
      })
      await say($, 'main', `context compacted (${e.trigger})`)
    }
    return done
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool_use_id) {
      const check: Check = {
        id: e.tool_use_id,
        tool: e.tool,
        bucket: bucketOf(e.tool),
        verdict: verdict.decision === 'allow' ? 'rule' : verdict.decision,
        inSubagent: Boolean(callLoop.get(e.tool_use_id)),
        detail: shorten(describeInput(e.tool, e.input), 90),
        at: await $.clock.now(),
      }
      await update($, gate, g => recordCheck(normalizeGate(g), check))
      // The status line updates when the call settles; only a refusal ends here.
      if (verdict.decision === 'deny') {
        await say($, 'gate', `denied by rule · ${check.detail}`, 'error')
        await refreshStatus($, cfg)
      }
    }
    return verdict
  })

  on('tool.call', async ($, e, next) => {
    callLoop.set(e.tool_use_id, e.agentId ?? null)
    const ran = await next(e).finally(() => callLoop.delete(e.tool_use_id))
    const didRun = ran.deny === undefined
    // Settle this call's pending ask, if it had one; skip the write (and the redraw) otherwise.
    const g0 = await getGate($)
    const isSettled = settleCheck(g0, e.tool_use_id, didRun) !== g0
    if (isSettled) await update($, gate, g => settleCheck(normalizeGate(g), e.tool_use_id, didRun))
    // A background agent hands its report back through this tool; an architect's report is its advice.
    if (String(e.tool) === 'SubagentHandback') {
      const message = (e as unknown as { message?: unknown }).message
      const a = e.agentId ? await getArchitect($) : null
      if (a && e.agentId && a.ids.includes(e.agentId) && typeof message === 'string') {
        const advice = adviceLine(message)
        if (advice && advice !== a.lastAdvice) await noteAdvice($, cfg, advice)
      }
      return ran
    }
    if (e.tool === 'Agent') {
      if (isSettled) await refreshStatus($, cfg)
      return ran
    }
    const hasFailed = didRun && ran.isError === true
    const isEdit = !hasFailed && didRun && EDIT_TOOLS.has(e.tool)
    const t0 = await getTurn($)
    if (isEdit || hasFailed || (!e.agentId && t0.errorStreak > 0)) {
      await update($, turn, t => afterCall(normalize(DEFAULT_TURN, t), { inSubagent: Boolean(e.agentId), hasFailed, isEdit }))
    }
    const text = shorten(describeInput(e.tool, e), 64)
    if (e.agentId) {
      const id = e.agentId
      await update($, agents, list =>
        listOf<unknown>(list)
          .map(normalizeCard)
          .map(c => (c.id === id ? noteTool(c, { tool: e.tool, text, isError: hasFailed || ran.deny !== undefined }) : c)),
      )
    }
    // The log keeps what is worth a glance: refusals, errors and edits; the rest is on the cards.
    if (ran.deny !== undefined) await say($, await whoIs($, e.agentId), `${text}  denied`, 'error', e.agentId ?? null)
    else if (hasFailed) await say($, await whoIs($, e.agentId), `${text}  ✗`, 'error', e.agentId ?? null)
    else if (isEdit) await say($, await whoIs($, e.agentId), text, 'info', e.agentId ?? null)
    if (isSettled || !didRun) await refreshStatus($, cfg)
    return ran
  })

  // A server-side review tool never reaches tool.call: it shows only in the assistant's rows.
  on('session.append', async ($, e, next) => {
    if (!e.agentId && e.message.type === 'assistant') {
      const a = await getArchitect($)
      // Consults this row opened: their result may be in the same row, after the stale read above.
      const opened = new Set<string>()
      for (const block of e.message.content as unknown as readonly ServerBlock[]) {
        if (block.type === 'server_tool_use' && block.name && block.id && cfg.architect.test(block.name)) {
          if (a.seen.includes(block.id)) continue
          const id = block.id
          await update($, architect, x => {
            const y = normalize(DEFAULT_ARCHITECT, x)
            return { ...y, seen: [...listOf<string>(y.seen), id].slice(-60) }
          })
          opened.add(id)
          await consultStarted($, cfg, id, `${block.name} tool`)
        } else if (block.type.endsWith('_tool_result') && block.tool_use_id) {
          const id = block.tool_use_id
          const isOpen = opened.has(id) || (await getArchitect($)).consults.some(c => c.id === id && c.endAt === null)
          if (isOpen) await consultEnded($, cfg, null, id)
        }
      }
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (!e.parentAgentId) await noteMode($, e.permissionMode)
    if (started.deny !== undefined || !started.agentId) return started
    const id = started.agentId
    if (await isArchitectType($, cfg, e.subagentType)) {
      await update($, architect, a => {
        const x = normalize(DEFAULT_ARCHITECT, a)
        return { ...x, ids: [...listOf<string>(x.ids), id].slice(-40) }
      })
      await update($, loops, l => listOf<Loop>(l).filter(x => x.id !== id))
      await consultStarted($, cfg, id, e.subagentType.split(':').pop() ?? 'agent')
      return started
    }
    const card: AgentCard = {
      ...normalizeCard({}),
      id,
      type: e.name ?? e.subagentType,
      model: started.model,
      description: e.description,
      spawnedAt: await $.clock.now(),
    }
    await update($, agents, list => [...listOf<unknown>(list).map(normalizeCard), card].slice(-24))
    await update($, loops, l => listOf<Loop>(l).filter(x => x.id !== id))
    await say($, shorten(cardTitle(card), 12), `spawned · ${card.type}`, 'info', id)
    await refreshStatus($, cfg)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const id = e.agentId
    const now = await $.clock.now()
    if (!id) {
      const [t, cards, cost] = await Promise.all([getTurn($), getCards($), costNow($)])
      const r = receiptOf(t, {
        durationMs: e.durationMs,
        agentsSince: cards.filter(c => c.spawnedAt >= t.startedAt).length,
        costNow: cost,
        reason: e.reason,
      })
      await update($, receipt, () => r)
      await update($, main, m => ({ ...normalize(DEFAULT_MAIN, m), isRunning: false }))
      await refreshStatus($, cfg)
      return done
    }
    if ((await getArchitect($)).ids.includes(id)) {
      await consultEnded($, cfg, e.answer, id)
      return done
    }
    const cards = await getCards($)
    if (cards.some(c => c.id === id)) {
      const status = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      await update($, agents, list =>
        listOf<unknown>(list)
          .map(normalizeCard)
          .map(c => (c.id === id ? { ...c, status, endedAt: now, answer: shorten(e.answer, 400) } : c)),
      )
      const card = cards.find(c => c.id === id)
      const took = card ? fmtDuration(now - card.spawnedAt) : ''
      await say($, await whoIs($, id), status === 'done' ? `done · ${took}` : status, status === 'done' ? 'done' : 'error', id)
    } else {
      await update($, loops, l => listOf<Loop>(l).map(x => (x.id === id ? { ...x, isDone: true, lastAt: now } : x)))
    }
    await refreshStatus($, cfg)
    return done
  })

  // ---------------------------------------------------------------- drawing

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const hasClient = 'Client' in els
    const [m, u, a, g, cards, lp, lines, t, r, v, now, fl, ver] = await Promise.all([
      getMain($),
      getUsage($),
      getArchitect($),
      getGate($),
      getCards($),
      getLoops($),
      getLog($),
      getTurn($),
      read($, receipt),
      getView($),
      $.clock.now(),
      read($, fleet),
      read($, version),
    ])
    const W = Math.max(40, e.props.bodyColumns)
    const layout = v.layout ?? cfg.layout
    const isWide = layout === 'wide' || (layout === 'auto' && W >= 110)
    const colW = isWide ? Math.floor((W - 2) / 2) : W
    const modelName = prettyModel(m.model)
    const viewed = e.props.view?.agentId ?? null
    const advising = isAdvising(a)
    const running = cards.filter(c => c.status === 'running')
    const showArchitect = a.consults.length > 0 || a.ids.length > 0
    const motion = cfg.motion && hasClient
    // A panel with nothing to show yet takes no room: most sessions never spawn an agent.
    const isEmpty: Record<Panel, boolean> = {
      main: false,
      architect: !showArchitect,
      gate: g.recent.length === 0 && gateSummary(g).total === 0,
      agents: cards.length === 0,
      loops: lp.length === 0,
      receipt: !m.isRunning && !r,
      fleet: !cfg.fleet, // shown while enabled, even while loading or failing, so a problem is visible
      log: false,
    }
    const panels = cfg.panels.filter(p => !isEmpty[p])
    const decider = m.mode === 'auto' ? 'classifier' : 'you'
    // Desktop (and the editor and phone) draw rounded cards; the terminal draws marked, boxed sections.
    const isDesk = e.surface !== 'terminal'
    const mark = isDesk ? '' : '■ '

    // A connector between panels: animated while its flow is live, a dim line otherwise.
    const rail = (key: string, active: boolean, color: string, width: number, marks: number[] = [], isMerge = false) =>
      motion ? (
        <els.Client
          key={key}
          module="./rail.tsx"
          width={width}
          height={1}
          props={{ active, width, color, dim: C.faint, marks, isMerge }}
        />
      ) : (
        <Text color={C.faint}>{'─'.repeat(Math.max(1, width))}</Text>
      )

    // A start time of 0 is unknown (state saved before it was recorded): no clock, not decades.
    const clock = (key: string, since: number, endAt: number | null, color: string) =>
      since <= 0 ? (
        <Text color={color}>—</Text>
      ) : hasClient ? (
        <els.Client key={key} module="./elapsed.tsx" props={{ since, now, endAt, color }} />
      ) : (
        <Text color={color}>{fmtTimer((endAt ?? now) - since)}</Text>
      )

    // Desktop: a panel's title is an SVG chip (rounded, marked, in the panel's colour); the rest stays live text.
    // The tab's chip is drawn this many px below the top of its box, so it overlaps the card's border a little.
    const TAB_DROP = 5
    // Desktop: the title as a tab sitting on the card's top edge, one row up (so every card keeps a free row above it).
    const tab = (title: string, color: string) => {
      const { Svg } = $.ui.resolve(e)
      const c = chipSvg(title, color, 18, TAB_DROP)
      return (
        <Box position="absolute" top={-1} left={1}>
          <Svg source={c.svg} alt={c.text} width={c.width} height={c.height} />
        </Box>
      )
    }

    // Desktop: a segmented bar as SVG, `px` wide at most.
    const segBar = (pct: number, px: number, color: string, label: string, height = 10) => {
      const { Svg } = $.ui.resolve(e)
      const b = segBarSvg(pct, px, color, height)
      return <Svg source={b.svg} alt={`${label} ${Math.round(pct)}%`} width={b.width} height={b.height} />
    }

    // Desktop: card borders are dark; a bright bar of the panel's colour stands beside each card (see `column`).
    const dimEdge = (color: string) => tintOf(color, 0.25)

    // ---- main
    const effortN = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 }[m.effort] ?? 0
    const effortName = { low: 'LOW', medium: 'MED', high: 'HIGH', xhigh: 'XHIGH', max: 'MAX' }[m.effort] ?? '—'
    const ctxHot = u.pct !== null && u.pct >= 80
    const coreTitle = `${mark}AGENT CORE [${modelName.toUpperCase()}]`
    const winK = `${Math.round(u.window / 1000)}k`
    const ctxBar = (width: number) => {
      const b = blocks(u.pct ?? 0, width)
      return (
        <Text wrap="truncate">
          <Text color={ctxHot ? C.warn : C.main}>{b.on}</Text>
          <Text color={C.faint}>{b.off}</Text>
        </Text>
      )
    }
    // "Context Window: 76k / 1,000k" and the percentage, with the compactions so far.
    const ctxHead = (
      <Box justifyContent="space-between">
        <Text wrap="truncate">
          <Text dimColor>{isDesk ? 'Context Window: ' : `Context Window (${kTokens(u.window)} max): `}</Text>
          {u.tokens !== null ? <Text bold>{kTokens(u.tokens)}</Text> : null}
          <Text dimColor>{u.tokens !== null ? ` / ${winK}` : winK}</Text>
          {u.compactions > 0 ? <Text color={C.amber}>{`  ⟲${u.compactions}`}</Text> : null}
        </Text>
        <Text color={ctxHot ? C.warn : isDesk ? C.amber : C.gate} bold>{`[${Math.round(u.pct ?? 0)}%]`}</Text>
      </Box>
    )
    const working = (
      <Text color={m.isRunning ? C.cleared : C.dim} bold={isDesk} backgroundColor={isDesk ? tintOf(m.isRunning ? C.gate : 'subtle', 0.16) : undefined}>
        {isDesk ? (m.isRunning ? ' ● WORKING ' : ' ○ IDLE ') : m.isRunning ? '● working' : '○ idle'}
      </Text>
    )
    const tile = (width: number, label: string, body: unknown) => (
      <Box flexDirection="column" borderStyle="round" borderColor={C.faint} paddingX={1} width={width}>
        <Text dimColor wrap="truncate">{label}</Text>
        {body}
      </Box>
    )
    const mainPanel = (w: number) => {
      const tileCount = u.costUsd !== null ? 3 : 2
      const tileW = Math.floor((w - 4 - (tileCount - 1)) / tileCount)
      const statCols = (u.costUsd !== null ? 1 : 0) + Math.min(2, u.limits.length)
      const colW3 = Math.floor((w - 4 - 2 * Math.max(0, statCols - 1)) / Math.max(1, statCols))
      return isDesk ? (
        <Box flexDirection="column" borderStyle="round" borderColor={dimEdge(C.main)} backgroundColor={tintOf(C.main)} paddingX={1} width={w}>
          {accent(C.main)}
          {tab(coreTitle, C.main)}
          <Box justifyContent="flex-end">{working}</Box>
          <Text wrap="truncate">
            <Text dimColor>{'Role: Primary Reasoner'}</Text>
            {m.mode ? <Text dimColor>{' · Mode: '}</Text> : null}
            {m.mode ? <Text color={C.amber} bold>{m.mode.toUpperCase()}</Text> : null}
          </Text>
          <Box columnGap={1}>
            {tile(
              tileW,
              'EFFORT LEVEL',
              <Text wrap="truncate">
                <Text color={C.main}>{'▮'.repeat(effortN) + '▯'.repeat(4 - effortN)} </Text>
                <Text color={C.main} bold>{effortName}</Text>
              </Text>,
            )}
            {tile(tileW, 'REQUESTS', <Text bold>{`${m.steps} req`}</Text>)}
            {u.costUsd !== null ? tile(tileW, 'SESSION COST', <Text color={C.gate} bold>{fmtUsd(u.costUsd)}</Text>) : null}
          </Box>
          {u.pct !== null ? ctxHead : null}
          {u.pct !== null ? segBar(u.pct, Math.round((w - 4) * 8.3), ctxHot ? C.warn : C.main, 'Context window') : null}
          {u.limits.length > 0 ? (
            <Box justifyContent="space-between">
              {u.limits.slice(0, 2).map(l => {
                return (
                  <Box columnGap={1}>
                    <Text wrap="truncate">
                      <Text dimColor>{`${quotaName(l.kind)}: `}</Text>
                      <Text bold>{`${Math.round(l.pct)}%`}</Text>
                    </Text>
                    {segBar(l.pct, 64, l.pct >= 80 ? C.warn : C.main, quotaName(l.kind), 8)}
                  </Box>
                )
              })}
            </Box>
          ) : null}
        </Box>
      ) : (
        <Box flexDirection="column" borderStyle="round" borderColor={C.main} paddingX={1} width={w}>
          <Box justifyContent="space-between">
            <Text color={C.main} bold wrap="truncate">{coreTitle}</Text>
            {working}
          </Box>
          <Box justifyContent="space-between">
            <Text wrap="truncate">
              <Text dimColor>Effort: </Text>
              <Text color={C.main}>{'■'.repeat(effortN) + '□'.repeat(4 - effortN)}</Text>
              <Text dimColor>{` (${effortName.toLowerCase()})`}</Text>
            </Text>
            {m.mode ? (
              <Text wrap="truncate">
                <Text dimColor>Mode: </Text>
                <Text color={C.amber} bold>{`[${m.mode.toUpperCase()}]`}</Text>
              </Text>
            ) : null}
            <Text wrap="truncate">
              <Text dimColor>Req: </Text>
              <Text bold>{`${m.steps}`}</Text>
            </Text>
          </Box>
          {u.pct !== null ? ctxHead : null}
          {u.pct !== null ? ctxBar(w - 4) : null}
          {u.pct !== null ? (
            <Box justifyContent="space-between">
              <Text color={C.faint}>0k</Text>
              <Text color={C.faint}>{winK}</Text>
            </Box>
          ) : null}
          {u.costUsd !== null || u.limits.length > 0 ? (
            <Box columnGap={2}>
              {u.costUsd !== null ? (
                <Box flexDirection="column" width={colW3}>
                  <Text dimColor>SESSION COST</Text>
                  <Text bold>{fmtUsd(u.costUsd)}</Text>
                </Box>
              ) : null}
              {u.limits.slice(0, 2).map(l => {
                const lg = gauge(l.pct, 5)
                return (
                  <Box flexDirection="column" width={colW3}>
                    <Text dimColor wrap="truncate">{quotaName(l.kind).toUpperCase()}</Text>
                    <Text wrap="truncate">
                      <Text bold>{`${Math.round(l.pct)}% `}</Text>
                      <Text color={l.pct >= 80 ? C.warn : C.main}>{lg.on}</Text>
                      <Text color={C.faint}>{lg.off}</Text>
                    </Text>
                  </Box>
                )
              })}
            </Box>
          ) : null}
        </Box>
      )
    }

    // ---- architect
    const lastConsult = a.consults[a.consults.length - 1]
    const architectPanel = (w: number) => {
      const tl = consultTimeline(a, now, Math.max(8, w - 4))
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={C.arch} paddingX={1} width={w}>
          <Box justifyContent="space-between">
            <Text color={C.arch} bold>
              {`${mark}`}{cfg.architectLabel} · {advising ? 'advising' : 'on call'}
            </Text>
            <Text>
              <Text dimColor>consults </Text>
              <Text color={C.arch} bold>
                {a.consults.length}
              </Text>
            </Text>
          </Box>
          <Text color={C.arch}>{tl}</Text>
          {lastConsult ? (
            <Text dimColor wrap="truncate">
              {advising
                ? `consulting since ${fmtClock(lastConsult.at)}`
                : `last ${fmtDuration(now - (lastConsult.endAt ?? lastConsult.at))} ago · took ${fmtDuration((lastConsult.endAt ?? now) - lastConsult.at)}`}
            </Text>
          ) : (
            <Text dimColor>not consulted yet</Text>
          )}
          {cfg.moments ? (
            <Box flexWrap="wrap" columnGap={2}>
              {(['before a plan', 'error repeats', 'before done'] as const).map(mo => {
                const isOn = lastConsult?.moment === mo
                return (
                  <Text color={isOn ? C.arch : C.dim} bold={isOn}>
                    {isOn ? '◆' : '◇'} {mo}
                  </Text>
                )
              })}
              <Text color={C.faint}>(inferred)</Text>
            </Box>
          ) : null}
          {a.lastAdvice ? (
            <Text color={C.arch} wrap="truncate">
              » {a.lastAdvice}
            </Text>
          ) : null}
        </Box>
      )
    }

    // ---- gate
    const s = gateSummary(g)
    const verdictColor = (c: Check) =>
      c.verdict === 'rule' ? C.gate : c.verdict === 'cleared' ? C.cleared : c.verdict === 'ask' ? C.amber : C.warn
    // Desktop: the gate's recent checks as small verdict-coloured cells.
    const checkStrip = (checks: Check[]) => {
      const { Svg } = $.ui.resolve(e)
      const st = checkStripSvg(checks.map(c => ({ color: verdictColor(c), dim: c.inSubagent })), 130)
      return <Svg source={st.svg} alt={`${checks.length} recent checks`} width={st.width} height={st.height} />
    }
    const gateTitle = cfg.gateLabel === 'GATE' ? 'GATEWAY' : cfg.gateLabel
    const gatePanel = (w: number) => {
      const strip = g.recent.slice(-Math.max(8, w - 4))
      const open = v.gateOpen
      const okN = s.rule + s.cleared
      const tallies = [
        { n: s.rule, label: 'allowed', icon: '✔', c: C.gate },
        { n: s.cleared, label: decider, icon: '⚙', c: C.cleared },
        { n: s.ask, label: 'pending', icon: '⚠', c: C.amber },
        { n: s.deny, label: 'denied', icon: '×', c: C.warn },
      ]
      const stripRow = (
        <Text wrap="truncate">
          {strip.length === 0 ? <Text color={C.faint}>no checks yet</Text> : null}
          {strip.map(c => (
            <Text color={verdictColor(c)} dimColor={c.inSubagent}>
              {c.verdict === 'deny' ? 'x' : '|'}
            </Text>
          ))}
        </Text>
      )
      const buckets = (['file', 'shell', 'other'] as const).map((b: Bucket) => {
        const tl = g.totals[b]
        const n = tl.rule + tl.ask + tl.cleared + tl.deny
        return (
          <Button
            key={`gate-${b}`}
            plain
            hotkey={b[0]}
            label={`${b} ${n}${open === b ? ' ▾' : ''}`}
            dimColor={n === 0}
            onPress={() => update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), gateOpen: normalize(DEFAULT_VIEW, x).gateOpen === b ? null : b }))}
          />
        )
      })
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={isDesk ? dimEdge(C.gate) : C.gate} backgroundColor={isDesk ? tintOf(C.gate) : undefined} paddingX={1} width={w}>
          {isDesk ? accent(C.gate) : null}
          {isDesk ? tab(`${gateTitle}`, C.gate) : null}
          {isDesk ? (
            <Box justifyContent="space-between" columnGap={1}>
              {strip.length > 0 ? checkStrip(strip) : null}
              <Text wrap="truncate">
                <Text color={C.gate}>{`${okN} OK`}</Text>
                {s.ask > 0 ? <Text color={C.amber}>{` · ${s.ask} PEND`}</Text> : null}
                {s.deny > 0 ? <Text color={C.warn}>{` · ${s.deny} DENIED`}</Text> : null}
              </Text>
            </Box>
          ) : null}
          {isDesk ? null : (
            <Box justifyContent="space-between">
              <Text color={C.gate} bold wrap="truncate">{`${mark}${gateTitle} PERMISSIONS`}</Text>
              <Text dimColor>{`${s.total} CHECKS TOTAL`}</Text>
            </Box>
          )}
          {isDesk ? (
            strip.length === 0 ? <Text color={C.faint}>no checks yet</Text> : null
          ) : (
            <Box justifyContent="space-between">
              {stripRow}
              <Text color={C.dim}>{`${okN} OK${s.ask > 0 ? ` / ${s.ask} PENDING` : ''}`}</Text>
            </Box>
          )}
          {isDesk ? (
            <Box flexDirection="column">
              <Text dimColor>{`${s.total} CHECKS:`}</Text>
              <Text wrap="truncate">
                {tallies.every(x => x.n === 0) ? <Text color={C.faint}>none yet</Text> : null}
                {tallies
                  .filter(x => x.n > 0)
                  .map((x, i) => (
                    <Text>
                      {i > 0 ? <Text dimColor> · </Text> : null}
                      <Text color={x.c} bold>{`${x.n} ${x.label}`}</Text>
                    </Text>
                  ))}
              </Text>
              <Box columnGap={2}>{buckets}</Box>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Box flexWrap="wrap" columnGap={1}>
                {tallies.map(x => (
                  <Text color={x.n > 0 ? x.c : C.dim}>{`[${x.icon} ${x.n} ${x.label[0].toUpperCase()}${x.label.slice(1)}]`}</Text>
                ))}
              </Box>
              <Box justifyContent="space-between">{buckets}</Box>
            </Box>
          )}
          {open
            ? g.recent
                .filter(c => c.bucket === open)
                .slice(-5)
                .map(c => (
                  <Text wrap="truncate">
                    <Text color={verdictColor(c)}>{c.verdict === 'deny' ? '✗ ' : '■ '}</Text>
                    <Text color={C.dim}>{`${(c.verdict === 'rule' ? 'allowed' : c.verdict === 'cleared' ? decider : c.verdict === 'ask' ? 'pending' : 'denied').padEnd(10)} `}</Text>
                    <Text dimColor={c.inSubagent}>{shorten(c.detail, Math.max(10, w - 18))}</Text>
                  </Text>
                ))
            : null}
        </Box>
      )
    }

    // ---- agents: cards up to the limit, swimlanes beyond it
    const statusColor = (c: AgentCard) => (c.status === 'failed' ? C.warn : c.status === 'done' ? C.gate : C.agent)
    const glyph = (c: AgentCard) => (c.status === 'running' ? '◐' : c.status === 'done' ? '✓' : c.status === 'failed' ? '✗' : '■')
    const expandOnPress = (id: string) => () =>
      update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), expanded: normalize(DEFAULT_VIEW, x).expanded === id ? null : id }))

    const agentsPanel = (w: number) => {
      // Cards need 20 columns each; when the pane can't hold the limit, lanes take over.
      const fit = Math.max(1, Math.min(cfg.maxCards, Math.floor((w + 1) / 21)))
      const useLanes = cards.length > fit
      const header = (
        <Box justifyContent="space-between" width={w}>
          <Text bold>{`${mark}AGENTS · ${running.length} running · ${cards.length} total`}</Text>
          {cards.length > 0 ? <Text color={C.faint}>1-{Math.min(cards.length, useLanes ? 6 : fit)} expand</Text> : null}
        </Box>
      )
      if (cards.length === 0) {
        return (
          <Box flexDirection="column" width={w}>
            {header}
            <Text color={C.faint}>no subagents yet</Text>
          </Box>
        )
      }
      if (useLanes) {
        const shown = cards.slice(-6)
        const barW = Math.max(8, w - 28)
        const geo = lanes(shown, now, barW)
        return (
          <Box flexDirection="column" width={w}>
            {header}
            {cards.length > shown.length ? <Text color={C.faint}>{`+${cards.length - shown.length} earlier`}</Text> : null}
            {shown.map((c, i) => {
              const gm = geo[i]
              const isViewed = viewed === c.id
              return (
                <Box>
                  <Text color={statusColor(c)} bold={isViewed}>{`${isViewed ? '▶' : glyph(c)} `}</Text>
                  <Box width={17}>
                    <Button key={`card-${c.id}`} plain hotkey={String(i + 1)} label={shorten(cardTitle(c), 14)} onPress={expandOnPress(c.id)} />
                  </Box>
                  <Text color={C.faint}>{' ' + '·'.repeat(gm?.before ?? 0)}</Text>
                  <Text color={statusColor(c)}>{'━'.repeat(gm?.bar ?? 1)}</Text>
                  <Text color={C.faint}>{'·'.repeat(gm?.after ?? 0) + ' '}</Text>
                  {clock(`lane-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}
                </Box>
              )
            })}
          </Box>
        )
      }
      const shown = cards.slice(-fit)
      const cardW = Math.max(20, Math.floor((w - (shown.length - 1)) / shown.length))
      const centers = shown.map((_, i) => i * (cardW + 1) + Math.floor(cardW / 2))
      return (
        <Box flexDirection="column" width={w}>
          {header}
          {rail('fan-out', running.length > 0, C.agent, w, centers)}
          <Box columnGap={1}>
            {shown.map((c, i) => {
              const isViewed = viewed === c.id
              const sameModel = !c.model || prettyModel(c.model) === modelName
              return (
                <Box
                  flexDirection="column"
                  borderStyle={isViewed ? 'double' : 'round'}
                  borderColor={c.lastStop === 'max_tokens' ? C.warn : C.agent}
                  borderDimColor={c.status !== 'running' && !isViewed}
                  width={cardW}
                  paddingX={1}
                >
                  <Button key={`card-${c.id}`} plain hotkey={String(i + 1)} label={titleLines(cardTitle(c), cardW - 7, cardW - 4)[0]} onPress={expandOnPress(c.id)} />
                  <Text bold wrap="truncate">
                    {titleLines(cardTitle(c), cardW - 7, cardW - 4)[1]}
                  </Text>
                  <Text color={C.dim} wrap="truncate">
                    {sameModel ? c.type : `${c.type} · ${prettyModel(c.model)}`}
                  </Text>
                  <Text dimColor wrap="truncate">
                    {c.steps > 0 ? `ctx ${kTokens(c.ctx)} · out ${kTokens(c.out)} · ${c.steps} st` : 'starting…'}
                  </Text>
                  <Box>
                    <Text color={c.lastStop === 'max_tokens' ? C.warn : statusColor(c)}>
                      {cardW >= 26 ? `${glyph(c)} ${c.lastStop === 'max_tokens' ? 'max_tokens' : c.status} ` : `${glyph(c)} `}
                    </Text>
                    <Box flexShrink={0}>{clock(`card-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}</Box>
                  </Box>
                </Box>
              )
            })}
          </Box>
          {rail('merge', running.length > 0, C.agent, w, centers, true)}
        </Box>
      )
    }

    const expandedCard = cards.find(c => c.id === v.expanded)
    const expandedPanel = (w: number) =>
      expandedCard ? (
        <Box flexDirection="column" borderStyle="single" borderColor={C.agent} paddingX={1} width={w}>
          <Text bold wrap="wrap">
            {expandedCard.description || expandedCard.type}
          </Text>
          <Text dimColor wrap="truncate">{`${expandedCard.type} · ${prettyModel(expandedCard.model)} · ${expandedCard.status} · ${expandedCard.steps} steps`}</Text>
          {expandedCard.tools.length === 0 ? <Text color={C.faint}>no tool calls yet</Text> : null}
          {expandedCard.tools.map(n => (
            <Text color={n.isError ? C.warn : C.text} wrap="truncate">
              {`${n.isError ? '✗' : '·'} ${n.text}`}
            </Text>
          ))}
          {expandedCard.answer ? (
            <Text dimColor wrap="wrap">
              {`» ${shorten(expandedCard.answer, 240)}`}
            </Text>
          ) : null}
        </Box>
      ) : null

    // ---- other loops (workflow agents, forks): ids that match no card
    const loopsPanel = (w: number) => {
      if (lp.length === 0) return null
      const active = lp.filter(l => isLoopActive(l, now)).length
      const dots = lp.slice(-Math.max(4, w - 38))
      return (
        <Box width={w}>
          <Text bold>other loops </Text>
          <Text dimColor>{`${lp.length} seen · ${active} active  `}</Text>
          {dots.map(l => (
            <Text color={isLoopActive(l, now) ? C.agent : l.isDone ? C.dim : C.faint}>{isLoopActive(l, now) ? '●' : l.isDone ? '✓' : '○'}</Text>
          ))}
        </Box>
      )
    }

    // ---- receipt: the turn now, or the last one
    const receiptPanel = (w: number) => {
      const isReview = t.isReviewing
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={C.main} borderDimColor={!m.isRunning && !isReview} paddingX={1} width={w}>
          {m.isRunning ? (
            <Box>
              <Text color={C.main} wrap="truncate">{`◐ back to ${modelName.toLowerCase()} · turn `}</Text>
              <Box flexShrink={0}>{clock('turn-clock', t.startedAt, null, C.main)}</Box>
              {w >= 60 ? <Text dimColor wrap="truncate">{` · ${plural(t.edits, 'edit')} · ${plural(t.errors, 'error')}`}</Text> : null}
            </Box>
          ) : r ? (
            <Text wrap="truncate">
              <Text color={r.reason === 'answer' ? C.gate : C.warn}>{r.reason === 'answer' ? '✓ ' : '✗ '}</Text>
              <Text>{`last turn ${fmtDuration(r.durationMs)} · ${plural(r.agents, 'agent')} · ${plural(r.edits, 'edit')} · ${plural(r.errors, 'error')}`}</Text>
              {r.costDelta !== null ? <Text color={C.main}>{` · +${fmtUsd(r.costDelta)}`}</Text> : null}
            </Text>
          ) : (
            <Text color={C.faint}>no turn finished yet</Text>
          )}
          {isReview ? <Text color={C.arch}>{`${cfg.architectLabel.toLowerCase()} reviewing before done (inferred)`}</Text> : null}
        </Box>
      )
    }

    // ---- log: whatever rows the other panels leave, 4 to 8
    const used = 2 + 5 + (showArchitect ? 6 : 0) + 6 + (v.gateOpen ? 5 : 0) + (cards.length > cfg.maxCards ? 3 + Math.min(6, cards.length) : 8) + (expandedCard ? 8 : 0) + (lp.length ? 1 : 0) + 3
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40
    const nLog = logRows(bodyRows, used)
    const shownLines = (viewed ? lines.filter(l => l.agentId === viewed) : lines).slice(-nLog)
    const colorOf = (l: LogLine) =>
      l.kind === 'error' ? C.warn : l.kind === 'consult' ? C.arch : l.who === 'main' ? C.main : l.who === 'gate' ? C.gate : l.who === 'you' ? C.text : C.agent
    const logPanel = (w: number) => {
      const live = m.isRunning && t.startedAt > 0
      const lines = (
        <Box flexDirection="column" borderStyle={isDesk ? 'round' : undefined} borderColor={C.faint} backgroundColor={isDesk ? '#00000040' : undefined} paddingX={isDesk ? 1 : 0}>
          {shownLines.length === 0 ? <Text color={C.faint}>nothing yet</Text> : null}
          {shownLines.map(l => (
            <Box>
              <Box width={9} flexShrink={0}>
                <Text color={C.faint}>{fmtClock(l.at)}</Text>
              </Box>
              <Box width={13} flexShrink={0}>
                <Text color={colorOf(l)} bold wrap="truncate">
                  {`[${shorten(l.who, 10)}]`}
                </Text>
              </Box>
              <Text color={l.kind === 'error' ? C.warn : C.text} wrap="truncate">
                {l.text}
              </Text>
            </Box>
          ))}
          {s.ask > 0 ? <Text color={C.amber}>{'❯ awaiting your permission'}</Text> : null}
        </Box>
      )
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={isDesk ? dimEdge('subtle') : C.faint} backgroundColor={isDesk ? tintOf('subtle', 0.06) : undefined} paddingX={1} width={w}>
          {isDesk ? accent('subtle') : null}
          {isDesk ? tab(`LIVE BUFFER${viewed ? ' · THIS AGENT' : ''}`, 'subtle') : null}
          {isDesk ? (
            <Box justifyContent="space-between">
              <Box>
                {live ? <Text color={C.main} bold>{'[TURN '}</Text> : null}
                {live ? clock('turn-log-clock', t.startedAt, null, C.main) : null}
                {live ? <Text color={C.main} bold>{']'}</Text> : null}
              </Box>
              <Text color={live ? C.cleared : C.dim}>{live ? '● STREAM' : '○ IDLE'}</Text>
            </Box>
          ) : null}
          {isDesk ? null : (
            <Box justifyContent="space-between">
              <Box>
                <Text color={C.dim} bold wrap="truncate">{`${mark}LIVE BUFFER${viewed ? ' · THIS AGENT' : ''}`}</Text>
                {live ? <Text color={C.dim} bold>{' [TURN '}</Text> : null}
                {live ? clock('turn-log-clock', t.startedAt, null, C.dim) : null}
                {live ? <Text color={C.dim} bold>{']'}</Text> : null}
              </Box>
              <Text color={live ? C.cleared : C.dim}>{live ? '● STREAM' : '○ IDLE'}</Text>
            </Box>
          )}
          {lines}
        </Box>
      )
    }

    // ---- fleet: running sessions with their estimated cost (from the user's fleet script)
    const kindColors = [C.agent, C.main, C.gate] // run, today, all
    const fleetTotal = fl.rows.reduce((sum, x) => sum + x.costUsd, 0)
    const fleetPanel = (w: number) => {
      const showIdle = w >= 56
      const costW = w >= 64 ? 24 : 20
      const idleW = showIdle ? 8 : 0
      const stateW = 7
      // inside the frame: 2 border + 2 padding, then the dot, the costs, the idle time and the state chip
      const room = Math.max(6, w - 4 - 2 - costW - idleW - stateW)
      const stateColor = (st: string) => (st === 'busy' ? C.amber : st === 'waiting' ? C.cleared : C.gate)
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={isDesk ? dimEdge(C.agent) : C.faint} backgroundColor={isDesk ? tintOf(C.agent) : undefined} paddingX={1} width={w}>
          {isDesk ? accent(C.agent) : null}
          {isDesk ? tab(`FLEET [${fl.rows.length} ACTIVE]`, C.agent) : null}
          {isDesk ? null : (
            <Text color={C.main} bold wrap="truncate">{`${mark}FLEET [${fl.rows.length} ACTIVE]`}</Text>
          )}
          <Box>
            <Box flexGrow={1}>
              <Text dimColor>{'  WORKER / ID'}</Text>
            </Box>
            <Box width={costW} justifyContent="flex-end">
              <Text color={kindColors[0]}>RUN</Text>
              <Text dimColor> / </Text>
              <Text color={kindColors[1]}>TODAY</Text>
              <Text dimColor> / </Text>
              <Text color={kindColors[2]}>ALL</Text>
            </Box>
            {showIdle ? (
              <Box width={idleW} justifyContent="flex-end">
                <Text dimColor>IDLE</Text>
              </Box>
            ) : null}
            <Box width={stateW} justifyContent="flex-end">
              <Text dimColor>STATE</Text>
            </Box>
          </Box>
          {fl.rows.length === 0 && !fl.error ? <Text dimColor>loading…</Text> : null}
          {fl.rows.slice(0, 6).map(x => {
            // run / today / all in their own colours; equal neighbours merge into one number in the wider kind's colour
            const groups: { v: string; c: string }[] = []
            ;[x.runCostUsd, x.todayCostUsd, x.costUsd].forEach((n, i) => {
              const v = `${i === 0 ? '$' : ''}${n.toFixed(2)}`
              const last = groups[groups.length - 1]
              if (last && last.v.replace('$', '') === v.replace('$', '')) last.c = kindColors[i]
              else groups.push({ v, c: kindColors[i] })
            })
            const st = stateOf(x.status)
            return (
              <Box>
                <Box flexGrow={1}>
                  <Text color={stateColor(x.status)}>{x.status === 'busy' ? '● ' : '○ '}</Text>
                  {x.entrypoint === 'claude-desktop' && x.hostId ? (
                    <Button key={`fleet-${x.id}`} plain label={shorten(x.name, room)} onPress={() => openSession($, x.hostId)} />
                  ) : (
                    <Text bold={x.status === 'busy'} wrap="truncate">{shorten(x.name, room)}</Text>
                  )}
                </Box>
                <Box width={costW} justifyContent="flex-end">
                  {groups.map((g, i) => (
                    <Text>
                      {i > 0 ? <Text dimColor> / </Text> : null}
                      <Text color={g.c}>{g.v}</Text>
                    </Text>
                  ))}
                  {x.costIncomplete ? <Text dimColor>+</Text> : null}
                </Box>
                {showIdle ? (
                  <Box width={idleW} justifyContent="flex-end">
                    <Text dimColor>{fmtDuration(x.idleMs)}</Text>
                  </Box>
                ) : null}
                <Box width={stateW} justifyContent="flex-end">
                  {isDesk ? (
                    <Text color={stateColor(x.status)} bold backgroundColor={tintOf(stateColor(x.status), 0.18)}>{` ${st} `}</Text>
                  ) : (
                    <Text color={stateColor(x.status)}>{`[${st}]`}</Text>
                  )}
                </Box>
              </Box>
            )
          })}
          {fl.rows.length > 6 ? <Text dimColor>{`+${fl.rows.length - 6} more`}</Text> : null}
          {fl.error ? <Text color={C.warn}>{`refresh failed: ${fl.error}`}</Text> : null}
          <Box justifyContent="space-between">
            <Text wrap="truncate">
              <Text dimColor>Today Total: </Text>
              <Text color={C.gate} bold>{fl.todayUsd !== null ? fmtUsd(fl.todayUsd) : '—'}</Text>
            </Text>
            <Text wrap="truncate">
              <Text dimColor>Sessions total: </Text>
              <Text bold>{fmtUsd(fleetTotal)}</Text>
            </Text>
          </Box>
        </Box>
      )
    }

    const draw = (p: Panel, w: number) =>
      p === 'main'
        ? mainPanel(w)
        : p === 'architect'
          ? architectPanel(w)
          : p === 'gate'
            ? gatePanel(w)
            : p === 'agents'
              ? agentsPanel(w)
              : p === 'loops'
                ? loopsPanel(w)
                : p === 'receipt'
                  ? receiptPanel(w)
                  : p === 'fleet'
                    ? fleetPanel(w)
                    : logPanel(w)

    // The desktop draws boxes with no gap where a terminal row leaves one: give the unlinked boxes a row of air.
    const gap = e.surface !== 'terminal'
    // Panels stack directly; only the agents panel draws rails (its fan-out and merge).
    // Desktop: a rounded end for the accent bar, so its ends are round instead of square.
    const accentCap = (color: string, isTop: boolean) => {
      const { Svg } = $.ui.resolve(e)
      const c = barCapSvg(color, isTop)
      return <Svg source={c.svg} alt="accent" width={c.width} height={c.height} />
    }
    // Desktop: a bright line down the inside of the card's left border, curving along the top and bottom borders at its ends.
    const accent = (color: string) => (
      <Box position="absolute" top={0} bottom={0} left={0} width={1} flexDirection="column">
        {accentCap(color, true)}
        <Box flexGrow={1}>
          <Box width="17%" backgroundColor={hexOf(color)} />
        </Box>
        {accentCap(color, false)}
      </Box>
    )
    const column = (ps: Panel[], w: number) => (
      <Box flexDirection="column" width={w}>
        {ps.map((p, i) => {
          return (
            <Box flexDirection="column" marginTop={gap ? (p === 'main' || p === 'gate' || p === 'fleet' || p === 'log' ? 2 : 1) : 0}>
              {draw(p, w)}
              {p === 'agents' ? expandedPanel(w) : null}
            </Box>
          )
        })}
      </Box>
    )

    // Desktop draws the agents' time axis as SVG under the panels.
    const svgLanes =
      e.surface !== 'terminal' && cards.length > 0
        ? (() => {
            const { Svg } = $.ui.resolve(e)
            const rowH = 18
            const pxW = 520
            const geo = lanes(cards.slice(-10), now, 100)
            const rects = cards
              .slice(-10)
              .map((c, i) => {
                const gm = geo[i]
                const x = 150 + ((gm?.before ?? 0) / 100) * (pxW - 160)
                const wpx = Math.max(3, ((gm?.bar ?? 1) / 100) * (pxW - 160))
                const fill = c.status === 'running' ? SVG_COLORS.running : c.status === 'done' ? SVG_COLORS.done : c.status === 'failed' ? SVG_COLORS.failed : SVG_COLORS.other
                const label = shorten(cardTitle(c), 22).replace(/[<&>]/g, '')
                return `<text x="4" y="${i * rowH + 13}" font-size="11" fill="${SVG_COLORS.label}">${label}</text><rect x="${x}" y="${i * rowH + 4}" width="${wpx}" height="10" rx="3" fill="${fill}"/>`
              })
              .join('')
            const svgH = Math.min(10, cards.length) * rowH + 4
            return (
              <Svg
                source={`<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${svgH}" viewBox="0 0 ${pxW} ${svgH}">${rects}</svg>`}
                alt={`${cards.length} agents on a time axis`}
                width={pxW}
                height={svgH}
              />
            )
          })()
        : null

    // Inline above the prompt (the terminal's main screen), the pane is a summary of at most 8 rows.
    const isMini = layout === 'mini' || (layout === 'auto' && e.props.placement === 'inline')
    if (isMini) {
      const live = [...cards.filter(c => c.status === 'running'), ...cards.filter(c => c.status !== 'running').reverse()].slice(0, 3)
      const counts = ` ${s.rule} allowed · ${s.cleared} ${decider}${s.ask > 0 ? ` · ${s.ask} pending` : ''} · ${s.deny} denied`
      const strip = g.recent.slice(-Math.max(4, W - cfg.gateLabel.length - 1 - counts.length))
      const mg = u.pct !== null ? gauge(u.pct, 6) : null
      return (
        <Box flexDirection="column" width={W}>
          <Text wrap="truncate">
            <Text color={C.main} bold>
              {modelName}
            </Text>
            <Text color={m.isRunning ? C.main : C.dim}>{m.isRunning ? ' ● working' : ' ○ idle'}</Text>
            {mg ? <Text dimColor> · ctx </Text> : null}
            {mg ? <Text color={(u.pct ?? 0) >= 80 ? C.warn : C.main}>{mg.on}</Text> : null}
            {mg ? <Text color={C.faint}>{mg.off}</Text> : null}
            {mg ? <Text>{` ${Math.round(u.pct ?? 0)}%`}</Text> : null}
            {u.compactions > 0 ? <Text color={C.amber}>{` ⟲${u.compactions}`}</Text> : null}
            {u.costUsd !== null ? <Text dimColor>{` · ${fmtUsd(u.costUsd)}`}</Text> : null}
            {showArchitect ? <Text color={C.arch}>{` · ${cfg.architectLabel.toLowerCase()} ${advising ? 'advising' : a.consults.length}`}</Text> : null}
          </Text>
          {strip.length > 0 ? (
            <Box>
              <Text dimColor>{`${cfg.gateLabel.toLowerCase()} `}</Text>
              {strip.map(c => (
                <Text color={verdictColor(c)} dimColor={c.inSubagent}>
                  {c.verdict === 'deny' ? 'x' : '|'}
                </Text>
              ))}
              <Text color={s.deny > 0 ? C.warn : s.ask > 0 ? C.amber : C.dim} wrap="truncate">
                {counts}
              </Text>
            </Box>
          ) : null}
          {live.map(c => (
            <Box>
              <Text color={statusColor(c)}>{`${glyph(c)} `}</Text>
              <Box width={Math.max(10, W - 30)}>
                <Text wrap="truncate">{cardTitle(c)}</Text>
              </Box>
              <Text dimColor>{c.steps > 0 ? ` ctx ${kTokens(c.ctx)} ` : ' '}</Text>
              {clock(`mini-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}
            </Box>
          ))}
          {cards.length > live.length ? (
            <Text color={C.faint} wrap="truncate">{`+${cards.length - live.length} more agents · /flightdeck layout compact for all`}</Text>
          ) : null}
          {lp.length > 0 ? <Text dimColor>{`other loops ${lp.length} · ${lp.filter(l => isLoopActive(l, now)).length} active`}</Text> : null}
          {!m.isRunning && r ? (
            <Text dimColor wrap="truncate">
              {`last turn ${fmtDuration(r.durationMs)} · ${plural(r.agents, 'agent')} · ${plural(r.edits, 'edit')} · ${plural(r.errors, 'error')}${r.costDelta !== null ? ` · +${fmtUsd(r.costDelta)}` : ''}`}
            </Text>
          ) : null}
        </Box>
      )
    }

    const body = isWide ? (
      <Box flexDirection="column">
        <Box columnGap={2}>
          {column(panels.filter(p => p === 'main' || p === 'architect' || p === 'gate'), colW)}
          {column(panels.filter(p => p === 'agents' || p === 'loops' || p === 'receipt' || p === 'fleet'), colW)}
        </Box>
        {panels.includes('log') ? <Box marginTop={gap ? 1 : 0}>{logPanel(W)}</Box> : null}
      </Box>
    ) : (
      column(panels, W)
    )

    const modelLine = (
      <Text wrap="truncate">
        <Text color={C.main} bold>{modelName.toUpperCase()}</Text>
        <Text color={C.dim}>{' :: '}</Text>
        <Text color={m.isRunning ? C.gate : C.dim} bold>{m.isRunning ? 'RUNNING' : 'IDLE'}</Text>
        {showArchitect ? <Text color={C.dim}>{' · '}</Text> : null}
        {showArchitect ? <Text color={C.arch}>{cfg.architectLabel}</Text> : null}
        {showArchitect ? <Text>{advising ? ' ADVISING' : ' ON CALL'}</Text> : null}
      </Text>
    )
    const logo = (() => {
      const { Svg } = $.ui.resolve(e)
      const l = logoSvg(C.main)
      return <Svg source={l.svg} alt="Flightdeck" width={l.size} height={l.size} />
    })()
    const heading = isDesk ? (
      <Box justifyContent="space-between" borderStyle="round" borderColor={C.faint} backgroundColor={tintOf('subtle', 0.06)} paddingX={1} width={W}>
        <Box columnGap={1}>
          {logo}
          <Box flexDirection="column">
            <Text wrap="truncate">
              <Text color={C.main} bold>FLIGHTDECK</Text>
              {ver ? <Text dimColor>{` v${ver}`}</Text> : null}
            </Text>
            {modelLine}
          </Box>
        </Box>
        {cards.length > 0 ? (
          <Text color={C.agent} backgroundColor={tintOf(C.agent, 0.16)}>{` agents (${cards.length}) `}</Text>
        ) : null}
      </Box>
    ) : (
      <Box justifyContent="space-between" width={W}>
        <Text wrap="truncate">
          <Text color={C.main} bold>FLIGHTDECK</Text>
          {ver ? <Text dimColor>{` v${ver}`}</Text> : null}
          <Text color={C.dim}>{' :: '}</Text>
          <Text color={C.main} bold>{modelName.toUpperCase()}</Text>
          <Text color={m.isRunning ? C.gate : C.dim} bold>{m.isRunning ? ' RUNNING' : ' IDLE'}</Text>
          {showArchitect ? <Text color={C.dim}>{' · '}</Text> : null}
          {showArchitect ? <Text color={C.arch}>{cfg.architectLabel}</Text> : null}
          {showArchitect ? <Text>{advising ? ' ADVISING' : ' ON CALL'}</Text> : null}
        </Text>
        {cards.length > 0 ? <Text color={C.agent}>{`agents (${cards.length})`}</Text> : null}
      </Box>
    )

    return (
      <Box flexDirection="column" width={W}>
        {heading}
        {body}
        {svgLanes}
      </Box>
    )
  })
}
