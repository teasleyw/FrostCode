import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { structuredPatch } from 'diff';
import type { TranscriptItem } from '../core/transcript.js';

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export type DiffLine = { type: 'add' | 'remove' | 'context' | 'gap'; text: string; oldNo?: number; newNo?: number };

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

export function displayPath(p: string, cwd: string): string {
  if (!p) return p;
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(cwd, abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Claude Code-style "Verb(argument)" header for a tool call. */
export function toolHeader(name: string, input: Record<string, unknown>, cwd: string): { verb: string; arg: string } {
  const path = (k = 'file_path') => displayPath(str(input[k]), cwd);
  switch (name) {
    case 'Read':
      return { verb: 'Read', arg: path() };
    case 'Edit':
    case 'MultiEdit':
      return { verb: 'Update', arg: path() };
    case 'Write':
      return { verb: 'Write', arg: path() };
    case 'NotebookEdit':
      return { verb: 'Edit Notebook', arg: path('notebook_path') };
    case 'Bash':
      return { verb: 'Bash', arg: clip(str(input.command).replace(/\s*\n\s*/g, ' ⏎ '), 160) };
    case 'Grep':
      return { verb: 'Search', arg: `pattern: "${clip(str(input.pattern), 60)}"${input.path ? `, path: "${displayPath(str(input.path), cwd)}"` : ''}` };
    case 'Glob':
      return { verb: 'Search', arg: `pattern: "${clip(str(input.pattern), 60)}"${input.path ? `, path: "${displayPath(str(input.path), cwd)}"` : ''}` };
    case 'WebFetch':
      return { verb: 'Fetch', arg: clip(str(input.url), 100) };
    case 'WebSearch':
      return { verb: 'Web Search', arg: `"${clip(str(input.query), 80)}"` };
    case 'Agent':
    case 'Task':
      return { verb: str(input.subagent_type) || 'Agent', arg: clip(str(input.description), 80) };
    case 'TodoWrite':
      return { verb: 'Update Todos', arg: '' };
    case 'ExitPlanMode':
      return { verb: 'Plan', arg: 'ready for review' };
    case 'AskUserQuestion':
      return { verb: 'Question', arg: '' };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
      return { verb: mcp ? `${mcp[1]} - ${mcp[2]}` : name, arg: first ? clip(first, 80) : '' };
    }
  }
}

const countLines = (s: string) => (s ? s.replace(/\n$/, '').split('\n').length : 0);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** One-line (or few-line) result shown under the tool header after "⎿". */
export function toolSummary(item: Extract<TranscriptItem, { kind: 'tool' }>, cwd: string): string {
  const result = item.result ?? '';
  if (item.status === 'running') return item.name === 'Bash' ? 'Running…' : '';
  if (item.status === 'denied') return 'Denied by you';
  if (item.status === 'error') return firstLines(cleanError(result), 4) || 'Error';
  const detail = item.detail as Record<string, any> | undefined;
  switch (item.name) {
    case 'Read': {
      // The runtime counts a trailing newline as a line; count the content itself.
      const n = typeof detail?.file?.content === 'string' ? countLines(detail.file.content) : (detail?.file?.numLines ?? countLines(result));
      return `Read ${plural(n, 'line')}`;
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const hunks = patchFor(item, cwd);
      const { add, remove } = countChanges(hunks);
      const p = displayPath(str(item.input.file_path), cwd);
      if (item.name === 'Write' && (detail?.type === 'create' || !hunks.length)) {
        return `Wrote ${plural(countLines(str(item.input.content)), 'line')} to ${p}`;
      }
      return `Updated ${p} with ${plural(add, 'addition')} and ${plural(remove, 'removal')}`;
    }
    case 'Bash':
      return firstLines(result.trimEnd(), 5) || '(no output)';
    case 'Grep':
    case 'Glob': {
      const n = detail?.numFiles ?? detail?.filenames?.length ?? (result.trim() ? result.trim().split('\n').length : 0);
      return /^No (files|matches)/.test(result) ? result.split('\n')[0] : `Found ${plural(n, item.name === 'Grep' && detail?.mode === 'content' ? 'line' : 'file')}`;
    }
    case 'TodoWrite':
      return todoSummary(item.input);
    case 'WebFetch':
      return firstLines(result, 2);
    default:
      return firstLines(result, 3);
  }
}

function cleanError(s: string): string {
  return s.replace(/<\/?tool_use_error>/g, '').trim();
}

export function firstLines(s: string, n: number): string {
  const lines = s.split('\n');
  if (lines.length <= n) return lines.map((l) => clip(l, 200)).join('\n');
  return [...lines.slice(0, n).map((l) => clip(l, 200)), `… +${lines.length - n} lines`].join('\n');
}

function todoSummary(input: Record<string, unknown>): string {
  const todos = Array.isArray(input.todos) ? (input.todos as { content?: string; status?: string }[]) : [];
  return todos.map((t) => `${t.status === 'completed' ? '☒' : t.status === 'in_progress' ? '◐' : '☐'} ${t.content ?? ''}`).join('\n');
}

export function countChanges(hunks: Hunk[]): { add: number; remove: number } {
  let add = 0;
  let remove = 0;
  for (const h of hunks) for (const l of h.lines) {
    if (l.startsWith('+')) add++;
    else if (l.startsWith('-')) remove++;
  }
  return { add, remove };
}

/** Hunks for a finished edit: the runtime's structured patch if present, else computed from the input. */
export function patchFor(item: Extract<TranscriptItem, { kind: 'tool' }>, cwd: string): Hunk[] {
  const detail = item.detail as { structuredPatch?: Hunk[] } | undefined;
  if (detail?.structuredPatch?.length) return detail.structuredPatch;
  return proposedPatch(item.name, item.input, cwd, false);
}

/**
 * Hunks for a proposed edit (before it runs), with real line numbers when the file can be read.
 * `readFile` false means the edit already happened, so the file on disk is the result, not the base.
 */
export function proposedPatch(name: string, input: Record<string, unknown>, cwd: string, readFile = true): Hunk[] {
  const file = str(input.file_path);
  const abs = file ? (isAbsolute(file) ? file : resolve(cwd, file)) : '';
  let original: string | null = null;
  if (readFile && abs) {
    try {
      original = readFileSync(abs, 'utf8');
    } catch {
      original = null;
    }
  }
  if (name === 'Write') {
    return structuredPatch(file, file, original ?? '', str(input.content), '', '', { context: 3 }).hunks;
  }
  const edits: { old_string: string; new_string: string; replace_all?: boolean }[] =
    name === 'MultiEdit' && Array.isArray(input.edits)
      ? (input.edits as never[])
      : [{ old_string: str(input.old_string), new_string: str(input.new_string), replace_all: !!input.replace_all }];
  if (original !== null && edits.every((e) => original!.includes(e.old_string))) {
    let next = original;
    for (const e of edits) next = e.replace_all ? next.split(e.old_string).join(e.new_string) : next.replace(e.old_string, () => e.new_string);
    return structuredPatch(file, file, original, next, '', '', { context: 3 }).hunks;
  }
  // No readable base: diff the snippets themselves (line numbers relative to the snippet).
  return edits.flatMap((e) => structuredPatch(file, file, e.old_string + '\n', e.new_string + '\n', '', '', { context: 3 }).hunks);
}

/** Flatten hunks into numbered display lines, with a gap marker between hunks. */
export function diffLines(hunks: Hunk[], maxLines = 60): { lines: DiffLine[]; truncated: number } {
  const out: DiffLine[] = [];
  hunks.forEach((h, hi) => {
    if (hi > 0) out.push({ type: 'gap', text: '...' });
    let o = h.oldStart;
    let n = h.newStart;
    for (const l of h.lines) {
      const text = l.slice(1);
      if (l.startsWith('\\')) continue; // "\ No newline at end of file"
      if (l.startsWith('+')) out.push({ type: 'add', text, newNo: n++ });
      else if (l.startsWith('-')) out.push({ type: 'remove', text, oldNo: o++ });
      else out.push({ type: 'context', text, oldNo: o++, newNo: n++ });
    }
  });
  if (out.length <= maxLines) return { lines: out, truncated: 0 };
  return { lines: out.slice(0, maxLines), truncated: out.length - maxLines };
}

export function isEditTool(name: string): boolean {
  return name === 'Edit' || name === 'MultiEdit' || name === 'Write';
}
