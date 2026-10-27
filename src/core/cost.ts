import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ModelUsage, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { frostHome } from '../config/env.js';

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CostSnapshot {
  /** Estimated USD for the whole SDK session (includes spend restored on resume). */
  sessionUsd: number;
  /** Estimated USD spent by this FrostCode process across all sessions it ran. */
  runUsd: number;
  /** Session token totals summed across models (subagents included). */
  tokens: TokenTotals;
  perModel: Record<string, ModelUsage>;
  turns: number;
  /** Tokens currently occupying the context window (last main-loop request). */
  contextTokens: number;
  contextWindow: number;
  lastTurnUsd: number;
}

const zeroTokens = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * Tracks the SDK's cost estimates. In streaming-input mode each turn's result carries
 * the running total for the query (plus spend restored on resume), so the latest
 * result is the session total; summing results would double count.
 */
export class CostTracker {
  private sessionUsd = 0;
  private baselineUsd = 0; // session spend restored from earlier runs
  private runBeforeSession = 0; // spend from sessions this process already finished
  private perModel: Record<string, ModelUsage> = {};
  private turns = 0;
  private contextTokens = 0;
  private contextWindow = 0;
  private lastTurnUsd = 0;
  private seenMessageIds = new Set<string>();

  constructor(private readonly store: CostStore | null = defaultCostStore()) {}

  /** Start accounting for a (possibly resumed) session. */
  beginSession(sessionId: string | null): void {
    this.runBeforeSession += this.sessionUsd - this.baselineUsd;
    const restored = sessionId && this.store ? this.store.get(sessionId) : 0;
    this.baselineUsd = restored;
    this.sessionUsd = restored;
    this.perModel = {};
    this.turns = 0;
    this.contextTokens = 0;
    this.lastTurnUsd = 0;
    this.seenMessageIds.clear();
  }

  apply(msg: SDKMessage): void {
    if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
      const id = msg.message.id;
      if (id && !this.seenMessageIds.has(id)) {
        this.seenMessageIds.add(id);
        const u = msg.message.usage;
        if (u) {
          this.contextTokens =
            (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        }
      }
    } else if (msg.type === 'result') {
      this.applyResult(msg);
    } else if (msg.type === 'conversation_reset') {
      // /clear or a plan approval that starts fresh: the SDK restarts its running totals.
      this.beginSession(msg.new_conversation_id ?? msg.session_id);
    } else if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      this.contextTokens = msg.compact_metadata.post_tokens ?? 0;
    }
  }

  private applyResult(r: SDKResultMessage): void {
    const total = Number.isFinite(r.total_cost_usd) ? r.total_cost_usd : 0;
    // A crashed session can report zeroed totals; never let the total go backwards.
    if (total > 0 && total >= this.sessionUsd) {
      this.lastTurnUsd = total - this.sessionUsd;
      this.sessionUsd = total;
    } else if (total > 0 && this.turns === 0 && total < this.sessionUsd) {
      // First result after a resume whose restored total we over-estimated.
      this.lastTurnUsd = 0;
      this.sessionUsd = total;
      this.baselineUsd = Math.min(this.baselineUsd, total);
    }
    if (r.modelUsage && Object.keys(r.modelUsage).length) {
      this.perModel = r.modelUsage;
      const windows = Object.values(r.modelUsage).map((m) => m.contextWindow).filter(Boolean);
      if (windows.length) this.contextWindow = Math.max(...windows);
    }
    this.turns += 1;
    if (this.store && r.session_id) this.store.set(r.session_id, this.sessionUsd);
  }

  setContextWindow(n: number): void {
    if (n > 0) this.contextWindow = n;
  }

  snapshot(): CostSnapshot {
    const tokens = zeroTokens();
    for (const m of Object.values(this.perModel)) {
      tokens.input += m.inputTokens ?? 0;
      tokens.output += m.outputTokens ?? 0;
      tokens.cacheRead += m.cacheReadInputTokens ?? 0;
      tokens.cacheWrite += m.cacheCreationInputTokens ?? 0;
    }
    return {
      sessionUsd: this.sessionUsd,
      runUsd: this.runBeforeSession + (this.sessionUsd - this.baselineUsd),
      tokens,
      perModel: this.perModel,
      turns: this.turns,
      contextTokens: this.contextTokens,
      contextWindow: this.contextWindow,
      lastTurnUsd: this.lastTurnUsd,
    };
  }
}

/** Persists each session's last known cost so a resumed session can tell restored spend from new spend. */
export interface CostStore {
  get(sessionId: string): number;
  set(sessionId: string, usd: number): void;
}

export class FileCostStore implements CostStore {
  private cache: Record<string, number> | null = null;
  constructor(private readonly file: string) {}

  private load(): Record<string, number> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      this.cache = {};
    }
    return this.cache!;
  }

  get(sessionId: string): number {
    return this.load()[sessionId] ?? 0;
  }

  set(sessionId: string, usd: number): void {
    const data = this.load();
    data[sessionId] = usd;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, this.file);
    } catch {
      /* cost persistence is best effort */
    }
  }
}

export function defaultCostStore(): CostStore {
  return new FileCostStore(join(frostHome(), 'costs.json'));
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
