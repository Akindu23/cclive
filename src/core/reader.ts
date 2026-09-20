import { join } from 'node:path';
import { formatPriceDate } from './pricing.ts';
import { RequestStore } from './requests.ts';
import { Tailer } from './tail.ts';
import { historyWindowStart, listTranscripts, readSubagentMeta, transcriptIds } from './transcripts.ts';
import type { PriceTable, RequestRow, Snapshot } from './types.ts';

export class Reader {
  readonly store: RequestStore;
  budget: number | null = null;
  private readonly tailer = new Tailer();

  constructor(readonly roots: string[], prices: PriceTable, private priceSource = `Prices: shipped file, ${formatPriceDate(prices.version)}`) {
    this.store = new RequestStore(prices);
  }

  setPrices(prices: PriceTable, priceSource: string): void {
    this.store.reprice(prices);
    this.priceSource = priceSource;
  }

  async readHistory(now = new Date()): Promise<number> {
    const files = await listTranscripts(this.roots, historyWindowStart(now));
    for (const { root, rel } of files) await this.reconcile(root, rel);
    return files.length;
  }

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

  unlogged(now = new Date()): number {
    return this.store.unlogged(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  sweep(now: Date): void {
    const since = historyWindowStart(now);
    this.store.sweep(since);
    this.tailer.forget(since);
  }

  snapshot(now = new Date()): Snapshot {
    const rows = this.store.rows();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const unlogged = this.store.unlogged(monthStart);
    return {
      rows,
      sessions: this.store.sessions(),
      priceSource: this.priceSource,
      monthToDate: rows.reduce((sum, r) => (r.timestamp >= monthStart ? sum + r.estimate : sum), unlogged),
      unlogged,
      budget: this.budget,
      skippedLines: this.store.skippedLines,
      unpricedRows: rows.filter((r) => r.flags.includes('unpriced')).length,
    };
  }
}
