import { realpathSync, watch, type FSWatcher } from 'node:fs';

const TRAILING_MS = 50;
const MAX_WAIT_MS = 250;

/** One recursive `fs.watch` per existing root. `*.jsonl` events debounce 50 ms trailing, 250 ms max, then `onChange(root, rel)`. */
export function watchTranscripts(roots: string[], onChange: (root: string, rel: string) => void): FSWatcher[] {
  const watchers: FSWatcher[] = [];
  for (const root of roots) {
    const pending = new Map<string, { timer: NodeJS.Timeout; deadline: number }>();
    let watcher: FSWatcher;
    try {
      // Watch the real path: on Windows a root spelled as an 8.3 short name (C:\Users\RUNNER~1\...) trips a libuv assertion in the recursive watcher.
      watcher = watch(realpathSync.native(root), { recursive: true }, (_event, filename) => {
        const rel = filename?.toString();
        if (!rel?.endsWith('.jsonl')) return; // yagni: an event with no filename is dropped; the next write for that file brings its own
        const now = Date.now();
        const prev = pending.get(rel);
        if (prev) clearTimeout(prev.timer);
        const deadline = prev?.deadline ?? now + MAX_WAIT_MS;
        const timer = setTimeout(() => {
          pending.delete(rel);
          onChange(root, rel);
        }, Math.max(0, Math.min(TRAILING_MS, deadline - now)));
        pending.set(rel, { timer, deadline });
      });
    } catch {
      continue; // missing root
    }
    watcher.on('error', () => {});
    watcher.on('close', () => pending.forEach((e) => clearTimeout(e.timer)));
    watchers.push(watcher);
  }
  return watchers;
}
