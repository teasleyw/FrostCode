import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export type ToolStatus = 'running' | 'done' | 'error' | 'denied';

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; parentId?: string }
  | { kind: 'thinking'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: Record<string, unknown>;
      status: ToolStatus;
      result?: string;
      /** Structured tool output from the runtime (e.g. FileEditOutput with structuredPatch). */
      detail?: unknown;
      parentId?: string;
    }
  | { kind: 'system'; id: string; text: string; tone: 'info' | 'warn' | 'error' | 'success' };

export function isFinal(item: TranscriptItem): boolean {
  if (item.kind === 'assistant' || item.kind === 'thinking') return !item.streaming;
  if (item.kind === 'tool') return item.status !== 'running';
  return true;
}

let counter = 0;
export const newId = (prefix = 'item') => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

interface StreamingBlock {
  itemId: string;
  type: 'text' | 'thinking';
}

/**
 * Folds the SDK message stream into display items. Streaming deltas build provisional
 * text items; the complete assistant message that follows finalizes them.
 */
export class TranscriptModel {
  items: TranscriptItem[] = [];
  private byId = new Map<string, TranscriptItem>();
  /** message.id -> block index -> streaming item */
  private streaming = new Map<string, Map<number, StreamingBlock>>();
  private currentStreamMessageId: string | null = null;
  /** tool_use ids the user denied, so their error result renders as a denial. */
  readonly deniedToolIds = new Set<string>();
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private add(item: TranscriptItem): TranscriptItem {
    this.items.push(item);
    this.byId.set(item.id, item);
    return item;
  }

  private replace(id: string, next: TranscriptItem): void {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx >= 0) this.items[idx] = next;
    this.byId.set(id, next);
  }

  get(id: string): TranscriptItem | undefined {
    return this.byId.get(id);
  }

  clear(): void {
    this.items = [];
    this.byId.clear();
    this.streaming.clear();
    this.deniedToolIds.clear();
    this.emit();
  }

  addUser(text: string): void {
    this.add({ kind: 'user', id: newId('user'), text });
    this.emit();
  }

  addSystem(text: string, tone: 'info' | 'warn' | 'error' | 'success' = 'info'): void {
    this.add({ kind: 'system', id: newId('sys'), text, tone });
    this.emit();
  }

  /** Close every provisional item (used after an interrupt or crash). */
  settle(): void {
    for (const item of this.items) {
      if ((item.kind === 'assistant' || item.kind === 'thinking') && item.streaming) {
        this.replace(item.id, { ...item, streaming: false });
      } else if (item.kind === 'tool' && item.status === 'running') {
        this.replace(item.id, { ...item, status: 'error', result: item.result ?? 'Interrupted' });
      }
    }
    this.streaming.clear();
    this.emit();
  }

  apply(msg: SDKMessage): void {
    switch (msg.type) {
      case 'stream_event':
        if (!msg.parent_tool_use_id) this.applyStreamEvent(msg.event as StreamEventLike);
        break;
      case 'assistant':
        this.applyAssistant(msg.message.id, msg.message.content as ContentBlockLike[], msg.parent_tool_use_id);
        break;
      case 'user':
        this.applyUser(msg as UserLike);
        break;
      case 'system':
        this.applySystem(msg as SystemLike);
        break;
      case 'result':
        if (msg.subtype !== 'success') {
          const errors = 'errors' in msg && msg.errors?.length ? `: ${msg.errors.join('; ')}` : '';
          this.addSystem(`Turn ended (${msg.subtype.replace(/_/g, ' ')})${errors}`, 'error');
        } else if (msg.is_error && msg.result) {
          this.addSystem(msg.result, 'error');
        }
        this.settleStreaming();
        break;
      default:
        return;
    }
    this.emit();
  }

  private settleStreaming(): void {
    for (const blocks of this.streaming.values()) {
      for (const b of blocks.values()) {
        const item = this.byId.get(b.itemId);
        if (item && (item.kind === 'assistant' || item.kind === 'thinking') && item.streaming) {
          this.replace(item.id, { ...item, streaming: false });
        }
      }
    }
    this.streaming.clear();
  }

  private applyStreamEvent(ev: StreamEventLike): void {
    if (ev.type === 'message_start') {
      this.currentStreamMessageId = ev.message?.id ?? null;
      return;
    }
    const mid = this.currentStreamMessageId;
    if (!mid) return;
    if (ev.type === 'content_block_start') {
      const t = ev.content_block?.type;
      if (t !== 'text' && t !== 'thinking') return;
      const itemId = newId(t === 'text' ? 'asst' : 'think');
      if (t === 'text') this.add({ kind: 'assistant', id: itemId, text: ev.content_block?.text ?? '', streaming: true });
      else this.add({ kind: 'thinking', id: itemId, text: ev.content_block?.thinking ?? '', streaming: true });
      if (!this.streaming.has(mid)) this.streaming.set(mid, new Map());
      this.streaming.get(mid)!.set(ev.index ?? 0, { itemId, type: t });
    } else if (ev.type === 'content_block_delta') {
      const block = this.streaming.get(mid)?.get(ev.index ?? 0);
      if (!block) return;
      const item = this.byId.get(block.itemId);
      if (!item) return;
      if (item.kind === 'assistant' && ev.delta?.type === 'text_delta') {
        this.replace(item.id, { ...item, text: item.text + (ev.delta.text ?? '') });
      } else if (item.kind === 'thinking' && ev.delta?.type === 'thinking_delta') {
        this.replace(item.id, { ...item, text: item.text + (ev.delta.thinking ?? '') });
      }
    }
  }

  /** Find the oldest still-streaming block of this message with the given type. */
  private claimStreaming(messageId: string, type: 'text' | 'thinking'): TranscriptItem | undefined {
    const blocks = this.streaming.get(messageId);
    if (!blocks) return undefined;
    const sorted = [...blocks.entries()].sort((a, b) => a[0] - b[0]);
    for (const [idx, b] of sorted) {
      if (b.type !== type) continue;
      blocks.delete(idx);
      return this.byId.get(b.itemId);
    }
    return undefined;
  }

  private applyAssistant(messageId: string, content: ContentBlockLike[], parentId: string | null): void {
    for (const block of content ?? []) {
      if (block.type === 'text') {
        const text = block.text ?? '';
        const existing = parentId ? undefined : this.claimStreaming(messageId, 'text');
        if (existing && existing.kind === 'assistant') {
          this.replace(existing.id, { ...existing, text, streaming: false });
        } else if (text.trim()) {
          this.add({ kind: 'assistant', id: newId('asst'), text, streaming: false, parentId: parentId ?? undefined });
        }
      } else if (block.type === 'thinking') {
        if (parentId) continue;
        const existing = this.claimStreaming(messageId, 'thinking');
        const text = block.thinking ?? '';
        if (existing && existing.kind === 'thinking') this.replace(existing.id, { ...existing, text, streaming: false });
        else if (text.trim()) this.add({ kind: 'thinking', id: newId('think'), text, streaming: false });
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
        const id = block.id ?? newId('tool');
        if (this.byId.has(id)) continue;
        this.add({
          kind: 'tool',
          id,
          name: block.name ?? 'tool',
          input: (block.input as Record<string, unknown>) ?? {},
          status: 'running',
          parentId: parentId ?? undefined,
        });
      }
    }
  }

  private applyUser(msg: UserLike): void {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return; // plain prompts are added by addUser / replays are ignored
    for (const block of content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      const item = this.byId.get(block.tool_use_id);
      if (!item || item.kind !== 'tool') continue;
      const text = toolResultText(block.content);
      const denied = this.deniedToolIds.has(item.id);
      this.replace(item.id, {
        ...item,
        status: denied ? 'denied' : block.is_error ? 'error' : 'done',
        result: text,
        detail: msg.tool_use_result ?? item.detail,
      });
    }
  }

  private applySystem(msg: SystemLike): void {
    if (msg.subtype === 'compact_boundary') {
      const m = msg.compact_metadata;
      const post = m?.post_tokens ? ` → ${m.post_tokens.toLocaleString()}` : '';
      this.add({
        kind: 'system',
        id: newId('sys'),
        text: `Conversation compacted (${m?.trigger ?? 'manual'}: ${m?.pre_tokens?.toLocaleString() ?? '?'}${post} tokens)`,
        tone: 'info',
      });
    } else if (msg.subtype === 'api_retry') {
      this.add({
        kind: 'system',
        id: newId('sys'),
        text: `API ${msg.error ?? 'error'}${msg.error_status ? ` (${msg.error_status})` : ''} — retrying (${msg.attempt}/${msg.max_retries}) in ${Math.round((msg.retry_delay_ms ?? 0) / 1000)}s`,
        tone: 'warn',
      });
    } else if (msg.subtype === 'status' && msg.compact_result === 'failed') {
      this.add({ kind: 'system', id: newId('sys'), text: `Compaction failed: ${msg.compact_error ?? 'unknown error'}`, tone: 'error' });
    }
  }
}

export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c && typeof c === 'object' && 'type' in c) {
          const block = c as { type: string; text?: string };
          if (block.type === 'text') return block.text ?? '';
          if (block.type === 'image') return '[image]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

// Loose shapes of the Messages API objects we read; the SDK's own types are much wider.
interface ContentBlockLike {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}
interface StreamEventLike {
  type: string;
  index?: number;
  message?: { id?: string };
  content_block?: { type?: string; text?: string; thinking?: string };
  delta?: { type?: string; text?: string; thinking?: string };
}
interface UserLike {
  message?: { content?: string | { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[] };
  tool_use_result?: unknown;
}
interface SystemLike {
  subtype: string;
  compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number };
  error?: string;
  error_status?: number | null;
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  compact_result?: string;
  compact_error?: string;
}
