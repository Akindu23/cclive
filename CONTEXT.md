# cclive

Live per-request dashboard for Claude Code, read from local transcript files.

## Language

**Request**:
One API call Claude Code made, identified by its message id. The unit of a table row. Transcripts write one line per content block, so many lines make one request.
_Avoid_: call, message, line, turn (a turn holds many requests)

**Spawning request**:
The request whose Agent tool call launched a subagent. Subagent requests nest under it.
_Avoid_: parent turn

**Turn**:
One user prompt and everything Claude Code did until it stopped for input. Contains one or more requests.

**Subagent request**:
A request made from a subagent transcript, which lives under the parent session's `subagents/` folder. Shown nested under the parent request that spawned it.
_Avoid_: sidechain, child

**Source**:
Where a request came from: the main thread, or a subagent named by its type and launch description.
_Avoid_: origin, agent, sidechain

**Compacted badge**:
A marker on the first main-thread request after Claude Code compacted its context. The compaction call itself is not in the transcript.
_Avoid_: compact request, summary row

**Aborted badge**:
A marker on a request that never wrote a final line, so its output count is partial.
_Avoid_: incomplete, in-flight

**Budget**:
The monthly dollar cap the user types in. cclive never reads it from Anthropic.
_Avoid_: limit, quota, plan

**Estimate**:
A dollar figure computed from token counts at list price. Always labelled as an estimate.
_Avoid_: cost, spend, bill

**Range chip**:
One of the five preset time windows above the tiles: 1d, 7d, 30d, MTD, Last month. Drives the tiles, chart and table. Does not affect the budget card.
_Avoid_: filter, period selector

**Stat tile**:
One of the three cards under the range chips: Total estimate, Main thread, Subagents. Each shows a dollar estimate for the range and a request count.
_Avoid_: KPI, stat card, metric box

**Pricing file**:
The versioned pricing.json shipped inside the package, one entry per model id at list price. At startup cclive refreshes it from the LiteLLM price file and falls back to the shipped copy offline. `--pricing <file>` wins over both by model id.
_Avoid_: price list, rates, tariff

**Unpriced badge**:
A marker on a request whose model id is not in the pricing file, even after stripping a date suffix. Its cost counts as $0 and the tiles warn how many rows are unpriced.
_Avoid_: unknown model, unknown cost

**Session**:
One Claude Code chat: one transcript file under a project folder plus its `subagents/` folder. Labelled `<project> · <title>`, with the start time when no title exists.
_Avoid_: conversation, chat, thread

**Session filter**:
The dropdown on the chips row that narrows the tiles, chart and table to one session. Never narrows the budget card.
_Avoid_: session picker, sidebar

**Price cache**:
The last good LiteLLM download saved at `~/.config/cclive/prices.json` with its ETag and fetch date. Used before the shipped pricing file when offline.
_Avoid_: price snapshot, local prices

**Price source label**:
The end of the budget card disclaimer that names which file priced the page and its date.
_Avoid_: pricing status, provenance line

**History window**:
The transcript files cclive reads at startup: those modified on or after 00:00 UTC on the 1st of the previous month. Older files cannot hold a row the page shows. The watcher still covers every file under both roots.
_Avoid_: lookback, retention, scan range

**Snapshot**:
The full priced data set plus totals as one JSON document. Served on first load, refetched by the page after a live-stream reconnect or a server restart, and pushed over the stream after the price refresh and after each daily history sweep.
_Avoid_: state dump, full refresh, payload

**Config file**:
`~/.config/cclive/config.json`. Holds only the budget. Every other flag applies to one run.
_Avoid_: settings, preferences, rc file

**Export button**:
The Export CSV control on the table header. Saves the table as filtered by range chip and session filter, flat, nine columns, from the browser. Never includes the budget card.
_Avoid_: download, dump, report

**History sweep**:
The once-a-day pass, at the first event after 00:00 UTC, that drops rows and dedup ids outside the history window and resets the month-to-date total on the 1st. Keeps memory bounded while the process runs for days.
_Avoid_: garbage collection, purge, rollover job
