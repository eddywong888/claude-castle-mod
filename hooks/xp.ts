// Level, XP, streaks and achievements. Each session keeps its own Stats under its own store key; the
// profile (level, streak, achievements) is always derived from every session's Stats added together.

export type Stats = {
  xp: number
  turns: number
  lines: number
  tests: number
  bats: number
  warm: number
  tidy: number
  night: number
  days: string[]
  /** Times this session's conversation was compacted: each raises the castle a tier. Absent in older records. */
  compacts?: number
  /** When the record was last saved: a record left unsaved for days belongs to a session that ended. */
  savedAt?: number
}

export const emptyStats = (): Stats => ({ xp: 0, turns: 0, lines: 0, tests: 0, bats: 0, warm: 0, tidy: 0, night: 0, days: [], compacts: 0 })

export function addStats(a: Stats, b: Stats): Stats {
  return {
    xp: a.xp + b.xp,
    turns: a.turns + b.turns,
    lines: a.lines + b.lines,
    tests: a.tests + b.tests,
    bats: a.bats + b.bats,
    warm: a.warm + b.warm,
    tidy: a.tidy + b.tidy,
    night: a.night + b.night,
    days: [...new Set([...a.days, ...b.days])].sort(),
    compacts: (a.compacts ?? 0) + (b.compacts ?? 0),
  }
}

/** What `a` gained since `b`, a record it grew from: XP and counts subtracted, only the days `b` lacked. */
export function subStats(a: Stats, b: Stats): Stats {
  const had = new Set(b.days)
  return {
    xp: Math.max(0, a.xp - b.xp),
    turns: Math.max(0, a.turns - b.turns),
    lines: Math.max(0, a.lines - b.lines),
    tests: Math.max(0, a.tests - b.tests),
    bats: Math.max(0, a.bats - b.bats),
    warm: Math.max(0, a.warm - b.warm),
    tidy: Math.max(0, a.tidy - b.tidy),
    night: Math.max(0, a.night - b.night),
    days: a.days.filter(d => !had.has(d)),
    compacts: Math.max(0, (a.compacts ?? 0) - (b.compacts ?? 0)),
  }
}

export const XP = { turn: 10, perTenLines: 1, linesCap: 50, test: 25, bat: 15, warm: 5, tidy: 5 }

/** XP for one finished turn of the main conversation. */
export function turnXp(t: { lines: number; warm: boolean; tidy: boolean }): number {
  return XP.turn + Math.min(XP.linesCap, Math.floor(t.lines / 10) * XP.perTenLines) + (t.warm ? XP.warm : 0) + (t.tidy ? XP.tidy : 0)
}

/** Total XP needed to reach a level: each level asks a little more than the last. */
export const xpFor = (level: number) => Math.round(150 * Math.pow(Math.max(0, level - 1), 1.6))

const TITLES: [number, string][] = [
  [1, 'Wanderer'],
  [5, 'Vampire Hunter'],
  [10, 'Belmont Heir'],
  [20, 'Whip Master'],
  [35, 'Night Stalker'],
  [50, 'Lord of the Castle'],
]

export const titleOf = (level: number) => TITLES.filter(([at]) => level >= at).pop()?.[1] ?? 'Wanderer'

export type Level = { level: number; title: string; into: number; need: number }

export function levelOf(xp: number): Level {
  let level = 1
  while (xp >= xpFor(level + 1)) level++
  const base = xpFor(level)
  return { level, title: titleOf(level), into: xp - base, need: xpFor(level + 1) - base }
}

/** The local calendar day of a moment, `2026-10-09`. */
export function dayKey(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const prevDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return dayKey(new Date(y ?? 0, (m ?? 1) - 1, (d ?? 1) - 1).getTime())
}

/** Days in a row with at least one finished turn, ending today (or yesterday, if today has none yet). */
export function streakOf(days: string[], today: string): number {
  const set = new Set(days)
  let day = set.has(today) ? today : prevDay(today)
  let n = 0
  while (set.has(day)) {
    n++
    day = prevDay(day)
  }
  return n
}

/** The longest run of consecutive days in the history. */
export function longestStreak(days: string[]): number {
  const set = new Set(days)
  let best = 0
  for (const day of set) {
    if (set.has(dayKey(new Date(day + 'T12:00:00').getTime() - 86400e3))) continue // not the start of a run
    let n = 0
    let d = day
    while (set.has(d)) {
      n++
      d = dayKey(new Date(d + 'T12:00:00').getTime() + 86400e3)
    }
    best = Math.max(best, n)
  }
  return best
}

export type Achievement = { id: string; name: string; how: string; met: (s: Stats, level: number, bestStreak: number) => boolean }

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first-blood', name: 'First Blood', how: 'Finish your first turn', met: s => s.turns >= 1 },
  { id: 'scribe', name: 'Scribe', how: 'Change 1,000 lines', met: s => s.lines >= 1000 },
  { id: 'archivist', name: 'Archivist', how: 'Change 10,000 lines', met: s => s.lines >= 10000 },
  { id: 'bat-slayer', name: 'Bat Slayer', how: 'See 10 subagents finish', met: s => s.bats >= 10 },
  { id: 'bat-plague', name: 'Bat Plague', how: 'See 100 subagents finish', met: s => s.bats >= 100 },
  { id: 'clean-kill', name: 'Clean Kill', how: 'Pass 25 test runs', met: s => s.tests >= 25 },
  { id: 'warm-hearth', name: 'Warm Hearth', how: 'Reply 50 times with the cache warm', met: s => s.warm >= 50 },
  { id: 'tidy-keep', name: 'Tidy Keep', how: 'Finish 50 turns under 60% context', met: s => s.tidy >= 50 },
  { id: 'night-owl', name: 'Night Owl', how: 'Finish a turn between midnight and 4am', met: s => s.night >= 1 },
  { id: 'devoted', name: 'Devoted', how: 'Keep a 3-day streak', met: (_s, _l, best) => best >= 3 },
  { id: 'relentless', name: 'Relentless', how: 'Keep a 7-day streak', met: (_s, _l, best) => best >= 7 },
  { id: 'eternal-night', name: 'Eternal Night', how: 'Keep a 30-day streak', met: (_s, _l, best) => best >= 30 },
  { id: 'vampire-hunter', name: 'Vampire Hunter', how: 'Reach level 5', met: (_s, level) => level >= 5 },
  { id: 'lord', name: 'Lord of the Castle', how: 'Reach level 50', met: (_s, level) => level >= 50 },
]

export type Profile = Level & { xp: number; streak: number; unlocked: string[]; castleTier: number }

export function profileOf(s: Stats, today: string): Profile {
  const lv = levelOf(s.xp)
  const streak = streakOf(s.days, today)
  // Achievements read the longest streak ever, so a missed day never takes one back.
  const best = Math.max(streak, longestStreak(s.days))
  const unlocked = ACHIEVEMENTS.filter(a => a.met(s, lv.level, best)).map(a => a.id)
  // The castle starts at tier 1 and rises one tier per compaction, up to 5.
  return { ...lv, xp: s.xp, streak, unlocked, castleTier: Math.min(5, 1 + (s.compacts ?? 0)) }
}

// A test runner at the start of a command: `npm test`, `npm t`, `pnpm run test:unit`, `pytest`, `go test`,
// `npx vitest`, `npx playwright test`. Each name ends at a space: `jest-codemods` and `pytest-watch` are other
// tools, `make test-lint` another target, and `npm run test:lint` a lint, not a test run.
const END = '(?=\\s|$)'
const SCRIPT = `test(:(?!lint|types?|typecheck|format|style|prettier|eslint)[\\w:-]+)?${END}`
const TEST_RUNNER = new RegExp(
  `^((npm|pnpm|yarn|bun)\\s+(run\\s+)?(${SCRIPT}|t${END})` +
    `|(npx\\s+|bunx\\s+|python3?\\s+-m\\s+)?(pytest|jest|vitest|mocha|rspec|phpunit)${END}` +
    `|(npx\\s+|bunx\\s+)?playwright\\s+test${END}` +
    `|(go|cargo|deno|mix|dotnet)\\s+test${END}|claude\\s+plugin\\s+test${END}|make\\s+test${END})`,
)

// Flags of a runner that lists, collects, compiles or explains tests: it succeeds without running any.
const NOT_A_RUN = /^(--collect-only|--co|--list-tests|--listTests|-list|--list|--help|-h|--version|--dry-run|--no-run|--setup-plan|--setup-only|--collectOnly|--fixtures|--fixtures-per-test|--markers|--showConfig|--show-config|--init)(=.*)?$/

// Commands that may lead a runner without changing what its success means, with the options that take a value.
const LEADERS: Record<string, { valued: string[]; then?: 'duration' }> = {
  time: { valued: [] },
  nice: { valued: ['-n', '--adjustment'] },
  env: { valued: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'] },
  timeout: { valued: ['-s', '--signal', '-k', '--kill-after'], then: 'duration' },
}
// `uv run`, `poetry run` and the like run what follows in a project's environment.
const RUNNERS_OF = /^(uv|poetry|pipenv|pdm|hatch|rye)$/
const RUN_VALUED = ['--with', '--python', '-p', '--project', '--directory', '--env-file', '--extra', '--group', '--package']

/** The words of a runner with whatever leads it dropped: `env CI=1 timeout -s KILL 300 npm test` is `npm test`. */
function runnerOf(words: string[]): string[] {
  let i = 0
  for (;;) {
    const w = words[i]
    if (w === undefined) return []
    if (/^\w+=/.test(w)) {
      i++ // VAR=value
      continue
    }
    const leader = LEADERS[w]
    if (leader) {
      i++
      while (words[i]?.startsWith('-')) i += leader.valued.includes(words[i] ?? '') ? 2 : 1
      if (leader.then === 'duration' && /^\d+(\.\d+)?[smhd]?$/.test(words[i] ?? '')) i++
      continue
    }
    if (RUNNERS_OF.test(w) && words[i + 1] === 'run') {
      i += 2
      while (words[i]?.startsWith('-')) i += RUN_VALUED.includes(words[i] ?? '') ? 2 : 1
      continue
    }
    return words.slice(i)
  }
}

/** A runner asked for something other than a run: `vitest list`, `vitest bench`, `go test -c`, `go test -run ^$`. */
function onlyLists(runner: string[]): boolean {
  const line = runner.join(' ')
  if (/^((npx|bunx)\s+)?(vitest|jest)\s+(list|bench|typecheck)(\s|$)/.test(line)) return true
  if (/^go\s+test(\s|$)/.test(line) && (runner.includes('-c') || /\s-run[\s=]\^?\$(\s|$)/.test(line))) return true
  return runner.some(w => NOT_A_RUN.test(w))
}

/**
 * True when the command's success means a test run passed: a test runner alone, or in an `&&` chain
 * (`cd app && npm test`), where every step has to succeed. Anything that can succeed after a failing test
 * (`||`, `;`, a pipe, a background `&`, a newline, a subshell) doesn't count.
 */
export function isTestCommand(command: string): boolean {
  // Quoted text is one argument, never a command: `echo "cd app && npm test"` runs no tests. Mask each quote
  // as a placeholder word, so the command's own structure is read without it.
  const quoted: string[] = []
  const masked = command.replace(/"[^"]*"|'[^']*'/g, m => `\u0000${quoted.push(m.slice(1, -1)) - 1}\u0000`)
  if (/["']/.test(masked)) return false // an unbalanced quote: can't tell what runs
  // `2>&1` and `&>/dev/null` only redirect output; everything after an unquoted `#` is a comment.
  const code = masked
    .replace(/\d*>&\d+/g, '')
    .replace(/&>>?\s*\S+/g, '')
    .replace(/(^|\s)#.*$/gm, '$1')
  if (/\|\||;|\||\n|`|\$\(|(^|[^&])&(?!&)/.test(code)) return false
  const unmask = (w: string) => w.replace(/\u0000(\d+)\u0000/g, (_, i: string) => quoted[Number(i)] ?? '')
  // The flags that mark a run as not running tests are read from the runner's own arguments: `ls -h && npm test`
  // runs tests, and `npm test -- -t "the --list flag"` names a test.
  return code.split('&&').some(part => {
    const runner = runnerOf(part.trim().split(/\s+/).filter(Boolean).map(unmask))
    return runner.length > 0 && TEST_RUNNER.test(runner.join(' ')) && !onlyLists(runner)
  })
}

/** The `/castle` report: level, streak, what earned the XP, and every achievement. */
export function report(s: Stats, p: Profile): string {
  const row = (label: string, value: string) => `  ${label.padEnd(22)}${value}`
  const got = new Set(p.unlocked)
  return [
    `Level ${p.level}, ${p.title}`,
    `${p.into} / ${p.need} XP to level ${p.level + 1} (${p.xp} XP in all)`,
    `Streak: ${p.streak} day${p.streak === 1 ? '' : 's'}`,
    '',
    'Where the XP came from',
    row('Turns finished', `${s.turns}`),
    row('Lines changed', `${s.lines}`),
    row('Test runs passed', `${s.tests}`),
    row('Subagents finished', `${s.bats}`),
    row('Warm-cache replies', `${s.warm}`),
    row('Turns under 60%', `${s.tidy}`),
    row('Compactions', `${s.compacts ?? 0} (castle tier ${p.castleTier} of 5)`),
    '',
    `Achievements (${got.size} of ${ACHIEVEMENTS.length})`,
    ...ACHIEVEMENTS.map(a => `  ${got.has(a.id) ? '✓' : '·'} ${a.name.padEnd(20)}${a.how}`),
  ].join('\n')
}
