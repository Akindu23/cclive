# cclive

Live per-request dashboard for Claude Code, read from the transcript files on your machine.

Claude Code writes every API request it makes to local JSONL transcripts. cclive reads them, opens one page in your browser, and shows one row per request with an estimate at list price. A request that spawned subagents expands to show their requests nested under it, so you can see which subagent, model or turn is eating the budget. The page updates live while Claude Code runs and shows the month-to-date estimate against a monthly budget you type in once.

For daily and monthly rollup tables use [ccusage](https://github.com/ryoppippi/ccusage). cclive answers a different question: what did this turn amount to, and how much of it came from the subagents it spawned.

## Usage

```
npx cclive                 # read transcripts, open http://localhost:4747
npx cclive --budget 1500   # set a monthly budget (saved for later runs)
npx cclive --json > out.json
Flags: --port <n>  --no-open  --pricing <file>  --offline  --budget <usd>  --json
```

| Flag | Default | Behaviour |
|---|---|---|
| `--budget <usd>` | none | Monthly budget for the budget card, saved to the config file. `0` clears it. |
| `--port <n>` | 4747 | Bind exactly this port. Without the flag cclive tries 4747, 4748, … and prints the one used. |
| `--no-open` | browser opens | Print the URL instead of opening the browser. |
| `--pricing <file>` | none | Per-model price overrides, first in precedence. Same shape as the shipped `pricing.json`. |
| `--offline` | off | Skip the LiteLLM price download. `CCLIVE_OFFLINE=1` does the same. |
| `--json` | off | Print the full snapshot as JSON and exit. |
| `--help`, `--version` | | Standard. |

Requires Node 20.16 or newer. The terminal prints the URL with how many transcripts were read and how long startup took, so the 2 s target is checkable on your own history.

Only the budget persists, in `~/.config/cclive/config.json` (`$XDG_CONFIG_HOME/cclive` when set, `%APPDATA%\cclive` on Windows). Every other flag applies to one run.

## What it does and does not do

cclive is read-only and local. It reads `~/.claude/projects` and `~/.config/claude/projects`, never writes to them, and serves the page on `127.0.0.1` only.

The one network call is an optional HTTPS download of the public [LiteLLM price file](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) at startup, so new models are priced without a new release. The last good download is cached next to the config file and a copy of the price table ships inside the package, so the dashboard works offline. `--offline` or `CCLIVE_OFFLINE=1` skips the download entirely.

No account access, no API key, no telemetry, no update check. Figures are estimates from token counts at list price and are not your invoice. The budget card names which price file priced the page and its date.

## Platforms

Windows, macOS, Linux and WSL are supported. Run cclive in the same environment as Claude Code, because it reads that environment's `~/.claude/projects`: WSL pairs with Claude Code in WSL, Windows with Claude Code in Windows. WSL gets no file change events for Windows drives under `/mnt/c`, so a WSL cclive pointed at a Windows Claude Code would not update live.

On Linux the watcher arms one inotify watch per transcript file and directory. A very large history can hit the default `fs.inotify.max_user_watches` limit, in which case new files stop being noticed until you raise it:

```
sudo sysctl fs.inotify.max_user_watches=524288
```

## Known gaps

- **Compaction request.** Claude Code does not write the compaction call to the transcript, so its estimate is missing. The Compacted badge shows the token counts it dropped so the gap is at least sized.
- **Inference geo.** Requests billed at the `us` inference geo carry a 1.1x multiplier that cclive does not apply.
- **Message id uniqueness.** Each request is counted once by its message id. Two unrelated requests sharing an id would collapse into one row.
- **Dropped file events.** macOS FSEvents can drop events under load and `fs.watch` cannot see that it did. cclive reconciles each file by size and offset on every event, so a dropped event is caught by the next one for that file rather than lost.

## Manual soak

There is no automated soak test. Before a release, run cclive for 24 hours alongside normal Claude Code use and sample it once a minute:

```
npx cclive --no-open &
while true; do ps -o rss=,%cpu= -p $!; sleep 60; done
```

Note the resident floor and the idle CPU. Both should stay flat over the day; the history sweep at 00:00 UTC drops rows that fell out of the window.

## Licence

MIT
