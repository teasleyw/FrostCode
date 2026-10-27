import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../../src/core/queue.js';

export interface FakeRun {
  options: Options;
  prompts: string[];
  calls: { method: string; args: unknown[] }[];
  /** Push an SDK message to the consumer. */
  emit(msg: SDKMessage): void;
  /** End the stream (optionally with an error). */
  end(error?: Error): void;
}

type Responder = (prompt: string, run: FakeRun) => void | Promise<void>;

let uuid = 0;
const id = () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`;

/** A stand-in for the SDK's query(): records options and control calls, replies via a responder. */
export function makeFakeQuery(responder: Responder) {
  const runs: FakeRun[] = [];
  const queryFn = ({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query => {
    const out = new AsyncQueue<SDKMessage>();
    let failure: Error | null = null;
    const run: FakeRun = {
      options: options ?? {},
      prompts: [],
      calls: [],
      emit: (m) => out.push(m),
      end: (e) => {
        failure = e ?? null;
        out.close();
      },
    };
    runs.push(run);
    (async () => {
      if (typeof prompt === 'string') return;
      for await (const m of prompt) {
        const content = m.message.content;
        const text = typeof content === 'string' ? content : '';
        run.prompts.push(text);
        await responder(text, run);
      }
    })();
    const iterator = out[Symbol.asyncIterator]();
    const record = (method: string) => async (...args: unknown[]) => {
      run.calls.push({ method, args });
      return undefined as never;
    };
    const q = {
      next: async () => {
        const r = await iterator.next();
        if (r.done && failure) throw failure;
        return r;
      },
      return: async () => ({ value: undefined, done: true as const }),
      throw: async (e: unknown) => {
        throw e;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      interrupt: record('interrupt'),
      setModel: record('setModel'),
      setPermissionMode: record('setPermissionMode'),
      initializationResult: async () => ({
        commands: [{ name: 'compact', description: 'compact', argumentHint: '' }],
        agents: [],
        output_style: 'default',
        available_output_styles: [],
        models: [
          { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus' },
          { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', description: 'fast' },
        ],
        account: { apiKeySource: 'ANTHROPIC_API_KEY' },
      }),
      supportedModels: async () => [],
      getContextUsage: async () => ({ categories: [], totalTokens: 1000, maxTokens: 200000, percentage: 0.5, model: 'claude-haiku-5-5' }),
      close: () => out.close(),
    };
    return q as unknown as Query;
  };
  return { queryFn: queryFn as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query, runs };
}

// ---- message builders ----------------------------------------------------

export function initMsg(sessionId = 'sess-1', model = 'claude-haiku-5-5'): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'ANTHROPIC_API_KEY',
    claude_code_version: 'test',
    cwd: '/tmp',
    tools: ['Read', 'Edit', 'Bash'],
    mcp_servers: [],
    model,
    permissionMode: 'default',
    slash_commands: ['compact'],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: id(),
    session_id: sessionId,
  } as SDKMessage;
}

export function assistantText(text: string, messageId = 'msg_' + id(), usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }): SDKMessage {
  return {
    type: 'assistant',
    message: { id: messageId, role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }], usage, stop_reason: null },
    parent_tool_use_id: null,
    uuid: id(),
    session_id: 'sess-1',
  } as unknown as SDKMessage;
}

export function assistantToolUse(toolId: string, name: string, input: Record<string, unknown>, messageId = 'msg_' + id()): SDKMessage {
  return {
    type: 'assistant',
    message: { id: messageId, role: 'assistant', content: [{ type: 'tool_use', id: toolId, name, input }], usage: { input_tokens: 5, output_tokens: 1 } },
    parent_tool_use_id: null,
    uuid: id(),
    session_id: 'sess-1',
  } as unknown as SDKMessage;
}

export function toolResult(toolId: string, content: string, isError = false, structured?: unknown): SDKMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content, is_error: isError }] },
    parent_tool_use_id: null,
    tool_use_result: structured,
    uuid: id(),
    session_id: 'sess-1',
  } as unknown as SDKMessage;
}

export function resultMsg(totalCost: number, sessionId = 'sess-1', model = 'claude-haiku-5-5'): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: '',
    stop_reason: 'end_turn',
    total_cost_usd: totalCost,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {
      [model]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: totalCost, contextWindow: 200000, maxOutputTokens: 64000 },
    },
    permission_denials: [],
    uuid: id(),
    session_id: sessionId,
  } as unknown as SDKMessage;
}

export function streamEvent(event: Record<string, unknown>): SDKMessage {
  return { type: 'stream_event', event, parent_tool_use_id: null, uuid: id(), session_id: 'sess-1' } as unknown as SDKMessage;
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await tick(5);
  }
}
