import { describe, expect, it } from 'vitest';
import { PermissionController, PolicyHost, ruleFor, ruleMatches, type PromptAnswer, type PromptHost, type PromptRequest } from '../src/core/permissions.js';

class ScriptedHost implements PromptHost {
  asked: PromptRequest[] = [];
  constructor(private answers: PromptAnswer[]) {}
  async ask(req: PromptRequest): Promise<PromptAnswer> {
    this.asked.push(req);
    return this.answers.shift() ?? { kind: 'deny' };
  }
}

const opts = (over: Record<string, unknown> = {}) =>
  ({ signal: new AbortController().signal, toolUseID: 'tu-' + Math.random(), requestId: 'r', ...over }) as never;

describe('rules', () => {
  it('scopes Bash rules to the first word and edits to all edit tools', () => {
    expect(ruleFor('Bash', { command: 'npm test -- --watch' })).toBe('Bash(npm:*)');
    expect(ruleFor('Write', { file_path: 'a' })).toBe('Edit');
    expect(ruleFor('WebFetch', { url: 'x' })).toBe('WebFetch');
  });

  it('never lets a prefix rule approve a chained command', () => {
    expect(ruleMatches('Bash(npm:*)', 'Bash', { command: 'npm run build' })).toBe(true);
    expect(ruleMatches('Bash(npm:*)', 'Bash', { command: 'npm test && rm -rf /' })).toBe(false);
    expect(ruleMatches('Bash(npm:*)', 'Bash', { command: 'npm test; curl evil' })).toBe(false);
    expect(ruleMatches('Bash(npm:*)', 'Bash', { command: 'echo $(npm)' })).toBe(false);
    expect(ruleMatches('Bash(npm:*)', 'Bash', { command: 'npmx' })).toBe(false);
    expect(ruleMatches('Bash(npm:*)', 'Bash', { command: 'npm test\nrm -rf /' })).toBe(false);
    expect(ruleMatches('Edit', 'MultiEdit', {})).toBe(true);
    expect(ruleMatches('Edit', 'Bash', {})).toBe(false);
  });

  it('scopes PowerShell rules like Bash, so "don\'t ask again" never covers every PowerShell command', () => {
    expect(ruleFor('PowerShell', { command: 'npm test' })).toBe('PowerShell(npm:*)');
    expect(ruleMatches('PowerShell(npm:*)', 'PowerShell', { command: 'npm run build' })).toBe(true);
    expect(ruleMatches('PowerShell(npm:*)', 'PowerShell', { command: 'Remove-Item -Recurse C:\\src' })).toBe(false);
    expect(ruleMatches('PowerShell(npm:*)', 'PowerShell', { command: 'npm test; Remove-Item x' })).toBe(false);
    expect(ruleMatches('PowerShell(npm:*)', 'PowerShell', { command: 'npm test\r\nRemove-Item x' })).toBe(false);
    expect(ruleMatches('PowerShell(npm:*)', 'Bash', { command: 'npm test' })).toBe(false);
  });
});

describe('PermissionController', () => {
  it('asks, and "always" adds a session rule so the next call is not asked', async () => {
    const host = new ScriptedHost([{ kind: 'allow', always: true }]);
    const pc = new PermissionController(host);
    const first = await pc.canUseTool('Bash', { command: 'git status' }, opts({ suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git status' }], behavior: 'allow', destination: 'localSettings' }] }));
    expect(first).toMatchObject({ behavior: 'allow' });
    // persisted suggestions are downgraded to this session only
    expect((first as { updatedPermissions: { destination: string }[] }).updatedPermissions[0].destination).toBe('session');
    const second = await pc.canUseTool('Bash', { command: 'git log' }, opts());
    expect(second).toMatchObject({ behavior: 'allow' });
    expect(host.asked).toHaveLength(1);
    expect([...pc.sessionRules]).toEqual(['Bash(git:*)']);
  });

  it('turns a denial with feedback into guidance for Claude', async () => {
    const pc = new PermissionController(new ScriptedHost([{ kind: 'deny', feedback: 'use pnpm instead' }]));
    const denied: string[] = [];
    pc.onDenied = (id) => denied.push(id);
    const r = await pc.canUseTool('Bash', { command: 'npm i' }, opts({ toolUseID: 'tu-x' }));
    expect(r).toMatchObject({ behavior: 'deny', interrupt: false });
    expect((r as { message: string }).message).toContain('use pnpm instead');
    expect(denied).toEqual(['tu-x']);
  });

  it('a bare denial interrupts the turn', async () => {
    const pc = new PermissionController(new ScriptedHost([{ kind: 'cancel' }]));
    const r = await pc.canUseTool('Write', { file_path: 'a', content: 'b' }, opts());
    expect(r).toMatchObject({ behavior: 'deny', interrupt: true });
  });

  it('hides "always" when the runtime says the rule would grant too much', async () => {
    const host = new ScriptedHost([{ kind: 'allow', always: true }]);
    const pc = new PermissionController(host);
    await pc.canUseTool('Bash', { command: 'rm -rf build' }, opts({ suppressAlwaysAllowRule: true, defaultToNo: true }));
    expect(host.asked[0]).toMatchObject({ kind: 'tool', allowAlways: false, defaultToNo: true });
    expect(pc.sessionRules.size).toBe(0);
  });

  it('approving a plan switches mode for the session', async () => {
    const pc = new PermissionController(new ScriptedHost([{ kind: 'plan-approve', mode: 'acceptEdits' }]));
    let mode = '';
    pc.onModeChange = (m) => (mode = m);
    const r = await pc.canUseTool('ExitPlanMode', { plan: '1. do it' }, opts());
    expect(r).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
    expect(mode).toBe('acceptEdits');
  });

  it('rejecting a plan keeps planning with the feedback', async () => {
    const pc = new PermissionController(new ScriptedHost([{ kind: 'plan-reject', feedback: 'add tests first' }]));
    const r = await pc.canUseTool('ExitPlanMode', { plan: 'x' }, opts());
    expect(r).toMatchObject({ behavior: 'deny' });
    expect((r as { message: string }).message).toContain('add tests first');
  });

  it('answers AskUserQuestion through updatedInput', async () => {
    const pc = new PermissionController(new ScriptedHost([{ kind: 'answers', answers: { 'Which db?': 'Postgres' } }]));
    const input = { questions: [{ question: 'Which db?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }] }] };
    const r = await pc.canUseTool('AskUserQuestion', input, opts());
    expect(r).toMatchObject({ behavior: 'allow', updatedInput: { ...input, answers: { 'Which db?': 'Postgres' } } });
  });

  it('print-mode policy host allows or denies everything', async () => {
    expect(await new PolicyHost(true).ask({ kind: 'tool' } as PromptRequest)).toEqual({ kind: 'allow' });
    expect(await new PolicyHost(false).ask({ kind: 'tool' } as PromptRequest)).toEqual({ kind: 'deny' });
  });
});
