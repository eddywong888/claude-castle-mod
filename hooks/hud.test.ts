import { expect, test } from 'claude-code/testing'

import { editLines, cacheHit, duration, elapsed, linesFromPatch, linesOf, legacyEntries, nextCache, spendKey, spendTime, k, moonLight, spentSince, timeLeftShort, wasWarm } from './hud'
import { buildSvg, castleSvg, fireLevel, moonPath, tierFor, TITLE_ICONS, zone } from './svg'
import { titleOf } from './xp'

const now = Date.parse('2026-10-09T10:00:00Z')

test('moon is full at refresh and new at reset', () => {
  expect(moonLight('five_hour', '2026-10-09T15:00:00Z', now)).toBe(1)
  expect(moonLight('five_hour', '2026-10-09T12:30:00Z', now)).toBe(0.5)
  expect(moonLight('five_hour', '2026-10-09T10:00:00Z', now)).toBe(0)
  expect(moonPath(12, 22, 11, 1)).toContain('A11.00 11')
})

test('helpers', () => {
  expect(timeLeftShort('2026-10-09T11:37:00Z', now)).toBe('1h 37m')
  expect(timeLeftShort('2026-10-12T12:00:00Z', now)).toBe('3d 2h')
  expect(k(1_000_000)).toBe('1M')
  expect(k(145_000)).toBe('145k')
  expect(k(999_600)).toBe('1M')
  expect(k(999_400)).toBe('999k')
  expect(cacheHit({ read: 90, written: 5, uncached: 5 })).toBe(90)
  expect(zone(15)).toBe('ink')
  expect(zone(70)).toBe('gold')
  expect(zone(90)).toBe('blood')
})

test('svg draws every section and animates only what moves', () => {
  const idle = buildSvg({
    usage: { usd: 2.9, tokens: 145000, window: 1e6, percent: 15, limits: [{ kind: 'five_hour', percentUsed: 1, resetsAt: '2026-10-09T11:37:00Z' }] },
    cache: null,
    bats: 0,
    now,
    prevPercent: 15,
    mode: 'auto',
  })
  expect(idle.source.startsWith('<svg')).toBe(true)
  expect(idle.source).toContain('145k of 1M')
  expect(idle.source).toContain('$2.90')
  expect(idle.source).toContain('5hr reset')
  expect(idle.source).toContain('1h 37m to ')
  expect(idle.source).toContain('prefers-color-scheme:dark')
  expect(idle.source).not.toContain('class="up"')
  expect(idle.alt).toContain('No subagents running')
  expect(idle.source).toContain('>cache<')

  const busy = buildSvg({ usage: null, cache: { read: 9, written: 1, uncached: 0, at: now - 50 * 60000 }, bats: 3, windowUsd: 12.3, now, prevPercent: 0, mode: 'dark' })
  expect(busy.source.match(/class="up"/g)?.length).toBe(3)
  expect(busy.source).toContain('10m')
  expect(busy.source).toContain('cache, 90% hit')
  expect(busy.source).toContain('$12.30')
  expect(busy.source).toContain('5h window')
  expect(busy.source).not.toContain('prefers-color-scheme')
})

test('5-hour spend sums only the window', () => {
  const ledger = [{ t: now - 6 * 3600e3, usd: 5 }, { t: now - 2 * 3600e3, usd: 1.5 }, { t: now - 60e3, usd: 0.25 }]
  expect(spentSince(ledger, now - 5 * 3600e3)).toBe(1.75)
})

test('cold cache', () => {
  const s = buildSvg({ usage: null, cache: { read: 1, written: 0, uncached: 0, at: now - 61 * 60000 }, bats: 0, now, prevPercent: 0, mode: 'light' })
  expect(s.source).toContain('cold')
})

test('lines and last turn', () => {
  expect(linesOf('Edit', { old_string: 'a\nb', new_string: 'a\nb\nc' })).toEqual({ added: 1, removed: 0 })
  expect(linesOf('Edit', { old_string: 'a\nx\nb', new_string: 'a\ny\nb' })).toEqual({ added: 1, removed: 1 })
  expect(linesOf('Write', { content: 'x\ny' })).toEqual({ added: 2, removed: 0 })
  expect(linesOf('Write', { content: 'x\n' })).toEqual({ added: 1, removed: 0 })
  expect(linesFromPatch([{ lines: [' a', '-b', '+c', '+d'] }, { lines: ['-e'] }])).toEqual({ added: 2, removed: 2 })
  expect(linesFromPatch(undefined)).toBe(null)
  expect(linesOf('Bash', { command: 'ls' })).toEqual({ added: 0, removed: 0 })
  expect(duration(38_000)).toBe('38s')
  expect(duration(125_000)).toBe('2m 5s')
  const s = buildSvg({ usage: null, cache: null, bats: 0, now, prevPercent: 0, mode: 'dark', lastTurn: { ms: 38_000, out: 4200 }, lines: { added: 214, removed: 37 } })
  expect(s.source).toContain('>last turn<')
  expect(s.source).toContain('4k output')
  expect(s.source).toContain('+214')
  expect(s.source).toContain('−37')
})

test('session time', () => {
  expect(elapsed(7 * 60e3)).toBe('7m')
  expect(elapsed(102 * 60e3)).toBe('1h 42m')
  const s = buildSvg({ usage: null, cache: null, bats: 0, now, prevPercent: 0, mode: 'dark', startedAt: now - 102 * 60e3 })
  expect(s.source).toContain('1h 42m')
  expect(s.alt).toContain('Session running 1h 42m')
})

test('the cache follows real cache activity and stays warm for an hour', () => {
  const u = (read: number, written: number) => ({ cache_read_input_tokens: read, cache_creation_input_tokens: written, input_tokens: 10 })
  const first = nextCache(null, u(0, 500), now)
  expect(first).toEqual({ read: 0, written: 500, uncached: 10, at: now, ttlMs: 60 * 60e3 })
  // A reply with no cache activity leaves the countdown alone.
  expect(nextCache(first, u(0, 0), now + 60e3)).toBe(first)
  expect(wasWarm(first, now + 59 * 60e3)).toBe(true)
  expect(wasWarm(first, now + 61 * 60e3)).toBe(false)
  expect(wasWarm(null, now)).toBe(false)
  // A five-minute cache, as a model switch can report.
  const short = nextCache(null, u(0, 500), now, 5 * 60e3)
  expect(wasWarm(short, now + 4 * 60e3)).toBe(true)
  expect(wasWarm(short, now + 30 * 60e3)).toBe(false)
})

test('castle burns as the prompt cache runs down', () => {
  expect(fireLevel(null)).toBe('none')
  expect(fireLevel(0.5)).toBe('none')
  expect(fireLevel(0.4)).toBe('small')
  expect(fireLevel(0.2)).toBe('medium')
  expect(fireLevel(0.1)).toBe('big')
  expect(fireLevel(0)).toBe('none') // expired: nothing left to save
  expect(castleSvg(10, 0.5).source).toContain('#e3b341')
  expect(castleSvg(10, 0.5).source).not.toContain('class="fa"')
  expect(castleSvg(10, 0.35).source.match(/class="fa"/g)?.length).toBe(2) // the roof and the main window
  expect(castleSvg(10, 0.35).source).toContain('#e0475b')
  expect(castleSvg(10, 0.15).source.match(/class="fa"/g)?.length).toBe(8) // roofs, windows and the wall
  expect(castleSvg(10, 0.05).source.match(/class="fa"/g)?.length).toBe(5) // fewer, bigger fires
  expect(castleSvg(10, 0.05).source).toContain('blaze')
  expect(castleSvg(10, 0.05).alt).toContain('5% of the cache left')
})

test('spend keys carry their own time', () => {
  const key = spendKey(now, 'abc-123', 0)
  expect(spendTime(key)).toBe(now)
  expect(spendKey(now, 'abc-123', 1)).not.toBe(key)
  const legacy = [{ t: now - 7 * 3600e3, usd: 3 }, { t: now - 3600e3, usd: 1.5 }, { t: now, usd: 0 }, 'junk']
  expect(legacyEntries(legacy, now - 6 * 3600e3)).toEqual([{ t: now - 3600e3, usd: 1.5, i: 1 }])
  expect(legacyEntries(undefined, 0)).toEqual([])
  expect(spendTime('spend:lq3x-9f2k')).toBe(null)
})

test('edits count what really changed', () => {
  const patch = [{ lines: [' a', '+b'] }]
  expect(editLines('Edit', { old_string: 'a', new_string: 'a\nb' }, { structuredPatch: patch })).toEqual({ added: 1, removed: 0 })
  expect(editLines('Edit', { old_string: 'a', new_string: 'b' }, { structuredPatch: patch, staged: true })).toEqual({ added: 0, removed: 0 })
  expect(editLines('Write', { content: 'x\ny' }, { type: 'update', originalFile: 'x\ny', structuredPatch: [] })).toEqual({ added: 0, removed: 0 })
  expect(editLines('Write', { content: 'x\ny' }, { type: 'create', originalFile: null, structuredPatch: [] })).toEqual({ added: 2, removed: 0 })
})

test('castle grows bolder as the context fills, keeping all its towers', () => {
  expect([tierFor(0), tierFor(39), tierFor(40), tierFor(60), tierFor(80), tierFor(100)]).toEqual([1, 1, 2, 3, 4, 4])
  const spires = (p: number) => castleSvg(p).source.match(/<polygon points=/g)?.length ?? 0
  expect(spires(0)).toBe(3) // three towers from the start
  expect(castleSvg(0).source).not.toContain('#c8283f')
  expect(castleSvg(40).source).toContain('#c8283f') // banners
  expect(castleSvg(60).source).toContain('opacity=".55"/>') // gold trim
  expect(castleSvg(60).source).toContain('96,-6') // taller main spire
  expect(spires(80)).toBe(4) // and the crest
  expect(castleSvg(80).alt).toContain('tier 4 of 4')
})

test('a subscription shows the moons and no costs; the API, the other way round', () => {
  const base = {
    usage: { usd: 2.9, tokens: 1000, window: 1e6, percent: 1, limits: [{ kind: 'five_hour', percentUsed: 1, resetsAt: '2026-10-09T11:37:00Z' }] },
    cache: null, bats: 0, now, prevPercent: 0, mode: 'dark' as const, windowUsd: 4,
  }
  const sub = buildSvg({ ...base, plan: 'subscription' }).alt
  expect(sub).toContain('5h limit')
  expect(sub).not.toContain('Session cost')
  expect(sub).not.toContain('5-hour window cost')
  const api = buildSvg({ ...base, usage: { ...base.usage, limits: [] }, plan: 'api' }).alt
  expect(api).toContain('Session cost $2.90')
  expect(api).not.toContain('rate-limit')
  // Not known yet: everything shows.
  const unknown = buildSvg(base).alt
  expect(unknown).toContain('5h limit')
  expect(unknown).toContain('Session cost')
})

test('every title has its own icon in the level section', () => {
  const titles = [1, 5, 10, 20, 35, 50].map(titleOf)
  expect(new Set(titles).size).toBe(6)
  for (const t of titles) expect([t, TITLE_ICONS[t] !== undefined]).toEqual([t, true])
  const lantern = buildSvg({ usage: null, cache: null, bats: 0, now, prevPercent: 0, mode: 'dark', profile: { level: 1, title: 'Wanderer', into: 0, need: 150, xp: 0, streak: 0, unlocked: [] } }).source
  const crown = buildSvg({ usage: null, cache: null, bats: 0, now, prevPercent: 0, mode: 'dark', profile: { level: 50, title: 'Lord of the Castle', into: 0, need: 9000, xp: 99999, streak: 0, unlocked: [] } }).source
  expect(lantern).toContain('#ff8a1f') // the lantern's flame
  expect(crown).not.toContain('#ff8a1f')
  expect(crown).toContain('#ff3b3b') // the vampire lord's red eyes
})
