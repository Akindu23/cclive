import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { get, type IncomingMessage } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Reader, convertLiteLLM, layerPrices, shippedPrices } from '../src/core/index.ts';
import { createServer, listen } from '../src/server.ts';
import { copyFixtureRoots } from './helpers.ts';

const NOW = new Date('2026-09-20T12:00:00Z');
const PAGE = readFileSync(new URL('../src/page.html', import.meta.url), 'utf8');
const CHART = '// chart bundle stub\n';
const GAMMA = 'gamma';

interface SseEvent { event: string; data: string }

async function openStream(url: string, signal: AbortSignal) {
  const res = await fetch(url, { signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/event-stream');
  const body = res.body;
  if (!body) throw new Error('no SSE body');
  const events: SseEvent[] = [];
  const waiters: Array<() => void> = [];
  let raw = '';
  (async () => {
    for await (const chunk of body) {
      raw += Buffer.from(chunk).toString('utf8');
      let end: number;
      while ((end = raw.indexOf('\n\n')) !== -1) {
        const block = raw.slice(0, end);
        raw = raw.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data !== undefined) events.push({ event, data });
        else events.push({ event: 'raw', data: block });
        waiters.splice(0).forEach((w) => w());
      }
    }
  })().catch(() => {});
  return {
    raw: () => raw,
    next(type: string, timeoutMs = 1000): Promise<SseEvent> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${type} event within ${timeoutMs} ms; saw ${JSON.stringify(events)}`)), timeoutMs);
        const check = () => {
          const hit = events.find((e) => e.event === type);
          if (!hit) return waiters.push(check);
          clearTimeout(timer);
          events.splice(events.indexOf(hit), 1);
          resolve(hit);
        };
        check();
      });
    },
  };
}

describe('local server', () => {
  const roots = copyFixtureRoots(NOW);
  const closers: Array<() => void> = [];
  afterAll(() => closers.forEach((c) => c()));

  async function start(rootDirs: string[], clock = () => NOW) {
    const reader = new Reader(rootDirs, shippedPrices());
    await reader.readHistory(NOW);
    const server = createServer(reader, PAGE, CHART, clock);
    const port = await listen(server, 0, true);
    closers.push(() => { server.closeAllConnections(); server.close(); });
    return { reader, server, base: `http://127.0.0.1:${port}` };
  }

  it('serves the snapshot JSON and the page, and nothing else', async () => {
    const { reader, base } = await start([roots.secondary]);
    const snapshot = reader.snapshot();

    const json = await fetch(`${base}/api/snapshot`);
    expect(json.headers.get('content-type')).toMatch(/application\/json/);
    expect(await json.json()).toEqual(JSON.parse(JSON.stringify(snapshot)));

    const page = await fetch(`${base}/`);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    const html = await page.text();
    expect(html).toBe(PAGE);
    expect(html).not.toMatch(/(src|href)=["']https?:/); // offline page: no external requests

    const chart = await fetch(`${base}/chart.js`);
    expect(chart.headers.get('content-type')).toMatch(/javascript/);
    expect(await chart.text()).toBe(CHART);

    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('pushes appended requests and new subagent files over SSE within a second', async () => {
    const { base } = await start([roots.secondary]);
    const ac = new AbortController();
    closers.push(() => ac.abort());
    await new Promise((r) => setTimeout(r, 300)); // FSEvents needs a moment after the watcher opens before it reports writes
    const stream = await openStream(`${base}/api/events`, ac.signal);
    const hello = await stream.next('hello');
    expect(hello.data).toMatch(/\S/);

    const main = join(roots.secondary, '-home-dev-project-gamma', `${GAMMA}.jsonl`);
    const line = (id: string, uuid: string, extra: object = {}, message: object = {}) => JSON.stringify({
      type: 'assistant', uuid, sessionId: GAMMA, isSidechain: false, timestamp: '2026-09-20T11:59:00.000Z', requestId: `req_${id}`,
      message: { id, model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 }, ...message }, ...extra,
    }) + '\n';

    appendFileSync(main, line('msg_live_1', 'as-live-1'));
    const rows = JSON.parse((await stream.next('rows')).data);
    expect(rows.map((r: { messageId: string }) => r.messageId)).toContain('msg_live_1');
    const snapshot = (await (await fetch(`${base}/api/snapshot`)).json()) as { rows: object[] };
    expect(snapshot.rows[0]).toMatchObject({ messageId: 'msg_live_1', estimate: 5 * 2e-6 + 5 * 10e-6 });

    // spawn + link in the main file, then the subagent file and meta
    appendFileSync(main, line('msg_live_spawn', 'as-live-2', {}, {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_live', name: 'Agent', input: { subagent_type: 'Explore', description: 'live scan' } }],
    }));
    appendFileSync(main, JSON.stringify({
      type: 'user', uuid: 'u-live-3', sessionId: GAMMA, timestamp: '2026-09-20T11:59:01.000Z', sourceToolAssistantUUID: 'as-live-2',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_live', content: 'launched' }] },
      toolUseResult: { status: 'async_launched', isAsync: true, agentId: 'eeeeeeeeeeeeeeee5', description: 'live scan' },
    }) + '\n');
    await stream.next('rows');
    const subDir = join(roots.secondary, '-home-dev-project-gamma', GAMMA, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-eeeeeeeeeeeeeeee5.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'live scan meta' }));
    writeFileSync(join(subDir, 'agent-eeeeeeeeeeeeeeee5.jsonl'), line('msg_live_sub', 'as-live-4', { isSidechain: true, agentId: 'eeeeeeeeeeeeeeee5' }));
    const sub = JSON.parse((await stream.next('rows')).data).find((r: { messageId: string }) => r.messageId === 'msg_live_sub');
    expect(sub).toMatchObject({ parentMessageId: 'msg_live_spawn', sourceType: 'subagent', sourceLabel: 'Explore: live scan meta' });
  });

  it('pushes the new unlogged figure when a session writes its cost-state record', async () => {
    const own = copyFixtureRoots(NOW); // own copy: the record appended here must not reach the sweep test's re-read of gamma
    const { reader, base } = await start([own.secondary]);
    const ac = new AbortController();
    closers.push(() => ac.abort());
    await new Promise((r) => setTimeout(r, 300));
    const stream = await openStream(`${base}/api/events`, ac.signal);
    await stream.next('hello');
    expect(reader.unlogged(NOW)).toBe(0);

    const main = join(own.secondary, '-home-dev-project-gamma', `${GAMMA}.jsonl`);
    appendFileSync(main, JSON.stringify({ type: 'cost-state', sessionId: GAMMA, startTime: 1788925671889, totalCostUSD: 1, modelUsage: {} }) + '\n');
    const unlogged = JSON.parse((await stream.next('unlogged')).data);
    expect(unlogged).toBeGreaterThan(0);
    expect(unlogged).toBeLessThan(1);
    expect(unlogged).toBe(reader.unlogged(NOW));
    const snapshot = (await (await fetch(`${base}/api/snapshot`)).json()) as { unlogged: number; monthToDate: number };
    expect(snapshot.unlogged).toBe(unlogged);
    expect(snapshot.monthToDate).toBeGreaterThan(unlogged);
  });

  it('re-pricing the reader and broadcasting pushes a snapshot event with the new label and estimates', async () => {
    const { reader, server, base } = await start([roots.secondary]);
    const ac = new AbortController();
    closers.push(() => ac.abort());
    const stream = await openStream(`${base}/api/events`, ac.signal);
    await stream.next('hello');
    expect(reader.snapshot().unpricedRows).toBe(1);

    const litellm = JSON.parse(readFileSync(new URL('./fixtures/litellm.json', import.meta.url), 'utf8'));
    reader.setPrices(layerPrices(shippedPrices(), convertLiteLLM(litellm, '2026-09-20T08:00:00Z')), 'Prices: LiteLLM, 20 Sep 2026');
    server.broadcastSnapshot();
    const snapshot = JSON.parse((await stream.next('snapshot')).data);
    expect(snapshot.priceSource).toBe('Prices: LiteLLM, 20 Sep 2026');
    expect(snapshot.unpricedRows).toBe(0);
    const nova = snapshot.rows.find((r: { messageId: string }) => r.messageId === 'msg_unpriced');
    expect(nova.flags).toEqual([]);
    expect(nova.estimate).toBeCloseTo(0.00012, 10); // 100×1 + 10×2 per million
    expect(snapshot).toEqual(JSON.parse(JSON.stringify(reader.snapshot())));
  });

  it('sweeps once at the first event after 00:00 UTC: rows outside the window go, stale tail state is released, a snapshot is pushed', async () => {
    let now = NOW;
    const { reader, base } = await start([roots.secondary], () => now);
    const ac = new AbortController();
    closers.push(() => ac.abort());
    await new Promise((r) => setTimeout(r, 300));
    const stream = await openStream(`${base}/api/events`, ac.signal);
    await stream.next('hello');
    const line = (id: string, ts: string) => JSON.stringify({
      type: 'assistant', uuid: id, sessionId: GAMMA, timestamp: ts, requestId: `req_${id}`,
      message: { id, model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } },
    }) + '\n';
    const ids = (rows: Array<{ messageId: string }>) => rows.map((r) => r.messageId);
    const main = join(roots.secondary, '-home-dev-project-gamma', `${GAMMA}.jsonl`);

    // clock into November: the window now starts 1 Oct, so September rows and tail state drop.
    // Writing gamma re-reads it from byte zero and its September rows return; untouched files stay gone.
    now = new Date('2026-11-01T00:00:05Z');
    appendFileSync(main, line('msg_nov', '2026-11-01T00:00:01.000Z'));
    const snapshot = JSON.parse((await stream.next('snapshot')).data);
    const swept = ids(snapshot.rows);
    expect(swept).toContain('msg_nov');
    expect(swept).toContain('msg_spawn_a');
    expect(swept).not.toContain('msg_fast_opus'); // beta
    expect(swept).not.toContain('msg_delta_before'); // delta
    expect(swept).not.toContain('msg_sub_a1'); // gamma subagent file
    expect(snapshot.monthToDate).toBeCloseTo(5 * 2e-6 + 5 * 10e-6, 12); // only the November row
    expect(snapshot).toEqual(JSON.parse(JSON.stringify(reader.snapshot(now))));
    expect(await (await fetch(`${base}/api/snapshot`)).json()).toEqual(snapshot);

    // same day again: no second sweep, plain rows batch
    appendFileSync(main, line('msg_nov_2', '2026-11-01T00:00:02.000Z'));
    expect(ids(JSON.parse((await stream.next('rows')).data))).toEqual(['msg_nov_2']);

    // beta's September tail state is gone, so a write re-reads it from byte zero and its ids count again
    const beta = join(roots.secondary, '-home-dev-project-beta', 'beta.jsonl');
    appendFileSync(beta, line('msg_nov_beta', '2026-11-01T00:00:03.000Z'));
    const reread = ids(JSON.parse((await stream.next('rows')).data));
    expect(reread).toContain('msg_nov_beta');
    expect(reread).toContain('msg_fast_opus');
  });

  it('arms no timer while idle with no page connected, and only the heartbeat with one', async () => {
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    await new Promise((r) => setTimeout(r, 400)); // let debounce and flush timers from earlier tests' writes expire
    const before = timers(); // ref'd timers only: node:http's own unref'd connections checker is not counted, and cannot keep the loop awake
    const { base } = await start([roots.secondary]);
    expect(timers()).toBe(before);
    const req = get(`${base}/api/events`, { agent: false });
    const res = await new Promise<IncomingMessage>((resolve) => req.on('response', resolve));
    await new Promise((r) => res.once('data', r)); // hello
    expect(timers()).toBe(before + 1);
    res.destroy();
    for (let i = 0; i < 50 && timers() !== before; i++) await new Promise((r) => setTimeout(r, 10)); // the server sees the close after the loopback teardown
    expect(timers()).toBe(before);
  });

  it('steps up from a busy port without --port and refuses one with it', async () => {
    const blocker = createNetServer();
    const busy = await listen(blocker, 0, true);
    closers.push(() => blocker.close());

    const stepped = createServer(new Reader([], shippedPrices()), PAGE, CHART);
    expect(await listen(stepped, busy, false)).toBe(busy + 1);
    closers.push(() => stepped.close());

    const strict = createServer(new Reader([], shippedPrices()), PAGE, CHART);
    await expect(listen(strict, busy, true)).rejects.toThrow(/EADDRINUSE/);
  });
});
