import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, writeJsonAtomic } from './config.ts';
import { LITELLM_URL, convertLiteLLM, formatPriceDate, layerPrices, shippedPrices, type PriceTable } from './core/index.ts';

const TIMEOUT_MS = 5000;
const MAX_BYTES = 10 * 1024 * 1024;

export interface PriceSource {
  table: PriceTable;
  label: string;
}

export interface PriceSetup {
  local: PriceSource;
  /** Resolves once the LiteLLM download settles, never rejects. `null` when offline. */
  refresh: Promise<PriceSource> | null;
}

export interface PriceOptions {
  offline: boolean;
  pricingFile?: string;
  url?: string;
  dir?: string;
  now?: Date;
}

/** The last good download: the converted table with the response ETag and the fetch time. */
interface PriceCache {
  etag: string | null;
  fetched_at: string;
  table: PriceTable;
}

type UserTable = Parameters<typeof layerPrices>[1];

/** `--pricing` over LiteLLM (fresh, else cache) over the shipped file. Download starts here so it overlaps the parse. */
export function setupPrices({ offline, pricingFile, url = LITELLM_URL, dir = configDir(), now = new Date() }: PriceOptions): PriceSetup {
  const user = pricingFile ? readUserTable(pricingFile) : null;
  const cachePath = join(dir, 'prices.json');
  const cache = readCache(cachePath);
  const finish = (litellm: PriceTable | null, label: string): PriceSource => {
    let table = litellm ? layerPrices(shippedPrices(), litellm) : shippedPrices();
    if (user) table = layerPrices(table, user);
    return { table, label };
  };
  const fromCache = (suffix: string) =>
    cache ? finish(cache.table, `Prices: cached LiteLLM, ${formatPriceDate(cache.fetched_at)}${suffix}`) : finish(null, `Prices: shipped file, ${formatPriceDate(shippedPrices().version)}${suffix}`);

  if (offline) return { local: fromCache(' (offline)'), refresh: null };
  const refresh = download(url, cache?.etag ?? null).then(
    (res) => {
      if (res === null) return fromCache('');
      const fetchedAt = now.toISOString();
      const table = convertLiteLLM(res.body, fetchedAt);
      try {
        writeJsonAtomic(cachePath, { etag: res.etag, fetched_at: fetchedAt, table } satisfies PriceCache);
      } catch {
        // a read-only config directory still gets fresh prices for this run
      }
      return finish(table, `Prices: LiteLLM, ${formatPriceDate(fetchedAt)}`);
    },
    () => fromCache(' (download failed)'),
  );
  return { local: fromCache(''), refresh };
}

/** `null` on a 304. Rejects on any other non-200 status, a body over the cap, or the 5 s timeout. */
async function download(url: string, etag: string | null): Promise<{ body: Record<string, unknown>; etag: string | null } | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: etag ? { 'if-none-match': etag } : {} });
  if (res.status === 304) {
    await res.body?.cancel();
    return null;
  }
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('response over 10 MB');
  if (!res.body) throw new Error('empty body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) throw new Error('response over 10 MB');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof body !== 'object' || body === null) throw new Error('not a JSON object');
  return { body, etag: res.headers.get('etag') };
}

function readCache(path: string): PriceCache | null {
  try {
    const c = JSON.parse(readFileSync(path, 'utf8'));
    return typeof c?.fetched_at === 'string' && typeof c?.table?.models === 'object' ? c : null;
  } catch {
    return null;
  }
}

function readUserTable(path: string): UserTable {
  let t: unknown;
  try {
    t = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`--pricing ${path}: ${(err as Error).message}`);
  }
  const models = (t as { models?: unknown })?.models;
  if (typeof models !== 'object' || models === null || Array.isArray(models)) throw new Error(`--pricing ${path}: expected {"models": {"<model id>": {...}}}`);
  return t as UserTable;
}
