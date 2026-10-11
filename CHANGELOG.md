# Changelog

## 0.11.1

- The working indicator beside the level is now a thrown cross that spins out along its track and back, so it can't be mistaken for the subagent bats.

## 0.11.0

- A bell tolls under a short organ chord when Claude finishes a reply: an original sound. `/castle sound off` silences it, `/castle sound on` brings it back.
- Beside the level, a bat flies along a track while Claude works and rests when it's your turn.
- The README's opening line describes the castle as it now behaves.

## 0.10.1

- Vampire Hunter and Lord of the Castle show pixel portraits: a hunter in a red headband, and a pale vampire lord with red eyes and a high red collar.

## 0.10.0

- Each title has its own icon in the level section: a lantern (Wanderer), a stake (Vampire Hunter), the crest (Belmont Heir), a whip (Whip Master), a crescent moon (Night Stalker) and a crown (Lord of the Castle).
- A gateway's spend limit is no longer taken for a subscription, so gateway users keep seeing their costs.
- On a five-minute cache the band redraws at each fire stage, so none is skipped.
- PRIVACY.md and the README say the mod asks what kind of login a session has, and never sees or uses the key.

## 0.9.0

- The castle burns as the prompt cache runs down: a small fire at 40% of its life left, medium at 20%, big at 10%. It goes out when the cache expires or a reply refreshes it.
- The castle grows as the context fills: banners at 40%, gold trim and a taller spire at 60%, crest and glow at 80%. Compactions are still counted in `/castle`, but no longer change the castle.

## 0.8.0

- The band fits how you pay. On a Claude subscription it shows the rate-limit moons and hides the session and 5-hour costs. With an API key or a third-party provider it shows the costs and hides the moons.
- A fuller description for the plugin listing (0.7.11).

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
