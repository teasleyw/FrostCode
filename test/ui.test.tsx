import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageView } from '../src/ui/components/MessageView.js';
import { PermissionPrompt } from '../src/ui/components/PermissionPrompt.js';
import { SelectList } from '../src/ui/components/SelectList.js';
import { PromptInput } from '../src/ui/components/PromptInput.js';
import { History } from '../src/ui/editor.js';
import { tick } from './helpers/fake-query.js';

const strip = (s = '') => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('MessageView', () => {
  it('renders a finished edit with header, summary and numbered diff', () => {
    const { lastFrame } = render(
      <MessageView
        cwd="/repo"
        width={100}
        item={{
          kind: 'tool',
          id: 't1',
          name: 'Edit',
          status: 'done',
          input: { file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' },
          detail: { structuredPatch: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-const a = 1;', '+const a = 2;'] }] },
        }}
      />,
    );
    const out = strip(lastFrame());
    const rel = join('src', 'app.ts'); // src\app.ts on Windows
    expect(out).toContain(`● Update(${rel})`);
    expect(out).toContain(`⎿  Updated ${rel} with 1 addition and 1 removal`);
    expect(out).toMatch(/10 - const a = 1;/);
    expect(out).toMatch(/10 \+ const a = 2;/);
  });

  it('renders assistant markdown and user prompts', () => {
    const a = render(<MessageView cwd="/" width={80} item={{ kind: 'assistant', id: 'a', text: 'Use **bold**', streaming: false }} />);
    expect(strip(a.lastFrame())).toContain('● Use bold');
    const u = render(<MessageView cwd="/" width={80} item={{ kind: 'user', id: 'u', text: 'fix it' }} />);
    expect(strip(u.lastFrame())).toContain('> fix it');
  });
});

describe('PermissionPrompt', () => {
  it('previews a Bash command and answers with the number keys', async () => {
    const onAnswer = vi.fn();
    const { lastFrame, stdin } = render(
      <PermissionPrompt
        cwd="/repo"
        width={90}
        onAnswer={onAnswer}
        request={{ kind: 'tool', id: 'r', toolName: 'Bash', toolUseId: 't', input: { command: 'npm test', description: 'Run tests' }, allowAlways: true, defaultToNo: false, ruleLabel: 'Bash(npm:*)' }}
      />,
    );
    const out = strip(lastFrame());
    expect(out).toContain('Bash command');
    expect(out).toContain('npm test');
    expect(out).toContain("Yes, and don't ask again for npm commands this session");
    await tick(20);
    stdin.write('2');
    await tick(20);
    expect(onAnswer).toHaveBeenCalledWith({ kind: 'allow', always: true });
  });

  it('shows the diff of a proposed edit and collects feedback on "No"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-ui-'));
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    const onAnswer = vi.fn();
    const { lastFrame, stdin } = render(
      <PermissionPrompt
        cwd={dir}
        width={90}
        onAnswer={onAnswer}
        request={{ kind: 'tool', id: 'r', toolName: 'Edit', toolUseId: 't', input: { file_path: join(dir, 'a.txt'), old_string: 'two', new_string: 'TWO' }, allowAlways: true, defaultToNo: false, ruleLabel: 'Edit' }}
      />,
    );
    const out = strip(lastFrame());
    expect(out).toContain('Do you want to make this edit to a.txt?');
    expect(out).toMatch(/2 - two/);
    expect(out).toMatch(/2 \+ TWO/);
    await tick(20);
    stdin.write('3');
    await tick(20);
    stdin.write('lowercase please');
    await tick(20);
    stdin.write('\r');
    await tick(20);
    expect(onAnswer).toHaveBeenCalledWith({ kind: 'deny', feedback: 'lowercase please' });
  });

  it('presents a plan with the three Claude Code choices', async () => {
    const onAnswer = vi.fn();
    const { lastFrame, stdin } = render(<PermissionPrompt cwd="/" width={90} onAnswer={onAnswer} request={{ kind: 'plan', id: 'p', toolUseId: 't', plan: '## Plan\n1. Add tests' }} />);
    const out = strip(lastFrame());
    expect(out).toContain('Ready to code?');
    expect(out).toContain('Yes, and auto-accept edits');
    expect(out).toContain('1. Add tests');
    await tick(20);
    stdin.write('2');
    await tick(20);
    expect(onAnswer).toHaveBeenCalledWith({ kind: 'plan-approve', mode: 'default' });
  });
});

describe('SelectList', () => {
  it('filters as you type and selects with enter', async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin } = render(
      <SelectList
        title="Select model"
        items={[
          { label: 'Opus', value: 'opus' },
          { label: 'Haiku', value: 'haiku' },
        ]}
        onSelect={onSelect}
        onCancel={() => {}}
      />,
    );
    expect(strip(lastFrame())).toContain('❯ Opus');
    await tick(20);
    stdin.write('hai');
    await tick(20);
    expect(strip(lastFrame())).toContain('❯ Haiku');
    stdin.write('\r');
    await tick(20);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ value: 'haiku' }));
  });
});

describe('PromptInput', () => {
  it('submits on enter, supports \\ + enter newlines and command completion', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = render(
      <PromptInput active history={new History()} placeholder="type" width={80} onSubmit={onSubmit} suggest={(v) => (v.startsWith('/mo') ? [{ name: 'model', description: 'Switch model' }] : [])} />,
    );
    await tick(20);
    stdin.write('line one\\');
    await tick(10);
    stdin.write('\r');
    await tick(10);
    stdin.write('line two');
    await tick(10);
    stdin.write('\r');
    await tick(20);
    expect(onSubmit).toHaveBeenCalledWith('line one\nline two');
    stdin.write('/mo');
    await tick(20);
    expect(strip(lastFrame())).toContain('/model');
    stdin.write('\r');
    await tick(20);
    expect(onSubmit).toHaveBeenLastCalledWith('/model');
  });
});
