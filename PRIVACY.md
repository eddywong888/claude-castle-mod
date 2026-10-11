# Privacy

Castle HUD runs entirely inside Claude Code on your machine.

- It reads only what Claude Code reports to plugins: context use, rate limits, cost, cache use, subagents and the edits and test commands that run in your sessions.
- To tell a subscription from pay-per-token use, it asks Claude Code what kind of login the session has (a claude.ai login or an API key). Claude Code answers with the kind and a sealed handle; the mod never sees your key or token, and never uses the handle.
- It saves your XP, streak, 5-hour spending, each conversation's HUD figures (lines changed, last turn, cache time) and your bell and cache settings in the plugin's own storage on your machine.
- When a reply is done it plays its own bell sound, a file inside the plugin, unless you turn it off with `/castle sound off`.
- It sends nothing anywhere. It makes no network requests and collects no analytics.

Uninstalling the plugin does not delete what it saved.

- `/castle reset`, then `/castle reset confirm`, with your other Claude Code sessions closed, deletes everything it recorded but keeps your bell and cache settings.
- To remove everything, settings included, delete the file under `~/.claude/plugins/store/` whose name starts with `castle-hud_`.
