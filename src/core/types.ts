export type Flag = 'compacted' | 'aborted' | 'unpriced';

/** Token counts from the `compact_boundary` record, so the unaccounted compaction request can at least be sized. */
export interface Compaction {
  preTokens: number;
  postTokens: number;
  cumulativeDroppedTokens: number;
}

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
  effort: string | null;
  tools: string[];
  attribution: string | null;
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

export interface Session {
  sessionId: string;
  /** `<project> · <title>`. Project is cwd basename, else the folder under the root; title is custom, else AI, else local start time. */
  label: string;
  lastWrite: number;
  newest: boolean;
  /** Claude Code's own USD total from `cost-state`, null until one is written (usually at session end). */
  costTotal: number | null;
  /** Same total split by Claude Code's model id, e.g. `claude-opus-5[1m]`. */
  costByModel: Record<string, number>;
}

export interface Snapshot {
  rows: RequestRow[];
  sessions: Session[];
  priceSource: string;
  /** Every row's estimate since 00:00 UTC on the 1st of the current month plus `unlogged`. */
  monthToDate: number;
  /** USD this month that Claude Code's per-session `cost-state` totals hold above the rows: aborted and retried streams, sidecar calls, compaction. */
  unlogged: number;
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
