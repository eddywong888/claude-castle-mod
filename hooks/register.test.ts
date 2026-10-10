import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Stats } from './xp'

const T0 = Date.parse('2026-10-09T10:00:00Z')
const RESET = '2026-10-09T12:00:00Z'

/** The world beneath the mod: a store to look into, a session whose cost the test sets, and a roster. */
function world(on: On, entries: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: T0 })
  const store = new Map<string, unknown>(Object.entries(entries))
  const s = { usd: 0, tokens: undefined as number | undefined, agents: [] as { id: string; status: string }[], toasts: [] as string[] }
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.usage', () => ({ value: {
    startedAt: T0,
    context: { tokens: s.tokens, window: 200_000, percent: s.tokens === undefined ? undefined : Math.round((s.tokens / 200_000) * 100) },
    rateLimits: [{ kind: 'five_hour', percentUsed: 1, resetsAt: RESET }],
    cost: { usd: s.usd },
  } }))
  on('agent.list', () => ({ value: s.agents }) as never)
  on('command.register', () => ({ value: { command: 'castle' } }))
  on('ui.toast', (_$, e) => {
    s.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.complete', (_$, e) => ({ text: e.answer, usage: e.usage }))
  on('classic.SessionStart', () => ({}) as never)
  return { clock, store, s }
}

const start = { cwd: '/', surface: 'desktop', isInteractive: true } as const
const spendTotal = (store: Map<string, unknown>) => [...store].filter(([k]) => /^spend:\d+:/.test(k)).reduce((sum, [, v]) => sum + Number(v), 0)
const xpRecord = (store: Map<string, unknown>) => [...store].find(([k]) => k.startsWith('xp:') && k !== 'xp:archive')?.[1] as Stats | undefined
const measure = (usd: number) => ({ context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 1, resetsAt: RESET }], cost: { usd }, changed: ['cost'] }) as never

test('spend after /clear counts from the new conversation’s own baseline', async ($, on) => {
  const { clock, store, s } = world(on)
  s.usd = 10
  await $.session.start(start as never)
  await $.session.measure(measure(10))
  expect(spendTotal(store)).toBe(0) // the baseline, not new spend
  await $.session.measure(measure(10.5))
  expect(Math.round(spendTotal(store) * 100)).toBe(50)
  // /clear: the new conversation's cost starts again from zero.
  await $.session.end({ reason: 'clear', sessionId: 'a', resume: undefined } as never)
  s.usd = 0
  await $.classic.SessionStart({ source: 'clear' } as never)
  await $.session.measure(measure(0.25))
  await clock.settle()
  expect(Math.round(spendTotal(store) * 100)).toBe(75)
})

test('spend kept in the old list format moves to write-once keys, once', async ($, on) => {
  const { clock, store } = world(on, { 'spend:old': [{ t: T0 - 60e3, usd: 2 }, { t: T0 - 30e3, usd: 1 }] })
  await $.session.start(start as never)
  await clock.advance(15_000)
  expect(store.has('spend:old')).toBe(false)
  expect(spendTotal(store)).toBe(3)
  await clock.advance(15_000)
  expect(spendTotal(store)).toBe(3)
})

test('only the main conversation’s finished compactions raise the castle', async ($, on) => {
  const { clock, store } = world(on)
  on('session.compact', (_$, e) => (e.trigger !== 'auto' ? { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensAfter: 20_000 } : { skip: 'no' }) as never)
  await $.session.start(start as never)
  await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  await $.session.compact({ trigger: 'manual', agentId: 'sub', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never) // skipped beneath
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  await clock.settle()
  expect(xpRecord(store)?.compacts).toBe(1)
})

test('a subagent that answers is credited once, even if the roster never lists it', async ($, on) => {
  const { clock, store } = world(on)
  on('agent.spawn', () => ({ model: 'm', agentId: 'bat1' }))
  await $.session.start(start as never)
  await $.agent.spawn({ tool_use_id: 't', prompt: 'p', description: 'd', subagentType: 'general-purpose', provider: 'anthropic' } as never)
  const answered = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', agentId: 'bat1', reason: 'answer' } as never
  await $.turn.complete(answered)
  await $.turn.complete(answered)
  await clock.advance(15_000)
  expect(xpRecord(store)?.bats).toBe(1)
})

test('an interrupted turn keeps its lines without earning XP for them later', async ($, on) => {
  const { clock, store } = world(on)
  on('tool.call', () => ({ result: { structuredPatch: [{ lines: ['+a', '+b', '+c', '+d', '+e', '+f', '+g', '+h', '+i', '+j'] }] } }) as never)
  await $.session.start(start as never)
  await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: '', new_string: 'a' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as never)
  await clock.advance(15_000)
  const r = xpRecord(store)
  expect(r?.lines).toBe(10)
  expect(r?.xp ?? 0).toBe(0)
})

test('records of sessions that ended days ago fold into one archive', async ($, on) => {
  const old = { xp: 100, turns: 3, lines: 0, tests: 0, bats: 0, warm: 0, tidy: 0, night: 0, days: ['2026-10-01'], compacts: 1, savedAt: T0 - 5 * 86400e3 }
  const live = { ...old, xp: 7, days: ['2026-10-09'], compacts: 0, savedAt: T0 - 60e3 }
  const { clock, store } = world(on, { 'xp:gone1': old, 'xp:gone2': { ...old, savedAt: undefined }, 'xp:open': live })
  await $.session.start(start as never)
  expect(store.has('xp:archive')).toBe(true)
  expect((store.get('xp:archive') as { total: Stats }).total.xp).toBe(200)
  expect(store.has('xp:open')).toBe(true)
  // A later pass deletes what the archive now counts.
  await clock.advance(5 * 60e3 + 15_000)
  expect(store.has('xp:gone1')).toBe(false)
  expect(store.has('xp:gone2')).toBe(false)
  const out = (await $.command.run({ command: 'castle', args: '' } as never)) as { text: string }
  expect(out.text).toContain('207 XP in all')
})

test('/castle reset asks first, then deletes everything saved', async ($, on) => {
  const { store } = world(on, { 'xp:someone': { xp: 50, turns: 1, lines: 0, tests: 0, bats: 0, warm: 0, tidy: 0, night: 0, days: [], savedAt: T0 } })
  await $.session.start(start as never)
  const ask = (await $.command.run({ command: 'castle', args: 'reset' } as never)) as { text: string }
  expect(ask.text).toContain('/castle reset confirm')
  expect(store.has('xp:someone')).toBe(true)
  await $.command.run({ command: 'castle', args: 'reset confirm' } as never)
  expect(store.size).toBe(0)
})
