import { describe, expect, it } from 'vitest';
import { buildAgentEnv, MissingApiKeyError, redact, agentConfigDir } from '../src/config/env.js';
import { AsyncQueue } from '../src/core/queue.js';
import { CostTracker, formatUsd, formatTokens, type CostStore } from '../src/core/cost.js';
import { TranscriptModel, isFinal } from '../src/core/transcript.js';
import { userText } from '../src/core/history.js';
import { assistantText, assistantToolUse, resultMsg, streamEvent, toolResult } from './helpers/fake-query.js';

describe('env', () => {
  it('passes the API key and strips every other auth path', () => {
    const env = buildAgentEnv({
      ANTHROPIC_API_KEY: 'sk-ant-abc12345678',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      ANTHROPIC_AUTH_TOKEN: 'bearer',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDECODE: '1',
      PATH: '/usr/bin',
    });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-abc12345678');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.CLAUDE_CONFIG_DIR).toBe(agentConfigDir());
    expect(env.CLAUDE_CONFIG_DIR).not.toMatch(/\.claude$/);
  });

  it('refuses to start without a key', () => {
    expect(() => buildAgentEnv({ PATH: '/usr/bin' })).toThrow(MissingApiKeyError);
    expect(() => buildAgentEnv({ ANTHROPIC_API_KEY: '   ' })).toThrow(MissingApiKeyError);
  });

  it('redacts keys in text', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-api03-SECRETSECRETSECRET' };
    expect(redact('failed with key sk-ant-api03-SECRETSECRETSECRET here', env)).toBe('failed with key sk-ant-*** here');
    expect(redact('other sk-ant-zzzzzzzzzzzzzz', env)).toBe('other sk-ant-***');
  });
});

describe('AsyncQueue', () => {
  it('delivers pushed items in order and ends on close', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    const got: number[] = [];
    const done = (async () => {
      for await (const n of q) got.push(n);
    })();
    q.push(2);
    q.push(3);
    q.close();
    await done;
    expect(got).toEqual([1, 2, 3]);
  });
});

class MemStore implements CostStore {
  data: Record<string, number> = {};
  get(id: string) {
    return this.data[id] ?? 0;
  }
  set(id: string, usd: number) {
    this.data[id] = usd;
  }
}

describe('CostTracker', () => {
  it('treats total_cost_usd as cumulative within a session', () => {
    const t = new CostTracker(new MemStore());
    t.beginSession(null);
    t.apply(resultMsg(0.01));
    t.apply(resultMsg(0.025));
    const s = t.snapshot();
    expect(s.sessionUsd).toBeCloseTo(0.025);
    expect(s.lastTurnUsd).toBeCloseTo(0.015);
    expect(s.runUsd).toBeCloseTo(0.025);
    expect(s.turns).toBe(2);
    expect(s.contextWindow).toBe(200000);
  });

  it('counts context from the latest main-loop message, once per message id', () => {
    const t = new CostTracker(null);
    t.beginSession(null);
    const m = assistantText('hi', 'msg_same', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 });
    t.apply(m);
    t.apply(m);
    expect(t.snapshot().contextTokens).toBe(105);
  });

  it('separates spend restored on resume from spend in this run', () => {
    const store = new MemStore();
    store.data['old'] = 0.5;
    const t = new CostTracker(store);
    t.beginSession('old');
    t.apply(resultMsg(0.6, 'old'));
    const s = t.snapshot();
    expect(s.sessionUsd).toBeCloseTo(0.6);
    expect(s.runUsd).toBeCloseTo(0.1);
    expect(store.data['old']).toBeCloseTo(0.6);
  });

  it('keeps run totals across sessions and never goes backwards on a zeroed crash result', () => {
    const t = new CostTracker(new MemStore());
    t.beginSession(null);
    t.apply(resultMsg(0.2, 'a'));
    t.apply(resultMsg(0, 'a'));
    expect(t.snapshot().sessionUsd).toBeCloseTo(0.2);
    t.beginSession(null);
    t.apply(resultMsg(0.05, 'b'));
    expect(t.snapshot().sessionUsd).toBeCloseTo(0.05);
    expect(t.snapshot().runUsd).toBeCloseTo(0.25);
  });

  it('formats money and tokens', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.00042)).toBe('$0.0004');
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(15400)).toBe('15k');
    expect(formatTokens(2_500_000)).toBe('2.50M');
  });
});

describe('TranscriptModel', () => {
  it('builds text from stream deltas and finalizes it with the full message', () => {
    const t = new TranscriptModel();
    t.apply(streamEvent({ type: 'message_start', message: { id: 'm1' } }));
    t.apply(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    t.apply(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }));
    t.apply(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }));
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ kind: 'assistant', text: 'Hello', streaming: true });
    expect(isFinal(t.items[0])).toBe(false);
    t.apply(assistantText('Hello!', 'm1'));
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ kind: 'assistant', text: 'Hello!', streaming: false });
  });

  it('tracks a tool call through its result, including structured output', () => {
    const t = new TranscriptModel();
    t.apply(assistantToolUse('tu1', 'Bash', { command: 'ls' }));
    expect(t.items[0]).toMatchObject({ kind: 'tool', status: 'running', name: 'Bash' });
    t.apply(toolResult('tu1', 'a.txt\nb.txt', false, { stdout: 'a.txt' }));
    expect(t.items[0]).toMatchObject({ kind: 'tool', status: 'done', result: 'a.txt\nb.txt', detail: { stdout: 'a.txt' } });
  });

  it('marks tools the user denied', () => {
    const t = new TranscriptModel();
    t.apply(assistantToolUse('tu2', 'Edit', { file_path: 'x' }));
    t.deniedToolIds.add('tu2');
    t.apply(toolResult('tu2', 'denied', true));
    expect(t.items[0]).toMatchObject({ status: 'denied' });
  });

  it('settles running items after an interrupt', () => {
    const t = new TranscriptModel();
    t.apply(assistantToolUse('tu3', 'Bash', { command: 'sleep 9' }));
    t.settle();
    expect(t.items[0]).toMatchObject({ status: 'error', result: 'Interrupted' });
  });

  it('reports compaction and failed turns', () => {
    const t = new TranscriptModel();
    t.apply({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 50000, post_tokens: 4000 }, uuid: 'u', session_id: 's' } as never);
    expect(t.items[0]).toMatchObject({ kind: 'system' });
    expect((t.items[0] as { text: string }).text).toContain('50,000');
    t.apply({ ...resultMsg(0), subtype: 'error_max_turns', errors: ['too many'] } as never);
    expect((t.items[1] as { text: string }).text).toContain('max turns');
  });
});

describe('history userText', () => {
  it('keeps typed text, drops tool results and injected context', () => {
    expect(userText('hello')).toBe('hello');
    expect(userText([{ type: 'text', text: 'hi' }])).toBe('hi');
    expect(userText([{ type: 'tool_result', tool_use_id: 'x', content: 'y' }])).toBeNull();
    expect(userText('<system-reminder>x</system-reminder>')).toBeNull();
    expect(userText('<command-name>/compact</command-name><command-args>keep tests</command-args>')).toBe('/compact keep tests');
  });
});
