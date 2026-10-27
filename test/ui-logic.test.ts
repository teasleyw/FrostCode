import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeCommand, findCommand, nextMode, parseSlash } from '../src/commands/registry.js';
import * as ed from '../src/ui/editor.js';
import { diffLines, displayPath, proposedPatch, toolHeader, toolSummary } from '../src/ui/tools.js';
import { renderMarkdown } from '../src/ui/markdown.js';
import { parseArgs } from '../src/cli-args.js';

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('slash commands', () => {
  it('parses commands and arguments', () => {
    expect(parseSlash('/model claude-haiku-5-5')).toEqual({ name: 'model', args: 'claude-haiku-5-5' });
    expect(parseSlash('/clear')).toEqual({ name: 'clear', args: '' });
    expect(parseSlash('hello /model')).toBeNull();
    expect(parseSlash('/compact keep the API notes')).toEqual({ name: 'compact', args: 'keep the API notes' });
  });

  it('resolves aliases and completes prefixes', () => {
    expect(findCommand('quit')?.name).toBe('exit');
    expect(findCommand('new')?.name).toBe('clear');
    expect(completeCommand('/co')).toEqual(expect.arrayContaining(['cost', 'codex', 'compact', 'context']));
    expect(completeCommand('/re', undefined, ['review'])).toEqual(['rename', 'resume', 'review']);
  });

  it('cycles modes like Claude Code, bypass only when enabled', () => {
    expect(nextMode('default', false)).toBe('acceptEdits');
    expect(nextMode('acceptEdits', false)).toBe('plan');
    expect(nextMode('plan', false)).toBe('default');
    expect(nextMode('plan', true)).toBe('bypassPermissions');
  });
});

describe('line editor', () => {
  it('inserts, deletes and moves', () => {
    let s = ed.insert(ed.empty, 'hello world');
    s = ed.deleteWord(s);
    expect(s).toEqual({ value: 'hello ', cursor: 6 });
    s = ed.lineStart(s);
    s = ed.insert(s, '> ');
    expect(s.value).toBe('> hello ');
    s = ed.killToEnd(s);
    expect(s.value).toBe('> ');
  });

  it('moves vertically across lines and reports the edges', () => {
    const s = ed.setValue('ab\ncdef');
    const up = ed.vertical(s, -1)!;
    expect(up.cursor).toBe(2);
    expect(ed.vertical(up, -1)).toBeNull();
  });

  it('keeps a shell-like history with a draft', () => {
    const h = new ed.History(['one', 'two']);
    expect(h.prev('draft')).toBe('two');
    expect(h.prev('')).toBe('one');
    expect(h.prev('')).toBeNull();
    expect(h.next()).toBe('two');
    expect(h.next()).toBe('draft');
  });
});

describe('tool display', () => {
  const cwd = '/repo';
  it('labels tools like Claude Code', () => {
    // Relative paths use the platform's separator (src\a.ts on Windows).
    expect(toolHeader('Edit', { file_path: '/repo/src/a.ts' }, cwd)).toEqual({ verb: 'Update', arg: join('src', 'a.ts') });
    expect(toolHeader('Bash', { command: 'npm test' }, cwd)).toEqual({ verb: 'Bash', arg: 'npm test' });
    expect(toolHeader('PowerShell', { command: 'Get-ChildItem\r\nnpm test' }, cwd)).toEqual({ verb: 'PowerShell', arg: 'Get-ChildItem ⏎ npm test' });
    expect(toolHeader('Grep', { pattern: 'TODO', path: '/repo/src' }, cwd).arg).toBe('pattern: "TODO", path: "src"');
    expect(toolHeader('mcp__github__get_issue', { id: '12' }, cwd).verb).toBe('github · get_issue (MCP)');
    expect(displayPath('/elsewhere/x', cwd)).toBe('/elsewhere/x');
  });

  it('summarizes results', () => {
    const base = { kind: 'tool' as const, id: 't', status: 'done' as const };
    expect(toolSummary({ ...base, name: 'Read', input: {}, result: '', detail: { file: { content: 'a\nb\n', numLines: 3 } } }, cwd)).toBe('Read 2 lines');
    expect(toolSummary({ ...base, name: 'Bash', input: {}, result: '1\n2\n3\n4\n5\n6\n7' }, cwd)).toBe('1\n2\n3\n4\n5\n… +2 lines');
    expect(toolSummary({ ...base, status: 'denied', name: 'Bash', input: {}, result: 'x' }, cwd)).toBe('Denied by you');
    expect(toolSummary({ ...base, status: 'error', name: 'Bash', input: {}, result: '<tool_use_error>boom</tool_use_error>' }, cwd)).toBe('boom');
    expect(
      toolSummary(
        { ...base, name: 'Edit', input: { file_path: '/repo/a.ts' }, detail: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] }] } },
        cwd,
      ),
    ).toBe('Updated a.ts with 2 additions and 1 removal');
  });

  it('previews an edit with the file\'s real line numbers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-diff-'));
    const file = join(dir, 'f.txt');
    writeFileSync(file, ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'target', 'l8'].join('\n') + '\n');
    const hunks = proposedPatch('Edit', { file_path: file, old_string: 'target', new_string: 'changed' }, dir);
    const { lines } = diffLines(hunks);
    expect(lines.find((l) => l.type === 'remove')).toMatchObject({ text: 'target', oldNo: 7 });
    expect(lines.find((l) => l.type === 'add')).toMatchObject({ text: 'changed', newNo: 7 });
    const created = proposedPatch('Write', { file_path: join(dir, 'new.txt'), content: 'x\ny\n' }, dir);
    expect(diffLines(created).lines.filter((l) => l.type === 'add')).toHaveLength(2);
  });
});

describe('markdown', () => {
  it('renders the common constructs to plain-readable text', () => {
    const out = strip(renderMarkdown('# Title\nSome **bold** and `code`.\n- item\n1. first\n```ts\nconst x = 1;\n```'));
    expect(out).toContain('Title');
    expect(out).toContain('Some bold and code.');
    expect(out).toContain('• item');
    expect(out).toContain('1. first');
    expect(out).toContain('const x = 1;');
    expect(out).not.toContain('```');
  });
});

describe('cli args', () => {
  it('parses flags and the prompt', () => {
    const a = parseArgs(['-m', 'haiku', '--plan', '-C', '/tmp', 'fix', 'the', 'bug']);
    expect(a).toMatchObject({ model: 'haiku', permissionMode: 'plan', cwd: '/tmp', prompt: 'fix the bug' });
    expect(parseArgs(['--resume']).resume).toBe(true);
    expect(parseArgs(['--resume', 'abc']).resume).toBe('abc');
    expect(parseArgs(['-p', '-y', 'hi'])).toMatchObject({ print: true, yes: true, prompt: 'hi' });
    expect(parseArgs(['codex', 'all']).sub).toEqual(['codex', 'all']);
    expect(() => parseArgs(['--permission-mode', 'yolo'])).toThrow(/Unknown permission mode/);
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown option/);
  });
});
