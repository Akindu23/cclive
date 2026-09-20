import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** `$XDG_CONFIG_HOME/cclive`, else `%APPDATA%\cclive` on Windows, else `~/.config/cclive`. Never created here. */
export function configDir(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform = process.platform): string {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'cclive');
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'cclive');
  return join(home, '.config', 'cclive');
}

/** Write JSON through a temp file and rename, creating the directory on first use. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

/** The budget in `config.json`, `null` when the file is missing, unreadable, or holds no positive number. */
export function readBudget(dir = configDir()): number | null {
  try {
    const b = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).budget;
    return typeof b === 'number' && b > 0 ? b : null;
  } catch {
    return null;
  }
}

/** `--budget <usd>`: the file holds only the budget, and `0` clears it. */
export function writeBudget(usd: number, dir = configDir()): void {
  writeJsonAtomic(join(dir, 'config.json'), usd > 0 ? { budget: usd } : {});
}
