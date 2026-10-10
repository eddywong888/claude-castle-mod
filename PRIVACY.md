# Privacy

Castle HUD runs entirely inside Claude Code on your machine.

- It reads only what Claude Code reports to plugins: context use, rate limits, cost, cache use, subagents and the edits and test commands that run in your sessions.
- It saves your XP, streak, 5-hour spending and each conversation's HUD figures (lines changed, last turn, cache time) in the plugin's own storage on your machine.
- It sends nothing anywhere. It makes no network requests and collects no analytics.

Uninstalling the plugin does not delete what it saved. To remove everything:

- type `/castle reset`, then `/castle reset confirm`, with your other Claude Code sessions closed; or
- delete the file under `~/.claude/plugins/store/` whose name starts with `castle-hud_`.
