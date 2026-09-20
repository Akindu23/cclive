import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RequestStore, buildSnapshot, formatStartTime, shippedPrices } from '../src/core/index.ts';
import { FIXTURE_ROOTS, copyFixtureRoots, touchAll } from './helpers.ts';

const NOW = new Date('2026-09-20T12:00:00Z');

describe('snapshot from the synthetic fixture', () => {
  const roots = copyFixtureRoots(NOW);

  it('prices one row per request with the right flags and counts', async () => {
    const snapshot = await buildSnapshot({ roots: [roots.secondary], prices: shippedPrices(), now: NOW });
    const rows = new Map(snapshot.rows.map((r) => [r.messageId, r]));

    expect(snapshot.priceSource).toBe('Prices: shipped file, 19 Sep 2026');
    expect(snapshot.skippedLines).toBe(3); // malformed line, unknown record type, synthetic error line
    expect(snapshot.unpricedRows).toBe(1);
    expect(snapshot.rows[0]?.messageId).toBe('msg_cache_writes');

    // fast block: 1000×10 + 100×50 + 2000×1.0 + 500×12.5 per million
    expect(rows.get('msg_fast_opus')?.estimate).toBeCloseTo(0.02325, 10);
    expect(rows.get('msg_fast_opus')?.speed).toBe('fast');
    expect(rows.get('msg_fast_opus')?.thinking).toBe(20);

    // trailing -YYYYMMDD stripped to claude-opus-5: 100×5 + 10×25
    expect(rows.get('msg_dated_opus')?.estimate).toBeCloseTo(0.00075, 10);
    expect(rows.get('msg_dated_opus')?.flags).toEqual([]);

    expect(rows.get('msg_unpriced')?.estimate).toBe(0);
    expect(rows.get('msg_unpriced')?.flags).toEqual(['unpriced']);

    // final line wins over the partial: 10×1 + 50×5
    expect(rows.get('msg_two_lines')?.output).toBe(50);
    expect(rows.get('msg_two_lines')?.thinking).toBe(30);
    expect(rows.get('msg_two_lines')?.estimate).toBeCloseTo(0.00026, 10);
    expect(rows.get('msg_two_lines')?.flags).toEqual([]);

    // no final line: last partial usage, aborted. Fable 5.1 cache read at 0.25: 20×10 + 7×50 + 1000×0.25
    expect(rows.get('msg_aborted')?.output).toBe(7);
    expect(rows.get('msg_aborted')?.estimate).toBeCloseTo(0.0008, 10);
    expect(rows.get('msg_aborted')?.flags).toEqual(['aborted']);

    // 5m and 1h writes priced apart: 100×10 + 10×50 + 200×12.5 + 300×20
    expect(rows.get('msg_cache_writes')?.estimate).toBeCloseTo(0.01, 10);
    expect(rows.get('msg_cache_writes')?.cacheWrite5m).toBe(200);
    expect(rows.get('msg_cache_writes')?.cacheWrite1h).toBe(300);

    expect(rows.has('0f0f0f0f-0000-4000-8000-000000000000')).toBe(false);
    expect(snapshot.rows.filter((r) => r.sessionId === 'beta')).toHaveLength(6);

    expect(rows.get('msg_fast_opus')).toMatchObject({
      requestId: 'req_fast', agentId: null, parentMessageId: null,
      timestamp: Date.parse('2026-09-15T10:00:01.000Z'), sourceType: 'main', sourceLabel: 'main', model: 'claude-opus-5',
      input: 1000, cacheRead: 2000, cacheWrite5m: 500, cacheWrite1h: 0, output: 100,
    });
  });
});

describe('history window and robustness', () => {
  it('skips files last written before the 1st of the previous month and missing roots', async () => {
    const roots = copyFixtureRoots(NOW);
    const before = await buildSnapshot({ roots: [roots.secondary, join(roots.dir, 'does-not-exist')], prices: shippedPrices(), now: NOW });
    expect(before.rows.length).toBeGreaterThan(0);

    touchAll(roots.secondary, new Date('2026-07-31T23:59:59Z')); // one second before the window opens
    const after = await buildSnapshot({ roots: [roots.secondary], prices: shippedPrices(), now: NOW });
    expect(after.rows).toEqual([]);

    touchAll(roots.secondary, new Date('2026-08-01T00:00:00Z'));
    const edge = await buildSnapshot({ roots: [roots.secondary], prices: shippedPrices(), now: NOW });
    expect(edge.rows.length).toBe(before.rows.length);
  });

  it('parses a 2 MB single line and holds back a final line with no trailing newline as still being written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cclive-bigline-'));
    const file = join(dir, 'proj', 's.jsonl');
    mkdirSync(join(dir, 'proj'));
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const big = JSON.stringify({ type: 'user', uuid: 'u', sessionId: 's', timestamp: '2026-09-15T10:00:00Z', isSidechain: false,
      message: { role: 'user', content: [{ type: 'image', source: { data: 'A'.repeat(2 * 1024 * 1024) } }] } });
    const a = (id: string) => JSON.stringify({ type: 'assistant', uuid: id, sessionId: 's', timestamp: '2026-09-15T10:00:01Z', isSidechain: false, requestId: 'r',
      message: { id, model: 'claude-sonnet-5', stop_reason: 'end_turn', usage } });
    writeFileSync(file, `${a('msg_before')}\n${big}\n${a('msg_after')}`); // no trailing newline
    const snapshot = await buildSnapshot({ roots: [dir], prices: shippedPrices(), now: NOW });
    expect(snapshot.rows.map((r) => r.messageId)).toEqual(['msg_before']); // msg_after counts once its newline lands
    expect(snapshot.skippedLines).toBe(0);
  });

  it('sums the month-to-date estimate from 00:00 UTC on the 1st across sessions, and carries the budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cclive-mtd-'));
    mkdirSync(join(dir, 'p1'));
    mkdirSync(join(dir, 'p2'));
    const line = (id: string, ts: string, input: number, output: number) => JSON.stringify({ type: 'assistant', uuid: id, sessionId: 's', timestamp: ts, isSidechain: false, requestId: 'r',
      message: { id, model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    // Sonnet 5 at $2 in / $10 out per million: 0.015 (last month), 0.003 (first instant of the month), 0.004 (other session)
    writeFileSync(join(dir, 'p1', 'a.jsonl'), `${line('msg_aug', '2026-08-31T23:59:59.999Z', 5000, 500)}\n${line('msg_sep1', '2026-09-01T00:00:00.000Z', 1000, 100)}\n`);
    writeFileSync(join(dir, 'p2', 'b.jsonl'), `${line('msg_sep5', '2026-09-05T08:00:00.000Z', 2000, 0)}\n`);

    const snapshot = await buildSnapshot({ roots: [dir], prices: shippedPrices(), now: NOW });
    expect(snapshot.rows).toHaveLength(3);
    expect(snapshot.monthToDate).toBeCloseTo(0.007, 10);
    expect(snapshot.budget).toBeNull();

    const withBudget = await buildSnapshot({ roots: [dir], prices: shippedPrices(), now: NOW, budget: 1500 });
    expect(withBudget.budget).toBe(1500);
  });
});

describe('snapshot from the anonymised real session', () => {
  // Expected counts come from jq over the raw transcript before anonymisation: 28 message ids with a requestId, one never final.
  const SESSION = 'd0b3a2a9-f089-4673-94d4-08103cefbe2d';

  it('matches the jq sums, dedups multi-line requests and flags the aborted one', async () => {
    const roots = copyFixtureRoots(NOW);
    const snapshot = await buildSnapshot({ roots: [roots.primary], prices: shippedPrices(), now: NOW });
    const rows = snapshot.rows.filter((r) => r.sessionId === SESSION);
    const sum = (k: 'input' | 'output' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h' | 'thinking' | 'estimate') =>
      rows.reduce((t, r) => t + r[k], 0);

    expect(rows).toHaveLength(28);
    expect(rows.every((r) => r.model === 'claude-fable-5-1')).toBe(true);
    expect(sum('input')).toBe(806);
    expect(sum('output')).toBe(20874);
    expect(sum('cacheRead')).toBe(2790013);
    expect(sum('cacheWrite5m')).toBe(0);
    expect(sum('cacheWrite1h')).toBe(131333);
    expect(sum('thinking')).toBe(1255);
    // (806×10 + 20874×50 + 2790013×0.25 + 131333×20) / 1e6
    expect(sum('estimate')).toBeCloseTo(4.37592325, 6);

    const aborted = rows.filter((r) => r.flags.includes('aborted'));
    expect(aborted.map((r) => r.messageId)).toEqual(['msg_011CesD3KDuskLCFFW18kbnE']);
    expect(snapshot.unpricedRows).toBe(0);
    expect(snapshot.skippedLines).toBe(1); // the one synthetic API error line
  });
});

describe('subagent linkage from the two-level spawn fixture', () => {
  const SESSION = 'gamma';
  const SUBAGENTS = join(FIXTURE_ROOTS, 'secondary', '-home-dev-project-gamma', SESSION, 'subagents');

  it('nests first-level subagents under their spawning request and second-level under the subagent spawner', async () => {
    const roots = copyFixtureRoots(NOW);
    const snapshot = await buildSnapshot({ roots: [roots.secondary], prices: shippedPrices(), now: NOW });
    const rows = new Map(snapshot.rows.filter((r) => r.sessionId === SESSION).map((r) => [r.messageId, r]));
    expect(rows.size).toBe(8);

    expect(rows.get('msg_sub_a1')?.parentMessageId).toBe('msg_spawn_a');
    expect(rows.get('msg_sub_a2')?.parentMessageId).toBe('msg_spawn_a');
    expect(rows.get('msg_sub_b1')?.parentMessageId).toBe('msg_sub_a1');
    expect(rows.get('msg_sub_c1')?.parentMessageId).toBe('msg_spawn_c');
    expect(rows.get('msg_spawn_a')?.parentMessageId).toBeNull();
    expect(rows.get('msg_main_after')?.parentMessageId).toBeNull();
  });

  it('labels subagent rows from the meta file, falling back to the Agent tool_use input', async () => {
    const roots = copyFixtureRoots(NOW);
    const snapshot = await buildSnapshot({ roots: [roots.secondary], prices: shippedPrices(), now: NOW });
    const rows = new Map(snapshot.rows.map((r) => [r.messageId, r]));

    expect(rows.get('msg_sub_a1')).toMatchObject({ sourceType: 'subagent', agentId: 'a1', sourceLabel: 'Explore: scan alpha' });
    expect(rows.get('msg_sub_b1')).toMatchObject({ sourceType: 'subagent', agentId: 'b2', sourceLabel: 'Explore: nested scan' });
    expect(rows.get('msg_sub_c1')).toMatchObject({ sourceType: 'subagent', agentId: 'c3', sourceLabel: 'general-purpose: no meta task' }); // no meta file
    expect(rows.get('msg_spawn_a')).toMatchObject({ sourceType: 'main', agentId: null, sourceLabel: 'main' });
  });

  it('holds a subagent with no link record at top level, then nests it when the link arrives incrementally', () => {
    const store = new RequestStore(shippedPrices());
    const fork = readFileSync(join(SUBAGENTS, 'agent-d4.jsonl'), 'utf8').trimEnd().split('\n');
    store.labelAgent('d4', 'fork: fork task');
    const first = fork.flatMap((l) => store.feed(l)); // starts with a fork-context-ref record without uuid or timestamp
    expect(first.map((r) => r.messageId)).toEqual(['msg_sub_d1']);
    expect(first[0]).toMatchObject({ sourceType: 'subagent', sourceLabel: 'fork: fork task', parentMessageId: null });
    expect(store.skippedLines).toBe(0);

    const spawnLine = JSON.stringify({ type: 'assistant', uuid: 'as-4', sessionId: 'gamma', isSidechain: false,
      timestamp: '2026-09-10T09:00:20.000Z', requestId: 'req_spawn_d',
      message: { id: 'msg_spawn_d', model: 'claude-sonnet-5', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'tool_use', id: 'toolu_D', name: 'Agent', input: { subagent_type: 'fork', description: 'fork task' } }] } });
    const linkLine = JSON.stringify({ type: 'user', uuid: 'u-5', sessionId: 'gamma', isSidechain: false,
      timestamp: '2026-09-10T09:00:21.000Z', sourceToolAssistantUUID: 'as-4',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_D', content: 'launched' }] },
      toolUseResult: { status: 'async_launched', isAsync: true, agentId: 'd4', description: 'fork task' } });
    expect(store.feed(spawnLine).map((r) => r.messageId)).toEqual(['msg_spawn_d']);
    const changed = store.feed(linkLine);
    expect(changed.map((r) => r.messageId)).toEqual(['msg_sub_d1']);
    expect(changed[0]?.parentMessageId).toBe('msg_spawn_d');
    expect(store.rows().find((r) => r.messageId === 'msg_sub_d1')?.parentMessageId).toBe('msg_spawn_d');
  });

  it('returns from a second batch of lines exactly the rows that changed, and a partial row becomes final', () => {
    const beta = readFileSync(join(FIXTURE_ROOTS, 'secondary/-home-dev-project-beta/beta.jsonl'), 'utf8')
      .trimEnd().split('\n');
    const store = new RequestStore(shippedPrices());
    const first = beta.slice(0, 9).flatMap((l) => store.feed(l)); // ends with the partial line of msg_two_lines
    expect(first.map((r) => r.messageId)).toEqual(['msg_fast_opus', 'msg_dated_opus', 'msg_unpriced', 'msg_two_lines']);
    expect(first[3]).toMatchObject({ flags: ['aborted'], output: 3 });

    const second = beta.slice(9).flatMap((l) => store.feed(l)); // final line of msg_two_lines, msg_aborted, msg_cache_writes
    expect(second.map((r) => r.messageId)).toEqual(['msg_two_lines', 'msg_aborted', 'msg_cache_writes']);
    expect(second[0]).toMatchObject({ flags: [], output: 50, thinking: 30 });
    expect(store.rows().filter((r) => r.messageId === 'msg_two_lines')).toHaveLength(1);
  });

  it('sweeping drops rows before the window start and lets their message ids be counted again', () => {
    const line = (id: string, ts: string) => JSON.stringify({ type: 'assistant', uuid: id, sessionId: 's', timestamp: ts, requestId: 'r',
      message: { id, model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
    const store = new RequestStore(shippedPrices());
    store.feed(line('msg_old', '2026-08-31T23:59:59.999Z'));
    store.feed(line('msg_new', '2026-09-01T00:00:00.000Z'));
    store.feed(line('msg_old', '2026-08-31T23:59:59.999Z'));
    expect(store.rows()).toHaveLength(2); // a repeat is still one row
    store.sweep(Date.UTC(2026, 8, 1));
    expect(store.rows().map((r) => r.messageId)).toEqual(['msg_new']);
    store.feed(line('msg_old', '2026-08-31T23:59:59.999Z'));
    expect(store.rows().map((r) => r.messageId)).toEqual(['msg_new', 'msg_old']);
  });

  it('agrees with isSidechain on every row in every fixture', async () => {
    const roots = copyFixtureRoots(NOW);
    const snapshot = await buildSnapshot({ roots: [roots.primary, roots.secondary], prices: shippedPrices(), now: NOW });
    const sidechain = new Map<string, boolean>();
    for (const rel of readdirSync(FIXTURE_ROOTS, { recursive: true, encoding: 'utf8' })) {
      if (!rel.endsWith('.jsonl')) continue;
      for (const line of readFileSync(join(FIXTURE_ROOTS, rel), 'utf8').split('\n')) {
        let rec: { type?: string; isSidechain?: boolean; message?: { id?: string } };
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // the secondary fixture has one malformed line on purpose
        }
        if (rec.type === 'assistant' && rec.message?.id) sidechain.set(rec.message.id, rec.isSidechain === true);
      }
    }
    expect(snapshot.rows.length).toBeGreaterThan(30);
    for (const row of snapshot.rows) {
      expect(row.sourceType, row.messageId).toBe(sidechain.get(row.messageId) ? 'subagent' : 'main');
    }
    // the orphan fork subagent keeps its label at top level in the full snapshot
    const orphan = snapshot.rows.find((r) => r.messageId === 'msg_sub_d1');
    expect(orphan).toMatchObject({ sourceType: 'subagent', sourceLabel: 'fork: fork task', parentMessageId: null });
  });
});

describe('compacted badge and session list', () => {
  const DELTA = 'delta';
  const ALPHA = 'd0b3a2a9-f089-4673-94d4-08103cefbe2d';
  const BETA = 'beta';
  const GAMMA = 'gamma';

  it('flags exactly the first main-thread request after compact_boundary and skips the compact summary', async () => {
    const roots = copyFixtureRoots(NOW);
    const snapshot = await buildSnapshot({ roots: [roots.secondary], prices: shippedPrices(), now: NOW });
    const rows = snapshot.rows.filter((r) => r.sessionId === DELTA);
    expect(rows.map((r) => r.messageId).sort()).toEqual(['msg_delta_after1', 'msg_delta_after2', 'msg_delta_before']); // no row for the summary
    const byId = new Map(rows.map((r) => [r.messageId, r]));
    expect(byId.get('msg_delta_after1')).toMatchObject({
      flags: ['compacted'], output: 8, // flag survives the partial-then-final pair
      compaction: { preTokens: 143859, postTokens: 11687, cumulativeDroppedTokens: 132172 },
    });
    expect(byId.get('msg_delta_before')).toMatchObject({ flags: [], compaction: null });
    expect(byId.get('msg_delta_after2')).toMatchObject({ flags: [], compaction: null });
  });

  it('labels sessions <project> · <title> with custom over AI, last title wins, start time when none', async () => {
    const roots = copyFixtureRoots(NOW);
    const snapshot = await buildSnapshot({ roots: [roots.primary, roots.secondary], prices: shippedPrices(), now: NOW });
    const labels = new Map(snapshot.sessions.map((s) => [s.sessionId, s.label]));
    expect(labels.get(DELTA)).toBe('-home-dev-project-delta · Custom delta'); // both kinds present, and a later ai-title
    expect(labels.get(ALPHA)).toBe('-home-dev-project-alpha · AI title 25'); // 25 repeated ai-title records
    expect(labels.get(BETA)).toBe('-home-dev-project-beta · AI title 1');
    expect(labels.get(GAMMA)).toBe(`-home-dev-project-gamma · ${formatStartTime(Date.parse('2026-09-10T09:00:00.000Z'))}`);
    expect(labels.size).toBe(4);
  });

  it('names the project after the cwd basename when a record carries one, else the folder', () => {
    const store = new RequestStore(shippedPrices());
    store.touchSession('s1', '-Users-me-Labs-Tools-cclive', 1);
    store.touchSession('s2', '-home-dev-other', 1);
    store.feed(JSON.stringify({ type: 'custom-title', sessionId: 's1', customTitle: 'T', cwd: '/Users/me/Labs/Tools/cclive' }));
    store.feed(JSON.stringify({ type: 'custom-title', sessionId: 's2', customTitle: 'U' }));
    const labels = new Map(store.sessions().map((s) => [s.sessionId, s.label]));
    expect(labels.get('s1')).toBe('cclive · T');
    expect(labels.get('s2')).toBe('-home-dev-other · U');
  });

  it('orders sessions newest first by last write, flags only the first, and covers every row', async () => {
    const roots = copyFixtureRoots(NOW);
    const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
    const stamp = (rel: string, d: Date) => utimesSync(join(roots.dir, rel), d, d);
    stamp(`secondary/-home-dev-project-gamma/${GAMMA}/subagents/agent-a1.jsonl`, hoursAgo(0)); // a subagent write counts
    stamp(`secondary/-home-dev-project-gamma/${GAMMA}.jsonl`, hoursAgo(5));
    stamp(`primary/-home-dev-project-alpha/${ALPHA}.jsonl`, hoursAgo(1));
    stamp(`secondary/-home-dev-project-beta/${BETA}.jsonl`, hoursAgo(2));
    stamp(`secondary/-home-dev-project-delta/${DELTA}.jsonl`, hoursAgo(3));
    const snapshot = await buildSnapshot({ roots: [roots.primary, roots.secondary], prices: shippedPrices(), now: NOW });

    expect(snapshot.sessions.map((s) => s.sessionId)).toEqual([GAMMA, ALPHA, BETA, DELTA]);
    expect(snapshot.sessions.map((s) => s.newest)).toEqual([true, false, false, false]);
    expect(snapshot.sessions[0]?.lastWrite).toBe(NOW.getTime());
    const ids = new Set(snapshot.sessions.map((s) => s.sessionId));
    for (const row of snapshot.rows) expect(ids.has(row.sessionId), row.messageId).toBe(true);
  });
});
