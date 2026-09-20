import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server, type ServerResponse } from 'node:http';
import type { Server as NetServer } from 'node:net';
import type { Reader, RequestRow } from './core/index.ts';
import { watchTranscripts } from './watch.ts';

const FLUSH_MS = 250;
const DAY_MS = 86_400_000;
const HEARTBEAT_MS = 20_000;
/** Bytes a client may leave unflushed before it counts as too slow to keep. */
const SLOW_CLIENT_BYTES = 1024 * 1024;

export type DashboardServer = Server & {
  /** Push the reader's whole snapshot to every connected page, e.g. after a re-price. */
  broadcastSnapshot(): void;
};

/** HTTP over one reader: `/`, `/chart.js`, `/api/snapshot`, SSE `/api/events`. Watches the roots for the server's life; the first file event after 00:00 UTC runs the history sweep. `clock` exists for tests. */
export function createServer(reader: Reader, page: string, chartJs: string, clock = () => new Date()): DashboardServer {
  const bootToken = randomUUID();
  let sweptDay = Math.floor(clock().getTime() / DAY_MS);
  const clients = new Set<ServerResponse>();
  const pending = new Map<string, RequestRow>();
  let flush: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const drop = (res: ServerResponse) => {
    clients.delete(res);
    res.destroy();
    if (clients.size === 0 && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };
  const broadcast = (chunk: string) => {
    for (const res of clients) {
      // yagni: `write` returning false is not the drop signal, a single >16 KB batch already trips it on a healthy socket
      if (res.writableLength > SLOW_CLIENT_BYTES) drop(res);
      else res.write(chunk);
    }
  };
  const push = (rows: RequestRow[]) => {
    if (clients.size === 0 || rows.length === 0) return; // a client that connects later refetches the snapshot
    for (const r of rows) pending.set(r.messageId, r);
    flush ??= setTimeout(() => {
      flush = null;
      const batch = [...pending.values()];
      pending.clear();
      broadcast(`event: rows\ndata: ${JSON.stringify(batch)}\n\n`);
    }, FLUSH_MS);
  };

  const server = createHttpServer((req, res) => {
    const path = req.url?.split('?')[0];
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
    } else if (path === '/chart.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(chartJs);
    } else if (path === '/api/snapshot') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(reader.snapshot(clock())));
    } else if (path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' });
      res.flushHeaders();
      res.on('error', () => {});
      res.on('close', () => drop(res));
      clients.add(res);
      heartbeat ??= setInterval(() => broadcast(': keep-alive\n\n'), HEARTBEAT_MS);
      res.write(`retry: 2000\n\nevent: hello\ndata: ${bootToken}\n\n`);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const broadcastSnapshot = () => broadcast(`event: snapshot\ndata: ${JSON.stringify(reader.snapshot(clock()))}\n\n`);
  const watchers = watchTranscripts(reader.roots, (root, rel) => {
    const now = clock();
    const day = Math.floor(now.getTime() / DAY_MS);
    const sweep = day !== sweptDay;
    if (sweep) {
      sweptDay = day;
      reader.sweep(now);
    }
    reader.reconcile(root, rel).then(sweep ? broadcastSnapshot : push, () => {}); // a vanished file is not an error worth stopping for
  });
  server.on('close', () => {
    watchers.forEach((w) => w.close());
    if (flush) clearTimeout(flush);
    if (heartbeat) clearInterval(heartbeat);
  });
  return Object.assign(server, { broadcastSnapshot });
}

/** Bind `127.0.0.1:port`. With `strict` a busy port rejects; otherwise the next port is tried until one is free. */
export function listen(server: NetServer, port: number, strict: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (!strict && err.code === 'EADDRINUSE') tryPort(p + 1);
        else reject(err);
      });
      server.listen(p, '127.0.0.1', () => {
        server.removeAllListeners('error');
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : p);
      });
    };
    tryPort(port);
  });
}
