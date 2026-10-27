import { renameSession, type ModelInfo, type PermissionMode, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentSession } from '../core/session.js';
import { TranscriptModel } from '../core/transcript.js';
import { CostTracker, defaultCostStore, formatTokens, formatUsd, type CostStore } from '../core/cost.js';
import { PermissionController, type PromptAnswer, type PromptHost, type PromptRequest } from '../core/permissions.js';
import { listSavedSessions, loadSessionTranscript, type SavedSession } from '../core/history.js';
import { loadProjects, rememberProject, resolveProjectPath, shortenPath, type Project } from '../core/projects.js';
import { COMMANDS, MODE_LABELS, findCommand, nextMode, parseSlash, type CommandContext, type CommandSpec } from '../commands/registry.js';
import { buildHandoffPrompt, findCodexSession, listCodexSessions, type CodexSessionSummary } from '../codex/sessions.js';
import { APP_VERSION } from '../config/env.js';

export type Overlay =
  | { type: 'model'; models: ModelInfo[] }
  | { type: 'resume'; sessions: SavedSession[]; costs: Record<string, number> }
  | { type: 'project'; projects: Project[] }
  | { type: 'codex'; sessions: CodexSessionSummary[]; unfinishedOnly: boolean }
  | { type: 'codex-actions'; session: CodexSessionSummary };

export interface PendingPrompt {
  request: PromptRequest;
  resolve(answer: PromptAnswer): void;
}

export interface ControllerOptions {
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  resume?: string;
  continueLast?: boolean;
  allowBypass?: boolean;
  /** Auto-accept edits applies to edit tools only; filesystem shell commands keep prompting. */
  guardShellInAcceptEdits?: boolean;
  /** Test seam: replace the SDK's query(). */
  queryFn?: ConstructorParameters<typeof AgentSession>[0]['queryFn'];
  costStore?: CostStore | null;
  onExit?(): void;
}

/** Fallback model list when the runtime cannot be asked (offline start, tests). */
export const FALLBACK_MODELS: ModelInfo[] = [
  { value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Most capable for complex work' },
  { value: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Best balance of speed and intelligence' },
  { value: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'Fastest and cheapest' },
  { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'Long-context model' },
];

/**
 * Everything the UI needs, with no React in it: owns the agent session, transcript,
 * cost tracking, permission prompts and slash commands. The UI subscribes and renders.
 */
export class AppController implements PromptHost {
  readonly transcript = new TranscriptModel();
  readonly cost: CostTracker;
  readonly permissions: PermissionController;
  session!: AgentSession;
  cwd: string;
  mode: PermissionMode;
  model: string | undefined;
  models: ModelInfo[] = [];
  overlay: Overlay | null = null;
  pending: PendingPrompt[] = [];
  busySince: number | null = null;
  /** Bumped on /clear so the UI can drop its scrollback region. */
  epoch = 0;
  /** Set by the terminal UI: wipe the screen before a new conversation is drawn. */
  onClearScreen: () => void = () => {};
  private listeners = new Set<() => void>();
  private unsubscribeSession: (() => void) | null = null;

  constructor(private readonly opts: ControllerOptions) {
    this.cwd = opts.cwd;
    this.mode = opts.permissionMode;
    this.model = opts.model;
    this.cost = new CostTracker(opts.costStore === undefined ? defaultCostStore() : opts.costStore);
    this.permissions = new PermissionController(this);
    this.permissions.onDenied = (id) => this.transcript.deniedToolIds.add(id);
    this.permissions.onModeChange = (mode) => {
      this.mode = mode;
      this.emit();
    };
    this.transcript.subscribe(() => this.emit());
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  get busy(): boolean {
    return this.session?.busy ?? false;
  }

  get sessionId(): string | null {
    return this.session?.info.sessionId ?? null;
  }

  /** Spawn the first session and load the runtime's model list. */
  async boot(): Promise<void> {
    rememberProject(this.cwd);
    let resume = this.opts.resume;
    if (!resume && this.opts.continueLast) {
      const [latest] = await listSavedSessions(this.cwd, 1);
      if (latest) resume = latest.id;
      else this.transcript.addSystem('No previous session in this project; starting a new one.', 'warn');
    }
    if (resume) await this.loadHistory(resume);
    this.startSession(resume);
    await this.handshake();
  }

  private async handshake(): Promise<void> {
    try {
      const init = await this.session.initialize();
      this.models = init.models?.length ? init.models : FALLBACK_MODELS;
      const src = init.account?.apiKeySource;
      if (src && src !== 'ANTHROPIC_API_KEY') {
        this.transcript.addSystem(
          `Warning: the runtime reports its credential came from "${src}", not ANTHROPIC_API_KEY. Check for an apiKeyHelper in this project's .claude/settings.json.`,
          'warn',
        );
      }
    } catch (e) {
      this.models = FALLBACK_MODELS;
      this.transcript.addSystem(`Could not start the agent runtime: ${(e as Error).message}`, 'error');
    }
    this.emit();
  }

  private startSession(resume?: string): void {
    this.unsubscribeSession?.();
    this.session = new AgentSession({
      cwd: this.cwd,
      model: this.model,
      permissionMode: this.mode,
      resume,
      allowBypass: this.opts.allowBypass,
      permissions: this.permissions,
      guardShellInAcceptEdits: this.opts.guardShellInAcceptEdits,
      currentMode: () => this.mode,
      queryFn: this.opts.queryFn,
    });
    this.cost.beginSession(resume ?? null);
    this.unsubscribeSession = this.session.subscribe((msg) => this.onMessage(msg));
    this.session.onBusyChange = (busy) => {
      this.busySince = busy ? Date.now() : null;
      this.emit();
    };
    this.session.onExit = (err) => {
      this.transcript.settle();
      this.cancelPrompts();
      if (err && !this.session.closed) {
        this.transcript.addSystem(`Agent runtime stopped: ${err.message}\nYour next message will restart it and resume this conversation.`, 'error');
      }
      this.emit();
    };
    this.session.start();
  }

  private onMessage(msg: SDKMessage): void {
    this.transcript.apply(msg);
    this.cost.apply(msg);
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.mode = msg.permissionMode;
      if (!this.model) this.model = undefined;
    }
    if (msg.type === 'system' && msg.subtype === 'status' && msg.permissionMode) this.mode = msg.permissionMode;
    this.emit();
  }

  // ---- PromptHost -------------------------------------------------------

  ask(request: PromptRequest, signal: AbortSignal): Promise<PromptAnswer> {
    return new Promise((resolve) => {
      const entry: PendingPrompt = {
        request,
        resolve: (answer) => {
          this.pending = this.pending.filter((p) => p !== entry);
          signal.removeEventListener('abort', onAbort);
          resolve(answer);
          this.emit();
        },
      };
      const onAbort = () => entry.resolve({ kind: 'cancel' });
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending = [...this.pending, entry];
      this.emit();
    });
  }

  answer(answer: PromptAnswer): void {
    const head = this.pending[0];
    if (!head) return;
    if (head.request.kind === 'tool' && answer.kind === 'allow' && answer.always && this.isEditTool(head.request.toolName)) {
      // "Allow all edits this session" == accept-edits mode, like Claude Code.
      void this.setMode('acceptEdits');
    }
    head.resolve(answer);
  }

  private isEditTool(name: string): boolean {
    return name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit';
  }

  private cancelPrompts(): void {
    for (const p of [...this.pending]) p.resolve({ kind: 'cancel' });
  }

  // ---- Input ------------------------------------------------------------

  async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const slash = parseSlash(trimmed);
    if (slash) {
      const cmd = findCommand(slash.name);
      if (cmd) {
        try {
          await cmd.run(this.commandContext, slash.args);
        } catch (e) {
          this.transcript.addSystem((e as Error).message, 'error');
        }
        this.emit();
        return;
      }
      if (this.session.info.slashCommands.includes(slash.name)) {
        this.passthrough(trimmed);
        return;
      }
      this.transcript.addSystem(`Unknown command /${slash.name}. Type /help for the list.`, 'error');
      return;
    }
    this.sendToAgent(trimmed);
  }

  private sendToAgent(text: string, display = text): void {
    this.transcript.addUser(display);
    try {
      this.session.send(text);
    } catch (e) {
      this.transcript.addSystem((e as Error).message, 'error');
    }
    this.emit();
  }

  passthrough(text: string): void {
    this.sendToAgent(text);
  }

  async interrupt(): Promise<void> {
    if (this.pending.length) {
      this.cancelPrompts();
    }
    if (this.busy) {
      await this.session.interrupt();
      this.transcript.addSystem('Interrupted by user', 'warn');
    }
  }

  async cycleMode(): Promise<void> {
    await this.setMode(nextMode(this.mode, !!this.opts.allowBypass));
  }

  async setMode(mode: PermissionMode): Promise<void> {
    if (mode === 'bypassPermissions' && !this.opts.allowBypass) {
      this.transcript.addSystem('Bypass mode is only available when FrostCode is started with --dangerously-skip-permissions.', 'error');
      return;
    }
    try {
      await this.session.setPermissionMode(mode);
      this.mode = mode;
    } catch (e) {
      this.transcript.addSystem(`Could not change mode: ${(e as Error).message}`, 'error');
    }
    this.emit();
  }

  async setModel(model: string | undefined): Promise<void> {
    try {
      await this.session.setModel(model);
      this.model = model;
      const label = model ? (this.models.find((m) => m.value === model)?.displayName ?? model) : 'default';
      this.transcript.addSystem(`Model set to ${label}${model && label !== model ? ` (${model})` : ''}`, 'success');
    } catch (e) {
      this.transcript.addSystem(`Could not switch model: ${(e as Error).message}`, 'error');
    }
    this.overlay = null;
    this.emit();
  }

  /** The model the runtime reports, or the resolved id of the "default" alias. */
  get modelLabel(): string {
    const reported = this.session?.info.model;
    const chosen = this.model ?? reported ?? this.models.find((m) => m.value === 'default')?.resolvedModel ?? 'default';
    const info = this.models.find((m) => m.value === chosen || m.resolvedModel === chosen);
    return info && info.value !== 'default' ? `${info.displayName}` : chosen;
  }

  // ---- Sessions & projects -----------------------------------------------

  private async loadHistory(sessionId: string): Promise<void> {
    try {
      const n = await loadSessionTranscript(sessionId, this.cwd, this.transcript);
      this.transcript.addSystem(`Resumed session ${sessionId.slice(0, 8)} (${n} messages)`, 'success');
    } catch (e) {
      this.transcript.addSystem(`Could not load session history: ${(e as Error).message}`, 'warn');
    }
  }

  async clear(): Promise<void> {
    await this.session.close();
    this.transcript.clear();
    this.onClearScreen();
    this.epoch++;
    this.permissions.sessionRules.clear();
    this.startSession();
    this.transcript.addSystem('Started a new conversation. The previous one can be resumed with /resume.');
    this.emit();
  }

  async resume(ref: string): Promise<void> {
    const sessions = await listSavedSessions(this.cwd, 200);
    const hit = sessions.find((s) => s.id === ref) ?? sessions.find((s) => s.id.startsWith(ref));
    if (!hit) {
      this.transcript.addSystem(`No saved session matching "${ref}" in ${shortenPath(this.cwd)}`, 'error');
      return;
    }
    this.overlay = null;
    await this.session.close();
    this.transcript.clear();
    this.onClearScreen();
    this.epoch++;
    await this.loadHistory(hit.id);
    this.startSession(hit.id);
    this.emit();
  }

  async switchProject(input: string): Promise<void> {
    const path = resolveProjectPath(input, this.cwd);
    this.overlay = null;
    if (path === this.cwd) {
      this.transcript.addSystem(`Already in ${shortenPath(path)}`);
      return;
    }
    await this.session.close();
    this.cwd = path;
    rememberProject(path);
    this.transcript.clear();
    this.onClearScreen();
    this.epoch++;
    this.permissions.sessionRules.clear();
    this.startSession();
    this.transcript.addSystem(`Switched project to ${shortenPath(path)}`, 'success');
    this.emit();
  }

  async openResumePicker(): Promise<void> {
    const sessions = await listSavedSessions(this.cwd, 50);
    if (!sessions.length) {
      this.transcript.addSystem(`No saved sessions for ${shortenPath(this.cwd)} yet.`);
      return;
    }
    const store = defaultCostStore();
    const costs: Record<string, number> = {};
    for (const s of sessions) costs[s.id] = store.get(s.id);
    this.overlay = { type: 'resume', sessions, costs };
    this.emit();
  }

  openProjectPicker(): void {
    this.overlay = { type: 'project', projects: loadProjects() };
    this.emit();
  }

  async openModelPicker(): Promise<void> {
    let models = this.models;
    if (!models.length) {
      try {
        models = await this.session.supportedModels();
      } catch {
        models = FALLBACK_MODELS;
      }
      this.models = models;
    }
    this.overlay = { type: 'model', models };
    this.emit();
  }

  closeOverlay(): void {
    this.overlay = null;
    this.emit();
  }

  // ---- Codex ----------------------------------------------------------------

  async openCodexBrowser(unfinishedOnly: boolean): Promise<void> {
    const sessions = await listCodexSessions({ unfinishedOnly, limit: unfinishedOnly ? 25 : 40 });
    if (!sessions.length && unfinishedOnly) {
      this.transcript.addSystem('No unfinished Codex sessions found in ~/.codex/sessions. Showing recent sessions instead.');
      return this.openCodexBrowser(false);
    }
    this.overlay = { type: 'codex', sessions, unfinishedOnly };
    this.emit();
  }

  openCodexActions(session: CodexSessionSummary): void {
    this.overlay = { type: 'codex-actions', session };
    this.emit();
  }

  async codexShow(ref: string): Promise<void> {
    this.overlay = null;
    const d = await findCodexSession(ref);
    if (!d) {
      this.transcript.addSystem(`No Codex session matching "${ref}"`, 'error');
      return;
    }
    const recent = d.timeline
      .filter((e) => e.role !== 'tool_output')
      .slice(-8)
      .map((e) => `  [${e.role}] ${e.text.replace(/\s+/g, ' ').slice(0, 110)}`)
      .join('\n');
    this.transcript.addSystem(
      [
        `Codex session ${d.id}`,
        `  status     ${d.status}${d.isSubagent ? ' (helper thread)' : ''}`,
        `  project    ${d.cwd ? shortenPath(d.cwd) : '?'}`,
        `  model      ${d.model ?? '?'}   turns ${d.turns}   tokens ${d.totalTokens ? formatTokens(d.totalTokens) : '?'}`,
        `  updated    ${new Date(d.updatedAt).toLocaleString()}`,
        `  log        ${shortenPath(d.file)} (read-only)`,
        '',
        `  request    ${(d.firstUserMessage ?? '(none)').replace(/\s+/g, ' ').slice(0, 300)}`,
        d.lastAgentMessage ? `  last reply ${d.lastAgentMessage.replace(/\s+/g, ' ').slice(0, 300)}` : '',
        d.pendingToolCalls.length ? `  pending    ${d.pendingToolCalls.map((p) => p.name).join(', ')}` : '',
        recent ? `\n  recent activity:\n${recent}` : '',
        '',
        `  /codex import ${d.id.slice(0, 13)} to hand it to Claude`,
      ]
        .filter((l) => l !== '')
        .join('\n'),
    );
    this.emit();
  }

  /** Hand a Codex session to the agent. The Codex log is only read, never written. */
  async codexImport(ref: string, switchToItsProject = false): Promise<void> {
    this.overlay = null;
    const d = await findCodexSession(ref);
    if (!d) {
      this.transcript.addSystem(`No Codex session matching "${ref}"`, 'error');
      return;
    }
    if (switchToItsProject && d.cwd && d.cwd !== this.cwd) {
      try {
        await this.switchProject(d.cwd);
      } catch (e) {
        this.transcript.addSystem(`Could not switch to ${d.cwd}: ${(e as Error).message}`, 'warn');
      }
    }
    const prompt = buildHandoffPrompt(d);
    this.sendToAgent(prompt, `Continue Codex session ${d.id.slice(0, 13)}: ${(d.firstUserMessage ?? '').replace(/\s+/g, ' ').slice(0, 120)}`);
  }

  // ---- Info commands ------------------------------------------------------

  showCost(): void {
    const c = this.cost.snapshot();
    const lines = [
      `Session cost:  ${formatUsd(c.sessionUsd)}   (this run: ${formatUsd(c.runUsd)}, last turn: ${formatUsd(c.lastTurnUsd)})`,
      `Tokens:        ${formatTokens(c.tokens.input)} in · ${formatTokens(c.tokens.output)} out · ${formatTokens(c.tokens.cacheRead)} cache read · ${formatTokens(c.tokens.cacheWrite)} cache write`,
      `Turns:         ${c.turns}`,
    ];
    const models = Object.entries(c.perModel);
    if (models.length) {
      lines.push('By model:');
      for (const [m, u] of models) {
        lines.push(`  ${m.padEnd(28)} ${formatUsd(u.costUSD).padStart(8)}  ${formatTokens(u.inputTokens)} in · ${formatTokens(u.outputTokens)} out · ${formatTokens(u.cacheReadInputTokens)} cached`);
      }
    }
    lines.push('', 'Estimates from the SDK price table; your Claude Console usage page is authoritative.');
    this.transcript.addSystem(lines.join('\n'));
  }

  async showContext(): Promise<void> {
    try {
      const u = await this.session.contextUsage();
      if (!u) {
        const c = this.cost.snapshot();
        this.transcript.addSystem(`Context: ${formatTokens(c.contextTokens)} tokens used (no live session).`);
        return;
      }
      const width = 30;
      const filled = Math.round((u.percentage / 100) * width);
      const lines = [
        `Context  ${'█'.repeat(filled)}${'░'.repeat(width - filled)}  ${formatTokens(u.totalTokens)} / ${formatTokens(u.maxTokens)} (${u.percentage.toFixed(0)}%)  ${u.model}`,
        ...u.categories
          .filter((cat) => cat.tokens > 0 && cat.kind !== 'free')
          .map((cat) => `  ${cat.name.padEnd(24)} ${formatTokens(cat.tokens).padStart(7)}`),
        '',
        'Use /compact to summarize the conversation and free space.',
      ];
      this.transcript.addSystem(lines.join('\n'));
    } catch (e) {
      this.transcript.addSystem(`Could not read context usage: ${(e as Error).message}`, 'error');
    }
  }

  showStatus(): void {
    const i = this.session.info;
    this.transcript.addSystem(
      [
        `FrostCode v${APP_VERSION}${i.version ? ` · agent runtime ${i.version}` : ''}`,
        `  project      ${shortenPath(this.cwd)}`,
        `  session      ${i.sessionId ?? '(starts with your first message)'}`,
        `  model        ${this.modelLabel}`,
        `  mode         ${MODE_LABELS[this.mode] ?? this.mode}`,
        `  auth         ${i.apiKeySource ?? 'ANTHROPIC_API_KEY (pending handshake)'} · API billing`,
        `  tools        ${i.tools.length ? i.tools.length + ' available' : '(after first message)'}`,
      ].join('\n'),
    );
  }

  showPermissions(): void {
    const rules = [...this.permissions.sessionRules];
    this.transcript.addSystem(
      rules.length
        ? `Allowed for this session:\n${rules.map((r) => `  • ${r}`).join('\n')}\n/permissions clear to reset`
        : 'No session allow rules yet. Answer "don\'t ask again" on a prompt to add one.',
    );
  }

  async rename(title: string): Promise<void> {
    const id = this.sessionId;
    if (!id) {
      this.transcript.addSystem('Send a message first; the session is saved after the first turn.', 'warn');
      return;
    }
    await renameSession(id, title, { dir: this.cwd });
    this.transcript.addSystem(`Session renamed to "${title}"`, 'success');
  }

  async shutdown(): Promise<void> {
    this.cancelPrompts();
    await this.session?.close();
  }

  readonly commandContext: CommandContext = {
    print: (text, tone) => this.transcript.addSystem(text, tone),
    clear: () => this.clear(),
    exit: () => this.opts.onExit?.(),
    setModel: (m) => this.setModel(m),
    openModelPicker: () => void this.openModelPicker(),
    setMode: (m) => this.setMode(m),
    currentMode: () => this.mode,
    openResumePicker: () => void this.openResumePicker(),
    resume: (id) => this.resume(id),
    openProjectPicker: () => this.openProjectPicker(),
    switchProject: (p) => this.switchProject(p),
    openCodexBrowser: (u) => void this.openCodexBrowser(u),
    codexShow: (r) => this.codexShow(r),
    codexImport: (r) => this.codexImport(r),
    showCost: () => this.showCost(),
    showContext: () => this.showContext(),
    showStatus: () => this.showStatus(),
    showPermissions: () => this.showPermissions(),
    clearPermissions: () => {
      this.permissions.sessionRules.clear();
      this.transcript.addSystem('Cleared session allow rules.', 'success');
    },
    rename: (t) => this.rename(t),
    passthrough: (t) => this.passthrough(t),
    commands: (): CommandSpec[] => COMMANDS,
  };
}
