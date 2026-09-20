import shipped from '../../pricing.json' with { type: 'json' };
import type { ModelPrice, PriceTable, RequestRow } from './types.ts';

export const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export function shippedPrices(): PriceTable {
  return shipped as PriceTable;
}

/** A partial table laid over `base`: a model in `over` replaces that entry whole; its `version` and `source` win when present. */
export function layerPrices(base: PriceTable, over: Partial<Pick<PriceTable, 'version' | 'source'>> & Pick<PriceTable, 'models'>): PriceTable {
  return { version: over.version ?? base.version, source: over.source ?? base.source, models: { ...base.models, ...over.models } };
}

interface LiteLLMEntry {
  litellm_provider?: unknown;
  input_cost_per_token?: unknown;
  output_cost_per_token?: unknown;
  cache_read_input_token_cost?: unknown;
  cache_creation_input_token_cost?: unknown;
  cache_creation_input_token_cost_above_1hr?: unknown;
  provider_specific_entry?: { fast?: unknown };
}

/** USD per token → USD per million, rounded to cents to absorb float noise like 0.19999999999999998. */
const perMillion = (perToken: unknown): number => (typeof perToken === 'number' ? Math.round(perToken * 1e8) / 100 : 0);

/** LiteLLM reduced to Anthropic `claude-` entries: ignore `*_above_200k_tokens`; 1h cache write falls back to 2× input; `fast` from the provider multiplier. */
export function convertLiteLLM(raw: Record<string, unknown>, fetchedAt: string): PriceTable {
  const models: Record<string, ModelPrice> = {};
  for (const [id, value] of Object.entries(raw)) {
    const e = value as LiteLLMEntry;
    if (!id.startsWith('claude-') || e.litellm_provider !== 'anthropic') continue;
    if (typeof e.input_cost_per_token !== 'number' || typeof e.output_cost_per_token !== 'number') continue;
    const input = perMillion(e.input_cost_per_token);
    const base = {
      input,
      output: perMillion(e.output_cost_per_token),
      cache_read: perMillion(e.cache_read_input_token_cost),
      cache_write_5m: perMillion(e.cache_creation_input_token_cost),
      cache_write_1h: typeof e.cache_creation_input_token_cost_above_1hr === 'number' ? perMillion(e.cache_creation_input_token_cost_above_1hr) : Math.round(input * 200) / 100,
    };
    const fast = e.provider_specific_entry?.fast;
    const scale = typeof fast === 'number' ? (v: number) => Math.round(v * fast * 100) / 100 : null;
    models[id] = {
      ...base,
      long_context: null,
      fast: scale ? { input: scale(base.input), output: scale(base.output), cache_read: scale(base.cache_read), cache_write_5m: scale(base.cache_write_5m), cache_write_1h: scale(base.cache_write_1h) } : null,
    };
  }
  return { version: fetchedAt.slice(0, 10), source: LITELLM_URL, models };
}

/** Exact id, else the id with a trailing -YYYYMMDD stripped, else undefined. */
export function lookupPrice(table: PriceTable, model: string): ModelPrice | undefined {
  return table.models[model] ?? table.models[model.replace(/-\d{8}$/, '')];
}

type Usage = Pick<RequestRow, 'input' | 'output' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h' | 'speed'>;

/** Output already includes thinking tokens. */
export function estimate(usage: Usage, price: ModelPrice): number {
  const p = usage.speed === 'fast' && price.fast ? price.fast : price;
  return (
    (usage.input * p.input +
      usage.output * p.output +
      usage.cacheRead * p.cache_read +
      usage.cacheWrite5m * p.cache_write_5m +
      usage.cacheWrite1h * p.cache_write_1h) /
    1e6
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatPriceDate(isoDate: string): string {
  const d = new Date(isoDate);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
