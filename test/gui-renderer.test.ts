import { describe, expect, it } from 'vitest';
import type { GuiItem, GuiProjectGroup } from '../src/gui/protocol.js';
import { applyPatch, emptyTranscript, filterGroups, flatSessions, ipcErrorMessage, nextMode, relativeTime, transcriptList } from '../src/gui/renderer/store.js';
import { renderMarkdown } from '../src/gui/renderer/Markdown.js';

const user = (id: string, text: string): GuiItem => ({ kind: 'user', id, text });
const asst = (id: string, text: string, streaming = false): GuiItem => ({ kind: 'assistant', id, text, streaming });

describe('transcript patches', () => {
  it('merges incremental patches and resets on a new conversation', () => {
    let t = applyPatch(emptyTranscript(), { reset: true, order: ['u1', 'a1'], changed: [user('u1', 'hi'), asst('a1', 'He', true)] });
    t = applyPatch(t, { reset: false, order: ['u1', 'a1'], changed: [asst('a1', 'Hello', false)] });
    expect(transcriptList(t).map((i) => ('text' in i ? i.text : ''))).toEqual(['hi', 'Hello']);
    t = applyPatch(t, { reset: true, order: ['u9'], changed: [user('u9', 'other session')] });
    expect(transcriptList(t)).toEqual([user('u9', 'other session')]);
  });

  it('drops items that left the order', () => {
    let t = applyPatch(emptyTranscript(), { reset: true, order: ['a', 'b'], changed: [user('a', '1'), user('b', '2')] });
    t = applyPatch(t, { reset: false, order: ['b'], changed: [] });
    expect(t.items.has('a')).toBe(false);
    expect(t.order).toEqual(['b']);
  });
});

describe('session search', () => {
  const groups: GuiProjectGroup[] = [
    { cwd: '/w/api', name: 'api', label: '~/w/api', exists: true, lastActivity: 3, sessions: [
      { id: '1', title: 'Fix login redirect', lastModified: 3, cwd: '/w/api', gitBranch: 'auth' },
      { id: '2', title: 'Add rate limiting', lastModified: 2, cwd: '/w/api' },
    ] },
    { cwd: '/w/web', name: 'web', label: '~/w/web', exists: true, lastActivity: 1, sessions: [{ id: '3', title: 'Login page styles', lastModified: 1, cwd: '/w/web' }] },
  ];

  it('matches every word against title, project and branch', () => {
    expect(flatSessions(filterGroups(groups, 'login')).map((s) => s.id)).toEqual(['1', '3']);
    expect(flatSessions(filterGroups(groups, 'login web')).map((s) => s.id)).toEqual(['3']);
    expect(flatSessions(filterGroups(groups, 'auth')).map((s) => s.id)).toEqual(['1']);
    expect(filterGroups(groups, 'nothing-matches')).toEqual([]);
    expect(filterGroups(groups, '  ')).toBe(groups);
  });
});

describe('formatting', () => {
  it('relative dates', () => {
    const now = new Date(2026, 9, 26, 15, 0).getTime();
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(new Date(2026, 9, 25, 9, 0).getTime(), now)).toBe('Yesterday');
    expect(relativeTime(new Date(2025, 0, 2).getTime(), now)).toMatch(/2025/);
  });

  it('cleans IPC errors and cycles modes like shift+tab in the terminal', () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'frost:submit': Error: The conversation is still starting."))).toBe(
      'The conversation is still starting.',
    );
    expect([nextMode('default'), nextMode('acceptEdits'), nextMode('plan'), nextMode('auto')]).toEqual(['acceptEdits', 'plan', 'auto', 'default']);
  });
});

describe('markdown', () => {
  it('escapes raw HTML from the model and renders code blocks with a copy button', () => {
    const html = renderMarkdown('Hi <img src=x onerror=alert(1)> **bold**\n\n```ts\nconst a = "<b>";\n```\n\n[x](javascript:alert(1))');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('data-copy');
    expect(html).toContain('const a = &quot;&lt;b&gt;&quot;;');
    expect(html).not.toContain('href="javascript:');
  });
});
