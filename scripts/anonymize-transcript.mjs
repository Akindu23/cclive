#!/usr/bin/env node
// Anonymise a Claude Code transcript for a fixture: keep ids, timestamps, usage and structure; redact text. Usage: node scripts/anonymize-transcript.mjs <in.jsonl> <out.jsonl>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: anonymize-transcript.mjs <in.jsonl> <out.jsonl>');
  process.exit(2);
}

const REDACTED = '[redacted]';
const CONVERSATION_KEYS = [
  'type', 'uuid', 'parentUuid', 'sessionId', 'timestamp', 'isSidechain', 'agentId',
  'userType', 'entrypoint', 'version', 'sessionKind',
];
const PER_TYPE_KEYS = {
  user: ['promptId', 'sourceToolAssistantUUID', 'isMeta', 'isCompactSummary', 'isVisibleInTranscriptOnly', 'toolDenialKind', 'permissionMode'],
  assistant: ['requestId', 'effort', 'apiBlockIndex', 'isApiErrorMessage', 'error', 'isAbortedMidStream'],
  attachment: [],
  system: ['subtype', 'level', 'isMeta', 'durationMs', 'messageCount', 'logicalParentUuid', 'hookCount', 'hookErrors', 'stopReason', 'toolUseID'],
  'fork-context-ref': ['parentSessionId', 'parentLastUuid', 'contextLength'],
};
const METADATA_KEYS = {
  'ai-title': ['sessionId'],
  'custom-title': ['sessionId'],
  'agent-name': ['sessionId'],
  'agent-color': ['sessionId', 'agentColor'],
  'last-prompt': ['sessionId', 'leafUuid'],
  mode: ['sessionId', 'mode'],
  'atis-latch': ['sessionId', 'atis'],
  'permission-mode': ['sessionId', 'permissionMode'],
  'cost-state': ['sessionId', 'startTime', 'totalCostUSD', 'totalAPIDuration', 'totalAPIDurationWithoutRetries', 'totalDuration', 'totalLinesAdded', 'totalLinesRemoved', 'totalToolDuration', 'hasUnknownModelCost', 'modelUsage'],
  'file-history-snapshot': ['messageId', 'isSnapshotUpdate'],
  'file-history-delta': ['messageId', 'snapshotMessageId', 'timestamp'],
  'queue-operation': ['sessionId', 'operation', 'timestamp', 'reason'],
  'bridge-session': ['sessionId'],
  'continued-in': ['sessionId', 'continuedInSessionId', 'timestamp'],
  'frame-link': ['sessionId', 'timestamp', 'artifactCount'],
};

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

let titleCount = 0;
function anonymiseBlock(block) {
  const out = { type: block.type };
  switch (block.type) {
    case 'text':
      out.text = REDACTED;
      break;
    case 'thinking':
      out.thinking = REDACTED;
      break;
    case 'tool_use':
      out.id = block.id;
      out.name = block.name === 'Agent' ? 'Agent' : 'Tool'; // only the Agent tool matters to the parser
      out.input = block.name === 'Agent'
        ? pick(block.input ?? {}, ['subagent_type', 'model', 'run_in_background'])
        : {};
      if (block.name === 'Agent' && block.input?.description != null) out.input.description = `task ${block.id.slice(-4)}`;
      break;
    case 'tool_result':
      out.tool_use_id = block.tool_use_id;
      if ('is_error' in block) out.is_error = block.is_error;
      out.content = typeof block.content === 'string' ? REDACTED : [{ type: 'text', text: REDACTED }];
      break;
    default:
      break;
  }
  return out;
}

function anonymiseMessage(message) {
  const out = pick(message, ['role', 'id', 'model', 'type', 'stop_reason', 'stop_sequence', 'usage']);
  if (typeof message.content === 'string') out.content = REDACTED;
  else if (Array.isArray(message.content)) out.content = message.content.map(anonymiseBlock);
  return out;
}

function anonymiseToolUseResult(result) {
  if (Array.isArray(result)) return [];
  if (typeof result === 'string') return REDACTED;
  if (result && typeof result === 'object') {
    const out = pick(result, ['status', 'isAsync', 'agentId', 'resolvedModel']);
    if (result.agentId != null && result.description != null) out.description = `task ${String(result.agentId).slice(-4)}`;
    return out;
  }
  return result;
}

function anonymiseRecord(rec) {
  const type = rec.type;
  if (type in PER_TYPE_KEYS) {
    const out = pick(rec, [...CONVERSATION_KEYS, ...PER_TYPE_KEYS[type]]);
    if (rec.message) out.message = anonymiseMessage(rec.message);
    if ('toolUseResult' in rec) out.toolUseResult = anonymiseToolUseResult(rec.toolUseResult);
    if (type === 'attachment') out.attachment = { type: rec.attachment?.type };
    if (type === 'system' && rec.compactMetadata) {
      out.compactMetadata = pick(rec.compactMetadata, ['trigger', 'preTokens', 'postTokens', 'cumulativeDroppedTokens', 'durationMs']);
    }
    return out;
  }
  const out = pick(rec, ['type', ...(METADATA_KEYS[type] ?? ['sessionId'])]);
  if (type === 'ai-title') out.aiTitle = `AI title ${++titleCount}`;
  if (type === 'custom-title') out.customTitle = `Custom title ${++titleCount}`;
  if (type === 'agent-name') out.agentName = 'agent';
  if (type === 'file-history-snapshot') out.snapshot = {};
  return out;
}

const lines = readFileSync(inPath, 'utf8').split('\n').filter((l) => l.length > 0);
const out = lines.map((line) => JSON.stringify(anonymiseRecord(JSON.parse(line))));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out.join('\n') + '\n');
console.error(`${lines.length} lines -> ${outPath}`);
