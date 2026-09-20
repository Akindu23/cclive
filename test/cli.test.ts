import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { copyFixtureRoots, touchAll } from './helpers.ts';
import { buildSnapshot, shippedPrices } from '../src/core/index.ts';

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const LITELLM = readFileSync(new URL('./fixtures/litellm.json', import.meta.url), 'utf8');

/** Every run is offline with a throwaway config dir unless a test says otherwise, so no test touches the network or the real cache. */
function env(home?: string, extra: NodeJS.ProcessEnv = {}) {
  return { ...process.env, HOME: home ?? process.env.HOME, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'cclive-cfg-')), CCLIVE_OFFLINE: '1', ...extra };
}

function run(args: string[], home?: string, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: env(home, extra) });
}

/** Like `run`, without blocking the event loop, so an in-process stub server can answer the child. */
function runAsync(args: string[], home: string, extra: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: env(home, extra) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

/** A HOME whose two transcript roots hold the fixture's secondary tree. */
function fixtureHome() {
  const now = new Date();
  const fixture = copyFixtureRoots(now);
  const home = join(fixture.dir, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  cpSync(fixture.secondary, join(home, '.claude', 'projects'), { recursive: true });
  touchAll(home, now);
  return home;
}

/** Serve the LiteLLM fixture, or hang forever, and count requests. */
function stub(hang = false) {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    if (!hang) res.writeHead(200, { etag: '"e1"' }).end(LITELLM);
  });
  return new Promise<{ url: string; hits: () => number; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/p.json`, hits: () => hits, close: () => { server.closeAllConnections(); server.close(); } });
    });
  });
}

describe('cclive CLI (built bundle)', () => {
  const closers: Array<() => void> = [];
  afterAll(() => closers.forEach((c) => c()));

  it('--json prints the same snapshot core builds for both transcript roots under HOME', async () => {
    const now = new Date();
    const fixture = copyFixtureRoots(now);
    const home = join(fixture.dir, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.config', 'claude'), { recursive: true });
    cpSync(fixture.primary, join(home, '.claude', 'projects'), { recursive: true });
    cpSync(fixture.secondary, join(home, '.config', 'claude', 'projects'), { recursive: true });
    touchAll(home, now);

    const result = run(['--json'], home);
    expect(result.status).toBe(0);
    const printed = JSON.parse(result.stdout);
    const expected = await buildSnapshot({
      roots: [join(home, '.claude', 'projects'), join(home, '.config', 'claude', 'projects')],
      prices: shippedPrices(),
      priceSource: 'Prices: shipped file, 19 Sep 2026 (offline)',
      now,
    });
    expect(printed).toEqual(expected);
    expect(printed.rows.some((r: { messageId: string }) => r.messageId === 'msg_fast_opus')).toBe(true);
  });

  it('--no-open --port 0 prints the URL, serves the page from the bundle and the snapshot --json prints', async () => {
    const now = new Date();
    const fixture = copyFixtureRoots(now);
    const home = join(fixture.dir, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    cpSync(fixture.secondary, join(home, '.claude', 'projects'), { recursive: true });
    touchAll(home, now);

    const child = spawn(process.execPath, [CLI, '--no-open', '--port', '0'], { env: env(home) });
    try {
      let out = '';
      const url = await new Promise<string>((resolve, reject) => {
        child.stdout.on('data', (d) => {
          out += d;
          const url = /^(http:\/\/127\.0\.0\.1:\d+)$/m.exec(out)?.[1];
          if (url) resolve(url);
        });
        child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)));
      });
      expect(out).toContain('Reading transcripts');
      const page = await (await fetch(`${url}/`)).text();
      expect(page).toContain('<title>cclive</title>');
      expect(page).toContain("fetch('/api/snapshot')");
      const chart = await fetch(`${url}/chart.js`);
      expect(chart.headers.get('content-type')).toMatch(/javascript/);
      expect(await chart.text()).toContain('Chart'); // the tree-shaken Chart.js bundle, inlined at build time
      const served = await (await fetch(`${url}/api/snapshot`)).json();
      expect(served).toEqual(JSON.parse(run(['--json'], home).stdout));
    } finally {
      child.kill();
    }
  });

  it('--port on a busy port exits non-zero with a message', async () => {
    const blocker = spawn(process.execPath, [CLI, '--no-open', '--port', '0'], { env: env('/nonexistent') });
    try {
      const port = await new Promise<string>((resolve) => {
        let out = '';
        blocker.stdout.on('data', (d) => {
          out += d;
          const port = /127\.0\.0\.1:(\d+)$/m.exec(out)?.[1];
          if (port) resolve(port);
        });
      });
      const busy = run(['--no-open', '--port', port], '/nonexistent');
      expect(busy.status).toBe(1);
      expect(busy.stderr).toContain(`127.0.0.1:${port}`);
    } finally {
      blocker.kill();
    }
  });

  it('--json online prints LiteLLM-priced rows, writes the cache, and --offline / CCLIVE_OFFLINE=1 make no request', async () => {
    const s = await stub();
    closers.push(s.close);
    const home = fixtureHome();
    const online = { CCLIVE_OFFLINE: '', CCLIVE_LITELLM_URL: s.url };

    const cfg = mkdtempSync(join(tmpdir(), 'cclive-cfg-'));
    const printed = JSON.parse((await runAsync(['--json'], home, { ...online, XDG_CONFIG_HOME: cfg })).stdout);
    expect(printed.priceSource).toMatch(/^Prices: LiteLLM, \d{1,2} \w{3} \d{4}$/);
    expect(printed.unpricedRows).toBe(0);
    expect(printed.rows.find((r: { messageId: string }) => r.messageId === 'msg_unpriced').flags).toEqual([]);
    expect(s.hits()).toBe(1);
    expect(existsSync(join(cfg, 'cclive', 'prices.json'))).toBe(true);

    const flag = JSON.parse(run(['--json', '--offline'], home, online).stdout);
    expect(flag.priceSource).toBe('Prices: shipped file, 19 Sep 2026 (offline)');
    const envVar = JSON.parse(run(['--json'], home, { ...online, CCLIVE_OFFLINE: '1' }).stdout);
    expect(envVar.priceSource).toBe('Prices: shipped file, 19 Sep 2026 (offline)');
    expect(s.hits()).toBe(1);

    // the cache from the first run prices an offline run, with the offline suffix
    const cached = JSON.parse(run(['--json', '--offline'], home, { ...online, XDG_CONFIG_HOME: cfg }).stdout);
    expect(cached.priceSource).toMatch(/^Prices: cached LiteLLM, \d{1,2} \w{3} \d{4} \(offline\)$/);
    expect(cached.unpricedRows).toBe(0);
  });

  it('--json returns within the 5 s cap when the download hangs, labelled "(download failed)"', async () => {
    const s = await stub(true);
    closers.push(s.close);
    const started = Date.now();
    const result = await runAsync(['--json'], fixtureHome(), { CCLIVE_OFFLINE: '', CCLIVE_LITELLM_URL: s.url });
    expect(Date.now() - started).toBeLessThan(7000);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).priceSource).toBe('Prices: shipped file, 19 Sep 2026 (download failed)');
  }, 10_000);

  it('--pricing overrides a model by id and rejects a file that is not a price table', () => {
    const home = fixtureHome();
    const file = join(mkdtempSync(join(tmpdir(), 'cclive-user-')), 'mine.json');
    writeFileSync(file, JSON.stringify({ models: { 'claude-nova-9': { input: 1, output: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 } } }));
    const printed = JSON.parse(run(['--json', '--pricing', file], home).stdout);
    const nova = printed.rows.find((r: { messageId: string }) => r.messageId === 'msg_unpriced');
    expect(nova.flags).toEqual([]);
    expect(nova.estimate).toBeCloseTo(0.00011, 10); // 100×1 + 10×1 per million
    expect(printed.priceSource).toBe('Prices: shipped file, 19 Sep 2026 (offline)');

    writeFileSync(file, '{"nope": true}');
    const bad = run(['--json', '--pricing', file], home);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('--pricing');
    expect(run(['--json', '--pricing', '/nonexistent/prices.json'], home).status).toBe(2);
  });

  it('--budget writes config.json, later runs carry it in the snapshot, --budget 0 clears it, a negative value exits 2', () => {
    const home = fixtureHome();
    const cfg = mkdtempSync(join(tmpdir(), 'cclive-cfg-'));
    const config = join(cfg, 'cclive', 'config.json');

    const set = run(['--json', '--budget', '1500'], home, { XDG_CONFIG_HOME: cfg });
    expect(set.status).toBe(0);
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ budget: 1500 });
    expect(JSON.parse(set.stdout).budget).toBe(1500);

    const later = JSON.parse(run(['--json'], home, { XDG_CONFIG_HOME: cfg }).stdout);
    expect(later.budget).toBe(1500);
    expect(typeof later.monthToDate).toBe('number');

    const cleared = run(['--json', '--budget', '0'], home, { XDG_CONFIG_HOME: cfg });
    expect(cleared.status).toBe(0);
    expect(JSON.parse(cleared.stdout).budget).toBeNull();
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({});
    expect(JSON.parse(run(['--json'], home, { XDG_CONFIG_HOME: cfg }).stdout).budget).toBeNull();

    const bad = run(['--json', '--budget', '-5'], home);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('--budget');
    expect(run(['--json', '--budget', 'lots'], home).status).toBe(2);
  });

  it('--help and --version exit 0; an unknown flag exits non-zero', () => {
    expect(run(['--help']).status).toBe(0);
    expect(run(['--help']).stdout).toContain('--json');
    expect(run(['--help']).stdout).toContain('--no-open');
    expect(run(['--help']).stdout).toContain('--offline');
    expect(run(['--help']).stdout).toContain('--pricing <file>');
    expect(run(['--help']).stdout).toContain('--budget <usd>');
    expect(run(['--port', 'abc']).status).toBe(2);
    const version = run(['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const bad = run(['--bogus']);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('bogus');
  });
});
