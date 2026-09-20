# cclive

Live per-request dashboard for Claude Code, read from the transcript files on your machine.

Claude Code writes every API request it makes to local JSONL transcripts. cclive reads them, opens one page in your browser, and shows one row per request with an estimate at list price. A request that spawned subagents expands to show their requests nested under it, so you can see which subagent, model or turn is eating the budget. The page updates live while Claude Code runs and tracks the month-to-date estimate against a monthly budget you type in once.

For daily and monthly rollup tables use [ccusage](https://github.com/ryoppippi/ccusage). cclive answers a different question: what did this turn amount to, and how much of it came from the subagents it spawned.

## Run it

```
npx cclive-dashboard@latest
```

That reads your transcripts and opens the dashboard at http://localhost:4747. Requires Node 22.12 or newer. Run it in the same environment as Claude Code (WSL with WSL, Windows with Windows), because it reads that environment's `~/.claude/projects`.

Set a monthly budget once with `--budget 1500`; it is the only setting that persists. For the other flags (`--port`, `--no-open`, `--offline`, `--pricing`, `--json`) run `npx cclive-dashboard --help`.

## Local and read-only

cclive reads `~/.claude/projects` and `~/.config/claude/projects`, never writes to them, and serves the page on `127.0.0.1` only. No account access, no API key, no telemetry, no update check.

The one network call is an optional download of the public [LiteLLM price file](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) at startup, so new models are priced without a new release. A copy ships in the package and the last download is cached, so `--offline` works too.

## Accuracy

Figures are estimates from token counts at list price and are not your invoice. Claude Code does not log everything to the transcript: the compaction call, aborted-and-retried streams and sidecar calls have no rows. Where a session's own `cost-state` total exceeds its rows, the month-to-date figure includes the difference and the budget card says how much. Web and cloud sessions and other machines leave no local transcript and are missing entirely.

## Licence

MIT
