import { spawn } from 'node:child_process';
import { homedir, release } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readBudget, writeBudget } from './config.ts';
import { Reader } from './core/index.ts';
import page from './page.html';
import { setupPrices } from './prices.ts';
import { createServer, listen } from './server.ts';

declare const __CCLIVE_VERSION__: string;
/** The tree-shaken Chart.js browser bundle, inlined by scripts/build.mjs. */
declare const __CCLIVE_CHART_JS__: string;

const DEFAULT_PORT = 4747;

const HELP = `cclive - live per-request dashboard for Claude Code, read from local transcripts

Usage:
  npx cclive                     # read transcripts, open the dashboard in the browser
  npx cclive --budget 1500       # set a monthly budget in USD (saved for later runs)
  npx cclive --json > out.json   # print the snapshot and exit

Flags:
  --budget <usd>     Monthly budget for the budget card, saved to the config file; 0 clears it
  --port <n>         Bind exactly this port (default: ${DEFAULT_PORT}, stepping up when busy)
  --no-open          Print the URL instead of opening the browser
  --pricing <file>   Per-model price overrides, first in precedence (same shape as pricing.json)
  --offline          Skip the LiteLLM price download; CCLIVE_OFFLINE=1 does the same
  --json             Print the full snapshot as JSON and exit
  --help, -h         Show this help
  --version          Print the version
`;

export function transcriptRoots(home = homedir()): string[] {
  return [join(home, '.claude', 'projects'), join(home, '.config', 'claude', 'projects')];
}

/** Open `url` with the platform opener, detached. Headless Linux and opener failures do nothing: the URL is already printed. */
function openBrowser(url: string): void {
  let cmd: [string, ...string[]];
  if (process.platform === 'darwin') cmd = ['open', url];
  else if (process.platform === 'win32') cmd = ['rundll32', 'url.dll,FileProtocolHandler', url];
  else if (/microsoft/i.test(release())) cmd = ['powershell.exe', '-NoProfile', '-Command', `Start-Process '${url}'`];
  else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) cmd = ['xdg-open', url];
  else return;
  try {
    spawn(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    // opener missing: the URL line is enough
  }
}

async function main(argv: string[]): Promise<number> {
  let values: { json?: boolean; help?: boolean; version?: boolean; port?: string; open?: boolean; pricing?: string; offline?: boolean; budget?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
        port: { type: 'string' },
        open: { type: 'boolean', default: true },
        pricing: { type: 'string' },
        offline: { type: 'boolean' },
        budget: { type: 'string' },
      },
      strict: true,
      allowNegative: true,
    }));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${__CCLIVE_VERSION__}\n`);
    return 0;
  }
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`--port must be an integer between 0 and 65535, got ${values.port}\n`);
    return 2;
  }
  let budget = readBudget();
  if (values.budget !== undefined) {
    const usd = Number(values.budget);
    if (!Number.isFinite(usd) || usd < 0) {
      process.stderr.write(`--budget must be a dollar amount of 0 or more, got ${values.budget}\n`);
      return 2;
    }
    try {
      writeBudget(usd);
    } catch (err) {
      process.stderr.write(`Could not save the budget: ${(err as Error).message}\n`);
      return 1;
    }
    budget = usd > 0 ? usd : null;
  }
  // The download starts here, before the parse, and lands once; CCLIVE_LITELLM_URL is a test hook for a stub server.
  let prices: ReturnType<typeof setupPrices>;
  try {
    prices = setupPrices({
      offline: values.offline || process.env.CCLIVE_OFFLINE === '1',
      pricingFile: values.pricing,
      url: process.env.CCLIVE_LITELLM_URL,
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  const reader = new Reader(transcriptRoots(), prices.local.table, prices.local.label);
  reader.budget = budget;

  if (values.json) {
    await reader.readHistory();
    if (prices.refresh) {
      const fresh = await prices.refresh;
      reader.setPrices(fresh.table, fresh.label);
    }
    process.stdout.write(`${JSON.stringify(reader.snapshot())}\n`);
    return 0;
  }

  process.stdout.write('Reading transcripts…\n');
  await reader.readHistory();
  const server = createServer(reader, page, __CCLIVE_CHART_JS__);
  prices.refresh?.then((fresh) => {
    reader.setPrices(fresh.table, fresh.label);
    server.broadcastSnapshot();
  });
  let bound: number;
  try {
    bound = await listen(server, port, values.port !== undefined);
  } catch (err) {
    process.stderr.write(`Could not bind 127.0.0.1:${port}: ${(err as Error).message}\n`);
    return 1;
  }
  const url = `http://127.0.0.1:${bound}`;
  process.stdout.write(`${url}\n`);
  if (values.open) openBrowser(url);
  return new Promise(() => {}); // serve until killed
}

process.exitCode = await main(process.argv.slice(2));
