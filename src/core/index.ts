import { LITELLM_URL, convertLiteLLM, formatPriceDate, layerPrices, shippedPrices } from './pricing.ts';
import { Reader } from './reader.ts';
import { RequestStore, formatStartTime } from './requests.ts';
import type { PriceTable, Snapshot } from './types.ts';

export type { Compaction, Flag, ModelPrice, PriceTable, RequestRow, Session, Snapshot } from './types.ts';
export { LITELLM_URL, Reader, RequestStore, convertLiteLLM, formatPriceDate, formatStartTime, layerPrices, shippedPrices };

export interface BuildOptions {
  roots: string[];
  prices: PriceTable;
  /** The price source label for the snapshot; defaults to the shipped-file label. */
  priceSource?: string;
  budget?: number | null;
  now?: Date;
}

/** Read every transcript in the history window under `roots` and return the priced snapshot. */
export async function buildSnapshot({ roots, prices, priceSource, budget = null, now = new Date() }: BuildOptions): Promise<Snapshot> {
  const reader = new Reader(roots, prices, priceSource);
  reader.budget = budget;
  await reader.readHistory(now);
  return reader.snapshot(now);
}
