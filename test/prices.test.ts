import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configDir } from '../src/config.ts';
import { setupPrices } from '../src/prices.ts';
import { shippedPrices } from '../src/core/index.ts';

const NOW = new Date('2026-09-20T12:00:00Z');
const LITELLM = readFileSync(new URL('./fixtures/litellm.json', import.meta.url), 'utf8');
const ETAG = '"litellm-v1"';

/** A stand-in for GitHub raw: serves the fixture with an ETag, answers 304 to a matching If-None-Match, records every request. */
function stub(mode: 'ok' | 'fail' | 'huge' = 'ok') {
  const seen: IncomingMessage[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(req);
    if (mode === 'fail') return void res.writeHead(500).end();
    if (mode === 'huge') return void res.writeHead(200, { 'content-length': String(20 * 1024 * 1024), etag: ETAG }).write('{');
    if (req.headers['if-none-match'] === ETAG) return void res.writeHead(304, { etag: ETAG }).end();
    res.writeHead(200, { 'content-type': 'application/json', etag: ETAG }).end(LITELLM);
  });
  return new Promise<{ url: string; seen: IncomingMessage[]; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/prices.json`, seen, close: () => { server.closeAllConnections(); server.close(); } });
    });
  });
}

describe('price refresh, disk cache, --offline and --pricing', () => {
  const closers: Array<() => void> = [];
  afterAll(() => closers.forEach((c) => c()));
  const tmp = () => mkdtempSync(join(tmpdir(), 'cclive-prices-'));

  it('downloads once, writes prices.json with the table, etag and fetched_at, then a second run sends If-None-Match and a 304 keeps the file', async () => {
    const s = await stub();
    closers.push(s.close);
    const dir = tmp();

    const first = setupPrices({ offline: false, url: s.url, dir, now: NOW });
    expect(first.local.label).toBe('Prices: shipped file, 19 Sep 2026');
    expect(first.local.table.models['claude-nova-9']).toBeUndefined();
    const refreshed = await first.refresh!;
    expect(refreshed.label).toBe('Prices: LiteLLM, 20 Sep 2026');
    expect(refreshed.table.models['claude-nova-9']?.input).toBe(1);
    expect(refreshed.table.models['claude-3-5-haiku-20241022']).toEqual(shippedPrices().models['claude-3-5-haiku-20241022']);
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]?.headers['if-none-match']).toBeUndefined();

    const cachePath = join(dir, 'prices.json');
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(cached.etag).toBe(ETAG);
    expect(cached.fetched_at).toBe(NOW.toISOString());
    expect(cached.table.models['claude-nova-9']?.input).toBe(1);
    expect(existsSync(`${cachePath}.tmp`)).toBe(false);
    const bytes = readFileSync(cachePath);

    const second = setupPrices({ offline: false, url: s.url, dir, now: new Date('2026-09-21T12:00:00Z') });
    expect(second.local.label).toBe('Prices: cached LiteLLM, 20 Sep 2026');
    expect(second.local.table.models['claude-nova-9']?.input).toBe(1);
    expect((await second.refresh!).label).toBe('Prices: cached LiteLLM, 20 Sep 2026');
    expect(s.seen).toHaveLength(2);
    expect(s.seen[1]?.headers['if-none-match']).toBe(ETAG);
    expect(readFileSync(cachePath).equals(bytes)).toBe(true);
  });

  it('--offline makes no request and labels the source "(offline)", from the cache when present and the shipped file otherwise', async () => {
    const s = await stub();
    closers.push(s.close);
    const empty = setupPrices({ offline: true, url: s.url, dir: tmp(), now: NOW });
    expect(empty.refresh).toBeNull();
    expect(empty.local.label).toBe('Prices: shipped file, 19 Sep 2026 (offline)');

    const dir = tmp();
    await setupPrices({ offline: false, url: s.url, dir, now: NOW }).refresh;
    const cached = setupPrices({ offline: true, url: s.url, dir, now: new Date('2026-09-22T00:00:00Z') });
    expect(cached.refresh).toBeNull();
    expect(cached.local.label).toBe('Prices: cached LiteLLM, 20 Sep 2026 (offline)');
    expect(cached.local.table.models['claude-nova-9']?.input).toBe(1);
    expect(s.seen).toHaveLength(1);
  });

  it('a failed download keeps the cache or the shipped file and appends "(download failed)"; an oversized body counts as failed', async () => {
    const ok = await stub();
    const failing = await stub('fail');
    const huge = await stub('huge');
    closers.push(ok.close, failing.close, huge.close);

    const dir = tmp();
    await setupPrices({ offline: false, url: ok.url, dir, now: NOW }).refresh;
    const fromCache = await setupPrices({ offline: false, url: failing.url, dir, now: NOW }).refresh!;
    expect(fromCache.label).toBe('Prices: cached LiteLLM, 20 Sep 2026 (download failed)');
    expect(fromCache.table.models['claude-nova-9']?.input).toBe(1);

    const noCache = await setupPrices({ offline: false, url: failing.url, dir: tmp(), now: NOW }).refresh!;
    expect(noCache.label).toBe('Prices: shipped file, 19 Sep 2026 (download failed)');
    expect(noCache.table).toEqual(shippedPrices());

    const capped = await setupPrices({ offline: false, url: huge.url, dir: tmp(), now: NOW }).refresh!;
    expect(capped.label).toBe('Prices: shipped file, 19 Sep 2026 (download failed)');
  });

  it('--pricing wins by model id over LiteLLM and the shipped file, before and after the download, and its version wins', async () => {
    const s = await stub();
    closers.push(s.close);
    const dir = tmp();
    const file = join(dir, 'mine.json');
    writeFileSync(file, JSON.stringify({ version: 'mine', models: { 'claude-nova-9': { input: 7, output: 7, cache_read: 7, cache_write_5m: 7, cache_write_1h: 7 } } }));
    const setup = setupPrices({ offline: false, pricingFile: file, url: s.url, dir, now: NOW });
    expect(setup.local.table.models['claude-nova-9']?.input).toBe(7);
    expect(setup.local.table.models['claude-opus-5']).toEqual(shippedPrices().models['claude-opus-5']);
    expect(setup.local.table.version).toBe('mine');
    const refreshed = await setup.refresh!;
    expect(refreshed.table.models['claude-nova-9']?.input).toBe(7);
    expect(refreshed.table.models['claude-sonnet-5']?.cache_write_1h).toBe(4); // 2 × input, since the fixture has no 1h field; the shipped table also says 4, so `version` below proves the source
    expect(refreshed.table.version).toBe('mine');
    expect(refreshed.label).toBe('Prices: LiteLLM, 20 Sep 2026');
  });

  it('configDir is $XDG_CONFIG_HOME/cclive, else %APPDATA%\\cclive on Windows, else ~/.config/cclive', () => {
    expect(configDir({ XDG_CONFIG_HOME: '/x' }, '/home/u', 'linux')).toBe('/x/cclive');
    expect(configDir({}, '/home/u', 'linux')).toBe('/home/u/.config/cclive');
    expect(configDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u', 'win32')).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'cclive'));
    expect(configDir({}, '/home/u', 'win32')).toBe(join('/home/u', '.config', 'cclive'));
  });
});
