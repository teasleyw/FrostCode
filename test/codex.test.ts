import { describe, expect, it, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildHandoffPrompt, findCodexSession, listCodexSessions, stripInjectedBlocks } from '../src/codex/sessions.js';

const line = (o: unknown) => JSON.stringify(o);
const meta = (id: string, extra: Record<string, unknown> = {}) =>
  line({ timestamp: '2026-10-26T10:00:00Z', type: 'session_meta', payload: { id, cwd: '/work/proj', cli_version: '0.1', timestamp: '2026-10-26T10:00:00Z', source: 'vscode', ...extra } });
const ctx = (model = 'gpt-6') => line({ type: 'turn_context', payload: { cwd: '/work/proj', model } });
const started = line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } });
const complete = (msg: string) => line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: msg } });
const userItem = (text: string, kinds?: string[]) =>
  line({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: kinds ? kinds.map((k, i) => ({ type: 'input_text', text: i === kinds.length - 1 ? text : `<environment_context>junk</environment_context>` })) : [{ type: 'input_text', text }],
      ...(kinds ? { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } : {}),
    },
  });
const agentItem = (text: string) => line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const call = (callId: string, name = 'exec_command') => line({ type: 'response_item', payload: { type: 'function_call', name, arguments: '{"cmd":"npm test"}', call_id: callId } });
const output = (callId: string) => line({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: '{"output":"ok"}' } });

let root: string;
const files: Record<string, string> = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
  const day = join(root, '2026', '10', '26');
  mkdirSync(day, { recursive: true });
  const write = (name: string, id: string, lines: string[], mtime: number) => {
    const p = join(day, `rollout-2026-10-26T10-00-00-${id}.jsonl`);
    writeFileSync(p, lines.join('\n') + '\n');
    const t = new Date(Date.UTC(2026, 9, 26, 10, mtime));
    utimesSync(p, t, t);
    files[name] = p;
  };
  write('done', '11111111-1111-4111-8111-111111111111', [meta('11111111-1111-4111-8111-111111111111'), ctx(), started, userItem('fix the login bug', ['agents_md.instructions', 'user.text']), agentItem('Fixed it.'), complete('Fixed it.')], 1);
  write('running', '22222222-2222-4222-8222-222222222222', [meta('22222222-2222-4222-8222-222222222222'), ctx('gpt-6-astra'), started, userItem('add dark mode'), agentItem('Working on the theme toggle.'), call('c1'), output('c1'), call('c2')], 2);
  write('aborted', '33333333-3333-4333-8333-333333333333', [meta('33333333-3333-4333-8333-333333333333'), ctx(), started, userItem('<environment_context>x</environment_context>\nrefactor utils'), line({ type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } })], 3);
  write('helper', '44444444-4444-4444-8444-444444444444', [meta('44444444-4444-4444-8444-444444444444', { source: { subagent: { other: 'guardian' } } }), ctx(), started, userItem('judge this action')], 4);
  write('delegated', '55555555-5555-4555-8555-555555555555', [meta('55555555-5555-4555-8555-555555555555', { thread_source: 'agent_created_thread' }), ctx(), started, line({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'd', output: '<codex_delegation><input>Build the settings page</input></codex_delegation>' } })], 5);
  writeFileSync(join(day, 'garbage.jsonl'), 'not json\n{"half":');
});

describe('Codex sessions (read-only)', () => {
  it('classifies status and skips helper threads by default', async () => {
    const all = await listCodexSessions({ root, limit: 50 });
    const byId = Object.fromEntries(all.map((s) => [s.id.slice(0, 8), s]));
    expect(byId['11111111'].status).toBe('completed');
    expect(byId['22222222'].status).toBe('in_progress');
    expect(byId['22222222'].pendingToolCalls).toEqual([{ name: 'exec_command', args: '{"cmd":"npm test"}' }]);
    expect(byId['33333333'].status).toBe('interrupted');
    expect(byId['44444444']).toBeUndefined();
    expect(byId['55555555'].status).toBe('in_progress');
    const withHelpers = await listCodexSessions({ root, limit: 50, includeSubagents: true });
    expect(withHelpers.find((s) => s.id.startsWith('44444444'))?.isSubagent).toBe(true);
  });

  it('extracts what the user typed, not injected context', async () => {
    const all = await listCodexSessions({ root, limit: 50 });
    const req = (p: string) => all.find((s) => s.id.startsWith(p))!.firstUserMessage;
    expect(req('11111111')).toBe('fix the login bug');
    expect(req('33333333')).toBe('refactor utils');
    expect(req('55555555')).toBe('Build the settings page');
    expect(all.find((s) => s.id.startsWith('22222222'))!.model).toBe('gpt-6-astra');
  });

  it('lists only unfinished sessions, newest first', async () => {
    const unfinished = await listCodexSessions({ root, unfinishedOnly: true });
    expect(unfinished.map((s) => s.id.slice(0, 8))).toEqual(['55555555', '33333333', '22222222']);
  });

  it('builds a handoff prompt with the request, last reply and pending calls', async () => {
    const d = await findCodexSession('22222222', root);
    expect(d).not.toBeNull();
    const prompt = buildHandoffPrompt(d!);
    expect(prompt).toContain('add dark mode');
    expect(prompt).toContain('Working on the theme toggle.');
    expect(prompt).toContain('exec_command');
    expect(prompt).toContain('do not modify it');
    expect(d!.timeline.some((e) => e.role === 'tool')).toBe(true);
  });

  it('never modifies the logs it reads', async () => {
    const fingerprint = () =>
      Object.values(files).map((f) => {
        const s = statSync(f);
        return `${f}:${s.mtimeMs}:${s.size}:${createHash('sha256').update(readFileSync(f)).digest('hex')}`;
      });
    const before = fingerprint();
    await listCodexSessions({ root, limit: 50, includeSubagents: true });
    for (const name of Object.keys(files)) await findCodexSession(files[name], root);
    expect(fingerprint()).toEqual(before);
  });

  it('strips leading injected blocks', () => {
    expect(stripInjectedBlocks('<a>x</a>\n<b k="1">y</b> hello')).toBe('hello');
    expect(stripInjectedBlocks('plain <b>text</b>')).toBe('plain <b>text</b>');
  });
});
