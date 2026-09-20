import { estimate, lookupPrice } from './pricing.ts';
import type { Compaction, Flag, PriceTable, RequestRow, Session } from './types.ts';

/** Record types Claude Code writes today. Anything else is skipped and counted. */
const KNOWN_TYPES = new Set([
  'user', 'assistant', 'attachment', 'system', 'fork-context-ref',
  'mode', 'atis-latch', 'last-prompt', 'ai-title', 'custom-title', 'agent-name', 'agent-color',
  'file-history-snapshot', 'file-history-delta', 'permission-mode', 'queue-operation', 'bridge-session',
  'cost-state', 'frame-link', 'artifact-autoreact-ledger', 'artifact-comment-monitor', 'continued-in',
]);

interface AgentToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input?: { subagent_type?: string; description?: string };
}

interface AssistantRecord {
  type: 'assistant';
  uuid: string;
  sessionId: string;
  timestamp: string;
  requestId?: string | null;
  agentId?: string;
  message: {
    id: string;
    model: string;
    stop_reason: string | null;
    content?: Array<{ type: string } | AgentToolUse>;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
      output_tokens_details?: { thinking_tokens?: number };
      speed?: string;
    };
  };
}

/** The parent-side record that links a subagent to the Agent tool call that spawned it. */
interface LinkRecord {
  type: 'user';
  sourceToolAssistantUUID?: string;
  message?: { content?: unknown };
  toolUseResult?: unknown;
}

/** `compact_boundary` marks a compaction; the first main-thread request after it carries the counts. */
interface SystemRecord {
  type: 'system';
  sessionId: string;
  subtype?: string;
  compactMetadata?: Partial<Compaction>;
}

interface TitleRecord {
  type: 'ai-title' | 'custom-title';
  sessionId: string;
  aiTitle?: string;
  customTitle?: string;
}

interface Entry {
  row: RequestRow;
  final: boolean;
}

interface SessionState {
  /** Folder name under the root, e.g. `-Users-me-src-app`. Used when no record has given a cwd. */
  project: string;
  /** Basename of the newest `cwd` seen in the session's records, e.g. `app`. */
  cwdName: string | null;
  lastWrite: number;
  startTime: number;
  aiTitle: string | null;
  customTitle: string | null;
}

const EMPTY_SESSION: SessionState = { project: '', cwdName: null, lastWrite: 0, startTime: Infinity, aiTitle: null, customTitle: null };

/** Holds every request seen, keyed by message id, and prices it. Feed lines, read rows. */
export class RequestStore {
  private readonly entries = new Map<string, Entry>();
  /** uuid of an assistant line holding an Agent tool_use → its message id (the spawning request). */
  private readonly spawnerByUuid = new Map<string, string>();
  /** Agent tool_use id → `<subagent_type>: <description>` from its input. */
  private readonly labelByToolUse = new Map<string, string>();
  /** agent id → spawning request message id, once the link record has been seen. */
  private readonly parentByAgent = new Map<string, string>();
  private readonly metaLabelByAgent = new Map<string, string>();
  private readonly fallbackLabelByAgent = new Map<string, string>();
  /** session id → counts from a `compact_boundary` not yet attached to a main-thread request. */
  private readonly pendingCompaction = new Map<string, Compaction>();
  private readonly sessionStates = new Map<string, SessionState>();
  /** One shared string per model id, so ten thousand rows do not hold ten thousand copies. */
  private readonly models = new Map<string, string>();
  skippedLines = 0;

  constructor(private prices: PriceTable) {}

  /** Swap the price table and re-estimate every row, refreshing its unpriced flag. */
  reprice(prices: PriceTable): void {
    this.prices = prices;
    for (const { row } of this.entries.values()) {
      const price = lookupPrice(prices, row.model);
      row.estimate = price ? estimate(row, price) : 0;
      row.flags = row.flags.filter((f) => f !== 'unpriced');
      if (!price) row.flags.push('unpriced');
    }
  }

  /** Label an agent from its sibling meta file. Returns rows whose label changed. */
  labelAgent(agentId: string, label: string): RequestRow[] {
    this.metaLabelByAgent.set(agentId, label);
    return this.relabel(agentId);
  }

  /** Note a write to one of a session's files. `project` is the basename of the folder under the root. */
  touchSession(sessionId: string, project: string, writtenAt: number): void {
    const state = this.session(sessionId);
    state.project = project;
    state.lastWrite = Math.max(state.lastWrite, writtenAt);
  }

  /** Drop rows timestamped before `since` and sessions not written since, so message ids outside the window can be counted again. */
  sweep(since: number): void {
    for (const [id, { row }] of this.entries) if (row.timestamp < since) this.entries.delete(id);
    for (const [id, s] of this.sessionStates) if (s.lastWrite < since) this.sessionStates.delete(id);
  }

  private session(sessionId: string): SessionState {
    let state = this.sessionStates.get(sessionId);
    if (!state) this.sessionStates.set(sessionId, (state = { ...EMPTY_SESSION }));
    return state;
  }

  /** Parse one transcript line. Returns the rows it created or changed. */
  feed(line: string): RequestRow[] {
    let rec: { type?: unknown };
    try {
      rec = JSON.parse(line);
    } catch {
      this.skippedLines++;
      return [];
    }
    if (typeof rec.type !== 'string' || !KNOWN_TYPES.has(rec.type)) {
      this.skippedLines++;
      return [];
    }
    this.noteStart(rec as { sessionId?: unknown; timestamp?: unknown; cwd?: unknown });
    if (rec.type === 'user') return this.feedLink(rec as LinkRecord);
    if (rec.type === 'system') this.feedSystem(rec as SystemRecord);
    if (rec.type === 'ai-title' || rec.type === 'custom-title') this.feedTitle(rec as TitleRecord);
    if (rec.type !== 'assistant') return [];
    return this.feedAssistant(rec as AssistantRecord);
  }

  private noteStart(rec: { sessionId?: unknown; timestamp?: unknown; cwd?: unknown }): void {
    if (typeof rec.sessionId !== 'string') return;
    const state = this.session(rec.sessionId);
    if (typeof rec.cwd === 'string') {
      const name = rec.cwd.split(/[\\/]/).filter(Boolean).pop();
      if (name) state.cwdName = name;
    }
    if (typeof rec.timestamp !== 'string') return;
    const t = Date.parse(rec.timestamp);
    if (t < state.startTime) state.startTime = t;
  }

  private feedSystem(rec: SystemRecord): void {
    if (rec.subtype !== 'compact_boundary' || typeof rec.sessionId !== 'string') return;
    const m = rec.compactMetadata ?? {};
    this.pendingCompaction.set(rec.sessionId, {
      preTokens: m.preTokens ?? 0,
      postTokens: m.postTokens ?? 0,
      cumulativeDroppedTokens: m.cumulativeDroppedTokens ?? 0,
    });
  }

  /** Title records repeat many times per file; the last one wins. */
  private feedTitle(rec: TitleRecord): void {
    if (typeof rec.sessionId !== 'string') return;
    const state = this.session(rec.sessionId);
    if (typeof rec.customTitle === 'string') state.customTitle = rec.customTitle;
    if (typeof rec.aiTitle === 'string') state.aiTitle = rec.aiTitle;
  }

  private feedLink(rec: LinkRecord): RequestRow[] {
    const result = rec.toolUseResult;
    if (typeof result !== 'object' || result === null || Array.isArray(result)) return [];
    const agentId = (result as { agentId?: unknown }).agentId;
    if (typeof agentId !== 'string' || typeof rec.sourceToolAssistantUUID !== 'string') return [];
    const parent = this.spawnerByUuid.get(rec.sourceToolAssistantUUID);
    if (parent === undefined) return [];
    this.parentByAgent.set(agentId, parent);
    const content = rec.message?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<{ type?: string; tool_use_id?: string }>) {
        const label = block.type === 'tool_result' && block.tool_use_id ? this.labelByToolUse.get(block.tool_use_id) : undefined;
        if (label) this.fallbackLabelByAgent.set(agentId, label);
      }
    }
    return this.relabel(agentId);
  }

  /** Re-derive parent and label on every row of `agentId`. yagni: full scan per link, ~150 links over ~11k rows locally. */
  private relabel(agentId: string): RequestRow[] {
    const changed: RequestRow[] = [];
    for (const { row } of this.entries.values()) {
      if (row.agentId !== agentId) continue;
      const parentMessageId = this.parentByAgent.get(agentId) ?? null;
      const sourceLabel = this.labelFor(agentId);
      if (row.parentMessageId === parentMessageId && row.sourceLabel === sourceLabel) continue;
      row.parentMessageId = parentMessageId;
      row.sourceLabel = sourceLabel;
      changed.push(row);
    }
    return changed;
  }

  private labelFor(agentId: string | null): string {
    if (agentId === null) return 'main';
    return this.metaLabelByAgent.get(agentId) ?? this.fallbackLabelByAgent.get(agentId) ?? 'subagent';
  }

  private indexSpawner(rec: AssistantRecord): void {
    for (const block of rec.message.content ?? []) {
      if (block.type !== 'tool_use' || (block as AgentToolUse).name !== 'Agent') continue;
      const { id, input } = block as AgentToolUse;
      this.spawnerByUuid.set(rec.uuid, rec.message.id);
      this.labelByToolUse.set(id, `${input?.subagent_type ?? 'subagent'}: ${input?.description ?? ''}`);
    }
  }

  private feedAssistant(rec: AssistantRecord): RequestRow[] {
    const msg = rec.message;
    if (rec.requestId == null || msg?.model === '<synthetic>' || !msg?.usage) {
      this.skippedLines++;
      return [];
    }
    this.indexSpawner(rec);
    const final = msg.stop_reason != null;
    const existing = this.entries.get(msg.id);
    if (existing?.final && !final) return []; // partial line after the final one: superseded

    const u = msg.usage;
    const speed = u.speed ?? null;
    const usage = {
      input: u.input_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      output: u.output_tokens,
      speed,
    };
    const price = lookupPrice(this.prices, msg.model);
    const agentId = rec.agentId ?? null;
    let compaction = existing?.row.compaction ?? null;
    if (!compaction && agentId === null) {
      const pending = this.pendingCompaction.get(rec.sessionId);
      if (pending) {
        compaction = pending;
        this.pendingCompaction.delete(rec.sessionId);
      }
    }
    const flags: Flag[] = [];
    if (compaction) flags.push('compacted');
    if (!final) flags.push('aborted');
    if (!price) flags.push('unpriced');

    const row: RequestRow = {
      messageId: msg.id,
      requestId: rec.requestId,
      agentId,
      sessionId: rec.sessionId,
      parentMessageId: agentId === null ? null : this.parentByAgent.get(agentId) ?? null,
      timestamp: Date.parse(rec.timestamp),
      sourceType: agentId === null ? 'main' : 'subagent',
      sourceLabel: this.labelFor(agentId),
      model: this.intern(msg.model),
      speed,
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite5m: usage.cacheWrite5m,
      cacheWrite1h: usage.cacheWrite1h,
      output: usage.output,
      thinking: u.output_tokens_details?.thinking_tokens ?? 0,
      estimate: price ? estimate(usage, price) : 0,
      flags,
      compaction,
    };
    this.entries.set(msg.id, { row, final });
    return [row];
  }

  private intern(s: string): string {
    const seen = this.models.get(s);
    if (seen !== undefined) return seen;
    this.models.set(s, s);
    return s;
  }

  /** Every row, newest first. */
  rows(): RequestRow[] {
    return [...this.entries.values()].map((e) => e.row).sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Every session seen, newest first by last write; only the first is `newest`. */
  sessions(): Session[] {
    return [...this.sessionStates.entries()]
      .map(([sessionId, s]) => ({ sessionId, label: `${s.cwdName ?? s.project} · ${titleOf(s)}`, lastWrite: s.lastWrite, newest: false }))
      .sort((a, b) => b.lastWrite - a.lastWrite)
      .map((s, i) => (i === 0 ? { ...s, newest: true } : s));
  }
}

function titleOf(s: SessionState): string {
  if (s.customTitle) return s.customTitle;
  if (s.aiTitle) return s.aiTitle;
  return Number.isFinite(s.startTime) ? formatStartTime(s.startTime) : '';
}

/** Local time on the machine running cclive, e.g. "Sep 10, 2026, 9:00 AM". */
export function formatStartTime(t: number): string {
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
