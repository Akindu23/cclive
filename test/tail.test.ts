import { appendFileSync, mkdtempSync, renameSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Tailer } from '../src/core/tail.ts';

async function drain(tailer: Tailer, path: string): Promise<string[]> {
  const lines: string[] = [];
  await tailer.reconcile(path, (l) => lines.push(l));
  return lines;
}

describe('offset tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cclive-tail-'));

  it('reads a new file from byte zero, then only the appended lines', async () => {
    const path = join(dir, 'a.jsonl');
    writeFileSync(path, 'one\ntwo\n');
    const tailer = new Tailer();
    expect(await drain(tailer, path)).toEqual(['one', 'two']);
    expect(await drain(tailer, path)).toEqual([]);
    appendFileSync(path, 'three\n');
    expect(await drain(tailer, path)).toEqual(['three']);
  });

  it('keeps a pending fragment until its newline lands, across a 2 MB line split over chunk boundaries', async () => {
    const path = join(dir, 'big.jsonl');
    const big = 'x'.repeat(2 * 1024 * 1024) + '€'; // multibyte tail so a split inside the character shows up
    writeFileSync(path, 'first\n' + big.slice(0, 1_500_000));
    const tailer = new Tailer();
    expect(await drain(tailer, path)).toEqual(['first']);
    appendFileSync(path, big.slice(1_500_000) + '\nlast\n');
    expect(await drain(tailer, path)).toEqual([big, 'last']);

    // one reconcile spanning several 1 MB chunks
    const whole = join(dir, 'whole.jsonl');
    writeFileSync(whole, big + '\n' + big + '\n');
    expect(await drain(new Tailer(), whole)).toEqual([big, big]);
  });

  it('restarts from byte zero when the file is truncated', async () => {
    const path = join(dir, 'trunc.jsonl');
    writeFileSync(path, 'alpha\nbeta\n');
    const tailer = new Tailer();
    await drain(tailer, path);
    truncateSync(path, 0);
    appendFileSync(path, 'gamma\n');
    expect(await drain(tailer, path)).toEqual(['gamma']);
  });

  it('restarts from byte zero when the file is replaced (new inode)', async () => {
    const path = join(dir, 'repl.jsonl');
    writeFileSync(path, 'alpha\nbeta\n');
    const tailer = new Tailer();
    await drain(tailer, path);
    const tmp = join(dir, 'repl.tmp');
    writeFileSync(tmp, 'alpha\nbeta\ndelta\n'); // longer than the old file, so only the inode tells
    renameSync(tmp, path);
    expect(await drain(tailer, path)).toEqual(['alpha', 'beta', 'delta']);
  });

  it('forgets tail state for files not written since a point in time, so they re-read from byte zero', async () => {
    const stale = join(dir, 'stale.jsonl');
    const fresh = join(dir, 'fresh.jsonl');
    writeFileSync(stale, 'one\n');
    writeFileSync(fresh, 'two\n');
    const old = new Date('2026-08-01T00:00:00Z');
    utimesSync(stale, old, old);
    const tailer = new Tailer();
    await drain(tailer, stale);
    await drain(tailer, fresh);
    expect(tailer.size).toBe(2);
    tailer.forget(Date.UTC(2026, 8, 1));
    expect(tailer.size).toBe(1);
    expect(await drain(tailer, stale)).toEqual(['one']);
    expect(await drain(tailer, fresh)).toEqual([]);
  });

  it('returns null and forgets the file when it is gone', async () => {
    const tailer = new Tailer();
    expect(await tailer.reconcile(join(dir, 'missing.jsonl'), () => {})).toBeNull();
  });
});
