import { LITELLM_URL, convertLiteLLM, formatPriceDate, layerPrices, shippedPrices } from './pricing.ts';
import { Reader } from './reader.ts';
import { RequestStore, formatStartTime } from './requests.ts';
import type { PriceTable, Snapshot } from './types.ts';

export type { Compaction, Flag, ModelPrice, PriceTable, RequestRow, Session, Snapshot } from './types.ts';
export { LITELLM_URL, Reader, RequestStore, convertLiteLLM, formatPriceDate, formatStartTime, layerPrices, shippedPrices };

export interface BuildOptions {
  roots: string[];
  prices: PriceTable;
  priceSource?: string;
  budget?: number | null;
  now?: Date;
}

export async function buildSnapshot({ roots, prices, priceSource, budget = null, now = new Date() }: BuildOptions): Promise<Snapshot> {
  const reader = new Reader(roots, prices, priceSource);
  reader.budget = budget;
  await reader.readHistory(now);
  return reader.snapshot(now);
}
