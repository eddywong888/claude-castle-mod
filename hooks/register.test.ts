import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Stats } from './xp'

const T0 = Date.parse('2026-10-09T10:00:00Z')
const RESET = '2026-10-09T12:00:00Z'

/** The world beneath the mod: a store to look into, a session whose cost the test sets, and a roster. */
function world(on: On, entries: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: T0 })
  const store = new Map<string, unknown>(Object.entries(entries))
  const s = { id: 's1', usd: 0, tokens: undefined as number | undefined, agents: [] as { id: string; status: string }[], toasts: [] as string[] }
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
  on('session.id', () => ({ value: s.id }))
  on('command.register', () => ({ value: { command: 'castle' } }))
  on('ui.toast', (_$, e) => {
    s.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer, usage: e.usage }))
  on('classic.SessionStart', () => ({}) as never)
  return { clock, store, s }
}

const start = { cwd: '/', surface: 'desktop', isInteractive: true } as const
const spendTotal = (store: Map<string, unknown>) => [...store].filter(([k]) => /^spend:\d+:/.test(k)).reduce((sum, [, v]) => sum + Number(v), 0)
const xpRecord = (store: Map<string, unknown>) => [...store].find(([k]) => k.startsWith('xp:'))?.[1] as Stats | undefined
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

test('records left unsaved for a week fold into one archive', async ($, on) => {
  const old = { xp: 100, turns: 3, lines: 0, tests: 0, bats: 0, warm: 0, tidy: 0, night: 0, days: ['2026-10-01'], compacts: 1, savedAt: T0 - 10 * 86400e3 }
  const live = { ...old, xp: 7, days: ['2026-10-09'], compacts: 0, savedAt: T0 - 60e3 }
  const { clock, store } = world(on, { 'xp:gone1': old, 'xp:gone2': { ...old, savedAt: undefined }, 'xp:open': live })
  await $.session.start(start as never)
  expect(store.has('archive:xp')).toBe(true)
  expect((store.get('archive:xp') as { total: Stats }).total.xp).toBe(200)
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

const rec = (xp: number, savedAt: number) => ({ xp, turns: 1, lines: 0, tests: 0, bats: 0, warm: 0, tidy: 0, night: 0, days: [], compacts: 0, savedAt })
const xpTotal = async ($: { command: { run: (e: never) => Promise<unknown> } }) => Number(/(\d+) XP in all/.exec(((await $.command.run({ command: 'castle', args: '' } as never)) as { text: string }).text)?.[1])

test('a session folds its own record into the archive as its conversation ends', async ($, on) => {
  const { clock, store } = world(on)
  on('tool.call', () => ({ result: {} }) as never)
  await $.session.start(start as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await clock.advance(15_000)
  const key = [...store.keys()].find(k => k.startsWith('xp:'))!
  await $.session.end({ reason: 'clear', sessionId: 'a', resume: undefined } as never)
  const archive = store.get('archive:xp') as { total: Stats; folded: Record<string, number> }
  expect(archive.total.xp).toBe(25)
  expect(key in archive.folded).toBe(true)
  // Counted once, by the archive, from now on.
  expect(await xpTotal($ as never)).toBe(25)
  expect(store.has(key)).toBe(false)
})

test('a record folded while its session is still open moves on and is counted once', async ($, on) => {
  const { clock, store } = world(on)
  on('tool.call', () => ({ result: {} }) as never)
  await $.session.start(start as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await clock.advance(15_000)
  const key = [...store.keys()].find(k => k.startsWith('xp:'))!
  // Another session folds it, as if this one had gone quiet.
  store.set('archive:xp', { total: { ...rec(25, 0), turns: 0 }, folded: { [key]: T0 } })
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  expect(await xpTotal($ as never)).toBe(50)
  await clock.advance(3 * 3600e3)
  expect(await xpTotal($ as never)).toBe(50)
})

test('the archive moves out of the xp: keys older versions read as records', async ($, on) => {
  const { clock, store } = world(on, { 'xp:archive': { total: rec(40, 0), folded: {} } })
  await $.session.start(start as never)
  await clock.advance(15_000)
  expect(store.has('xp:archive')).toBe(false)
  expect((store.get('archive:xp') as { total: Stats }).total.xp).toBe(40)
  expect(await xpTotal($ as never)).toBe(40)
})

test('/castle reset  confirm works with extra spaces', async ($, on) => {
  const { store } = world(on, { 'xp:someone': rec(50, T0) })
  await $.session.start(start as never)
  await $.command.run({ command: 'castle', args: ' reset   confirm ' } as never)
  expect(store.size).toBe(0)
})

test('a conversation’s lines changed and last turn are saved, and restored after a restart', async ($, on) => {
  const { clock, store } = world(on, {
    'conv:s1': { lines: { added: 7, removed: 2 }, lastTurn: { ms: 9000, out: 4000 }, cache: null, at: T0 - 60e3 },
    'conv:gone': { lines: { added: 1, removed: 0 }, lastTurn: null, cache: null, at: T0 - 40 * 86400e3 },
  })
  on('tool.call', () => ({ result: { structuredPatch: [{ lines: ['+a'] }] } }) as never)
  await $.session.start(start as never)
  expect(store.has('conv:gone')).toBe(false) // a month untouched
  await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: '', new_string: 'a' } as never)
  await clock.advance(15_000)
  // Restored 7 and 2, then one more line added.
  expect((store.get('conv:s1') as { lines: unknown }).lines).toEqual({ added: 8, removed: 2 })
  expect((store.get('conv:s1') as { lastTurn: unknown }).lastTurn).toEqual({ ms: 9000, out: 4000 })
})

const band = async ($: { ui: { mount: (e: never) => Promise<{ drawn: () => Promise<unknown>; unmount: () => Promise<void> }> } }) => {
  const ui = await $.ui.mount({ plugin: 'castle-hud', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120 } } as never)
  const text = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return text
}

test('XP stays on the band through /clear, folded or not', async ($, on) => {
  const { clock } = world(on)
  on('tool.call', () => ({ result: {} }) as never)
  await $.session.start(start as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await clock.advance(15_000)
  expect(await band($ as never)).toContain('25 / ')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: undefined } as never)
  await $.classic.SessionStart({ source: 'clear', session_id: 's2' } as never)
  await clock.advance(15_000)
  expect(await band($ as never)).toContain('25 / ')
})

test('an older-format archive is merged in, and counted once', async ($, on) => {
  const { clock, store } = world(on, {
    'archive:xp': { total: rec(100, 0), folded: { 'xp:a': T0 } },
    'xp:archive': { total: rec(40, 0), folded: { 'xp:b': T0 } },
  })
  await $.session.start(start as never)
  expect(await xpTotal($ as never)).toBe(140)
  // An old window writes its copy again, folding nothing new: it adds nothing.
  store.set('xp:archive', { total: rec(140, 0), folded: { 'xp:a': T0, 'xp:b': T0 } })
  await clock.advance(5 * 60e3 + 15_000)
  expect(await xpTotal($ as never)).toBe(140)
  expect(store.has('xp:archive')).toBe(false)
})

test('a fork saves the conversation it leaves and starts its own figures afresh', async ($, on) => {
  const { clock, store } = world(on)
  on('tool.call', () => ({ result: { structuredPatch: [{ lines: ['+a'] }] } }) as never)
  await $.session.start(start as never)
  await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: '', new_string: 'a' } as never)
  // No refresh between the edit and the fork: the fork itself saves it.
  await $.classic.SessionStart({ source: 'fork', session_id: 's1' } as never)
  expect((store.get('conv:s1') as { lines: unknown }).lines).toEqual({ added: 1, removed: 0 })
  await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: '', new_string: 'a' } as never)
  await clock.advance(15_000)
  expect((store.get('conv:s1') as { lines: unknown }).lines).toEqual({ added: 1, removed: 0 })
})

test('the saved 5-hour reset never moves back', async ($, on) => {
  const { clock, store } = world(on, { 'reset:five_hour': '2026-10-09T14:00:00Z' })
  await $.session.start(start as never)
  await clock.advance(15_000)
  expect(store.get('reset:five_hour')).toBe('2026-10-09T14:00:00Z')
})

test('the stopwatch shows cold within a refresh of the cache expiring', async ($, on) => {
  const { clock } = world(on)
  await $.session.start(start as never)
  await clock.advance(20_000) // so the cache expires 20 seconds into a minute
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 500, model: 'm' }
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage } as never)
  // 15 seconds after it expires: the band says cold, not "1m".
  await clock.advance(60 * 60e3 + 15_000)
  expect(await band($ as never)).toContain('cache expired')
})
