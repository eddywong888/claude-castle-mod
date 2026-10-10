# Changelog

## 0.7.10

The release after four Opus audits, a Sonnet audit and two Codex reviews.

**New**
- A conversation's lines changed, last turn and cache stopwatch come back after a restart, and `/resume` brings back the resumed conversation's.
- `/castle reset` deletes everything the mod saved, after you confirm with `/castle reset confirm`.
- Each session's XP is added to one saved total when its conversation ends, so the store file stays small.

**Changed**
- The cache stopwatch counts down a fixed hour from each reply. It switches to five minutes only when a model switch reports a five-minute cache. A compaction or a model switch restarts it.
- Test runs are recognised from the runner's own words. Wrappers such as `time`, `env`, `timeout`, `nice` and `uv run` are understood. Runs that only list, compile or explain tests earn no XP.

**Fixed**
- XP is no longer counted twice or lost across `/clear`, `/resume`, forks, long sleeps, several open windows or updates from older versions.
- After a compaction, the context meter shows the smaller context instead of 0%.
- A failed first refresh no longer freezes the band.
- Level-up and achievement pop-ups appear once, not once per open window.
- The 5-hour total uses the latest reset any session has seen.
- XP is saved before a session's exit time runs out.
- Interrupted turns and interrupted test runs earn no XP.
- The stopwatch shows "cache expired" within one refresh of the cache running out.
- Counts from 999,500 up show as `1M`.

## 0.7.1 and earlier

The first public versions: the band, the moons, cost tracking, subagent bats, levels and achievements, and the castle that burns and gains tiers.
