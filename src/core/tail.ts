import { open, stat, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';

const CHUNK = 1024 * 1024;

interface TailState {
  /** Bytes consumed so far. The unterminated tail of the last read is kept in `pending`, not re-read. */
  offset: number;
  ino: number;
  /** mtime from the last stat, epoch milliseconds. */
  mtimeMs: number;
  pending: Buffer[];
  busy: boolean;
  dirty: boolean;
}

/** Read only bytes appended since last call; a new inode or a truncate restarts from zero. Split lines join as Buffers. */
export class Tailer {
  private readonly files = new Map<string, TailState>();

  /** Stat `path` and emit new complete lines. Null if gone. A call during a read marks dirty so the in-flight read loops once more. */
  async reconcile(path: string, onLine: (line: string) => void): Promise<Stats | null> {
    let state = this.files.get(path);
    if (!state) this.files.set(path, (state = { offset: 0, ino: 0, mtimeMs: 0, pending: [], busy: false, dirty: false }));
    if (state.busy) {
      state.dirty = true;
      return null;
    }
    state.busy = true;
    try {
      let s: Stats;
      do {
        state.dirty = false;
        try {
          s = await stat(path);
        } catch {
          this.files.delete(path);
          return null;
        }
        state.mtimeMs = s.mtimeMs;
        if (s.ino !== state.ino || s.size < state.offset) {
          state.offset = 0;
          state.pending = [];
          state.ino = s.ino;
        }
        if (s.size > state.offset) await this.read(path, state, s.size, onLine);
      } while (state.dirty);
      return s;
    } finally {
      state.busy = false;
    }
  }

  get size(): number {
    return this.files.size;
  }

  /** Release state for files not written since `before`. A later write re-reads such a file from byte zero. */
  forget(before: number): void {
    for (const [path, s] of this.files) if (!s.busy && s.mtimeMs < before) this.files.delete(path);
  }

  private async read(path: string, state: TailState, size: number, onLine: (line: string) => void): Promise<void> {
    let fh: FileHandle;
    try {
      fh = await open(path, 'r');
    } catch {
      return; // vanished between stat and open: the next event sorts it out
    }
    try {
      while (state.offset < size) {
        const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - state.offset));
        const { bytesRead } = await fh.read(buf, 0, buf.length, state.offset);
        if (bytesRead === 0) break;
        state.offset += bytesRead;
        let start = 0;
        let nl: number;
        while ((nl = buf.indexOf(0x0a, start)) !== -1 && nl < bytesRead) {
          const piece = buf.subarray(start, nl);
          onLine(state.pending.length ? Buffer.concat([...state.pending, piece]).toString('utf8') : piece.toString('utf8'));
          state.pending = [];
          start = nl + 1;
        }
        if (start < bytesRead) state.pending.push(Buffer.from(buf.subarray(start, bytesRead)));
      }
    } finally {
      await fh.close();
    }
  }
}
