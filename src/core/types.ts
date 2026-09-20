export type Flag = 'compacted' | 'aborted' | 'unpriced';

/** Token counts from the `compact_boundary` record, so the unaccounted compaction request can at least be sized. */
export interface Compaction {
  preTokens: number;
  postTokens: number;
  cumulativeDroppedTokens: number;
}

/** One API request, deduplicated on message id. Timestamps are epoch milliseconds UTC. */
export interface RequestRow {
  messageId: string;
  requestId: string;
  agentId: string | null;
  sessionId: string;
  parentMessageId: string | null;
  timestamp: number;
  sourceType: 'main' | 'subagent';
  sourceLabel: string;
  model: string;
  speed: string | null;
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  thinking: number;
  estimate: number;
  flags: Flag[];
  /** Set on the first main-thread request after a context compaction. */
  compaction: Compaction | null;
}

/** One Claude Code chat: a main transcript plus its subagent files. */
export interface Session {
  sessionId: string;
  /** `<project> · <title>`. The project is the basename of the session's cwd, else the folder name under the root; the title is the custom title, else the AI title, else the local start time. */
  label: string;
  /** Newest mtime across the session's files, epoch milliseconds. */
  lastWrite: number;
  newest: boolean;
}

export interface Snapshot {
  rows: RequestRow[];
  /** Newest first by last write. */
  sessions: Session[];
  priceSource: string;
  /** Every row's estimate since 00:00 UTC on the 1st of the current month plus `unlogged`, across every session and source. */
  monthToDate: number;
  /** USD this month that Claude Code's per-session `cost-state` totals hold above the rows: aborted and retried streams, sidecar calls, compaction. */
  unlogged: number;
  /** The monthly cap the user typed with `--budget`, `null` when unset. */
  budget: number | null;
  skippedLines: number;
  unpricedRows: number;
}

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  long_context?: null;
  fast?: Omit<ModelPrice, 'fast' | 'long_context'> | null;
}

export interface PriceTable {
  version: string;
  source: string;
  models: Record<string, ModelPrice>;
}
