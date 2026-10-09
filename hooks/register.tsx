import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Usage } from '../types'
import { legacyEntries, linesFromPatch, linesOf, nextCache, spendKey, spendTime, spentSince, WINDOW_MS } from './hud'
import { buildSvg, castleSvg, NIGHT } from './svg'
import { ACHIEVEMENTS, addStats, dayKey, emptyStats, isTestCommand, profileOf, report, turnXp, XP } from './xp'
import type { Stats } from './xp'

const usage = atom({ plugin: 'castle-hud', key: 'usage' } as const, null)
const cache = atom({ plugin: 'castle-hud', key: 'cache' } as const, null)
const batCount = atom({ plugin: 'castle-hud', key: 'bats' } as const, 0)
const tick = atom({ plugin: 'castle-hud', key: 'now' } as const, 0)
const windowUsd = atom({ plugin: 'castle-hud', key: 'windowUsd' } as const, null)
const lastTurn = atom({ plugin: 'castle-hud', key: 'lastTurn' } as const, null)
const lines = atom({ plugin: 'castle-hud', key: 'lines' } as const, { added: 0, removed: 0 })
const startedAt = atom({ plugin: 'castle-hud', key: 'startedAt' } as const, 0)
const profile = atom({ plugin: 'castle-hud', key: 'profile' } as const, null)

// Cross-session spend. Every cost increase is its own write-once key, `spend:<t>:<id>`, holding the dollars:
// sessions never overwrite each other, and clean-up deletes only keys whose own time has passed.
const SPEND = 'spend:'
const KEEP_MS = 6 * 3600e3
type Entry = { t: number; usd: number }
// Entries already read: they never change once written.
const seenSpend = new Map<string, number>()
// Numbers this session's spend keys, so two increases in the same millisecond never share one.
let spendSeq = 0

const ACTIVE = new Set(['pending', 'running', 'waiting'])

function toUsage(u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): Usage {
  return {
    usd: u.cost?.usd,
    tokens: u.context.tokens,
    window: u.context.window,
    percent: u.context.percent,
    limits: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
  }
}

// This module's own state, fresh on every load.
let lastUsd: number | undefined
const myId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
// Subagents spawned but not yet in the roster, by id, with when they were spawned.
const fresh = new Map<string, number>()
// Subagents seen running, to notice when one finishes.
const seenRunning = new Set<string>()
// This session's XP record, saved under its own key; lines changed during the current turn.
const XP_KEY = `xp:${myId}`
let mine: Stats = emptyStats()
let turnLines = 0
let dirty = false
// The level and achievements last shown, to toast what is new; null until the first profile is read.
let known: { level: number; unlocked: Set<string> } | null = null

function windowStart(u: Usage | null, now: number): number {
  const span = WINDOW_MS.five_hour ?? 0
  const five = u?.limits.find(l => l.kind === 'five_hour')
  if (!five?.resetsAt) return now - span
  const reset = Date.parse(five.resetsAt)
  // Past its reset with no new reading yet: the new window began at that reset.
  return reset <= now ? reset : reset - span
}

/** Every session's spend entries still worth keeping; deletes the ones past keeping and older formats. */
async function allSpend($: EngineInterface, t: number): Promise<Entry[]> {
  const out: Entry[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(SPEND)) continue
    const at = spendTime(key)
    if (at === null) {
      // The previous format, a list per session: copy what is still in range to new keys, then drop it.
      const id = key.slice(SPEND.length)
      const keep = legacyEntries(await $.store.get(key), t - KEEP_MS)
      for (const [i, e] of keep.entries()) {
        const k = spendKey(e.t, `old-${id}`, i)
        await $.store.set(k, e.usd)
        seenSpend.set(k, e.usd)
        out.push(e)
      }
      await $.store.delete(key)
      continue
    }
    if (at < t - KEEP_MS) {
      await $.store.delete(key)
      seenSpend.delete(key)
      continue
    }
    let usd = seenSpend.get(key)
    if (usd === undefined) {
      usd = Number(await $.store.get(key)) || 0
      seenSpend.set(key, usd)
    }
    out.push({ t: at, usd })
  }
  return out
}

async function resum($: EngineInterface) {
  const t = await $.clock.now()
  const spent = spentSince(await allSpend($, t), windowStart(await read($, usage), t))
  if (Math.abs(spent - ((await read($, windowUsd)) ?? -1)) > 0.004) await update($, windowUsd, () => spent)
}

/** Running subagents from the roster, plus any spawned in the last 10 seconds that it does not list yet. */
async function countBats($: EngineInterface) {
  const agents = await $.agent.list()
  const t = await $.clock.now()
  const ids = new Set(agents.filter(a => ACTIVE.has(a.status)).map(a => a.id))
  const listed = new Set(agents.map(a => a.id))
  for (const [id, at] of fresh) {
    if (listed.has(id) || at < t - 10_000) fresh.delete(id)
    else ids.add(id)
  }
  if (ids.size !== (await read($, batCount))) await update($, batCount, () => ids.size)
  // A subagent that was running and now reports completed is a bat slain.
  for (const id of seenRunning) {
    if (ids.has(id)) continue
    seenRunning.delete(id)
    if (agents.find(a => a.id === id)?.status === 'completed') {
      mine = { ...mine, bats: mine.bats + 1, xp: mine.xp + XP.bat }
      dirty = true
    }
  }
  for (const id of ids) seenRunning.add(id)
}

let saving: Promise<void> = Promise.resolve()

/** Saves this session's record if it changed. Saves run one at a time, so an older record never lands last. */
function saveMine($: EngineInterface): Promise<void> {
  // A failed save must not stop later ones: start from a settled queue. The record stays marked until a save lands.
  saving = saving.catch(() => undefined).then(async () => {
    if (!dirty) return
    const snapshot = mine
    await $.store.set(XP_KEY, snapshot)
    // XP earned while this save ran changed `mine`: leave it marked, for the next save.
    if (mine === snapshot) dirty = false
  })
  return saving
}

/** Saves this session's record if it changed, then re-derives the profile from every session's records. */
async function syncProfile($: EngineInterface): Promise<Stats> {
  await saveMine($).catch(() => undefined) // retried on the next refresh
  let all = emptyStats()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('xp:')) continue
    const s = key === XP_KEY ? mine : ((await $.store.get(key)) as Stats | undefined)
    if (s) all = addStats(all, s)
  }
  const p = profileOf(all, dayKey(await $.clock.now()))
  const was = await read($, profile)
  if (!was || was.xp !== p.xp || was.streak !== p.streak || was.unlocked.length !== p.unlocked.length) await update($, profile, () => p)

  if (known) {
    if (p.level > known.level) $.ui.toast(`Level ${p.level} reached: ${p.title}`)
    for (const a of ACHIEVEMENTS) if (p.unlocked.includes(a.id) && !known.unlocked.has(a.id)) $.ui.toast(`Achievement unlocked: ${a.name}`)
  }
  known = { level: p.level, unlocked: new Set(p.unlocked) }
  return all
}

/** Starts this conversation's own figures over: on load, and after /clear. */
async function startOver($: EngineInterface) {
  const now = await $.session.usage()
  await update($, usage, () => toUsage(now))
  lastUsd = now.cost?.usd
  await update($, startedAt, () => now.startedAt)
}

export const register: Register = on => {
  let shownPercent = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const refresh = async () => {
      // Write only what changed: every write redraws the band.
      await countBats($)
      const minute = Math.floor((await $.clock.now()) / 60000) * 60000
      if (minute !== (await read($, tick))) await update($, tick, () => minute)
      // Re-sum the window each refresh, so it drops back to $0 after a reset even when idle.
      await resum($)
      await syncProfile($)
    }
    await $.store.delete('ledger') // the shared list an earlier version kept
    await startOver($)
    await $.command.register({ name: 'castle', description: 'Show your castle-hud level, streak and achievements' })
    await refresh()
    $.clock.every(15_000, () => void refresh())

    return result
  })

  // /clear starts a new conversation without a new session.start: reset what belongs to the old one.
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'clear') {
      turnLines = 0
      await update($, lines, () => ({ added: 0, removed: 0 }))
      await update($, lastTurn, () => null)
      await update($, cache, () => null)
      $.clock.after(1000, () => void startOver($))
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    const u = toUsage(e)
    await update($, usage, () => u)

    if (e.cost && e.changed.includes('cost')) {
      const t = await $.clock.now()
      // A total below the last one means the session's cost started over (a /clear): all of it is new.
      const delta = lastUsd === undefined ? 0 : e.cost.usd < lastUsd ? e.cost.usd : e.cost.usd - lastUsd
      lastUsd = e.cost.usd
      if (delta > 0) await $.store.set(spendKey(t, myId, spendSeq++), delta)
      await resum($)
    }

    return next(e)
  })

  // Lines changed: count each edit that went through, in the main loop and in subagents.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const isEdit = e.tool === 'Edit' || e.tool === 'Write' || (e.tool as string) === 'MultiEdit'
    if (isEdit && ran.deny === undefined && ran.isError !== true) {
      // The result's patch is what really changed; the input is the fallback when no patch came back.
      const patch = (ran.result as { structuredPatch?: unknown } | undefined)?.structuredPatch
      // A new file's patch comes back empty: fall back to the input when the patch shows nothing.
      const fromPatch = linesFromPatch(patch)
      const d = fromPatch && fromPatch.added + fromPatch.removed > 0 ? fromPatch : linesOf(e.tool, e as unknown as Record<string, unknown>)
      turnLines += d.added + d.removed
      if (d.added + d.removed > 0) await update($, lines, l => ({ added: l.added + d.added, removed: l.removed + d.removed }))
    }

    return ran
   }).catch(($, e, next) => next(e)) // counting failed: the tool call still goes through

  // A test run that passed earns XP.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    // Only a run that finished here counts: a background run has only started, its result unknown.
    const isBackground = e.run_in_background === true || (ran.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId !== undefined
    if (ran.deny === undefined && ran.isError !== true && !isBackground && isTestCommand(e.command)) {
      mine = { ...mine, tests: mine.tests + 1, xp: mine.xp + XP.test }
      dirty = true
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'castle' }, async $ => {
    const all = await syncProfile($)
    const p = await read($, profile)

    return { text: p ? report(all, p) : 'No XP yet: finish a turn to start.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.deny === undefined && spawned.agentId) {
      fresh.set(spawned.agentId, await $.clock.now())
      await countBats($)
    }

    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId) {
      await countBats($)
    } else if (e.usage) {
      const u = e.usage
      const turn = { ms: e.durationMs, out: u.output_tokens }
      await update($, lastTurn, () => turn)

      // XP for the turn: finishing it, the lines it changed, a warm cache, a tidy context.
      const t = await $.clock.now()
      const warm = u.cache_read_input_tokens > 0
      const tidy = ((await read($, usage))?.percent ?? 0) < 60
      const isNight = new Date(t).getHours() < 4
      const day = dayKey(t)
      mine = {
        ...mine,
        xp: mine.xp + turnXp({ lines: turnLines, warm, tidy }),
        turns: mine.turns + 1,
        lines: mine.lines + turnLines,
        warm: mine.warm + (warm ? 1 : 0),
        tidy: mine.tidy + (tidy ? 1 : 0),
        night: mine.night + (isNight ? 1 : 0),
        days: mine.days.includes(day) ? mine.days : [...mine.days, day],
      }
      turnLines = 0
      dirty = true
      await syncProfile($)
      const at = await $.clock.now()
      const prev = await read($, cache)
      const next2 = nextCache(prev?.at ? prev : null, u, at)
      if (next2 !== prev) await update($, cache, () => next2)
    }

    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Drawn on the desktop app, VS Code and mobile only: a terminal keeps its own status line.
    if (e.props.hasSurvey || e.surface === 'terminal') return next(e)

    const u = await read($, usage)
    const saved = await read($, cache)
    const c = saved?.at ? saved : null
    const bats = await read($, batCount)
    const spent = await read($, windowUsd)
    const turn = await read($, lastTurn)
    const changed = await read($, lines)
    const began = await read($, startedAt)
    const prof = await read($, profile)
    const now = (await read($, tick)) || (await $.clock.now())
    const pct = u?.percent ?? 0

    const { Box, Svg } = $.ui.resolve(e)
    const svg = buildSvg({ usage: u, cache: c, bats, now, prevPercent: shownPercent, mode: 'dark', windowUsd: spent ?? undefined, lastTurn: turn, lines: changed, startedAt: began || undefined, profile: prof })
    const castle = castleSvg(pct)
    const widest = Math.max(0, ...svg.parts.map(p => p.width))
    shownPercent = pct

    // Drawn as images, not interactive frames: an image swaps in place on a redraw, a frame reloads and flashes.
    return (
      // Mods get no corner radius; a round border in the background's own color is how the corners round.
      <Box flexDirection="row" alignItems="flex-end" backgroundColor={NIGHT} borderStyle="round" borderColor={NIGHT} overflow="hidden" width="100%">
        {/* The sections wrap in the space left of the castle, which keeps a column of its own: nothing sits under the flames. */}
        <Box flexDirection="row" flexWrap="wrap" alignItems="flex-end" flexGrow={1} flexShrink={1} minWidth={`${widest}px`}>
          {svg.parts.map((part, i) => (
            <Svg key={`s${i}`} source={part.source} alt={part.alt} width={part.width} height={part.height} />
          ))}
        </Box>
        {/* On a pane too narrow for both, the castle shrinks and clips first: a section is never cut. */}
        <Box flexShrink={1} minWidth={0} overflow="hidden" flexDirection="row" justifyContent="flex-end">
          <Svg key="castle" source={castle.source} alt={castle.alt} width={castle.width} height={castle.height} />
        </Box>
      </Box>
    )
  })
}
