import { expect, test } from 'claude-code/testing'

import { addStats, emptyStats, isTestCommand, levelOf, longestStreak, profileOf, report, streakOf, subStats, turnXp, xpFor } from './xp'

test('levels climb a steepening curve with titles', () => {
  expect(levelOf(0)).toMatchObject({ level: 1, title: 'Wanderer', into: 0, need: 150 })
  expect(levelOf(xpFor(5)).level).toBe(5)
  expect(levelOf(xpFor(5)).title).toBe('Vampire Hunter')
  expect(levelOf(xpFor(5) - 1).level).toBe(4)
  expect(levelOf(xpFor(12)).title).toBe('Belmont Heir')
  expect(xpFor(3) - xpFor(2)).toBeGreaterThan(xpFor(2) - xpFor(1))
})

test('turn XP: base, capped lines, warm cache, tidy context', () => {
  expect(turnXp({ lines: 0, warm: false, tidy: false })).toBe(10)
  expect(turnXp({ lines: 95, warm: true, tidy: true })).toBe(10 + 9 + 5 + 5)
  expect(turnXp({ lines: 5000, warm: false, tidy: false })).toBe(60)
})

test('streaks count days in a row ending today or yesterday', () => {
  expect(streakOf(['2026-10-07', '2026-10-08', '2026-10-09'], '2026-10-09')).toBe(3)
  expect(streakOf(['2026-10-07', '2026-10-08'], '2026-10-09')).toBe(2)
  expect(streakOf(['2026-10-06', '2026-10-08'], '2026-10-09')).toBe(1)
  expect(streakOf(['2026-10-01'], '2026-10-09')).toBe(0)
  expect(streakOf(['2026-09-30', '2026-10-01'], '2026-10-01')).toBe(2)
})

test('sessions add up, and achievements follow from the totals', () => {
  const a = { ...emptyStats(), xp: 100, turns: 1, bats: 6, days: ['2026-10-08'] }
  const b = { ...emptyStats(), xp: 50, turns: 2, bats: 4, days: ['2026-10-08', '2026-10-09'] }
  const all = addStats(a, b)
  expect(all).toMatchObject({ xp: 150, turns: 3, bats: 10, days: ['2026-10-08', '2026-10-09'] })
  const p = profileOf(all, '2026-10-09')
  expect(p.level).toBe(2)
  expect(p.streak).toBe(2)
  expect(p.unlocked).toContain('first-blood')
  expect(p.unlocked).toContain('bat-slayer')
  expect(p.unlocked).not.toContain('devoted')
  expect(report(all, p)).toContain('Achievements (2 of 14)')
  expect(report(all, p)).toContain('Compactions           0 (castle tier 1 of 5)')
})

test('test commands are recognised', () => {
  expect(isTestCommand('npm test')).toBe(true)
  expect(isTestCommand('cd app && pnpm run test -- --watch=false')).toBe(true)
  expect(isTestCommand('python -m pytest -q')).toBe(true)
  expect(isTestCommand('cargo test')).toBe(true)
  expect(isTestCommand('claude plugin test .')).toBe(true)
  expect(isTestCommand('git status')).toBe(false)
  expect(isTestCommand('cat latest.txt')).toBe(false)
  expect(isTestCommand('echo pytest')).toBe(false)
  expect(isTestCommand('grep -r "npm test" .')).toBe(false)
  expect(isTestCommand('CI=1 npx vitest run')).toBe(true)
  expect(isTestCommand('npm test 2>&1')).toBe(true)
  expect(isTestCommand('npm test || true')).toBe(false)
  expect(isTestCommand('false && npm test; true')).toBe(false)
  expect(isTestCommand('npm test | tail -20')).toBe(false)
  expect(isTestCommand('npm test &')).toBe(false)
  expect(isTestCommand('pytest --collect-only')).toBe(false)
  expect(isTestCommand('go test -list .')).toBe(false)
  expect(isTestCommand('npm test -- --help')).toBe(false)
  expect(isTestCommand('npx jest --listTests')).toBe(false)
  expect(isTestCommand('pytest -q tests/')).toBe(true)
  expect(isTestCommand('echo "Run: cd app && npm test"')).toBe(false)
  expect(isTestCommand("pytest -k 'slow and db'")).toBe(true)
  expect(isTestCommand('npm test "unclosed')).toBe(false)
  expect(isTestCommand('echo ok # && npm test')).toBe(false)
  expect(isTestCommand('pytest "--collect-only"')).toBe(false)
  expect(isTestCommand('npm test # --help documents the command')).toBe(true)
  expect(isTestCommand('cargo test --no-run')).toBe(false)
  expect(isTestCommand('pytest --setup-plan')).toBe(false)
  expect(isTestCommand("pytest -k 'a or b' --co")).toBe(false)
  expect(isTestCommand('npm test # run the suite')).toBe(true)
})

test('streak achievements stay earned after a missed day', () => {
  const days = ['2026-10-01', '2026-10-02', '2026-10-03']
  expect(longestStreak(days)).toBe(3)
  expect(longestStreak(['2026-09-30', '2026-10-01', '2026-10-05'])).toBe(2)
  const p = profileOf({ ...emptyStats(), turns: 3, days }, '2026-10-09')
  expect(p.streak).toBe(0)
  expect(p.unlocked).toContain('devoted')
})

test('each compaction raises the castle a tier, up to five', () => {
  expect(profileOf(emptyStats(), '2026-10-09').castleTier).toBe(1)
  expect(profileOf({ ...emptyStats(), compacts: 2 }, '2026-10-09').castleTier).toBe(3)
  expect(profileOf({ ...emptyStats(), compacts: 9 }, '2026-10-09').castleTier).toBe(5)
  const old = { xp: 0, turns: 0, lines: 0, tests: 0, bats: 0, warm: 0, tidy: 0, night: 0, days: [] }
  expect(addStats(old, { ...emptyStats(), compacts: 1 }).compacts).toBe(1)
})

test('runs that only list or compile tests earn nothing; wrapped runs still count', () => {
  for (const c of ['npx vitest list', 'go test -c ./pkg', 'go test -run ^$ ./...', "go test -run '^$' ./...", 'pytest --fixtures', 'pytest --markers', 'npx jest --showConfig', 'make test-lint'])
    expect([c, isTestCommand(c)]).toEqual([c, false])
  for (const c of ['time npm test', 'env CI=1 npm test', 'timeout 300 npm test', 'uv run pytest', 'npx playwright test', 'npm t', 'npm test &>/dev/null', 'go test -count=1 ./...', 'make test'])
    expect([c, isTestCommand(c)]).toEqual([c, true])
})

test('what a record gained since an earlier one', () => {
  const before = { ...emptyStats(), xp: 100, turns: 5, days: ['2026-10-08'], compacts: 1 }
  const after = { ...emptyStats(), xp: 130, turns: 7, days: ['2026-10-08', '2026-10-09'], compacts: 2 }
  expect(subStats(after, before)).toEqual({ ...emptyStats(), xp: 30, turns: 2, days: ['2026-10-09'], compacts: 1 })
})

test('runner names end at a space, and the not-a-run flags are read from the runner alone', () => {
  for (const c of ['npx jest-codemods .', 'jest-coverage-badges', 'pytest-watch', 'npx vitest-preview', 'npm run test:lint', 'npm run test:types', 'npx vitest bench', 'npx vitest typecheck', 'npx jest --init', 'pytest "--collect-only"'])
    expect([c, isTestCommand(c)]).toEqual([c, false])
  for (const c of ['ls -h && npm test', 'du -h . && npm test', 'git commit -m "fix --help text" && npm test', 'npm test -- -t "handles --list flag"', 'npx jest --passWithNoTests', 'timeout -s KILL 300 npm test', 'timeout -k 5 300 npm test', 'timeout 2.5 npm test', 'nice -n 10 npm test', 'env -i PATH=/bin npm test', 'env -u X npm test', 'time -p npm test', 'uv run --with pytest pytest', 'npm run test:unit', 'npm test -- -t "--list"'])
    expect([c, isTestCommand(c)]).toEqual([c, true])
})
