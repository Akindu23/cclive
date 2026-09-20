import { cpSync, mkdtempSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_ROOTS = fileURLToPath(new URL('./fixtures/roots/', import.meta.url));

/** Copy the fixture roots into a temp dir and stamp every file with `mtime`, since git does not keep mtimes. */
export function copyFixtureRoots(mtime: Date): { primary: string; secondary: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cclive-fixture-'));
  cpSync(FIXTURE_ROOTS, dir, { recursive: true });
  touchAll(dir, mtime);
  return { dir, primary: join(dir, 'primary'), secondary: join(dir, 'secondary') };
}

export function touchAll(dir: string, mtime: Date): void {
  for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const full = join(dir, entry);
    if (statSync(full).isFile()) utimesSync(full, mtime, mtime);
  }
}
