// Pure helpers shared by the desktop SVG and the terminal text band.

/** How long the prompt cache stays warm after a reply (this session's 1-hour TTL). */
export const CACHE_TTL_MS = 60 * 60e3

/** The store key for one cost increase: `spend:<time>:<session id>:<sequence>`, unique even within a millisecond. */
export const spendKey = (t: number, id: string, seq: number) => `spend:${Math.round(t)}:${id}:${seq}`

/**
 * The entries of a spend key in the previous format (a list per session) still worth keeping, each with its
 * index in the original list: a retried conversion gives an entry the same new key even after others expire.
 */
export function legacyEntries(value: unknown, keepFrom: number): { t: number; usd: number; i: number }[] {
  if (!Array.isArray(value)) return []
  const out: { t: number; usd: number; i: number }[] = []
  value.forEach((e: unknown, i) => {
    const x = e as { t?: unknown; usd?: unknown } | null
    if (x && typeof x.t === 'number' && typeof x.usd === 'number' && x.t >= keepFrom && x.usd > 0) out.push({ t: x.t, usd: x.usd, i })
  })
  return out
}

/** The time in a spend key, or null for a key in an older format. */
export function spendTime(key: string): number | null {
  const m = /^spend:(\d+):/.exec(key)
  return m ? Number(m[1]) : null
}

/** What was spent at or after `start`, from the cross-session ledger. */
export function spentSince(ledger: { t: number; usd: number }[], start: number): number {
  return ledger.reduce((sum, e) => (e.t >= start ? sum + e.usd : sum), 0)
}

export const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3600e3, seven_day: 7 * 86400e3 }
const WANING = ['🌕', '🌖', '🌗', '🌘', '🌑']

/** How lit the moon is: 1 (full) when the window has just refreshed, 0 (new) at its reset. */
export function moonLight(kind: string, resetsAt: string | undefined, now: number): number {
  const span = WINDOW_MS[kind]
  if (!span || !resetsAt) return 1
  const left = Math.max(0, Date.parse(resetsAt) - now)

  return Math.min(1, Math.max(0, left / span))
}

export function moonEmoji(kind: string, resetsAt: string | undefined, now: number): string {
  const elapsed = 1 - moonLight(kind, resetsAt, now)

  return WANING[Math.round(elapsed * (WANING.length - 1))] ?? '🌑'
}

export function timeLeftShort(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const mins = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`

  return `${m}m`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number) => String(n).padStart(2, '0')

export function endsAt(resetsAt: string | undefined, kind: string): string {
  if (!resetsAt) return ''
  const t = new Date(resetsAt)
  const clock = `${pad(t.getHours())}:${pad(t.getMinutes())}`

  return kind === 'five_hour' ? clock : `${DAYS[t.getDay()]} ${clock}`
}

export const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'Spend' }

/** Share of the last turn's input the prompt cache served, 0 to 100. */
export function cacheHit(c: { read: number; written: number; uncached: number }): number {
  const total = c.read + c.written + c.uncached

  return total === 0 ? 0 : Math.round((c.read / total) * 100)
}

/** Splits text into lines; a trailing newline ends the last line rather than starting a new one. */
function splitLines(v: unknown): string[] {
  if (typeof v !== 'string' || v.length === 0) return []
  const parts = v.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** Lines added and removed in a tool result's patch: hunk lines starting `+` or `-`. */
export function linesFromPatch(patch: unknown): { added: number; removed: number } | null {
  if (!Array.isArray(patch)) return null
  const total = { added: 0, removed: 0 }
  for (const hunk of patch as { lines?: unknown }[]) {
    if (!Array.isArray(hunk.lines)) return null
    for (const line of hunk.lines as unknown[]) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) total.added += 1
      else if (line.startsWith('-')) total.removed += 1
    }
  }
  return total
}

/** A fallback when no patch came back: compare old and new text, ignoring the lines they share at each end. */
function diffCount(oldText: unknown, newText: unknown): { added: number; removed: number } {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  return { added: b.length - head - tail, removed: a.length - head - tail }
}

/**
 * Lines an Edit or Write call changed, from its result where it can. A staged edit (held for review) changed
 * nothing yet; a Write that updated a file with the same content has an empty patch and changed nothing; only
 * a new file, or a result without a patch, falls back to counting the input.
 */
export function editLines(tool: string, input: Record<string, unknown>, result: unknown): { added: number; removed: number } {
  const r = (result ?? {}) as { staged?: unknown; structuredPatch?: unknown; type?: unknown; originalFile?: unknown }
  if (r.staged === true) return { added: 0, removed: 0 }
  const patch = linesFromPatch(r.structuredPatch)
  if (patch && patch.added + patch.removed > 0) return patch
  if (tool === 'Write' && r.type === 'update' && typeof r.originalFile === 'string') return { added: 0, removed: 0 }
  return linesOf(tool, input)
}

/** Lines an edit tool changed, from its input, when its result carried no patch. */
export function linesOf(tool: string, input: Record<string, unknown>): { added: number; removed: number } {
  if (tool === 'Edit') return diffCount(input.old_string, input.new_string)
  if (tool === 'Write') return { added: splitLines(input.content).length, removed: 0 }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    const total = { added: 0, removed: 0 }
    for (const e of input.edits as Record<string, unknown>[]) {
      const d = diffCount(e.old_string, e.new_string)
      total.added += d.added
      total.removed += d.removed
    }
    return total
  }
  return { added: 0, removed: 0 }
}

export type CacheState = { read: number; written: number; uncached: number; at: number; model?: string; ttlMs?: number; rebased?: boolean }

const FIVE_MIN = 5 * 60e3

/**
 * The cache after a main-loop reply. A reply that neither read nor wrote the cache leaves it as it was.
 * The cache's life is learned from what happens after a gap longer than five minutes: still read, it lasts
 * an hour; written afresh with nothing read, it lasted five minutes.
 */
export function nextCache(
  prev: CacheState | null,
  u: { cache_read_input_tokens: number; cache_creation_input_tokens: number; input_tokens: number; model?: string },
  at: number,
  coldStart = false,
  startedAt = at,
): CacheState | null {
  const read = u.cache_read_input_tokens
  const written = u.cache_creation_input_tokens
  if (read + written === 0) return prev
  // A turn that started cold rebuilt the cache, whatever its later requests read: learn from it as unread.
  const readWhenStarted = coldStart ? 0 : read
  const sameModel = !prev?.model || !u.model || prev.model === u.model
  // A different model has its own cache: start again from the default lifetime.
  let ttlMs = sameModel ? (prev?.ttlMs ?? CACHE_TTL_MS) : CACHE_TTL_MS
  // After a compaction the cached prefix changed: the next rewrite says nothing about the cache's life.
  if (prev?.at && sameModel && !prev.rebased) {
    // The idle gap is from the last reply to when this turn started: its reads happened then, not at its end.
    const gap = startedAt - prev.at
    if (gap > FIVE_MIN && gap < CACHE_TTL_MS) {
      if (readWhenStarted > 0) ttlMs = CACHE_TTL_MS
      else if (written > 0) ttlMs = FIVE_MIN
    }
  }
  return { read, written, uncached: u.input_tokens, at, model: u.model, ttlMs }
}

/** Session length as hours and minutes: `1h 42m`, `7m`. */
export function elapsed(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60000))
  const h = Math.floor(mins / 60)
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export function k(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`

  return String(n)
}

/** A text gauge for the terminal: filled cells up to the percent. */
export function gauge(percent: number, width = 16): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}
