import { expect, test } from 'claude-code/testing'

import { editLines, cacheHit, duration, elapsed, gauge, linesFromPatch, linesOf, legacyEntries, nextCache, spendKey, spendTime, k, moonEmoji, moonLight, spentSince, timeLeftShort } from './hud'
import { buildSvg, castleSvg, fireLevel, moonPath, zone } from './svg'

const now = Date.parse('2026-10-09T10:00:00Z')

test('moon is full at refresh and new at reset', () => {
  expect(moonLight('five_hour', '2026-10-09T15:00:00Z', now)).toBe(1)
  expect(moonLight('five_hour', '2026-10-09T12:30:00Z', now)).toBe(0.5)
  expect(moonEmoji('five_hour', '2026-10-09T10:01:00Z', now)).toBe('🌑')
  expect(moonPath(12, 22, 11, 1)).toContain('A11.00 11')
})

test('helpers', () => {
  expect(timeLeftShort('2026-10-09T11:37:00Z', now)).toBe('1h 37m')
  expect(timeLeftShort('2026-10-12T12:00:00Z', now)).toBe('3d 2h')
  expect(k(1_000_000)).toBe('1M')
  expect(k(145_000)).toBe('145k')
  expect(cacheHit({ read: 90, written: 5, uncached: 5 })).toBe(90)
  expect(gauge(50, 4)).toBe('██░░')
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

test('cache follows real cache activity and learns its life', () => {
  const u = (read: number, written: number, model = 'm') => ({ cache_read_input_tokens: read, cache_creation_input_tokens: written, input_tokens: 10, model })
  const first = nextCache(null, u(0, 500), now)
  expect(first?.ttlMs).toBe(60 * 60e3)
  // A reply with no cache activity leaves the countdown alone.
  expect(nextCache(first, u(0, 0), now + 60e3)).toBe(first)
  // Read again after 20 minutes: the cache lasts an hour.
  expect(nextCache(first, u(400, 10), now + 20 * 60e3)?.ttlMs).toBe(60 * 60e3)
  // Rewritten with nothing read after 20 minutes: it lasted five.
  expect(nextCache(first, u(0, 500), now + 20 * 60e3)?.ttlMs).toBe(5 * 60e3)
  // A different model starts its own cache: nothing is learned from the gap.
  expect(nextCache(first, u(0, 500, 'other'), now + 20 * 60e3)?.ttlMs).toBe(60 * 60e3)
  // A model that learned five minutes doesn't pass that on to the next model.
  const short = nextCache(first, u(0, 500), now + 20 * 60e3)
  expect(short?.ttlMs).toBe(5 * 60e3)
  expect(nextCache(short, u(0, 500, 'other'), now + 21 * 60e3)?.ttlMs).toBe(60 * 60e3)
})

test('castle burns as the context fills', () => {
  expect(fireLevel(69)).toBe('none')
  expect(fireLevel(70)).toBe('small')
  expect(fireLevel(85)).toBe('medium')
  expect(fireLevel(90)).toBe('big')
  expect(castleSvg(49).source).toContain('#e3b341')
  expect(castleSvg(50).source).not.toContain('#e3b341')
  expect(castleSvg(50).source).toContain('#e0475b')
  expect(castleSvg(50).source).not.toContain('class="fa"')
  expect(castleSvg(72).source.match(/class="fa"/g)?.length).toBe(2) // the roof and the main window
  expect(castleSvg(72).source).toContain('#e0475b')
  expect(castleSvg(83).source.match(/class="fa"/g)?.length).toBe(8) // roofs, windows and the wall
  expect(castleSvg(95).source.match(/class="fa"/g)?.length).toBe(5) // fewer, bigger fires
  expect(castleSvg(95).source).toContain('blaze')
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

test('castle grows with its tier', () => {
  const towers = (t: number) => castleSvg(0, t).source.match(/<polygon points=/g)?.length ?? 0
  expect(towers(1)).toBe(2) // starts with two towers
  expect(towers(2)).toBe(3)
  expect(towers(3)).toBe(3) // the keep has battlements, not a spire
  expect(towers(5)).toBe(5) // four spires and the crest
  expect(castleSvg(0, 4).source).toContain('#c8283f')
  expect(castleSvg(0, 9).alt).toContain('tier 5 of 5')
})

test('a cold start keeps its real cache counts but learns the short life', () => {
  const u = { cache_read_input_tokens: 45000, cache_creation_input_tokens: 5000, input_tokens: 10, model: 'm' }
  const first = nextCache(null, { ...u, cache_read_input_tokens: 0 }, now)
  const cold = nextCache(first, u, now + 20 * 60e3, true)
  expect(cold?.read).toBe(45000)
  expect(cold?.ttlMs).toBe(5 * 60e3)
  expect(nextCache(first, u, now + 20 * 60e3, false)?.ttlMs).toBe(60 * 60e3)
})

test('cache life is learned from when a turn started, and not just after a compaction', () => {
  const u = (read: number, written: number) => ({ cache_read_input_tokens: read, cache_creation_input_tokens: written, input_tokens: 10, model: 'm' })
  const short = { ...nextCache(null, u(0, 500), now)!, ttlMs: 5 * 60e3 }
  // Started 4 minutes after the last reply (cache still warm), finished at 6: no evidence of an hour-long cache.
  expect(nextCache(short, u(400, 10), now + 6 * 60e3, false, now + 4 * 60e3)?.ttlMs).toBe(5 * 60e3)
  // Started 20 minutes after and still read: the cache lasts an hour.
  expect(nextCache(short, u(400, 10), now + 21 * 60e3, false, now + 20 * 60e3)?.ttlMs).toBe(60 * 60e3)
  // After a compaction, a cold rewrite 20 minutes later teaches nothing.
  const hour = { ...short, ttlMs: 60 * 60e3, rebased: true }
  expect(nextCache(hour, u(0, 500), now + 21 * 60e3, true, now + 20 * 60e3)?.ttlMs).toBe(60 * 60e3)
})
