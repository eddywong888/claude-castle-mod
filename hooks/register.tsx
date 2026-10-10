import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Cache, LastTurn, Lines, Usage } from '../types'
import { CACHE_TTL_MS, editLines, legacyEntries, nextCache, spendKey, spendTime, spentSince, wasWarm, WINDOW_MS } from './hud'
import { buildSvg, castleSvg, NIGHT } from './svg'
import { ACHIEVEMENTS, addStats, dayKey, emptyStats, isTestCommand, profileOf, report, subStats, turnXp, XP } from './xp'
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
// This session's XP id, kept in the session's state so a reload keeps adding to the same record.
const xpId = atom({ plugin: 'castle-hud', key: 'xpId' } as const, '')

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
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
const myId = newId()
// Subagents spawned but not yet in the roster, by id, with when they were spawned.
const fresh = new Map<string, number>()
// Subagents seen running or spawned, to notice when one finishes; and those already credited with XP.
const seenRunning = new Set<string>()
const credited = new Set<string>()
// When a watched subagent was first missing from the roster: one gone for long is dropped rather than watched forever.
const missingSince = new Map<string, number>()
const MISSING_MS = 10 * 60e3
// This session's XP record, saved under its own key (set at session start); lines changed during the current turn.
let XP_KEY = `xp:${myId}`
let mine: Stats = emptyStats()
// The record as last saved, and when: an open session saves at least hourly, so a record unsaved for days has ended.
let lastSaved: Stats | null = null
let lastSavedAt = 0
const TOUCH_EVERY_MS = 3600e3
// Ended sessions' records are folded into one archive record, so the store doesn't grow a key per session forever.
// Each session folds its own record as it ends; a record left by a session that crashed is folded by others once
// it has gone unsaved for a week. Outside the `xp:` keys, which versions before 0.7.2 read as session records.
const ARCHIVE = 'archive:xp'
const OLD_ARCHIVE = 'xp:archive'
type Archive = { total: Stats; folded: Record<string, number> }
const FOLD_AFTER_MS = 7 * 86400e3
const FORGET_FOLDED_MS = 30 * 86400e3
// The level and achievements already toasted, shared by every session so each is toasted once, not once a window.
const TOASTED = 'toasted'
// The 5-hour window's last known reset, kept for the moments before Claude Code's first reading.
const RESET_KEY = 'reset:five_hour'
let knownReset: string | undefined
// Other sessions' XP records, re-read every few minutes rather than on every refresh.
let others = new Map<string, Stats>()
let othersAt = 0
const OTHERS_EVERY_MS = 5 * 60e3
let turnLines = 0
// When the main conversation's current turn started (turn.start fires for the main loop only).
let turnStartedAt = 0
// How long the prompt cache lasts: an hour, unless a model switch reports otherwise.
let cacheTtlMs = CACHE_TTL_MS
let dirty = false
// This conversation's own figures (lines changed, last turn, cache), saved under its id so a restart restores them.
const CONV = 'conv:'
const CONV_KEEP_MS = 30 * 86400e3
type Conversation = { lines: Lines; lastTurn: LastTurn | null; cache: Cache | null; at: number }
let convDirty = false
// The conversation the figures belong to, set as it starts: they're saved under it even mid-switch.
let convId: string | undefined
// The level and achievements last shown, to toast what is new; null until the first profile is read.
let known: { level: number; unlocked: Set<string> } | null = null

function windowStart(resetsAt: string | undefined, now: number): number {
  const span = WINDOW_MS.five_hour ?? 0
  if (!resetsAt) return now - span
  const reset = Date.parse(resetsAt)
  // Past its reset with no new reading yet: the new window began at that reset.
  return reset <= now ? reset : reset - span
}

/** Every session's spend entries still worth keeping; deletes the ones past keeping and older formats. */
async function allSpend($: EngineInterface, t: number): Promise<Entry[]> {
  // Keyed by destination: an entry copied on an interrupted earlier pass and still in its old list counts once.
  const out = new Map<string, Entry>()
  const keys = await $.store.keys()
  // Forget entries other sessions have deleted since the last pass.
  const present = new Set(keys)
  for (const key of seenSpend.keys()) if (!present.has(key)) seenSpend.delete(key)
  for (const key of keys) {
    if (!key.startsWith(SPEND)) continue
    const at = spendTime(key)
    if (at === null) {
      // The previous format, a list per session: copy what is still in range to new keys, then drop it.
      const id = key.slice(SPEND.length)
      const keep = legacyEntries(await $.store.get(key), t - KEEP_MS)
      for (const e of keep) {
        const k = spendKey(e.t, `old-${id}`, e.i)
        await $.store.set(k, e.usd)
        seenSpend.set(k, e.usd)
        out.set(k, { t: e.t, usd: e.usd })
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
    out.set(key, { t: at, usd })
  }
  return [...out.values()]
}

let summing: Promise<void> = Promise.resolve()

/** Re-sums the 5-hour spend; sums run one at a time, so an older total never replaces a newer one. */
function resum($: EngineInterface): Promise<void> {
  summing = summing.catch(() => undefined).then(() => sumSpend($))
  return summing
}

const later = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b)

/**
 * The 5-hour window's reset: this session's reading while it's still ahead; once it has passed (an idle session)
 * or before the first reading, the latest any session saved, which another session may have moved on.
 */
async function fiveHourReset($: EngineInterface, now: number): Promise<string | undefined> {
  const own = (await read($, usage))?.limits.find(l => l.kind === 'five_hour')?.resetsAt
  if (own && Date.parse(own) > now) return own
  const saved = await $.store.get(RESET_KEY)
  if (typeof saved === 'string') knownReset = later(knownReset, saved)
  return later(own, knownReset)
}

/** Saves the 5-hour window's reset when a reading brings a later one. */
async function noteReset($: EngineInterface, u: Usage) {
  const at = u.limits.find(l => l.kind === 'five_hour')?.resetsAt
  if (!at || at === knownReset) return
  // Never move the saved reset back: a session's first reading may be older than another's latest.
  const saved = await $.store.get(RESET_KEY)
  knownReset = later(knownReset, typeof saved === 'string' ? saved : undefined)
  if (later(at, knownReset) !== at || at === knownReset) return
  await $.store.set(RESET_KEY, at)
  knownReset = at
}

async function sumSpend($: EngineInterface) {
  const t = await $.clock.now()
  const spent = spentSince(await allSpend($, t), windowStart(await fiveHourReset($, t), t))
  if (Math.abs(spent - ((await read($, windowUsd)) ?? -1)) > 0.004) await update($, windowUsd, () => spent)
}

let roster: Promise<void> = Promise.resolve()

/** Reads the roster; readings run one at a time, so an older one never lands after a newer one. */
function countBats($: EngineInterface): Promise<void> {
  roster = roster.catch(() => undefined).then(() => readRoster($))
  return roster
}

/** Running subagents from the roster, plus any spawned in the last 10 seconds that it does not list yet. */
async function readRoster($: EngineInterface) {
  const agents = await $.agent.list()
  const t = await $.clock.now()
  const ids = new Set(agents.filter(a => ACTIVE.has(a.status)).map(a => a.id))
  const listed = new Set(agents.map(a => a.id))
  for (const [id, at] of fresh) {
    if (listed.has(id) || at < t - 10_000) fresh.delete(id)
    else ids.add(id)
  }
  if (ids.size !== (await read($, batCount))) await update($, batCount, () => ids.size)
  // A subagent that was running (or was spawned) and now reports completed is a bat slain, once.
  for (const id of seenRunning) {
    if (ids.has(id)) continue
    const status = agents.find(a => a.id === id)?.status
    if (status === undefined) {
      // Not in the roster yet: keep watching, for a while. Its turn.complete may still credit it.
      const since = missingSince.get(id) ?? t
      missingSince.set(id, since)
      if (t - since > MISSING_MS) {
        seenRunning.delete(id)
        missingSince.delete(id)
      }
      continue
    }
    seenRunning.delete(id)
    missingSince.delete(id)
    if (status === 'completed') creditBat(id)
  }
  for (const id of ids) {
    seenRunning.add(id)
    missingSince.delete(id)
  }
}

/** A subagent finished: a bat slain, credited once whichever sign of it comes first. */
function creditBat(id: string) {
  if (credited.has(id)) return
  credited.add(id)
  mine = { ...mine, bats: mine.bats + 1, xp: mine.xp + XP.bat }
  dirty = true
}

let saving: Promise<void> = Promise.resolve()

/** Saves this session's record if it changed. Saves run one at a time, so an older record never lands last. */
function saveMine($: EngineInterface): Promise<void> {
  // A failed save must not stop later ones: start from a settled queue. The record stays marked until a save lands.
  saving = saving.catch(() => undefined).then(async () => {
    const now = await $.clock.now()
    // Unchanged records are saved again hourly, so others can tell an open session from an ended one.
    if (!dirty && (!lastSaved || now - lastSavedAt < TOUCH_EVERY_MS)) return
    // Another session may have folded this record into the archive (after a long sleep, say): never write over it.
    if (lastSaved) await leaveIfFolded($)
    const snapshot = mine
    await $.store.set(XP_KEY, { ...snapshot, savedAt: now })
    lastSaved = snapshot
    lastSavedAt = now
    // XP earned while this save ran changed `mine`: leave it marked, for the next save.
    if (mine === snapshot) dirty = false
  })
  return saving
}

async function readArchive($: EngineInterface): Promise<Archive> {
  let a = (await $.store.get(ARCHIVE)) as Partial<Archive> | undefined
  // 0.7.2 and 0.7.3 keep it among the `xp:` keys, and a window still running one may write it again: merge it in.
  const old = (await $.store.get(OLD_ARCHIVE)) as Partial<Archive> | undefined
  if (old) {
    a = mergeArchives(a, old)
    await $.store.set(ARCHIVE, a)
    await $.store.delete(OLD_ARCHIVE)
  } else if (!a) {
    // Another session may have just moved it: look once more before taking the archive as empty.
    a = (await $.store.get(ARCHIVE)) as Partial<Archive> | undefined
  }
  return { total: a?.total ?? emptyStats(), folded: a?.folded ?? {} }
}

/**
 * The archive with an older-format one merged in. Its total is added only when it folded records this one
 * hasn't: a total already merged on an earlier pass, and copied again by an old window, isn't counted twice.
 */
function mergeArchives(a: Partial<Archive> | undefined, old: Partial<Archive>): Archive {
  const total = a?.total ?? emptyStats()
  const folded = { ...(a?.folded ?? {}) }
  const oldFolded = old.folded ?? {}
  const fresh = !a || Object.keys(oldFolded).length === 0 || Object.keys(oldFolded).some(k => !(k in folded))
  return { total: fresh && old.total ? addStats(total, old.total) : total, folded: { ...oldFolded, ...folded } }
}

/** Moves this session on to a fresh record, keeping only what the saved one (now counted elsewhere) lacks. */
async function moveToNewRecord($: EngineInterface) {
  const id = newId()
  await update($, xpId, () => id)
  XP_KEY = `xp:${id}`
  mine = lastSaved ? subStats(mine, lastSaved) : mine
  lastSaved = null
  lastSavedAt = 0
  // The archive now counts what this record held: read it again rather than show a total without it.
  othersAt = 0
  dirty = mine.xp > 0 || mine.turns > 0 || mine.lines > 0 || (mine.compacts ?? 0) > 0
}

/**
 * When this record is already in the archive, carries on under a new key with only what was earned since. A
 * record saved before but gone from the store was folded too, its entry in the archive's list since forgotten.
 */
async function leaveIfFolded($: EngineInterface) {
  const archive = await readArchive($)
  if (XP_KEY in archive.folded || (lastSaved && (await $.store.get(XP_KEY)) === undefined)) await moveToNewRecord($)
}

/**
 * Folds this session's saved record into the archive as the conversation ends, then carries on under a new one.
 * The old key is deleted by a later pass of any session, once the archive counting it is surely in the store.
 */
async function foldMine($: EngineInterface) {
  if (!lastSaved) return
  const archive = await readArchive($)
  if (!(XP_KEY in archive.folded)) {
    const now = await $.clock.now()
    const total = addStats(archive.total, lastSaved)
    await $.store.set(ARCHIVE, { total, folded: { ...archive.folded, [XP_KEY]: now } })
    // Show it at once: the next refresh's profile adds the archive from the cache, not from the store.
    others.set(ARCHIVE, total)
  }
  await moveToNewRecord($)
}

/**
 * Other sessions' records, with the archive's total among them. Records not saved for days belong to ended
 * sessions: they are added to the archive and listed as folded, and deleted on a later pass, once the archive
 * that counts them is surely the one in the store (a fold lost to another session's write is simply redone).
 */
async function readOthers($: EngineInterface, now: number): Promise<Map<string, Stats>> {
  const archive = await readArchive($)
  const keys = await $.store.keys()
  const present = new Set(keys)
  const out = new Map<string, Stats>()
  const fold: [string, Stats][] = []
  // Folded while still open: carry on under a new record, so it isn't counted twice and then deleted.
  if (XP_KEY in archive.folded) await moveToNewRecord($)
  for (const key of keys) {
    if (!key.startsWith('xp:') || key === XP_KEY || key === OLD_ARCHIVE) continue
    if (key in archive.folded) {
      await $.store.delete(key) // counted in the archive
      continue
    }
    // Saved within the week: an open session's (they save hourly), or one that just ended and will fold itself.
    const s = (await $.store.get(key)) as Stats | undefined
    if (!s) continue
    if (now - (s.savedAt ?? 0) > FOLD_AFTER_MS) fold.push([key, s])
    else out.set(key, s)
  }
  const folded = { ...archive.folded }
  let changed = false
  for (const [key, at] of Object.entries(folded)) {
    if (!present.has(key) && now - at > FORGET_FOLDED_MS) {
      delete folded[key]
      changed = true
    }
  }
  let total = archive.total
  for (const [key, s] of fold) {
    total = addStats(total, s)
    folded[key] = now
    changed = true
  }
  if (changed) await $.store.set(ARCHIVE, { total, folded })
  out.set(ARCHIVE, total)
  return out
}

let syncing: Promise<Stats> = Promise.resolve(emptyStats())

/** Saves and re-derives the profile; syncs run one at a time, so an older profile never replaces a newer one. */
function syncProfile($: EngineInterface, everyone = false): Promise<Stats> {
  syncing = syncing.catch(() => emptyStats()).then(() => deriveProfile($, everyone))
  return syncing
}

/** Saves this session's record if it changed, then re-derives the profile from every session's records. */
async function deriveProfile($: EngineInterface, everyone = false): Promise<Stats> {
  await saveMine($).catch(() => undefined) // retried on the next refresh
  const now = await $.clock.now()
  if (everyone || now - othersAt > OTHERS_EVERY_MS) {
    others = await readOthers($, now)
    othersAt = now
  }
  let all = mine
  for (const s of others.values()) all = addStats(all, s)
  const p = profileOf(all, dayKey(now))
  const was = await read($, profile)
  const changed = !was || was.xp !== p.xp || was.streak !== p.streak || was.unlocked.length !== p.unlocked.length || was.castleTier !== p.castleTier
  if (changed) await update($, profile, () => p)

  const seen = known
  if (seen && (p.level > seen.level || p.unlocked.some(a => !seen.unlocked.has(a)))) {
    // Every open session sees the same rise: toast only what no session has toasted yet.
    const shown = (await $.store.get(TOASTED)) as { level: number; unlocked: string[] } | undefined
    const base = shown ?? { level: seen.level, unlocked: [...seen.unlocked] }
    const had = new Set(base.unlocked)
    if (p.level > base.level) $.ui.toast(`Level ${p.level} reached: ${p.title}`)
    for (const a of ACHIEVEMENTS) if (p.unlocked.includes(a.id) && !had.has(a.id)) $.ui.toast(`Achievement unlocked: ${a.name}`)
    await $.store.set(TOASTED, { level: Math.max(base.level, p.level), unlocked: [...new Set([...base.unlocked, ...p.unlocked])] })
  }
  known = { level: p.level, unlocked: new Set(p.unlocked) }
  return all
}

/**
 * Deletes everything the mod saved: every session's XP, the archive and the 5-hour spending. Runs in turn with
 * the profile syncs and the saves, so none already under way writes an old record back afterwards.
 */
function resetAll($: EngineInterface): Promise<void> {
  const run = syncing.catch(() => emptyStats()).then(async () => {
    saving = saving.catch(() => undefined).then(() => wipe($))
    await saving
    return emptyStats()
  })
  syncing = run
  return run.then(() => undefined)
}

async function wipe($: EngineInterface) {
  for (const key of await $.store.keys()) await $.store.delete(key)
  mine = emptyStats()
  lastSaved = null
  lastSavedAt = 0
  dirty = false
  others = new Map()
  // Read everyone again on the next refresh, which finds the store empty.
  othersAt = 0
  known = null
  seenSpend.clear()
  knownReset = undefined
  await update($, profile, () => null)
  await update($, windowUsd, () => null)
}

/** Starts this conversation's own figures over, for a cleared, resumed or forked conversation. */
async function forgetConversation($: EngineInterface) {
  // Until the new conversation's baseline is read, cost changes count as nothing rather than as old spend.
  lastUsd = undefined
  turnLines = 0
  await update($, lines, () => ({ added: 0, removed: 0 }))
  await update($, lastTurn, () => null)
  await update($, cache, () => null)
  // The old conversation's figures were saved as it ended; nothing new is unsaved yet.
  convDirty = false
}

/** Saves this conversation's figures under its id, if they changed. */
async function saveConversation($: EngineInterface) {
  if (!convDirty) return
  convDirty = false
  try {
    const saved: Conversation = { lines: await read($, lines), lastTurn: await read($, lastTurn), cache: await read($, cache), at: await $.clock.now() }
    await $.store.set(CONV + (convId ?? (await $.session.id())), saved)
  } catch (err) {
    convDirty = true // tried again on the next refresh
    throw err
  }
}

/** Puts back this conversation's figures as they were last saved: after a restart, or on /resume. */
async function restoreConversation($: EngineInterface) {
  const held = await read($, cache)
  // A hot reload keeps the figures it had, which are newer than any saved: leave them, and save them soon,
  // since what changed just before the reload may not be saved yet.
  const changed = await read($, lines)
  if ((await read($, lastTurn)) || changed.added + changed.removed > 0) {
    if (held?.ttlMs) cacheTtlMs = held.ttlMs
    convDirty = true
    return
  }
  const saved = (await $.store.get(CONV + (convId ?? (await $.session.id())))) as Partial<Conversation> | undefined
  if (!saved) return
  await update($, lines, () => saved.lines ?? { added: 0, removed: 0 })
  await update($, lastTurn, () => saved.lastTurn ?? null)
  await update($, cache, () => saved.cache ?? null)
  // The cache's life, as a model switch last reported it.
  if (saved.cache?.ttlMs) cacheTtlMs = saved.cache.ttlMs
}

/** Deletes saved conversations not touched for a month. */
async function pruneConversations($: EngineInterface) {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith(CONV)) continue
    const saved = (await $.store.get(key)) as Partial<Conversation> | undefined
    if (!saved || now - (saved.at ?? 0) > CONV_KEEP_MS) await $.store.delete(key)
  }
}

/** Re-reads the context and limits now, rather than waiting for the next turn's measurement. */
async function refreshUsage($: EngineInterface) {
  const fresh = toUsage(await $.session.usage())
  // Just after a compaction the context isn't measured yet: keep the compacted size the result gave.
  await update($, usage, prev => (fresh.tokens === undefined && prev ? { ...fresh, tokens: prev.tokens, percent: prev.percent } : fresh))
  await noteReset($, fresh)
}

/** Reads this conversation's starting figures: on load, and after /clear, /resume or a fork. */
async function startOver($: EngineInterface, id?: string, restore = true) {
  convId = id ?? (await $.session.id().catch(() => undefined))
  const now = await $.session.usage()
  const u = toUsage(now)
  await update($, usage, () => u)
  lastUsd = now.cost?.usd
  await update($, startedAt, () => now.startedAt)
  await noteReset($, u)
  if (restore) await restoreConversation($).catch(() => undefined)
}

export const register: Register = on => {
  let shownPercent = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // Each step on its own: one that fails (a store that can't be read, say) leaves the rest running.
    const attempt = async (step: () => Promise<unknown>) => {
      try {
        await step()
      } catch {
        // tried again on the next refresh
      }
    }
    const refresh = async () => {
      // Write only what changed: every write redraws the band.
      await attempt(() => countBats($))
      await attempt(async () => {
        // The band redraws each minute, and also the moment the cache goes cold, so the stopwatch never shows
        // a minute left on a cache that has expired.
        const now = await $.clock.now()
        const c = await read($, cache)
        const expires = c?.at ? c.at + (c.ttlMs ?? CACHE_TTL_MS) : 0
        const minute = Math.floor(now / 60000) * 60000
        const mark = expires > minute && expires <= now ? expires : minute
        if (mark !== (await read($, tick))) await update($, tick, () => mark)
      })
      // Re-sum the window each refresh, so it drops back to $0 after a reset even when idle.
      await attempt(() => resum($))
      await attempt(() => syncProfile($))
      await attempt(() => saveConversation($))
    }
    // The timer first: if anything below fails, the band still keeps time.
    $.clock.every(15_000, () => void refresh())
    await attempt(() => $.command.register({ name: 'castle', description: 'Show your castle-hud level, streak and achievements', argumentHint: '[reset]' }))
    await attempt(() => $.store.delete('ledger')) // the shared list an earlier version kept
    // Keep one XP record per session across reloads: reuse the session's id and carry on from its saved record.
    await attempt(async () => {
      const kept = await read($, xpId)
      const id = kept || myId
      if (!kept) await update($, xpId, () => id)
      XP_KEY = `xp:${id}`
      try {
        const saved = (await $.store.get(XP_KEY)) as Stats | undefined
        const archive = await readArchive($)
        // Already in the archive (folded as its conversation ended): its XP is counted there. Start a new record.
        if (XP_KEY in archive.folded) await moveToNewRecord($)
        else if (saved) {
          const { savedAt, ...stats } = saved
          mine = stats
          lastSaved = stats
          lastSavedAt = savedAt ?? 0
        }
      } catch (err) {
        // The saved record couldn't be read: write to a new one rather than over it.
        await moveToNewRecord($)
        throw err
      }
    })
    await attempt(() => startOver($))
    await attempt(() => pruneConversations($))
    await refresh()

    return result
  })

  // /clear and /resume switch conversation without a new session.start: reset what belongs to the old one.
  on('session.end', async ($, e, next) => {
    // Save and fold first: the hooks share a short time limit at exit, and XP earned since the last refresh
    // mustn't be lost. The conversation is over, so its record goes into the archive.
    await saveConversation($).catch(() => undefined)
    await saveMine($)
      .then(() => (dirty ? undefined : foldMine($)))
      .catch(() => undefined)
    // The new conversation's figures are started over when it starts (classic.SessionStart below), before any turn.
    return next(e)
  })

  // The moment a new or compacted conversation is in place: no turn can have run in it yet.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source === 'clear' || e.source === 'resume' || e.source === 'fork') {
      // A fork may come without a session.end: save the conversation it leaves before starting over.
      if (e.source === 'fork') await saveConversation($).catch(() => undefined)
      await forgetConversation($)
      // Its cost baseline, before any spend; a resumed conversation's own figures come back, a fork starts afresh.
      await startOver($, e.session_id, e.source !== 'fork')
    }
    if (e.source === 'compact') await refreshUsage($) // the compacted context, now installed

    return result
  }).catch(($, e, next) => next(e))

  // A model switch leaves the old model's cache behind, and says how long the cache lasts.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    cacheTtlMs = e.cache_ttl === '5m' ? 5 * 60e3 : CACHE_TTL_MS
    // A resume restores the conversation's own model: its cache, and the restored stopwatch, stand.
    if (e.source === 'resume') return result
    await update($, cache, () => null)
    convDirty = true

    return result
  }).catch(($, e, next) => next(e))

  // A compaction (the person's /compact, or Claude Code's own at its limit) rebuilds the castle a tier, up to five.
  // A `precompute` only prepares one ahead of time, and a skipped compaction changes nothing: neither counts.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    // Only the main conversation's compaction: a subagent's (`e.agentId`) changes neither its context nor the castle.
    if (!e.agentId && e.trigger !== 'precompute' && result.skip === undefined) {
      mine = { ...mine, compacts: (mine.compacts ?? 0) + 1 }
      dirty = true
      // The tier from every session's records, read fresh, not from a profile that may be minutes old.
      void syncProfile($, true)
        .then(all => {
          const n = all.compacts ?? 0
          if (n >= 1 && n <= 4) $.ui.toast(`Castle rebuilt to tier ${n + 1} of 5`)
        })
        .catch(() => undefined)
      // The conversation the cache held is gone: the next reply writes a new one.
      await update($, cache, () => null)
      convDirty = true
      // The compacted size comes with the result: show it now, which also puts the fire out. The engine
      // installs the new conversation after this hook returns, so reading the session here would be too early.
      const u = await read($, usage)
      if (u && result.tokensAfter !== undefined && u.window > 0) {
        const tokens = result.tokensAfter
        await update($, usage, () => ({ ...u, tokens, percent: Math.round((tokens / u.window) * 100) }))
      }
    }

    return result
  }).catch(($, e, next) => next(e)) // counting failed: the compaction still goes through

  on('turn.start', async ($, e, next) => {
    turnStartedAt = await $.clock.now()

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const u = toUsage(e)
    await update($, usage, () => u)
    await noteReset($, u).catch(() => undefined)

    if (e.cost && e.changed.includes('cost')) {
      const t = await $.clock.now()
      // A total below the last one means the session's cost started over (a /clear): all of it is new.
      const delta = lastUsd === undefined ? 0 : e.cost.usd < lastUsd ? e.cost.usd : e.cost.usd - lastUsd
      // Move the baseline only once the delta is saved: a failed write is retried with the next measurement.
      if (delta > 0) await $.store.set(spendKey(t, myId, spendSeq++), delta)
      lastUsd = e.cost.usd
      await resum($)
    }

    return next(e)
  })

  // Lines changed: count each edit that went through, in the main loop and in subagents.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const isEdit = e.tool === 'Edit' || e.tool === 'Write' || (e.tool as string) === 'MultiEdit'
    if (isEdit && ran.deny === undefined && ran.isError !== true) {
      const d = editLines(e.tool, e as unknown as Record<string, unknown>, ran.result)
      turnLines += d.added + d.removed
      if (d.added + d.removed > 0) {
        await update($, lines, l => ({ added: l.added + d.added, removed: l.removed + d.removed }))
        convDirty = true
      }
    }

    return ran
   }).catch(($, e, next) => next(e)) // counting failed: the tool call still goes through

  // A test run that passed earns XP.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    // Only a run that finished here counts: a background run has only started, its result unknown.
    const isBackground = e.run_in_background === true || (ran.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId !== undefined
    const interrupted = (ran.result as { interrupted?: unknown } | undefined)?.interrupted === true
    if (ran.deny === undefined && ran.isError !== true && !interrupted && !isBackground && isTestCommand(e.command)) {
      mine = { ...mine, tests: mine.tests + 1, xp: mine.xp + XP.test }
      dirty = true
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'castle' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase().split(/\s+/).join(' ')
    if (arg === 'reset')
      return {
        text: [
          'This deletes everything castle-hud saved: your XP, level, streak, achievements, castle tier and the 5-hour spending.',
          'Close your other Claude Code sessions first, or they save their own XP again.',
          'To go ahead, type: /castle reset confirm',
        ].join('\n'),
      }
    if (arg === 'reset confirm') {
      await resetAll($)
      return { text: 'Everything castle-hud saved is deleted. You start again at level 1.' }
    }
    const all = await syncProfile($, true)
    const p = await read($, profile)

    return { text: p ? report(all, p) : 'No XP yet: finish a turn to start.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    // A workflow's agents never appear in the roster: leave them out rather than track them forever.
    if (spawned.deny === undefined && spawned.agentId && !e.workflow) {
      fresh.set(spawned.agentId, await $.clock.now())
      seenRunning.add(spawned.agentId) // so a subagent that finishes before the next roster reading still counts
      await countBats($)
    }

    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId) {
      // A subagent we watched answered: it finished, even if the roster drops it before the next reading.
      if (e.reason === 'answer' && seenRunning.has(e.agentId)) {
        creditBat(e.agentId)
        seenRunning.delete(e.agentId)
        missingSince.delete(e.agentId)
      }
      await countBats($)
    } else if (!e.usage) {
      // Interrupted or failed with nothing counted: keep its lines, so they don't earn XP on the next turn.
      if (turnLines > 0) {
        mine = { ...mine, lines: mine.lines + turnLines }
        dirty = true
      }
      turnLines = 0
    } else {
      const u = e.usage
      const turn = { ms: e.durationMs, out: u.output_tokens }
      await update($, lastTurn, () => turn)
      convDirty = true

      // XP for the turn: finishing it, the lines it changed, a warm cache, a tidy context.
      const t = await $.clock.now()
      // turn.complete arrives before the turn's own measurement: read the context as it stands now.
      const live = await $.session.usage()
      // Warm: the turn started within the hour after the last reply, and read the cache.
      const prev = await read($, cache)
      const warm = u.cache_read_input_tokens > 0 && wasWarm(prev?.at ? prev : null, turnStartedAt || t)
      const tidy = (live.context.percent ?? 0) < 60
      const isNight = new Date(t).getHours() < 4
      const day = dayKey(t)
      // Only an answered turn earns XP, counts as finished and marks the day; a cancelled or failed one
      // still counts its lines changed, its cost and its cache.
      const answered = e.reason === 'answer'
      mine = answered
        ? {
            ...mine,
            xp: mine.xp + turnXp({ lines: turnLines, warm, tidy }),
            turns: mine.turns + 1,
            lines: mine.lines + turnLines,
            warm: mine.warm + (warm ? 1 : 0),
            tidy: mine.tidy + (tidy ? 1 : 0),
            night: mine.night + (isNight ? 1 : 0),
            days: mine.days.includes(day) ? mine.days : [...mine.days, day],
          }
        : { ...mine, lines: mine.lines + turnLines }
      turnLines = 0
      dirty = true
      void syncProfile($) // the turn doesn't wait for the profile
      const at = await $.clock.now()
      const next2 = nextCache(prev?.at ? prev : null, u, at, cacheTtlMs)
      if (next2 !== prev) await update($, cache, () => next2)
    }

    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Drawn in the desktop app only (Claude Code raises this band on terminal and desktop): a terminal keeps its own status line.
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
    const castle = castleSvg(pct, prof?.castleTier ?? 1)
    shownPercent = pct

    // Drawn as images, not interactive frames: an image swaps in place on a redraw, a frame reloads and flashes.
    return (
      // Mods get no corner radius; a round border in the background's own color is how the corners round.
      <Box flexDirection="row" alignItems="flex-end" backgroundColor={NIGHT} borderStyle="round" borderColor={NIGHT} overflow="hidden" width="100%">
        {/* The sections wrap in the space left of the castle, which keeps a column of its own: nothing sits under the flames. */}
        {/* The sections give way first (wrapping onto another row); the castle keeps its size unless even that isn't enough. */}
        <Box flexDirection="row" flexWrap="wrap" alignItems="flex-end" flexGrow={1} flexShrink={100}>
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
