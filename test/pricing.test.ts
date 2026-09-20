import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSnapshot, convertLiteLLM, layerPrices, shippedPrices } from '../src/core/index.ts';
import { copyFixtureRoots } from './helpers.ts';

const NOW = new Date('2026-09-20T12:00:00Z');
const LITELLM = JSON.parse(readFileSync(new URL('./fixtures/litellm.json', import.meta.url), 'utf8'));

describe('LiteLLM conversion and price layering', () => {
  const roots = copyFixtureRoots(NOW);
  const converted = convertLiteLLM(LITELLM, '2026-09-20T08:00:00.000Z');
  const prices = layerPrices(shippedPrices(), converted);

  it('keeps only Anthropic-provider claude- keys, drops above-200k fields, rounds to cents and keeps the shipped Haiku 3.5 row', () => {
    expect(converted.version).toBe('2026-09-20');
    expect(Object.keys(converted.models).sort()).toEqual(['claude-fable-5-1', 'claude-nova-9', 'claude-opus-5', 'claude-sonnet-5']);
    // float noise 1.9999999999999998e-6 → 2.00; no 1h field → 2 × input; no fast multiplier → null
    expect(converted.models['claude-sonnet-5']).toEqual({ input: 2, output: 10, cache_read: 0.2, cache_write_5m: 2.5, cache_write_1h: 4, long_context: null, fast: null });
    // 1h from LiteLLM's field, fast block from the 2× multiplier
    expect(converted.models['claude-opus-5']).toEqual({
      input: 5, output: 25, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10, long_context: null,
      fast: { input: 10, output: 50, cache_read: 1, cache_write_5m: 12.5, cache_write_1h: 20 },
    });
    expect(converted.models['claude-fable-5-1']?.cache_read).toBe(0.25);
    expect(prices.models['claude-3-5-haiku-20241022']).toEqual(shippedPrices().models['claude-3-5-haiku-20241022']);
    expect(prices.version).toBe('2026-09-20');
  });

  it('prices a model the shipped file lacks once LiteLLM carries it, with the same estimates elsewhere', async () => {
    const snapshot = await buildSnapshot({ roots: [roots.secondary], prices, priceSource: 'Prices: LiteLLM, 20 Sep 2026', now: NOW });
    const rows = new Map(snapshot.rows.map((r) => [r.messageId, r]));
    expect(snapshot.priceSource).toBe('Prices: LiteLLM, 20 Sep 2026');
    expect(snapshot.unpricedRows).toBe(0);
    // claude-nova-9: 5×1 + 5×2 per million, no longer unpriced
    expect(rows.get('msg_unpriced')?.flags).toEqual([]);
    expect(rows.get('msg_unpriced')?.estimate).toBeGreaterThan(0);
    expect(rows.get('msg_fast_opus')?.estimate).toBeCloseTo(0.02325, 10);
  });

  it('a --pricing file replaces a model entry whole, its version and source win when present, other models fall through', async () => {
    const user = { version: 'mine-2026-09-20', models: { 'claude-opus-5': { input: 1, output: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 } } };
    const table = layerPrices(prices, user);
    expect(table.version).toBe('mine-2026-09-20');
    expect(table.source).toBe(prices.source);
    expect(table.models['claude-opus-5']).toEqual(user.models['claude-opus-5']); // no fast block survives from below
    expect(table.models['claude-sonnet-5']).toEqual(prices.models['claude-sonnet-5']);
    const snapshot = await buildSnapshot({ roots: [roots.secondary], prices: table, now: NOW });
    const rows = new Map(snapshot.rows.map((r) => [r.messageId, r]));
    expect(rows.get('msg_fast_opus')?.estimate).toBeCloseTo(0.0011, 10); // 1000×1 + 100×1, fast speed with no fast block
    expect(rows.get('msg_dated_opus')?.estimate).toBeCloseTo(0.00011, 10); // date suffix stripped onto the user entry
  });
});
