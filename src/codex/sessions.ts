/**
 * Read-only access to OpenAI Codex session logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
 *
 * Nothing here writes, renames, locks or touches those files: they are only opened for
 * reading. Importing a session into FrostCode builds a separate handoff message.
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export type CodexStatus = 'in_progress' | 'interrupted' | 'completed' | 'unknown';

export interface CodexSessionSummary {
  id: string;
  file: string;
  cwd: string | null;
  model: string | null;
  cliVersion: string | null;
  startedAt: string | null;
  updatedAt: number;
  sizeBytes: number;
  status: CodexStatus;
  /** A Codex helper thread (e.g. an auto-review guardian) rather than a user conversation. */
  isSubagent: boolean;
  firstUserMessage: string | null;
  lastUserMessage: string | null;
  lastAgentMessage: string | null;
  /** Tool calls that never got an output. */
  pendingToolCalls: { name: string; args: string }[];
  turns: number;
  totalTokens: number | null;
}

export interface CodexTimelineEntry {
  role: 'user' | 'assistant' | 'tool' | 'tool_output' | 'event';
  text: string;
  timestamp?: string;
}

export interface CodexSessionDetail extends CodexSessionSummary {
  timeline: CodexTimelineEntry[];
}

export function defaultCodexRoot(): string {
  return process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'sessions') : join(homedir(), '.codex', 'sessions');
}

/** All rollout files under the sessions root, newest modification first. */
export async function findCodexSessionFiles(root = defaultCodexRoot()): Promise<{ file: string; mtime: number; size: number }[]> {
  const out: { file: string; mtime: number; size: number }[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 4) await walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const s = await stat(p);
          out.push({ file: p, mtime: s.mtimeMs, size: s.size });
        } catch {
          /* vanished */
        }
      }
    }
  }
  await walk(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

export interface ListOptions {
  root?: string;
  limit?: number;
  /** Only sessions whose last turn never completed (in progress or interrupted). */
  unfinishedOnly?: boolean;
  includeSubagents?: boolean;
}

export async function listCodexSessions(opts: ListOptions = {}): Promise<CodexSessionSummary[]> {
  const files = await findCodexSessionFiles(opts.root);
  const limit = opts.limit ?? 30;
  const out: CodexSessionSummary[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    let summary: CodexSessionSummary;
    try {
      summary = (await parseCodexFile(f.file, { timeline: false, mtime: f.mtime, size: f.size })).summary;
    } catch {
      continue;
    }
    if (!opts.includeSubagents && summary.isSubagent) continue;
    if (opts.unfinishedOnly && !isUnfinished(summary)) continue;
    out.push(summary);
  }
  return out;
}

export function isUnfinished(s: CodexSessionSummary): boolean {
  return s.status === 'in_progress' || s.status === 'interrupted';
}

/** Find a session by full id, id prefix, or file path. */
export async function findCodexSession(ref: string, root?: string): Promise<CodexSessionDetail | null> {
  const files = await findCodexSessionFiles(root);
  const needle = ref.trim();
  const hit = files.find((f) => f.file === needle || f.file.includes(needle));
  if (!hit) return null;
  const { summary, timeline } = await parseCodexFile(hit.file, { timeline: true, mtime: hit.mtime, size: hit.size });
  return { ...summary, timeline };
}

interface ParseOpts {
  timeline: boolean;
  mtime: number;
  size: number;
}

/** Stream one rollout file and summarize it. Tolerates older and newer record layouts. */
export async function parseCodexFile(
  file: string,
  opts: ParseOpts,
): Promise<{ summary: CodexSessionSummary; timeline: CodexTimelineEntry[] }> {
  const idFromName = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file)?.[1] ?? file;
  const s: CodexSessionSummary = {
    id: idFromName,
    file,
    cwd: null,
    model: null,
    cliVersion: null,
    startedAt: null,
    updatedAt: opts.mtime,
    sizeBytes: opts.size,
    status: 'unknown',
    isSubagent: false,
    firstUserMessage: null,
    lastUserMessage: null,
    lastAgentMessage: null,
    pendingToolCalls: [],
    turns: 0,
    totalTokens: null,
  };
  const timeline: CodexTimelineEntry[] = [];
  const pending = new Map<string, { name: string; args: string }>();
  let openTurn = false;
  let lastTerminal: 'complete' | 'aborted' | null = null;

  const stream = createReadStream(file, { encoding: 'utf8', flags: 'r' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const type = rec.type as string | undefined;
    const payload = (rec.payload ?? rec) as Record<string, unknown>;
    const ptype = payload.type as string | undefined;
    const ts = rec.timestamp as string | undefined;

    if (type === 'session_meta' || (!type && payload.id && payload.cwd && !s.startedAt)) {
      s.id = (payload.id as string) ?? s.id;
      s.cwd = (payload.cwd as string) ?? s.cwd;
      s.cliVersion = (payload.cli_version as string) ?? null;
      s.startedAt = (payload.timestamp as string) ?? ts ?? null;
      const source = payload.source as Record<string, unknown> | string | undefined;
      // Helper threads (e.g. the auto-review guardian) carry source.subagent; delegated and handed-off threads are real work.
      s.isSubagent = !!(source && typeof source === 'object' && 'subagent' in source);
      continue;
    }
    if (type === 'turn_context') {
      s.model = (payload.model as string) ?? s.model;
      s.cwd = (payload.cwd as string) ?? s.cwd;
      continue;
    }
    if (type === 'event_msg') {
      if (ptype === 'task_started') {
        openTurn = true;
        s.turns += 1;
      } else if (ptype === 'task_complete') {
        openTurn = false;
        lastTerminal = 'complete';
        if (typeof payload.last_agent_message === 'string') s.lastAgentMessage = payload.last_agent_message;
      } else if (ptype === 'turn_aborted') {
        openTurn = false;
        lastTerminal = 'aborted';
        if (opts.timeline) timeline.push({ role: 'event', text: `turn aborted (${payload.reason ?? 'unknown'})`, timestamp: ts });
      } else if (ptype === 'thread_settings_applied') {
        const model = (payload.thread_settings as Record<string, unknown> | undefined)?.model;
        if (typeof model === 'string') s.model = model;
      } else if (ptype === 'token_count') {
        const total = (payload.info as Record<string, any> | undefined)?.total_token_usage?.total_tokens;
        if (typeof total === 'number') s.totalTokens = total;
      } else if (ptype === 'user_message' && typeof payload.message === 'string') {
        noteUser(payload.message, ts);
      } else if (ptype === 'agent_message' && typeof payload.message === 'string') {
        s.lastAgentMessage = payload.message;
      }
      continue;
    }
    // Response items: the model-visible conversation.
    const item = type === 'response_item' ? payload : !type && ptype ? payload : null;
    if (!item) continue;
    if (ptype === 'message') {
      const role = item.role as string;
      const text = role === 'user' ? userItemText(item) : messageText(item.content);
      if (!text) continue;
      if (role === 'user') noteUser(text, ts);
      else if (role === 'assistant') {
        s.lastAgentMessage = text;
        if (opts.timeline) timeline.push({ role: 'assistant', text, timestamp: ts });
      }
    } else if (ptype === 'function_call' || ptype === 'custom_tool_call' || ptype === 'local_shell_call') {
      const callId = (item.call_id as string) ?? (item.id as string);
      const name = [item.namespace, item.name].filter(Boolean).join('.') || ptype;
      const args = String(item.arguments ?? item.input ?? JSON.stringify(item.action ?? ''));
      if (callId) pending.set(callId, { name, args: args.slice(0, 400) });
      if (opts.timeline) timeline.push({ role: 'tool', text: `${name}: ${args.slice(0, 2000)}`, timestamp: ts });
    } else if (ptype === 'function_call_output' || ptype === 'custom_tool_call_output' || ptype === 'local_shell_call_output') {
      const callId = item.call_id as string;
      if (callId) pending.delete(callId);
      // Threads created by another Codex thread receive their task inside a delegation envelope.
      if (!s.firstUserMessage && typeof item.output === 'string') {
        const delegated = /<codex_delegation>[\s\S]*?<input>([\s\S]*?)<\/input>/.exec(item.output)?.[1]?.trim();
        if (delegated) noteUser(delegated, ts);
      }
      if (opts.timeline) timeline.push({ role: 'tool_output', text: outputText(item.output).slice(0, 2000), timestamp: ts });
    }
  }

  function noteUser(raw: string, ts?: string): void {
    // Skip injected context blocks (environment, AGENTS.md, permissions) — not typed by the user.
    const text = stripInjectedBlocks(raw);
    if (!text || text.startsWith('# AGENTS.md')) return;
    if (!s.firstUserMessage) s.firstUserMessage = text;
    s.lastUserMessage = text;
    if (opts.timeline) timeline.push({ role: 'user', text, timestamp: ts });
  }

  s.pendingToolCalls = [...pending.values()];
  if (openTurn || s.pendingToolCalls.length) s.status = 'in_progress';
  else if (lastTerminal === 'aborted') s.status = 'interrupted';
  else if (lastTerminal === 'complete') s.status = 'completed';
  // Collapse consecutive duplicate user entries (Codex logs both the event and the response item).
  const deduped = timeline.filter((e, i) => !(i > 0 && e.role === 'user' && timeline[i - 1].role === 'user' && timeline[i - 1].text === e.text));
  return { summary: s, timeline: deduped };
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * The part of a user message the person actually typed. Newer logs label each content
 * item (user.text vs agents_md.instructions, environments.environment_context, ...);
 * older ones need the injected XML-ish blocks stripped.
 */
function userItemText(item: Record<string, unknown>): string {
  const content = item.content;
  const meta = item.internal_chat_message_metadata_passthrough as { content_item_kinds?: unknown } | undefined;
  const kinds = meta?.content_item_kinds;
  if (Array.isArray(content) && Array.isArray(kinds) && kinds.length === content.length) {
    return messageText(content.filter((_, i) => typeof kinds[i] === 'string' && (kinds[i] as string).startsWith('user.'))).trim();
  }
  return stripInjectedBlocks(messageText(content));
}

export function stripInjectedBlocks(text: string): string {
  let out = text.trim();
  for (let i = 0; i < 10; i++) {
    const m = /^<([A-Za-z_][\w-]*)\b[^>]*>[\s\S]*?<\/\1>\s*/.exec(out);
    if (!m) break;
    out = out.slice(m[0].length).trim();
  }
  return out;
}

function outputText(output: unknown): string {
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed.output === 'string') return parsed.output;
    } catch {
      /* plain text */
    }
    return output;
  }
  return messageText(output) || JSON.stringify(output ?? '');
}

const clip = (t: string | null, n: number) => (t ? (t.length > n ? t.slice(0, n) + '…' : t) : '');

/** A self-contained prompt that hands an unfinished Codex task to FrostCode. */
export function buildHandoffPrompt(d: CodexSessionDetail): string {
  const recent = d.timeline.slice(-24).map((e) => `[${e.role}] ${clip(e.text, 800)}`).join('\n');
  const pending = d.pendingToolCalls.map((p) => `- ${p.name}: ${clip(p.args, 300)}`).join('\n');
  return [
    `I'm handing you an unfinished OpenAI Codex session to continue. Its log (read-only, do not modify it) is ${d.file}.`,
    '',
    `Codex session ${d.id} — status: ${d.status}${d.model ? `, model ${d.model}` : ''}${d.cwd ? `, working directory ${d.cwd}` : ''}.`,
    '',
    '## Original request',
    clip(d.firstUserMessage, 4000) || '(not recorded)',
    d.lastUserMessage && d.lastUserMessage !== d.firstUserMessage ? `\n## Latest request\n${clip(d.lastUserMessage, 4000)}` : '',
    d.lastAgentMessage ? `\n## Codex's last message\n${clip(d.lastAgentMessage, 3000)}` : '',
    pending ? `\n## Tool calls that never returned\n${pending}` : '',
    recent ? `\n## Recent activity\n${recent}` : '',
    '',
    'First check the current state of the files involved (the work may be partly done), then summarize what remains and continue the task.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
