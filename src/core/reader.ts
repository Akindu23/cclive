import { join } from 'node:path';
import { formatPriceDate } from './pricing.ts';
import { RequestStore } from './requests.ts';
import { Tailer } from './tail.ts';
import { historyWindowStart, listTranscripts, readSubagentMeta, transcriptIds } from './transcripts.ts';
import type { PriceTable, RequestRow, Snapshot } from './types.ts';

/** The transcript roots read into one request store, incrementally: read the history once, then reconcile files as they change. */
export class Reader {
  readonly store: RequestStore;
  /** The monthly cap from the config file; rides in the snapshot untouched. */
  budget: number | null = null;
  private readonly tailer = new Tailer();

  constructor(readonly roots: string[], prices: PriceTable, private priceSource = `Prices: shipped file, ${formatPriceDate(prices.version)}`) {
    this.store = new RequestStore(prices);
  }

  /** Re-price every row from `prices` and relabel the source. */
  setPrices(prices: PriceTable, priceSource: string): void {
    this.store.reprice(prices);
    this.priceSource = priceSource;
  }

  /** Read every transcript in the history window. Returns how many files were read. */
  async readHistory(now = new Date()): Promise<number> {
    const files = await listTranscripts(this.roots, historyWindowStart(now));
    for (const { root, rel } of files) await this.reconcile(root, rel);
    return files.length;
  }

  /** Read whatever `rel` under `root` has appended since last time. Returns the rows created or changed. */
  async reconcile(root: string, rel: string): Promise<RequestRow[]> {
    const path = join(root, rel);
    const changed = new Map<string, RequestRow>();
    const note = (rows: RequestRow[]) => rows.forEach((r) => changed.set(r.messageId, r));
    const meta = await readSubagentMeta(path);
    if (meta) note(this.store.labelAgent(meta.agentId, meta.label));
    const s = await this.tailer.reconcile(path, (line) => note(this.store.feed(line)));
    if (s) {
      const { project, sessionId } = transcriptIds(rel);
      this.store.touchSession(sessionId, project, s.mtimeMs);
    }
    return [...changed.values()];
  }

  /** The history sweep: forget rows, dedup ids and tail state that fell out of the history window as of `now`. */
  sweep(now: Date): void {
    const since = historyWindowStart(now);
    this.store.sweep(since);
    this.tailer.forget(since);
  }

  snapshot(now = new Date()): Snapshot {
    const rows = this.store.rows();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    return {
      rows,
      sessions: this.store.sessions(),
      priceSource: this.priceSource,
      monthToDate: rows.reduce((sum, r) => (r.timestamp >= monthStart ? sum + r.estimate : sum), 0),
      budget: this.budget,
      skippedLines: this.store.skippedLines,
      unpricedRows: rows.filter((r) => r.flags.includes('unpriced')).length,
    };
  }
}
