import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { HookCallbackMatcher, HookInput, Options } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'node:path';
import { prepareProcessEnv } from '../src/config/env.js';
import { GuiBackend, type BackendEvent } from '../src/gui/backend.js';
import { AppController } from '../src/app/controller.js';
import { acceptEditsShellGuard, runsFilesystemCommand } from '../src/core/accept-edits-guard.js';
import { modeLabel } from '../src/gui/renderer/store.js';
import { assistantToolUse, initMsg, makeFakeQuery, resultMsg, toolResult, until, type FakeRun } from './helpers/fake-query.js';
import { makeProject, writeTranscript } from './helpers/transcripts.js';

beforeAll(() => prepareProcessEnv());

const live: GuiBackend[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((b) => b.shutdown()));
});

function backendFor(cwd: string, responder: Parameters<typeof makeFakeQuery>[0] = () => {}) {
  const fake = makeFakeQuery(responder);
  const events: BackendEvent[] = [];
  const backend = new GuiBackend({
    defaultCwd: cwd,
    prefsFile: join(makeProject(), 'gui-state.json'),
    emit: (e) => events.push(e),
    queryFn: fake.queryFn,
    costStore: null,
    throttleMs: 0,
  });
  live.push(backend);
  return { backend, events, ...fake };
}

const modeCalls = (run: FakeRun) => run.calls.filter((c) => c.method === 'setPermissionMode').map((c) => c.args[0]);

/** Run the PreToolUse hooks the session registered, the way the runtime would. */
async function preToolUse(options: Options, command: string, permissionMode?: string) {
  const matchers = (options.hooks?.PreToolUse ?? []) as HookCallbackMatcher[];
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 't',
    session_id: 's',
    transcript_path: '/dev/null',
    cwd: '/tmp',
    permission_mode: permissionMode,
  } as unknown as HookInput;
  const out = [];
  for (const m of matchers) if (!m.matcher || m.matcher === 'Bash') for (const h of m.hooks) out.push(await h(input, 't', { signal: new AbortController().signal }));
  return out;
}
const decision = (outs: unknown[]) =>
  (outs.find((o) => (o as { hookSpecificOutput?: unknown }).hookSpecificOutput) as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)
    ?.hookSpecificOutput?.permissionDecision;

describe('desktop "Auto mode" switch', () => {
  it('turns the runtime auto mode on and off, never acceptEdits or bypass', async () => {
    const { backend, runs } = backendFor(makeProject());
    await backend.start();
    await backend.setAutoMode(true);
    expect(backend.snapshot().mode).toBe('auto');
    await backend.setAutoMode(false);
    expect(backend.snapshot().mode).toBe('default');
    expect(modeCalls(runs[0])).toEqual(['auto', 'default']);
    expect(backend.controller!.permissions.sessionRules.size).toBe(0);
  });
});

describe('auto-accept edits mode (Shift+Tab cycle)', () => {
  it('switches the live session with setPermissionMode, on and off, and never to bypass', async () => {
    const cwd = makeProject();
    const { backend, runs } = backendFor(cwd);
    await backend.start();
    expect(backend.snapshot().mode).toBe('default');
    expect(runs[0].options.permissionMode).toBe('default');
    expect(runs[0].options.allowDangerouslySkipPermissions).toBe(false);

    await backend.setMode('acceptEdits');
    expect(backend.snapshot().mode).toBe('acceptEdits');
    await backend.setMode('default');
    expect(backend.snapshot().mode).toBe('default');
    await backend.setMode('acceptEdits');

    expect(modeCalls(runs[0])).toEqual(['acceptEdits', 'default', 'acceptEdits']);
    expect(runs.flatMap(modeCalls)).not.toContain('bypassPermissions');
    // No blanket allow rules were added on the way.
    expect(backend.controller!.permissions.sessionRules.size).toBe(0);
  });

  it('is per conversation: a new one starts in Ask, and reopening restores the choice', async () => {
    const cwd = makeProject();
    const a = writeTranscript(cwd, [['first', 'one']]);
    const b = writeTranscript(cwd, [['second', 'two']]);
    const { backend, runs } = backendFor(cwd);
    await backend.refreshSessions(false);

    await backend.openSession(a, cwd);
    await backend.setMode('acceptEdits');
    expect(backend.snapshot().mode).toBe('acceptEdits');

    await backend.openSession(b, cwd);
    expect(backend.snapshot().mode).toBe('default');
    expect(runs.at(-1)!.options.permissionMode).toBe('default');

    await backend.newSession(cwd);
    expect(backend.snapshot().mode).toBe('default');

    await backend.openSession(a, cwd);
    expect(backend.snapshot().mode).toBe('acceptEdits');
    expect(runs.at(-1)!.options).toMatchObject({ resume: a, permissionMode: 'acceptEdits' });
  });

  it('edits applied without a prompt still appear in the conversation with their diff', async () => {
    const cwd = makeProject();
    const { backend } = backendFor(cwd, async (_p, run) => {
      run.emit(initMsg('s-edit'));
      // acceptEdits: the runtime approves the edit itself and never calls canUseTool.
      run.emit(assistantToolUse('e1', 'Edit', { file_path: join(cwd, 'a.txt'), old_string: 'cold', new_string: 'frozen' }));
      run.emit(toolResult('e1', 'The file has been updated.'));
      run.emit(resultMsg(0.001, 's-edit'));
    });
    await backend.start();
    await backend.setMode('acceptEdits');
    await backend.submit('rename cold to frozen');
    await until(() => !backend.controller!.busy && backend.controller!.transcript.items.some((i) => i.kind === 'tool' && i.status === 'done'));
    expect(backend.snapshot().prompt).toBeNull();
    const row = backend.initial().transcript.changed.find((i) => i.kind === 'tool');
    expect(row && row.kind === 'tool' && row.diff?.map((l) => `${l.type}:${l.text}`)).toEqual(['remove:cold', 'add:frozen']);
  });

  it('shell commands and MCP tools (Blender included) still ask while it is on', async () => {
    const cwd = makeProject();
    const asked: string[] = [];
    const { backend } = backendFor(cwd, async (_p, run) => {
      // The runtime's init reports the mode it is in, which the toggle already set.
      run.emit({ ...initMsg('s-ask'), permissionMode: 'acceptEdits' } as never);
      for (const [id, name, input] of [
        ['b1', 'Bash', { command: 'npm test' }],
        ['m1', 'mcp__blender__get_scene_info', {}],
      ] as const) {
        run.emit(assistantToolUse(id, name, input));
        const d = await run.options.canUseTool!(name, input, { signal: new AbortController().signal, toolUseID: id, requestId: 'r' } as never);
        asked.push(`${name}:${d.behavior}`);
        run.emit(toolResult(id, d.behavior, d.behavior !== 'allow'));
      }
      run.emit(resultMsg(0.001, 's-ask'));
    });
    await backend.start();
    await backend.setMode('acceptEdits');
    await backend.submit('test and look at the scene');

    await until(() => backend.snapshot().prompt !== null);
    expect(backend.snapshot().prompt).toMatchObject({ kind: 'tool', toolName: 'Bash' });
    backend.answer({ kind: 'allow' });
    await until(() => (backend.snapshot().prompt as { toolName?: string } | null)?.toolName === 'mcp__blender__get_scene_info');
    backend.answer({ kind: 'deny', feedback: 'not now' });
    await until(() => asked.length === 2);
    expect(asked).toEqual(['Bash:allow', 'mcp__blender__get_scene_info:deny']);
    expect(backend.snapshot().mode).toBe('acceptEdits');
  });

  it('sends filesystem shell commands back to the prompt only while acceptEdits is on', async () => {
    const cwd = makeProject();
    const { backend, runs } = backendFor(cwd);
    await backend.start();
    const opts = runs[0].options;

    expect(decision(await preToolUse(opts, 'rm -rf build'))).toBeUndefined(); // Ask mode: untouched
    await backend.setMode('acceptEdits');
    expect(decision(await preToolUse(opts, 'rm -rf build', 'acceptEdits'))).toBe('ask');
    expect(decision(await preToolUse(opts, 'mkdir out && mv a.txt out/'))).toBe('ask'); // the host's mode alone is enough
    expect(decision(await preToolUse(opts, 'npm test', 'acceptEdits'))).toBeUndefined(); // normal rules decide
    await backend.setMode('default');
    expect(decision(await preToolUse(opts, 'rm -rf build', 'default'))).toBeUndefined();
    // The guard only ever asks; it never allows.
    expect(JSON.stringify(await preToolUse(opts, 'rm x', 'acceptEdits'))).not.toContain('"allow"');
  });
});

describe('the guard', () => {
  it('spots filesystem commands anywhere in a shell line', () => {
    for (const c of ['rm a', 'cd x && rm a', 'echo hi; touch f', 'sudo mv a b', 'FOO=1 cp a b', 'cat a | tee b', '/bin/rm a', 'x=$(mkdir d)'])
      expect(runsFilesystemCommand(c), c).toBe(true);
    for (const c of ['npm test', 'git status', 'ls -la', 'grep rm notes.txt', 'echo "mv"']) expect(runsFilesystemCommand(c), c).toBe(false);
  });

  it('ignores other tools', async () => {
    const m = acceptEditsShellGuard(() => 'acceptEdits');
    const out = await m.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {}, permission_mode: 'acceptEdits' } as never, 't', {
      signal: new AbortController().signal,
    });
    expect(out).toEqual({});
  });
});

describe('the CLI is unchanged', () => {
  it('registers no shell guard unless the host asks for it (only the MCP approval hook)', async () => {
    const fake = makeFakeQuery(() => {});
    const ctrl = new AppController({ cwd: makeProject(), permissionMode: 'acceptEdits', queryFn: fake.queryFn, costStore: null });
    await ctrl.boot();
    expect(fake.runs[0].options.hooks?.PreToolUse?.map((m) => m.matcher)).toEqual(['mcp__.*']);
    expect(fake.runs[0].options.permissionMode).toBe('acceptEdits');
    await ctrl.shutdown();
  });
});

describe('mode label beside the composer', () => {
  it('names each mode plainly', () => {
    expect(['default', 'acceptEdits', 'plan', 'auto'].map(modeLabel)).toEqual(['Ask before edits', 'Auto-accept edits', 'Plan mode', 'Auto mode']);
  });
});
