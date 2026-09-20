import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';

const SUBAGENT_FILE = /^agent-([0-9a-f]+)\.jsonl$/;

/** For `…/subagents/agent-<id>.jsonl`, the agent id and label from the sibling `.meta.json`; null if missing. */
export async function readSubagentMeta(file: string): Promise<{ agentId: string; label: string } | null> {
  const m = SUBAGENT_FILE.exec(basename(file));
  if (!m || basename(join(file, '..')) !== 'subagents') return null;
  const agentId = m[1];
  if (!agentId) return null;
  try {
    const meta = JSON.parse(await readFile(file.slice(0, -'.jsonl'.length) + '.meta.json', 'utf8'));
    if (typeof meta?.agentType !== 'string' || typeof meta?.description !== 'string') return null;
    return { agentId, label: `${meta.agentType}: ${meta.description}` };
  } catch {
    return null;
  }
}

/** 00:00 UTC on the 1st of the month before `now`. A file last written before this cannot hold a row the page shows. */
export function historyWindowStart(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
}

/** Project folder and session id from a path relative to its root: `<project>/<session>.jsonl` or `<project>/<session>/subagents/agent-<id>.jsonl`. */
export function transcriptIds(rel: string): { project: string; sessionId: string } {
  const [project = '', second = ''] = rel.split(sep);
  return { project, sessionId: second.endsWith('.jsonl') ? second.slice(0, -'.jsonl'.length) : second };
}

/** Every *.jsonl under the roots that exist, with mtime at or after `since`, as root plus relative path. */
export async function listTranscripts(roots: string[], since: number): Promise<Array<{ root: string; rel: string }>> {
  const files: Array<{ root: string; rel: string }> = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root, { recursive: true, encoding: 'utf8' });
    } catch {
      continue; // missing root
    }
    for (const rel of entries) {
      if (!rel.endsWith('.jsonl')) continue;
      const s = await stat(join(root, rel));
      if (s.isFile() && s.mtimeMs >= since) files.push({ root, rel });
    }
  }
  return files;
}
