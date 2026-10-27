import type { HookCallback, HookCallbackMatcher, McpServerConfig, McpServerStatus, McpSetServersResult } from '@anthropic-ai/claude-agent-sdk';
import { redact } from '../config/env.js';
import { describeConfig, discoverMcpServers, SCOPE_LABELS, type DiscoveredServer, type DiscoveryRoots } from './discovery.js';
import { McpStore } from './store.js';
import type { McpAction, McpEntryState, McpEntryView, McpToolView } from './types.js';

/** The live session's MCP controls (AgentSession forwards them to the SDK's Query). */
export interface McpRuntime {
  mcpServerStatus(): Promise<McpServerStatus[]>;
  toggleMcpServer(name: string, enabled: boolean): Promise<void>;
  reconnectMcpServer(name: string): Promise<void>;
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
}

/** Asks the user to approve one sensitive MCP call; resolves true for yes. */
export type ExplicitAsk = (req: { toolName: string; input: Record<string, unknown>; toolUseId: string; reason: string }, signal: AbortSignal) => Promise<boolean>;

export interface McpManagerOptions {
  roots?: DiscoveryRoots;
  storeFile?: string;
}

/** mcp__<server>__<tool>; server names may contain underscores, so match against known names first. */
export function splitMcpToolName(toolName: string, known: Iterable<string> = []): { server: string; tool: string } | null {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice(5);
  for (const name of [...known].sort((a, b) => b.length - a.length)) {
    if (rest.startsWith(`${name}__`)) return { server: name, tool: rest.slice(name.length + 2) };
  }
  const i = rest.indexOf('__');
  return i > 0 ? { server: rest.slice(0, i), tool: rest.slice(i + 2) } : null;
}

/**
 * MCP for one project: which servers exist (read-only discovery), which the user approved and
 * enabled (FrostCode's own store), what the runtime reports about them, and the actions on them.
 * Only approved, enabled servers are handed to the runtime; the session runs with
 * strictMcpConfig, so nothing the user has not approved connects on its own.
 */
export class McpManager {
  private servers: DiscoveredServer[] = [];
  private status = new Map<string, McpServerStatus>();
  private runtime: McpRuntime | null = null;
  readonly store: McpStore;
  private listeners = new Set<() => void>();
  /** Names registered with the live runtime (its startup set, then each setMcpServers). */
  private registered = new Set<string>();

  constructor(
    readonly cwd: string,
    private readonly opts: McpManagerOptions = {},
  ) {
    this.store = new McpStore(opts.storeFile);
    this.refresh();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Re-read every config source (and FrostCode's decisions). Never writes to them. */
  refresh(): void {
    this.store.reload();
    this.servers = discoverMcpServers(this.cwd, this.opts.roots);
  }

  get discovered(): readonly DiscoveredServer[] {
    return this.servers;
  }

  private decisionState(s: DiscoveredServer): McpEntryState | null {
    if (!s.config) return 'unsupported';
    if (s.shadowedBy) return 'shadowed';
    const d = this.store.get(s.id);
    if (!d) return 'needs-approval';
    if (d.fingerprint !== s.fingerprint) return 'changed';
    if (d.decision === 'rejected') return 'rejected';
    if (!d.enabled) return 'disabled';
    return null;
  }

  /** Approved, enabled, usable: what the runtime gets. */
  activeServers(): DiscoveredServer[] {
    return this.servers.filter((s) => this.decisionState(s) === null);
  }

  runtimeConfig(): Record<string, McpServerConfig> {
    const out: Record<string, McpServerConfig> = {};
    for (const s of this.activeServers()) out[s.name] = s.config as McpServerConfig;
    return out;
  }

  /** Servers waiting for a yes/no from the user. */
  awaitingApproval(): DiscoveredServer[] {
    return this.servers.filter((s) => {
      const st = this.decisionState(s);
      return st === 'needs-approval' || st === 'changed';
    });
  }

  find(ref: string): DiscoveredServer | undefined {
    const usable = this.servers.filter((s) => !s.shadowedBy);
    return this.servers.find((s) => s.id === ref) ?? usable.find((s) => s.name === ref) ?? usable.find((s) => s.name.toLowerCase() === ref.toLowerCase());
  }

  // ---- runtime -----------------------------------------------------------

  /** Called when a session starts with runtimeConfig() as its servers. */
  attach(runtime: McpRuntime | null): void {
    this.runtime = runtime;
    this.status.clear();
    this.registered = new Set(runtime ? Object.keys(this.runtimeConfig()) : []);
    this.emit();
  }

  /** Ask the runtime how each server is doing, and re-enable any it holds disabled that FrostCode has enabled. */
  async refreshStatus(): Promise<void> {
    if (!this.runtime) return;
    const list = await this.runtime.mcpServerStatus();
    this.status = new Map(list.map((s) => [s.name, s]));
    for (const s of this.activeServers()) {
      if (this.status.get(s.name)?.status === 'disabled') {
        await this.runtime.toggleMcpServer(s.name, true).catch(() => {});
      }
    }
    this.emit();
  }

  /** Re-send the approved set. The SDK replaces its dynamic servers with exactly this set. */
  private async sync(): Promise<string | null> {
    if (!this.runtime) return null;
    const desired = this.runtimeConfig();
    const result = await this.runtime.setMcpServers(desired);
    this.registered = new Set(Object.keys(desired));
    const errors = Object.entries(result?.errors ?? {});
    return errors.length ? errors.map(([n, e]) => `${n}: ${e}`).join('; ') : null;
  }

  async act(ref: string, action: McpAction): Promise<string> {
    if (action === 'refresh') {
      this.refresh();
      await this.refreshStatus().catch(() => {});
      this.emit();
      return 'Reloaded MCP configuration.';
    }
    const s = this.find(ref);
    if (!s) throw new Error(`No MCP server named "${ref}".`);
    if (!s.config) throw new Error(`${s.name} cannot be used here: ${s.problem ?? 'unsupported'}.`);
    if (s.shadowedBy) throw new Error(`${s.name} from ${SCOPE_LABELS[s.scope]} is shadowed by ${s.shadowedBy}.`);
    let msg: string;
    switch (action) {
      case 'approve': {
        this.store.decide(s.id, 'approved', s.fingerprint);
        const err = await this.sync();
        msg = err ? `Approved ${s.name}, but it failed to connect: ${err}` : `Approved ${s.name}.${this.runtime ? ' Connecting…' : ' It connects when the session starts.'}`;
        break;
      }
      case 'reject':
        this.store.decide(s.id, 'rejected', s.fingerprint);
        if (this.registered.has(s.name)) await this.sync();
        msg = `Rejected ${s.name}. It will not be connected.`;
        break;
      case 'enable': {
        const st = this.decisionState(s);
        if (st === 'needs-approval' || st === 'changed' || st === 'rejected') throw new Error(`${s.name} is not approved. Approve it first.`);
        this.store.setEnabled(s.id, true);
        if (this.runtime) {
          if (this.registered.has(s.name)) await this.runtime.toggleMcpServer(s.name, true);
          else await this.sync();
        }
        msg = `Enabled ${s.name}.`;
        break;
      }
      case 'disable':
        this.store.setEnabled(s.id, false);
        if (this.runtime && this.registered.has(s.name)) await this.runtime.toggleMcpServer(s.name, false);
        msg = `Disabled ${s.name}. Its configuration is unchanged.`;
        break;
      case 'reconnect':
        if (this.decisionState(s) !== null) throw new Error(`${s.name} is not approved and enabled.`);
        if (!this.runtime) throw new Error('The agent runtime is not running yet.');
        if (this.registered.has(s.name)) await this.runtime.reconnectMcpServer(s.name);
        else await this.sync();
        msg = `Reconnecting ${s.name}…`;
        break;
    }
    await this.refreshStatus().catch(() => {});
    this.emit();
    return msg;
  }

  setToolTrusted(server: string, tool: string, trusted: boolean): void {
    this.store.setTrusted(server, tool, trusted);
    this.emit();
  }

  // ---- views ------------------------------------------------------------

  private toolViews(name: string): McpToolView[] {
    const tools = this.status.get(name)?.tools ?? [];
    return tools.map((t) => {
      const readOnly = !!t.annotations?.readOnly;
      const destructive = !!t.annotations?.destructive;
      return {
        name: t.name,
        description: redact(t.description ?? ''),
        readOnly,
        destructive,
        sensitive: destructive || !readOnly,
        trusted: this.store.isTrusted(name, t.name),
      };
    });
  }

  entries(): McpEntryView[] {
    return this.servers.map((s) => {
      const d = describeConfig(s.config);
      let state = this.decisionState(s);
      const live = state === null ? this.status.get(s.name) : undefined;
      let detail: string | undefined;
      if (state === 'unsupported') detail = s.problem;
      else if (state === 'shadowed') detail = `Uses ${s.shadowedBy} instead`;
      if (state === null) {
        if (!this.runtime || !live) state = 'starting';
        else if (live.status === 'disabled') state = 'disabled';
        else state = live.status;
        if (live?.error) detail = redact(live.error);
      }
      return {
        id: s.id,
        name: s.name,
        scope: s.scope,
        scopeLabel: SCOPE_LABELS[s.scope],
        source: s.source,
        transport: s.transport,
        summary: redact(d.summary),
        envKeys: d.envKeys,
        headerKeys: d.headerKeys,
        state,
        detail,
        offInSource: !!s.offInSource,
        serverInfo: live?.serverInfo,
        tools: live ? this.toolViews(s.name) : [],
      };
    });
  }

  // ---- sensitive-call approval ---------------------------------------------

  /** True when a call to this MCP tool must be approved by the user first. Unknown tools count as sensitive. */
  isSensitive(toolName: string): boolean {
    const split = splitMcpToolName(toolName, this.status.keys());
    if (!split) return false;
    if (this.store.isTrusted(split.server, split.tool)) return false;
    const tool = this.status.get(split.server)?.tools?.find((t) => t.name === split.tool);
    if (!tool) return true;
    return !!tool.annotations?.destructive || !tool.annotations?.readOnly;
  }

  /**
   * PreToolUse hook for every MCP tool. Read-only and trusted tools fall through to the normal
   * permission rules. Anything else is put to the user here, in every permission mode
   * (auto, accept edits and bypass included), and only a "yes" lets it run.
   */
  approvalHook(ask: ExplicitAsk): HookCallbackMatcher {
    const hook: HookCallback = async (input, _id, { signal }) => {
      if (input.hook_event_name !== 'PreToolUse' || !input.tool_name.startsWith('mcp__')) return {};
      if (!this.isSensitive(input.tool_name)) return {};
      const split = splitMcpToolName(input.tool_name, this.status.keys());
      const tool = split ? this.status.get(split.server)?.tools?.find((t) => t.name === split.tool) : undefined;
      const reason = tool
        ? `${split!.server} marks ${split!.tool} as ${tool.annotations?.destructive ? 'destructive' : 'able to change things'}; MCP tools that are not read-only need your approval for each call.`
        : 'FrostCode has no read-only marking for this MCP tool, so each call needs your approval.';
      const ok = await ask({ toolName: input.tool_name, input: (input.tool_input as Record<string, unknown>) ?? {}, toolUseId: input.tool_use_id, reason }, signal);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: ok ? 'allow' : 'deny',
          permissionDecisionReason: ok ? 'Approved by the user in FrostCode.' : 'The user declined this MCP tool call.',
        },
      };
    };
    // The user may take a while to answer; the default hook timeout is far too short.
    return { matcher: 'mcp__.*', hooks: [hook], timeout: 24 * 60 * 60 };
  }
}
