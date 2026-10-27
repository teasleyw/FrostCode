import {
  query,
  type HookCallbackMatcher,
  type McpServerConfig,
  type McpServerStatus,
  type McpSetServersResult,
  type ModelInfo,
  type Options,
  type PermissionMode,
  type Query,
  type SDKControlGetContextUsageResponse,
  type SDKControlInitializeResponse,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { buildAgentEnv, redact } from '../config/env.js';
import { acceptEditsShellGuard } from './accept-edits-guard.js';
import { AsyncQueue } from './queue.js';
import type { PermissionController } from './permissions.js';

export interface SessionOptions {
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  resume?: string;
  forkSession?: boolean;
  allowBypass?: boolean;
  permissions: PermissionController;
  /** Extra instructions appended to the system prompt. */
  appendSystemPrompt?: string;
  /** Keep filesystem shell commands under normal approval while acceptEdits is on (desktop app). */
  guardShellInAcceptEdits?: boolean;
  /** The mode as the host sees it (plan approval can change it without a status message). */
  currentMode?: () => PermissionMode;
  /**
   * MCP servers the user approved (FrostCode's MCP manager decides). When set, the runtime
   * runs with strictMcpConfig: no other MCP configuration (a project's .mcp.json, plugins)
   * connects without going through FrostCode's approval.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /** PreToolUse hooks added to the session (the MCP approval hook). */
  extraPreToolUse?: HookCallbackMatcher[];
  /** Lets tests swap in a fake SDK. */
  queryFn?: typeof query;
}

export interface SessionInfo {
  sessionId: string | null;
  model: string | null;
  permissionMode: PermissionMode;
  tools: string[];
  slashCommands: string[];
  apiKeySource: string | null;
  cwd: string;
  version: string | null;
}

type Listener = (msg: SDKMessage) => void;

const FROSTCODE_PROMPT = [
  'You are running inside FrostCode, an interactive terminal coding assistant built on the Claude Agent SDK.',
  'The user sees your text rendered as Markdown in a terminal, plus a live view of every tool call, its result, and file diffs.',
  'Keep responses concise and terminal-friendly.',
].join(' ');

/**
 * One persistent conversation with the Agent SDK in streaming-input mode.
 * User turns go in through an async queue; every SDK message is fanned out to listeners.
 */
export class AgentSession {
  private q: Query | null = null;
  private input: AsyncQueue<SDKUserMessage> | null = null;
  private listeners = new Set<Listener>();
  private stderrTail: string[] = [];
  private running: Promise<void> | null = null;
  busy = false;
  closed = false;
  info: SessionInfo;
  onBusyChange: (busy: boolean) => void = () => {};
  onExit: (error: Error | null) => void = () => {};

  constructor(private opts: SessionOptions) {
    this.info = {
      sessionId: opts.resume ?? null,
      model: opts.model ?? null,
      permissionMode: opts.permissionMode,
      tools: [],
      slashCommands: [],
      apiKeySource: null,
      cwd: opts.cwd,
      version: null,
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get options(): Readonly<SessionOptions> {
    return this.opts;
  }

  /** Spawn the runtime. Safe to call more than once. */
  start(): void {
    if (this.q) return;
    this.input = new AsyncQueue<SDKUserMessage>();
    const options: Options = {
      cwd: this.opts.cwd,
      env: buildAgentEnv(),
      model: this.opts.model,
      permissionMode: this.opts.permissionMode,
      allowDangerouslySkipPermissions: !!this.opts.allowBypass,
      canUseTool: this.opts.permissions.canUseTool,
      hooks: this.preToolUseHooks(),
      ...(this.opts.mcpServers ? { mcpServers: this.opts.mcpServers, strictMcpConfig: true } : {}),
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: [FROSTCODE_PROMPT, this.opts.appendSystemPrompt].filter(Boolean).join('\n\n') },
      // 'user' resolves inside FrostCode's isolated config dir; 'project' brings in CLAUDE.md and .claude/settings.json.
      settingSources: ['user', 'project', 'local'],
      resume: this.opts.resume,
      forkSession: this.opts.forkSession,
      stderr: (data) => {
        this.stderrTail.push(redact(data));
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      },
    };
    const queryFn = this.opts.queryFn ?? query;
    this.q = queryFn({ prompt: this.input, options });
    this.running = this.consume(this.q);
  }

  private preToolUseHooks(): Options['hooks'] {
    const list: HookCallbackMatcher[] = [...(this.opts.extraPreToolUse ?? [])];
    if (this.opts.guardShellInAcceptEdits) list.push(acceptEditsShellGuard(() => this.opts.currentMode?.() ?? this.info.permissionMode));
    return list.length ? { PreToolUse: list } : undefined;
  }

  private async consume(q: Query): Promise<void> {
    let error: Error | null = null;
    try {
      for await (const msg of q) {
        this.observe(msg);
        for (const fn of this.listeners) fn(msg);
      }
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      const tail = this.stderrTail.slice(-5).join('').trim();
      if (tail) error.message += `\n${tail}`;
      error.message = redact(error.message);
    } finally {
      this.q = null;
      this.input = null;
      this.setBusy(false);
      this.onExit(error);
    }
  }

  private observe(msg: SDKMessage): void {
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.info = {
        ...this.info,
        sessionId: msg.session_id,
        model: msg.model,
        permissionMode: msg.permissionMode,
        tools: msg.tools,
        slashCommands: msg.slash_commands,
        apiKeySource: msg.apiKeySource,
        cwd: msg.cwd,
        version: msg.claude_code_version,
      };
    } else if (msg.type === 'system' && msg.subtype === 'status' && msg.permissionMode) {
      this.info = { ...this.info, permissionMode: msg.permissionMode };
    } else if (msg.type === 'result') {
      this.info = { ...this.info, sessionId: msg.session_id };
      this.setBusy(false);
    } else if (msg.type === 'conversation_reset') {
      this.info = { ...this.info, sessionId: msg.new_conversation_id ?? msg.session_id };
    }
  }

  private setBusy(b: boolean): void {
    if (this.busy === b) return;
    this.busy = b;
    this.onBusyChange(b);
  }

  /** Queue a user turn. Starts (or restarts, resuming the same session) the runtime if needed. */
  send(text: string): void {
    if (this.closed) throw new Error('session is closed');
    if (!this.q) {
      if (this.info.sessionId && !this.opts.resume) this.opts = { ...this.opts, resume: this.info.sessionId, forkSession: false };
      this.start();
    }
    this.setBusy(true);
    this.input!.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
  }

  async interrupt(): Promise<void> {
    if (!this.q || !this.busy) return;
    try {
      await this.q.interrupt();
    } catch {
      /* the turn may already have finished */
    }
  }

  async setModel(model: string | undefined): Promise<void> {
    this.opts = { ...this.opts, model };
    if (this.q) await this.q.setModel(model);
    this.info = { ...this.info, model: model ?? this.info.model };
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.opts = { ...this.opts, permissionMode: mode };
    if (this.q) await this.q.setPermissionMode(mode);
    this.info = { ...this.info, permissionMode: mode };
  }

  /** Start the runtime and return its handshake (models, commands, account/auth source). */
  async initialize(): Promise<SDKControlInitializeResponse> {
    if (!this.q) this.start();
    const init = await this.q!.initializationResult();
    this.info = {
      ...this.info,
      apiKeySource: init.account?.apiKeySource ?? this.info.apiKeySource,
      slashCommands: init.commands?.map((c) => c.name) ?? this.info.slashCommands,
      version: init.claude_code_version ?? this.info.version,
    };
    return init;
  }

  async supportedModels(): Promise<ModelInfo[]> {
    if (!this.q) this.start();
    return this.q!.supportedModels();
  }

  async contextUsage(): Promise<SDKControlGetContextUsageResponse | null> {
    if (!this.q) return null;
    return this.q.getContextUsage({ detail: 'summary' });
  }

  // ---- MCP (the SDK's own controls; FrostCode never edits MCP config files) ----

  get started(): boolean {
    return !!this.q;
  }

  private live(): Query {
    if (!this.q) this.start();
    return this.q!;
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    return this.live().mcpServerStatus();
  }

  async toggleMcpServer(name: string, enabled: boolean): Promise<void> {
    await this.live().toggleMcpServer(name, enabled);
  }

  async reconnectMcpServer(name: string): Promise<void> {
    await this.live().reconnectMcpServer(name);
  }

  /** Replace the session's servers. Also kept for restarts, so a resumed runtime gets the same set. */
  async setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult> {
    this.opts = { ...this.opts, mcpServers: servers };
    return this.live().setMcpServers(servers);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.input?.close();
    this.q?.close();
    await this.running?.catch(() => {});
  }
}
