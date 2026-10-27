import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppController } from '../src/app/controller.js';
import { AgentSession } from '../src/core/session.js';
import { PermissionController, PolicyHost } from '../src/core/permissions.js';
import { assistantText, assistantToolUse, initMsg, makeFakeQuery, resultMsg, toolResult, until } from './helpers/fake-query.js';

const project = () => realpathSync(mkdtempSync(join(tmpdir(), 'fc-proj-')));

describe('AgentSession', () => {
  it('runs in streaming-input mode with API-key auth and FrostCode options', async () => {
    const { queryFn, runs } = makeFakeQuery((p, run) => {
      run.emit(initMsg());
      run.emit(assistantText(`echo: ${p}`));
      run.emit(resultMsg(0.001));
    });
    const s = new AgentSession({ cwd: '/tmp', model: 'claude-haiku-5-5', permissionMode: 'default', permissions: new PermissionController(new PolicyHost(false)), queryFn });
    const seen: string[] = [];
    s.subscribe((m) => seen.push(m.type));
    s.send('hi');
    expect(s.busy).toBe(true);
    await until(() => !s.busy);
    const o = runs[0].options;
    expect(o.includePartialMessages).toBe(true);
    expect(o.model).toBe('claude-haiku-5-5');
    expect(o.permissionMode).toBe('default');
    expect(typeof o.canUseTool).toBe('function');
    expect(o.env?.ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);
    expect(o.env?.CLAUDE_CONFIG_DIR).toContain(process.env.FROSTCODE_HOME!);
    expect(o.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
    expect(seen).toEqual(['system', 'assistant', 'result']);
    expect(s.info.sessionId).toBe('sess-1');
    await s.close();
  });

  it('restarts after the runtime dies and resumes the same session', async () => {
    const { queryFn, runs } = makeFakeQuery((p, run) => {
      run.emit(initMsg('sess-9'));
      run.emit(resultMsg(0.001, 'sess-9'));
      if (p === 'crash') run.end(new Error('runtime exited with code 1'));
    });
    const s = new AgentSession({ cwd: '/tmp', permissionMode: 'default', permissions: new PermissionController(new PolicyHost(false)), queryFn });
    let exitError: Error | null | undefined;
    s.onExit = (e) => (exitError = e);
    s.send('crash');
    await until(() => exitError !== undefined);
    expect(exitError?.message).toContain('runtime exited');
    s.send('again');
    await until(() => runs.length === 2);
    expect(runs[1].options.resume).toBe('sess-9');
    await s.close();
  });

  it('forwards model, mode and interrupt to the live query', async () => {
    const { queryFn, runs } = makeFakeQuery(() => {});
    const s = new AgentSession({ cwd: '/tmp', permissionMode: 'default', permissions: new PermissionController(new PolicyHost(false)), queryFn });
    s.send('long task');
    await s.setModel('claude-opus-5-5');
    await s.setPermissionMode('plan');
    await s.interrupt();
    expect(runs[0].calls.map((c) => [c.method, c.args[0]])).toEqual([
      ['setModel', 'claude-opus-5-5'],
      ['setPermissionMode', 'plan'],
      ['interrupt', undefined],
    ]);
    await s.close();
  });
});

describe('AppController', () => {
  function setup(responder: Parameters<typeof makeFakeQuery>[0]) {
    const fake = makeFakeQuery(responder);
    const ctrl = new AppController({ cwd: project(), permissionMode: 'default', queryFn: fake.queryFn, costStore: null });
    return { ctrl, ...fake };
  }

  it('shows the conversation and tracks cost', async () => {
    const { ctrl } = setup((p, run) => {
      run.emit(initMsg());
      run.emit(assistantText('Hello there'));
      run.emit(resultMsg(0.0123));
    });
    await ctrl.boot();
    await ctrl.submit('hi');
    await until(() => !ctrl.busy && ctrl.cost.snapshot().turns === 1);
    expect(ctrl.transcript.items.map((i) => i.kind)).toEqual(['user', 'assistant']);
    expect(ctrl.cost.snapshot().sessionUsd).toBeCloseTo(0.0123);
    expect(ctrl.models.length).toBeGreaterThan(0);
    await ctrl.shutdown();
  });

  it('routes a permission request to the UI and back', async () => {
    const { ctrl, runs } = setup(async (_p, run) => {
      run.emit(initMsg());
      run.emit(assistantToolUse('tu1', 'Bash', { command: 'rm -rf build' }));
      const decision = await run.options.canUseTool!('Bash', { command: 'rm -rf build' }, { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1' } as never);
      run.emit(toolResult('tu1', decision.behavior === 'allow' ? 'removed' : 'denied', decision.behavior !== 'allow'));
      run.emit(resultMsg(0.001));
    });
    await ctrl.boot();
    await ctrl.submit('clean the build');
    await until(() => ctrl.pending.length === 1);
    expect(ctrl.pending[0].request).toMatchObject({ kind: 'tool', toolName: 'Bash', ruleLabel: 'Bash(rm:*)' });
    ctrl.answer({ kind: 'deny', feedback: 'keep the build dir' });
    await until(() => !ctrl.busy && ctrl.pending.length === 0);
    const tool = ctrl.transcript.items.find((i) => i.kind === 'tool');
    expect(tool).toMatchObject({ status: 'denied' });
    expect(runs).toHaveLength(1);
    await ctrl.shutdown();
  });

  it('handles slash commands locally and passes runtime commands through', async () => {
    const { ctrl, runs } = setup((_p, run) => {
      run.emit(initMsg());
      run.emit(resultMsg(0.001));
    });
    await ctrl.boot();
    await ctrl.submit('/model claude-sonnet-5-5');
    expect(runs[0].calls.find((c) => c.method === 'setModel')?.args[0]).toBe('claude-sonnet-5-5');
    expect(ctrl.model).toBe('claude-sonnet-5-5');
    await ctrl.submit('/plan');
    expect(ctrl.mode).toBe('plan');
    await ctrl.submit('/plan');
    expect(ctrl.mode).toBe('default');
    await ctrl.submit('/mode bypassPermissions');
    expect(ctrl.mode).toBe('default'); // not enabled at launch
    await ctrl.submit('/compact keep api notes');
    await until(() => runs[0].prompts.includes('/compact keep api notes'));
    await ctrl.submit('/nope');
    const last = ctrl.transcript.items[ctrl.transcript.items.length - 1];
    expect(last).toMatchObject({ kind: 'system', tone: 'error' });
    await ctrl.submit('/cost');
    expect(JSON.stringify(ctrl.transcript.items)).toContain('Session cost');
    await ctrl.shutdown();
  });

  it('/clear starts a new runtime and keeps the run total', async () => {
    const { ctrl, runs } = setup((_p, run) => {
      run.emit(initMsg(`sess-${runs.length}`));
      run.emit(resultMsg(0.01, `sess-${runs.length}`));
    });
    await ctrl.boot();
    await ctrl.submit('one');
    await until(() => ctrl.cost.snapshot().turns === 1);
    const epoch = ctrl.epoch;
    await ctrl.submit('/clear');
    expect(ctrl.epoch).toBe(epoch + 1);
    await ctrl.submit('two');
    await until(() => runs.length === 2 && ctrl.cost.snapshot().turns === 1 && !ctrl.busy);
    expect(ctrl.cost.snapshot().runUsd).toBeCloseTo(0.02);
    expect(runs[1].options.resume).toBeUndefined();
    await ctrl.shutdown();
  });

  it('shift+tab cycles default → acceptEdits → plan → default', async () => {
    const { ctrl } = setup(() => {});
    await ctrl.boot();
    await ctrl.cycleMode();
    expect(ctrl.mode).toBe('acceptEdits');
    await ctrl.cycleMode();
    expect(ctrl.mode).toBe('plan');
    await ctrl.cycleMode();
    expect(ctrl.mode).toBe('default');
    await ctrl.shutdown();
  });
});
