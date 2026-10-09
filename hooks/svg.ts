// The desktop HUD as one SVG strip: a clock-tower dial for context, true-phase
// moons for the rate-limit windows, and 8-bit sprites for the pickups.

import { cacheHit, k, moonLight, timeLeftShort, endsAt, LIMIT_LABEL } from './hud'
import { CACHE_TTL_MS } from './hud'
import type { Cache, LastTurn, Lines, Profile, Usage } from '../types'
import { duration, elapsed } from './hud'

export type Mode = 'light' | 'dark' | 'auto'
export type Hud = { usage: Usage | null; cache: Cache | null; bats: number; now: number; prevPercent: number; mode: Mode; windowUsd?: number; lastTurn?: LastTurn | null; lines?: Lines; startedAt?: number; profile?: Profile | null }

/** The HUD is laid out at 23px values; drawn at this scale, values come out at 14px. */
export const SCALE = 14 / 23
/** The castle's own scale. */
export const CASTLE_SCALE = 0.83

const LIGHT = { ink: '#2b2130', stone: '#8a8190', gold: '#a8780a', goldDark: '#6e4e06', goldLight: '#e8c25a', blood: '#a3162f', bloodLight: '#d0405a', bloodDark: '#6a0d1e', lit: '#f1e7c8', track: 'rgba(43,33,48,.14)', shadow: 'rgba(43,33,48,.62)' }
const DARK = { ink: '#ece3d0', stone: '#8e8597', gold: '#e3b341', goldDark: '#8a6510', goldLight: '#f7dc8a', blood: '#c8283f', bloodLight: '#f06a7c', bloodDark: '#7d1222', lit: '#f1e7c8', track: 'rgba(236,227,208,.16)', shadow: 'rgba(10,8,12,.7)' }

const vars = (p: typeof LIGHT) => Object.entries(p).map(([n, v]) => `--${n}:${v}`).join(';')

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const VALUE_W = 12.8 // px per character at 23px Palatino, an estimate for layout
const CAPTION_W = 10.7 // px per character at 19.7px (12px drawn)

function sprite(rows: string[], colors: Record<string, string>, x: number, y: number, px: number): string {
  let out = ''
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const fill = colors[row[c] ?? '.']
      if (fill) out += `<rect x="${x + c * px}" y="${y + r * px}" width="${px}" height="${px}" fill="${fill}"/>`
    }
  })
  return out
}

const COIN = ['..XXXX..', '.XHHGGX.', 'XHGGGGDX', 'XGGGGGDX', 'XGGGGGDX', 'XGGGGDDX', '.XDDDDX.', '..XXXX..']
const RESET_LABEL: Record<string, string> = { five_hour: '5hr', seven_day: '7d' }

const DAGGER = ['..X..', '..X..', '.XWX.', '.XWX.', '.XWX.', '.XWX.', 'BBBBB', '..B..', '..B..']
const SCROLL = ['.XXXXXXX.', 'XWWWWWWWX', '.WLLLLLW.', '.WWWWWWW.', '.WLLLLW..', '.WWWWWWW.', 'XWWWWWWWX', '.XXXXXXX.']

const CREST = ['XXXXXXXX', 'XGGGGGGX', 'XGGRRGGX', 'XGRRRRGX', 'XGGRRGGX', '.XGRRGX.', '.XGGGGX.', '..XGGX..', '...XX...']

const STOPWATCH = ['...BB...', '.XXXXXX.', 'XWWWHWWX', 'XWWWHWWX', 'XWWWHHWX', 'XWWWWWWX', 'XWWWWWWX', '.XXXXXX.']
const BAG = ['..TTTT..', '...XX...', '..XGGX..', '.XGHGGX.', 'XGHGGGGX', 'XGGGGGGX', 'XGGGGGGX', '.XXXXXX.']
const BAT_UP = ['X........X', 'XX..XX..XX', 'XXXXXXXXXX', '.XXXXXXXX.', '...X..X...']
const BAT_DOWN = ['....XX....', '..XXXXXX..', 'XXXXXXXXXX', 'X..XXXX..X', '....XX....']

export const zone = (p: number) => (p >= 85 ? 'blood' : p >= 60 ? 'gold' : 'ink')

/** The lit part of a waning moon (lit on its left), `light` from 1 (full) to 0 (new). */
export function moonPath(cx: number, cy: number, r: number, light: number): string {
  const rx = Math.abs(2 * light - 1) * r
  const sweep = light > 0.5 ? 0 : 1
  return `M${cx} ${cy - r}A${r} ${r} 0 0 0 ${cx} ${cy + r}A${rx.toFixed(2)} ${r} 0 0 ${sweep} ${cx} ${cy - r}Z`
}

// Craters (dx, dy, radius) as fractions of the moon's radius, and the limb's darkening toward the edge.
const CRATERS: [number, number, number][] = [[-0.3, -0.28, 0.22], [0.28, 0.12, 0.17], [-0.12, 0.42, 0.13], [0.4, -0.4, 0.1], [-0.5, 0.1, 0.09]]

/** The lit part of the moon, with craters and a darkened limb, clipped to the phase. */
function litMoon(cx: number, cy: number, r: number, light: number): string {
  const d = moonPath(cx, cy, r, light)
  const craters = CRATERS.map(([dx, dy, cr]) => `<circle cx="${(cx + dx * r).toFixed(1)}" cy="${(cy + dy * r).toFixed(1)}" r="${(cr * r).toFixed(1)}" fill="#8a7a5c" fill-opacity=".38"/>`).join('')
  return `<defs><clipPath id="lit"><path d="${d}"/></clipPath><radialGradient id="limb" cx="42%" cy="40%" r="62%"><stop offset="55%" stop-color="#3a2a14" stop-opacity="0"/><stop offset="100%" stop-color="#3a2a14" stop-opacity=".45"/></radialGradient></defs>
<g clip-path="url(#lit)"><circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--lit)"/>${craters}<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#limb)"/></g>
<path d="${d}" fill="none" stroke="var(--stone)" stroke-width=".6"/>`
}

type Section = { width: number; body: (x: number) => string }

function textBlock(x: number, value: string, caption: string, valueColor = 'var(--ink)'): string {
  return `<text x="${x}" y="27" class="v" fill="${valueColor}">${esc(value)}</text><text x="${x}" y="50" class="c">${esc(caption)}</text>`
}

const blockWidth = (value: string, caption: string) => Math.max(value.length * VALUE_W, caption.length * CAPTION_W)

export type Part = { source: string; alt: string; width: number; height: number }

export function buildSvg(h: Hud): { parts: Part[]; source: string; alt: string } {
  const u = h.usage
  const pct = Math.min(100, Math.max(0, u?.percent ?? 0))
  const sections: Section[] = []
  const alt: string[] = []

  // Context: the blood meter, a row of cells that fill red as the context grows.
  {
    const value = `${pct}%`
    const caption = u?.tokens === undefined ? `context of ${k(u?.window ?? 0)}` : `${k(u.tokens)} of ${k(u.window)}`
    const CELLS = 20
    const cw = 5
    const step = 6.5
    const top = 9
    const tall = 17
    const filled = pct > 0 ? Math.max(1, Math.round((pct / 100) * CELLS)) : 0
    const before = h.prevPercent > 0 ? Math.max(1, Math.round((Math.min(100, h.prevPercent) / 100) * CELLS)) : 0
    const meterW = CELLS * step
    const cells = Array.from({ length: CELLS }, (_, c) => {
      const cx = (c * step).toFixed(1)
      if (c >= filled) return `<rect x="${cx}" y="${top}" width="${cw}" height="${tall}" fill="var(--track)"/>`
      // Cells that are new since the last draw drip in, one after another.
      const isNew = c >= before
      const anim = isNew ? ` class="drip" style="animation-delay:${((c - before) * 0.05).toFixed(2)}s"` : ''
      return `<g${anim}><rect x="${cx}" y="${top}" width="${cw}" height="${tall}" fill="var(--blood)"/><rect x="${cx}" y="${top}" width="${cw}" height="3" fill="var(--bloodLight)"/><rect x="${cx}" y="${top + tall - 3}" width="${cw}" height="3" fill="var(--bloodDark)"/></g>`
    }).join('')
    const notch = (p: number, color: string) => `<rect x="${((p / 100) * meterW - 1.5).toFixed(1)}" y="${top - 6}" width="3" height="3" fill="${color}"/>`
    const z = zone(pct)
    // The value and caption sit on one line, centered under the bar.
    const lineW = value.length * VALUE_W + 8 + caption.length * CAPTION_W
    const w = Math.max(meterW, lineW)
    const barX = (w - meterW) / 2
    sections.push({
      width: w,
      body: x => `<g transform="translate(${x} 0)"><title>Context window: ${esc(caption)} (${value}).</title>
<g transform="translate(${barX.toFixed(1)} 0)">${cells}${notch(60, 'var(--gold)')}${notch(85, 'var(--blood)')}</g>
<text x="${(w / 2).toFixed(1)}" y="52" text-anchor="middle"><tspan class="v" fill="${z === 'ink' ? 'var(--ink)' : `var(--${z})`}">${esc(value)}</tspan><tspan class="c" dx="8">${esc(caption)}</tspan></text></g>`,
    })
    alt.push(`Context ${value}, ${caption}`)
  }

  // Rate limits: one moon per window, full when it refreshed, new when it resets.
  for (const l of u?.limits ?? []) {
    const label = LIMIT_LABEL[l.kind] ?? l.kind
    const value = `${l.percentUsed}%`
    // First line: the percent with its window's name beside it; second line: time left and when it resets.
    const name = `${RESET_LABEL[l.kind] ?? label} reset`
    const caption = l.resetsAt ? `${timeLeftShort(l.resetsAt, h.now)} to ${endsAt(l.resetsAt, l.kind)}` : 'no reset time yet'
    const light = moonLight(l.kind, l.resetsAt, h.now)
    const hot = l.percentUsed >= 80
    const firstW = value.length * VALUE_W + 8 + name.length * CAPTION_W
    sections.push({
      width: 40 + Math.max(firstW, caption.length * CAPTION_W),
      body: x => `<g transform="translate(${x} 0)"><title>${esc(label)} limit: ${value} used.</title>
<circle cx="15" cy="31" r="14.5" fill="var(--shadow)" stroke="var(--stone)" stroke-width=".8"/>
${light > 0.01 ? litMoon(15, 31, 14.5, light) : ''}
<text x="40" y="27"><tspan class="v" fill="${hot ? 'var(--blood)' : 'var(--ink)'}">${esc(value)}</tspan><tspan class="c" dx="8">${esc(name)}</tspan></text>
<text x="40" y="50" class="c">${esc(caption)}</text></g>`,
    })
    alt.push(`${label} limit ${value}, ${name} ${caption}`)
  }
  if ((u?.limits.length ?? 0) === 0) {
    sections.push({
      width: 40 + blockWidth('—', 'no limit data yet'),
      body: x => `<g transform="translate(${x} 0)"><circle cx="15" cy="31" r="14.5" fill="var(--track)" stroke="var(--stone)" stroke-width=".8"/>${textBlock(40, '—', 'no limit data yet', 'var(--stone)')}</g>`,
    })
    alt.push('No rate-limit reading yet')
  }

  // Cache: the stopwatch, counting down to when the prompt cache goes cold.
  {
    const cache = h.cache?.at ? h.cache : null
    const ttl = cache?.ttlMs ?? CACHE_TTL_MS
    const left = cache ? cache.at + ttl - h.now : 0
    const warm = left > 0
    const mins = Math.min(ttl / 60000, Math.ceil(left / 60000))
    const value = !cache ? '—' : warm ? `${mins}m` : 'cold'
    const caption = !cache ? 'cache' : warm ? `cache, ${cacheHit(cache)}% hit` : 'cache expired'
    const low = warm && left < 5 * 60000
    sections.push({
      width: 36 + blockWidth(value, caption),
      body: x => `<g transform="translate(${x} 0)"><title>Prompt cache: it lasts ${ttl / 60000} minutes after each reply. ${warm ? 'While warm, the next reply reads the conversation from cache at a fraction of the price.' : 'Cold: the next reply pays to write the conversation to cache again.'}</title>
${sprite(STOPWATCH, { X: 'var(--ink)', W: warm ? 'var(--lit)' : 'var(--track)', H: 'var(--blood)', B: 'var(--gold)' }, 0, 18, 3.4)}${textBlock(36, value, caption, low ? 'var(--blood)' : warm ? 'var(--ink)' : 'var(--stone)')}</g>`,
    })
    alt.push(`Cache ${value}, ${caption}`)
  }

  // Cost: the coin for this session, the money bag for the 5-hour window.
  {
    const value = u?.usd === undefined ? '—' : `$${u.usd.toFixed(2)}`
    sections.push({
      width: 36 + blockWidth(value, 'session'),
      body: x => `<g transform="translate(${x} 0)"><title>What this session has cost so far.</title>
${sprite(COIN, { X: 'var(--goldDark)', H: 'var(--goldLight)', G: 'var(--gold)', D: 'var(--goldDark)' }, 0, 18, 3.2)}${textBlock(36, value, 'session', 'var(--gold)')}</g>`,
    })
    alt.push(`Session cost ${value}`)
    const win = h.windowUsd === undefined ? '—' : `$${h.windowUsd.toFixed(2)}`
    sections.push({
      width: 36 + blockWidth(win, '5h window'),
      body: x => `<g transform="translate(${x} 0)"><title>What every session running this mod spent since the current 5-hour window began.</title>
${sprite(BAG, { X: 'var(--goldDark)', G: 'var(--gold)', H: 'var(--goldLight)', T: 'var(--blood)' }, 0, 15, 3.2)}${textBlock(36, win, '5h window', 'var(--gold)')}</g>`,
    })
    alt.push(`5-hour window cost ${win}`)
  }

  // Session time: a candle that burns down over eight hours.
  if (h.startedAt) {
    const ms = h.now - h.startedAt
    const value = elapsed(ms)
    const BURN_MS = 8 * 3600e3
    const px = 3.2
    const wax = Math.max(1, Math.round(7 * (1 - Math.min(1, ms / BURN_MS))))
    const base = 14 + 9 * px // bottom of the candle
    const waxTop = base - px - wax * px
    const candle =
      `<rect x="${px * 1.5}" y="${base - px}" width="${px * 4}" height="${px}" fill="var(--goldDark)"/>` +
      `<rect x="${px * 2}" y="${waxTop}" width="${px * 3}" height="${wax * px}" fill="var(--lit)"/>` +
      `<rect x="${px * 4}" y="${waxTop}" width="${px}" height="${wax * px}" fill="var(--stone)" opacity=".5"/>` +
      `<rect x="${px * 3}" y="${waxTop - px * 2}" width="${px}" height="${px * 2}" fill="var(--gold)"/>` +
      `<rect x="${px * 3}" y="${waxTop - px * 2}" width="${px}" height="${px}" fill="var(--bloodLight)"/>`
    sections.push({
      width: 30 + blockWidth(value, 'session'),
      body: x => `<g transform="translate(${x} 0)">${candle}${textBlock(30, value, 'session')}</g>`,
    })
    alt.push(`Session running ${value}`)
  }

  // Last turn: the dagger, how long the last reply took and what it wrote.
  {
    const t = h.lastTurn
    const value = t ? duration(t.ms) : '—'
    const caption = t ? `last turn, ${k(t.out)} out` : 'last turn'
    sections.push({
      width: 30 + blockWidth(value, caption),
      body: x => `<g transform="translate(${x} 0)">${sprite(DAGGER, { X: 'var(--stone)', W: 'var(--lit)', B: 'var(--gold)' }, 2, 14, 3.4)}${textBlock(30, value, caption)}</g>`,
    })
    alt.push(t ? `Last turn ${value}, ${k(t.out)} tokens written` : 'No turn yet')
  }

  // Lines changed: the scroll, lines added and removed by edits this session.
  {
    const l = h.lines ?? { added: 0, removed: 0 }
    const plus = `+${l.added}`
    const minus = `−${l.removed}`
    sections.push({
      width: 38 + blockWidth(`${plus} ${minus}`, 'lines changed'),
      body: x => `<g transform="translate(${x} 0)">${sprite(SCROLL, { X: 'var(--goldDark)', W: 'var(--lit)', L: 'var(--stone)' }, 0, 17, 3.2)}<text x="38" y="27" class="v"><tspan fill="var(--ink)">${plus}</tspan><tspan fill="var(--blood)" dx="8">${minus}</tspan></text><text x="38" y="50" class="c">lines changed</text></g>`,
    })
    alt.push(`${l.added} lines added, ${l.removed} removed`)
  }

  // Subagents: one flapping bat each, up to four.
  {
    const n = h.bats
    const shown = Math.min(4, Math.max(1, n))
    const value = n === 0 ? 'none' : String(n)
    const caption = n === 1 ? 'subagent' : 'subagents'
    const batW = 25
    const flock = 6 + shown * 14 + 12
    const batsSvg = Array.from({ length: shown }, (_, i) => {
      const bx = i * 14
      const by = 24 + (i % 2 === 0 ? 0 : -7)
      const fill = { X: n === 0 ? 'var(--stone)' : 'var(--ink)' }
      if (n === 0) return `<g opacity=".45">${sprite(BAT_UP, fill, bx, by, 2.5)}</g>`
      const delay = `${i * 0.13}s`
      return `<g class="up" style="animation-delay:${delay}">${sprite(BAT_UP, fill, bx, by, 2.5)}</g><g class="down" style="animation-delay:${delay}">${sprite(BAT_DOWN, fill, bx, by, 2.5)}</g>`
    }).join('')
    sections.push({
      width: flock + blockWidth(value, caption),
      body: x => `<g transform="translate(${x} 0)"><title>Subagents running now.</title>${batsSvg}${textBlock(flock + batW - 25, value, caption, n === 0 ? 'var(--stone)' : 'var(--ink)')}</g>`,
    })
    alt.push(n === 0 ? 'No subagents running' : `${n} subagents running`)
  }

  // Level: the crest, the level and title, and a gold bar of XP toward the next level.
  if (h.profile) {
    const p = h.profile
    const value = `LV ${p.level}`
    const name = p.title
    const xpText = `${p.into} / ${p.need} XP${p.streak > 0 ? `, ${p.streak}-day streak` : ''}`
    const barW = 70
    const fill = Math.max(0, Math.min(1, p.need > 0 ? p.into / p.need : 0))
    const firstW = value.length * VALUE_W + 8 + name.length * CAPTION_W
    const secondW = barW + 10 + xpText.length * CAPTION_W
    sections.push({
      width: 34 + Math.max(firstW, secondW),
      body: x => `<g transform="translate(${x} 0)">${sprite(CREST, { X: 'var(--goldDark)', G: 'var(--gold)', R: 'var(--blood)' }, 0, 14, 3.2)}
<text x="34" y="27"><tspan class="v" fill="var(--gold)">${esc(value)}</tspan><tspan class="c" dx="8">${esc(name)}</tspan></text>
<rect x="34" y="38" width="${barW}" height="7" fill="var(--track)"/><rect x="34" y="38" width="${(barW * fill).toFixed(1)}" height="7" fill="var(--gold)"/><rect x="34" y="38" width="${(barW * fill).toFixed(1)}" height="2" fill="var(--goldLight)"/>
<text x="${34 + barW + 10}" y="46" class="c">${esc(xpText)}</text></g>`,
    })
    alt.push(`Level ${p.level}, ${p.title}, ${xpText}`)
  }

  // One image per section, so the band wraps them to its width instead of shrinking one wide image.
  const PAD = 22 // left inset of every section, so wrapped rows line up
  const GAP = 18 // right space; with the next inset, 40 between sections (24px drawn)

  const palette =
    h.mode === 'light' ? `svg{${vars(LIGHT)}}` : h.mode === 'dark' ? `svg{${vars(DARK)}}` : `svg{${vars(LIGHT)}}@media (prefers-color-scheme:dark){svg{${vars(DARK)}}}`

  const style = `<style>${palette}
text{font-family:Palatino,'Palatino Linotype','Book Antiqua',Georgia,serif;font-variant-numeric:tabular-nums lining-nums}
.v{font-size:23px;font-weight:600;letter-spacing:.01em}
.c{font-size:19.7px;fill:var(--stone)}
rect{shape-rendering:crispEdges}
.drip{animation:drip .5s ease-out}
@keyframes drip{from{opacity:.15}to{opacity:1}}
@keyframes flapA{0%,49.9%{opacity:1}50%,100%{opacity:0}}
@keyframes flapB{0%,49.9%{opacity:0}50%,100%{opacity:1}}
.up{animation:flapA .36s steps(1) infinite}.down{opacity:0;animation:flapB .36s steps(1) infinite}
@media (prefers-reduced-motion:reduce){.drip{animation:none}.up{animation:none}.down{animation:none;opacity:0}}
</style>`

  const parts = sections.map((sec, i) => {
    const width = Math.ceil(PAD + sec.width + GAP)
    const body = sec.body(PAD)
    const w = Math.round(width * SCALE)
    const ht = Math.round(60 * SCALE)
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${ht}" viewBox="0 0 ${width} 60">${style}${body}</svg>`
    return { source, alt: alt[i] ?? '', width: w, height: ht }
  })

  return { parts, source: parts.map(p => p.source).join(''), alt: alt.join('. ') }
}

/** The night sky the band sits on, behind the HUD. */
export const NIGHT = '#1d1528'

const FLAMES: Record<'small' | 'medium' | 'big', string[]> = {
  small: ['..Y..', '..YO.', '.YOO.', '.OOR.', 'ORRRO', '.RRR.'],
  medium: ['...Y...', '...YO..', '..YOO..', '..OOOY.', '.YOORO.', '.OORRO.', 'ORRRRRO', '.RRRRR.'],
  big: ['....Y....', '...YY....', '...YOY...', '..YOOO.Y.', '..OOROOY.', '.YORRRO..', '.OORRROO.', 'ORRRRRRRO', 'ORRRRRRRO', '.RRRRRRR.'],
}
const FIRE = { Y: '#ffd84a', O: '#ff8a1f', R: '#d8261c' }

/** How much of the castle burns: none under 70% context, then small, medium and big fires. */
export function fireLevel(percent: number): 'none' | 'small' | 'medium' | 'big' {
  return percent >= 90 ? 'big' : percent >= 80 ? 'medium' : percent >= 70 ? 'small' : 'none'
}

/** A flickering flame, its base centered at (cx, baseY): two frames, the second mirrored. */
function flame(size: 'small' | 'medium' | 'big', cx: number, baseY: number, delay: number): string {
  const rows = FLAMES[size]
  const px = 2
  const w = (rows[0]?.length ?? 0) * px
  const x = cx - w / 2
  const y = baseY - rows.length * px
  const mirrored = rows.map(r => [...r].reverse().join(''))
  const style = `style="animation-delay:${delay}s"`
  return `<g class="fa" ${style}>${sprite(rows, FIRE, x, y, px)}</g><g class="fb" ${style}>${sprite(mirrored, FIRE, x, y, px)}</g>`
}

/** The castle's tiers: each /clear raises it one, up to five. */
export const MAX_TIER = 5

/**
 * The castle on the right edge of the band: towers, lit windows, a few stars. It grows with its tier (two
 * towers at 1; the right tower at 2; the keep at 3; banners at 4; an outer watchtower and a gold crest at 5)
 * and burns as the context fills.
 */
export function castleSvg(percent = 0, tier = 4): { source: string; alt: string; width: number; height: number } {
  const stone = '#3d2f52'
  const DY = 20 // room above the towers for the flames
  const t = Math.max(1, Math.min(MAX_TIER, Math.round(tier)))
  type Tower = { x: number; w: number; top: number; tip: number; from: number }
  // The tier each part appears at.
  const LEFT = 1
  const RIGHT = 2
  const KEEP = 3
  const BANNERS = 4
  const OUTER = 5
  const all: Tower[] = [
    { x: 6, w: 12, top: 20, tip: 8, from: OUTER }, // outer watchtower
    { x: 34, w: 14, top: 24, tip: 12, from: LEFT }, // left tower
    { x: 86, w: 20, top: 12, tip: 0, from: 1 }, // main tower
    { x: 146, w: 14, top: 22, tip: 10, from: RIGHT }, // right tower
    { x: 196, w: 26, top: 30, tip: 30, from: KEEP }, // keep, with battlements
  ]
  const towers = all.filter(tw => t >= tw.from)
  const has = (from: number) => t >= from
  const shapes = towers
    .map(({ x, w, top, tip }) => {
      const merlons = Array.from({ length: Math.floor(w / 5) }, (_, i) => `<rect x="${x + i * 5}" y="${top - 3}" width="3" height="3"/>`).join('')
      const spire = tip < top ? `<polygon points="${x - 2},${top - 3} ${x + w / 2},${tip} ${x + w + 2},${top - 3}"/>` : merlons
      return `<rect x="${x}" y="${top}" width="${w}" height="${52 - top}"/>${spire}`
    })
    .join('')
  const wall = `<rect x="0" y="38" width="240" height="14"/>${Array.from({ length: 24 }, (_, i) => `<rect x="${i * 10}" y="35" width="5" height="3"/>`).join('')}`
  const stars = ([[12, 9, 0.7], [58, 4, 0.5], [122, 18, 0.6], [176, 6, 0.8], [230, 14, 0.5], [70, 30, 0.35]] as [number, number, number][])
    .map(([x, y, o]) => `<rect x="${x}" y="${y + DY}" width="1.6" height="1.6" fill="#e8dcc0" opacity="${o}"/>`)
    .join('')

  // Banners from tier 4 on the side spires; a gold crest on the main spire at tier 5.
  const banner = (cx: number, tipY: number) =>
    `<rect x="${cx}" y="${tipY - 9}" width="1" height="9" fill="#8e8597"/><rect x="${cx + 1}" y="${tipY - 9}" width="6" height="4" fill="#c8283f"/><rect x="${cx + 1}" y="${tipY - 9}" width="6" height="1" fill="#d4a017"/>`
  const banners = has(BANNERS) ? banner(41, 12) + banner(153, 10) + (has(OUTER) ? banner(12, 8) : '') : ''
  const crest = has(OUTER) ? `<polygon points="96,-8 99,-4 96,0 93,-4" fill="#d4a017"/><rect x="95" y="-6" width="2" height="4" fill="#fff3c4"/>` : ''

  const fire = fireLevel(percent)
  // The windows turn from candle-gold to red once half the context is used, before any fire.
  const lit = percent >= 50 ? '#e0475b' : '#e3b341'
  const windows =
    `<rect x="94" y="22" width="3" height="5" fill="${lit}"/>` +
    (has(LEFT) ? `<rect x="40" y="32" width="2" height="4" fill="${lit}" opacity=".55"/>` : '') +
    (has(RIGHT) ? `<rect x="151" y="30" width="2" height="4" fill="${lit}" opacity="${fire === 'none' ? 0 : 0.7}"/>` : '') +
    (has(OUTER) ? `<rect x="11" y="28" width="2" height="4" fill="${lit}" opacity=".55"/>` : '')

  // Flames sit on the spire tips of the towers that stand (and the keep's battlements for the big fire).
  const main = 86 + 10
  const left = 34 + 7
  const right = 146 + 7
  const side = (size: 'small' | 'medium' | 'big', delay: number) =>
    (has(LEFT) ? flame(size, left, 14, delay) : '') + (has(RIGHT) ? flame(size, right, 12, delay + 0.1) : '')
  const flames =
    fire === 'small' ? flame('small', main, 2, 0)
    : fire === 'medium' ? flame('medium', main, 2, 0) + side('small', 0.1)
    : fire === 'big' ? flame('big', main, 2, 0) + side('medium', 0.1) + (has(KEEP) ? flame('small', 202, 27, 0.15) + flame('small', 214, 27, 0.05) : '') + (has(OUTER) ? flame('small', 12, 10, 0.12) : '')
    : ''
  const glow = fire === 'big'
    ? `<defs><radialGradient id="blaze" cx="50%" cy="100%" r="70%"><stop offset="0%" stop-color="#d8261c" stop-opacity=".45"/><stop offset="100%" stop-color="#d8261c" stop-opacity="0"/></radialGradient></defs><rect x="0" y="0" width="240" height="${60 + DY}" fill="url(#blaze)"/>`
    : ''
  const style = `<style>.fa{animation:fa .3s steps(1) infinite}.fb{opacity:0;animation:fb .3s steps(1) infinite}@keyframes fa{0%,49.9%{opacity:1}50%,100%{opacity:0}}@keyframes fb{0%,49.9%{opacity:0}50%,100%{opacity:1}}@media (prefers-reduced-motion:reduce){.fa{animation:none}.fb{animation:none;opacity:0}}rect{shape-rendering:crispEdges}</style>`
  const H = 60 + DY
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(240 * CASTLE_SCALE)}" height="${Math.round(H * CASTLE_SCALE)}" viewBox="0 0 240 ${H}">${style}${glow}${stars}<g transform="translate(0 ${DY + 8})"><g fill="${stone}" shape-rendering="crispEdges">${wall}${shapes}</g>${banners}${crest}${windows}${flames}</g></svg>`
  const alt = `Castle, tier ${t} of ${MAX_TIER}` + (fire === 'none' ? '' : `, on fire (${fire}): context at ${percent}%`)

  return { source, alt, width: Math.round(240 * CASTLE_SCALE), height: Math.round(H * CASTLE_SCALE) }
}
