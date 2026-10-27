import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { AppController, type ControllerOptions } from '../app/controller.js';
import { agentConfigDir, frostHome, redact } from '../config/env.js';
import type { CostStore } from '../core/cost.js';
import { deleteSavedSession, listAllSavedSessions, renameSavedSession, type SavedSession } from '../core/history.js';
import type { PromptAnswer } from '../core/permissions.js';
import { loadProjects, rememberProject, resolveProjectPath, shortenPath } from '../core/projects.js';
import type { TranscriptItem } from '../core/transcript.js';
import { diffLines, isEditTool, patchFor, proposedPatch, toolHeader, toolSummary } from '../ui/tools.js';
import type {
  DiffLine,
  GuiInitial,
  GuiItem,
  GuiMode,
  GuiProjectGroup,
  GuiPrompt,
  GuiSession,
  GuiSnapshot,
  RecentProject,
  TranscriptPatch,
} from './protocol.js';

// ---- persisted desktop state ----------------------------------------------

export interface GuiPrefs {
  /** The conversation open when the app last ran; reopened on the next launch. */
  last?: { sessionId: string | null; cwd: string };
  model?: string | null;
  window?: { x?: number; y?: number; width: number; height: number };
}

export function guiPrefsFile(): string {
  return join(frostHome(), 'gui-state.json');
}

export function loadGuiPrefs(file = guiPrefsFile()): GuiPrefs {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? (data as GuiPrefs) : {};
  } catch {
    return {};
  }
}

export function saveGuiPrefs(patch: Partial<GuiPrefs>, file = guiPrefsFile()): void {
  const next = { ...loadGuiPrefs(file), ...patch };
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, file);
  } catch {
    /* best effort */
  }
}

// ---- transcript -> renderer -------------------------------------------------

const MAX_FIELD = 20_000;
const clipField = (s: string) => (s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}\n… (${s.length - MAX_FIELD} more characters)` : s);
const clean = (s: string) => clipField(redact(s));

/** Convert a transcript item into what the renderer draws: redacted, clipped, tool rows pre-summarized. */
export function toGuiItem(item: TranscriptItem, cwd: string): GuiItem {
  switch (item.kind) {
    case 'user':
      return { kind: 'user', id: item.id, text: clean(item.text) };
    case 'assistant':
    case 'thinking':
      return { kind: item.kind, id: item.id, text: clean(item.text), streaming: item.streaming };
    case 'system':
      return { kind: 'system', id: item.id, text: clean(item.text), tone: item.tone };
    case 'tool': {
      const { verb, arg } = toolHeader(item.name, item.input, cwd);
      let diff: DiffLine[] | undefined;
      if (isEditTool(item.name) && item.status === 'done') {
        try {
          diff = diffLines(patchFor(item, cwd), 200).lines;
        } catch {
          diff = undefined;
        }
      }
      let input: string;
      if (item.name === 'Bash' && typeof item.input.command === 'string') input = item.input.command;
      else input = JSON.stringify(item.input, null, 2);
      return {
        kind: 'tool',
        id: item.id,
        name: item.name,
        verb,
        arg: redact(arg),
        status: item.status,
        summary: redact(toolSummary(item, cwd)),
        input: clean(input),
        result: clean(item.result ?? ''),
        diff: diff?.map((l) => ({ ...l, text: redact(l.text) })),
        subagent: !!item.parentId,
      };
    }
  }
}

/** Sends only the transcript items whose objects changed (TranscriptModel replaces items on update). */
export class TranscriptDiffer {
  private sent = new Map<string, TranscriptItem>();
  private needReset = true;
  private lastOrder = '';

  reset(): void {
    this.needReset = true;
  }

  diff(items: TranscriptItem[], cwd: string, force = false): TranscriptPatch | null {
    const reset = this.needReset;
    this.needReset = false;
    if (reset) this.sent.clear();
    const changed: GuiItem[] = [];
    for (const item of items) {
      if (this.sent.get(item.id) === item) continue;
      this.sent.set(item.id, item);
      changed.push(toGuiItem(item, cwd));
    }
    const order = items.map((i) => i.id);
    const orderKey = order.join(',');
    if (!reset && !force && !changed.length && orderKey === this.lastOrder) return null;
    this.lastOrder = orderKey;
    return { reset, order, changed };
  }
}

// ---- sessions ---------------------------------------------------------------

/** The saved transcript file of a session and its current mtime, or null if it cannot be found. */
function viewedFile(sessionId: string): { file: string; mtime: Date } | null {
  const root = join(agentConfigDir(), 'projects');
  try {
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, `${sessionId}.jsonl`);
      if (existsSync(file)) return { file, mtime: statSync(file).mtime };
    }
  } catch {
    /* no transcripts yet */
  }
  return null;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Group saved sessions by project, adding recent projects that have no sessions yet. Newest first. */
export function groupSessions(saved: SavedSession[], recent: { path: string; lastOpened: number }[]): GuiProjectGroup[] {
  const groups = new Map<string, GuiProjectGroup>();
  const group = (cwd: string): GuiProjectGroup => {
    let g = groups.get(cwd);
    if (!g) {
      g = { cwd, name: basename(cwd) || cwd, label: shortenPath(cwd), exists: existsSync(cwd), lastActivity: 0, sessions: [] };
      groups.set(cwd, g);
    }
    return g;
  };
  for (const s of saved) {
    const cwd = s.cwd || '(unknown project)';
    const g = group(cwd);
    const session: GuiSession = { id: s.id, title: s.title, lastModified: s.lastModified, cwd, gitBranch: s.gitBranch };
    g.sessions.push(session);
    g.lastActivity = Math.max(g.lastActivity, s.lastModified);
  }
  for (const p of recent) {
    // Older entries may hold an unresolved path (/tmp/x) for a project the runtime records as /private/tmp/x.
    const g = group(realOrSelf(p.path));
    g.lastActivity = Math.max(g.lastActivity, p.lastOpened);
  }
  for (const g of groups.values()) g.sessions.sort((a, b) => b.lastModified - a.lastModified);
  return [...groups.values()].sort((a, b) => b.lastActivity - a.lastActivity);
}

// ---- backend ----------------------------------------------------------------

export type BackendEvent =
  | { type: 'state'; payload: GuiSnapshot }
  | { type: 'transcript'; payload: TranscriptPatch }
  | { type: 'sessions'; payload: GuiProjectGroup[] };

export interface BackendOptions {
  /** Project used when there is nothing to restore. */
  defaultCwd: string;
  /** Open this project instead of restoring the last conversation (frostcode gui <dir>). */
  cwd?: string;
  emit(event: BackendEvent): void;
  prefsFile?: string;
  /** Test seams, passed straight to AppController. */
  queryFn?: ControllerOptions['queryFn'];
  costStore?: CostStore | null;
  /** Coalesce rapid controller updates (streaming deltas) into one IPC message. */
  throttleMs?: number;
}

const GUI_MODES: GuiMode[] = ['default', 'acceptEdits', 'plan', 'auto'];
/** Slash commands whose terminal pickers have a desktop equivalent. */
const DESKTOP_EQUIVALENT: Record<string, string> = {
  model: 'Pick a model from the menu in the top bar.',
  resume: 'Pick a conversation from the sidebar.',
  project: 'Choose a project with the project button in the top bar (⌘O).',
  codex: 'Codex browsing is available in the terminal app (frostcode, then /codex).',
};

/**
 * The desktop app's view of FrostCode: one live AppController (the same one the terminal
 * UI drives) for the open conversation, plus session listing, switching and persistence.
 */
export class GuiBackend {
  private ctrl: AppController | null = null;
  private unsubscribe: (() => void) | null = null;
  private generation = 0;
  private phase: GuiSnapshot['phase'] = 'starting';
  private differ = new TranscriptDiffer();
  private lastEpoch = -1;
  private sessions: GuiProjectGroup[] = [];
  /** Mode of the open conversation. Each conversation keeps its own; a new one starts in Ask. */
  private mode: PermissionMode = 'default';
  /** Modes chosen per saved conversation during this run of the app (never written to disk). */
  private sessionModes = new Map<string, GuiMode>();
  private model: string | null;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastSessionId: string | null = null;
  /** Transcript of a resumed session nobody has sent a message in yet, with its original mtime. */
  private viewed: { file: string; mtime: Date } | null = null;
  private wasBusy = false;
  /** Sessions whose last turn finished on its own this run; shown as done in the sidebar. */
  private finished = new Set<string>();
  /** Turns the user stopped, so their end is not "done". */
  private stopped = new WeakSet<AppController>();
  /** Conversations switched away from mid-turn: they keep running, unseen, and close when the turn ends. */
  private background = new Map<AppController, { unsubscribe: () => void; lastId: string | null }>();
  private closed = false;

  constructor(private readonly opts: BackendOptions) {
    this.model = loadGuiPrefs(this.prefsFile).model ?? null;
  }

  private get prefsFile(): string {
    return this.opts.prefsFile ?? guiPrefsFile();
  }

  get controller(): AppController | null {
    return this.ctrl;
  }

  /** Reopen the last conversation (or start one in the requested / default project). */
  async start(): Promise<void> {
    await this.refreshSessions(false);
    const last = loadGuiPrefs(this.prefsFile).last;
    if (this.opts.cwd) {
      const resume = last?.cwd === this.opts.cwd ? last.sessionId : null;
      return this.activate(this.opts.cwd, resume && this.isSaved(resume) ? resume : undefined);
    }
    if (last && existsSync(last.cwd)) {
      return this.activate(last.cwd, last.sessionId && this.isSaved(last.sessionId) ? last.sessionId : undefined);
    }
    return this.activate(this.opts.defaultCwd);
  }

  /**
   * Shut a controller down. A resumed runtime appends bookkeeping (mode, cost state) to its
   * transcript on exit even when nothing was said; if no message was sent, restore the file's
   * mtime so merely viewing a conversation does not change its "last activity" date.
   */
  private async close(ctrl: AppController | null): Promise<void> {
    const viewed = this.viewed;
    this.viewed = null;
    await ctrl?.shutdown();
    if (viewed) {
      try {
        utimesSync(viewed.file, new Date(), viewed.mtime);
      } catch {
        /* the file may have been deleted */
      }
    }
  }

  private isSaved(id: string): boolean {
    return this.sessions.some((g) => g.sessions.some((s) => s.id === id));
  }

  /**
   * Leave the current conversation and open another (resume = saved session id). A conversation
   * left mid-turn keeps running in the background; reopening it reattaches to the live one.
   */
  private async activate(cwd: string, resume?: string): Promise<void> {
    const gen = ++this.generation;
    const old = this.ctrl;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ctrl = null;
    this.phase = 'starting';
    if (old?.busy) this.toBackground(old);
    else await this.close(old);
    if (gen !== this.generation || this.closed) return;
    const running = resume ? [...this.background.keys()].find((c) => c.sessionId === resume && c.cwd === cwd) : undefined;
    if (running) return this.attach(running);
    this.viewed = resume ? viewedFile(resume) : null;
    this.mode = (resume && this.sessionModes.get(resume)) || 'default';

    const ctrl = new AppController({
      cwd,
      resume,
      model: this.model ?? undefined,
      permissionMode: this.mode,
      guardShellInAcceptEdits: true,
      queryFn: this.opts.queryFn,
      costStore: this.opts.costStore,
      onExit: () => {},
    });
    this.ctrl = ctrl;
    this.differ.reset();
    this.lastEpoch = ctrl.epoch;
    this.lastSessionId = resume ?? null;
    this.wasBusy = false;
    this.unsubscribe = ctrl.subscribe(() => this.onControllerChange(ctrl));
    this.persistLast();
    this.flush();
    await ctrl.boot();
    if (gen !== this.generation) return;
    this.phase = 'ready';
    this.flush();
  }

  /** Keep a mid-turn conversation running after the user switches away. */
  private toBackground(ctrl: AppController): void {
    this.viewed = null;
    const entry = { unsubscribe: () => {}, lastId: ctrl.sessionId };
    entry.unsubscribe = ctrl.subscribe(() => this.onBackgroundChange(ctrl, entry));
    this.background.set(ctrl, entry);
  }

  /** Bring a background conversation back into view, as it is right now. */
  private attach(ctrl: AppController): void {
    this.background.get(ctrl)?.unsubscribe();
    this.background.delete(ctrl);
    this.viewed = null;
    this.mode = ctrl.mode;
    this.ctrl = ctrl;
    this.differ.reset();
    this.lastEpoch = ctrl.epoch;
    this.lastSessionId = ctrl.sessionId;
    this.wasBusy = ctrl.busy;
    this.unsubscribe = ctrl.subscribe(() => this.onControllerChange(ctrl));
    this.phase = 'ready';
    this.persistLast();
    this.flush();
  }

  private onBackgroundChange(ctrl: AppController, entry: { unsubscribe: () => void; lastId: string | null }): void {
    if (this.background.get(ctrl) !== entry) return;
    const id = ctrl.sessionId;
    if (!ctrl.busy) {
      // The turn ended unseen: record it and free the runtime. Reopening resumes it from disk.
      if (id && !this.stopped.has(ctrl)) this.finished.add(id);
      entry.unsubscribe();
      this.background.delete(ctrl);
      void ctrl.shutdown();
      void this.refreshSessions();
      return;
    }
    if (id !== entry.lastId) {
      entry.lastId = id; // a new conversation got its id: show it in the list
      void this.refreshSessions();
    }
    this.schedule(); // running / waiting marks
  }

  private onControllerChange(ctrl: AppController): void {
    if (ctrl !== this.ctrl) return;
    if (ctrl.epoch !== this.lastEpoch) {
      this.lastEpoch = ctrl.epoch;
      this.differ.reset();
    }
    const id = ctrl.sessionId;
    let sessionsStale = false;
    if (id && id !== this.lastSessionId) {
      this.lastSessionId = id;
      this.persistLast();
      sessionsStale = true;
    }
    if (ctrl.busy) this.viewed = null; // a real turn: the new mtime is genuine activity
    if (!this.wasBusy && ctrl.busy) {
      this.stopped.delete(ctrl);
      if (id) this.finished.delete(id);
    }
    if (this.wasBusy && !ctrl.busy) {
      sessionsStale = true; // a turn finished: title / activity changed
      if (id && !this.stopped.has(ctrl)) this.finished.add(id);
    }
    this.wasBusy = ctrl.busy;
    // Plan approval and "allow all edits" change the mode from inside the controller; keep it with this conversation.
    if (GUI_MODES.includes(ctrl.mode as GuiMode)) this.mode = ctrl.mode;
    this.rememberMode(ctrl);
    if (sessionsStale) void this.refreshSessions();
    this.schedule();
  }

  private rememberMode(ctrl: AppController): void {
    if (ctrl.sessionId && GUI_MODES.includes(ctrl.mode as GuiMode)) this.sessionModes.set(ctrl.sessionId, ctrl.mode as GuiMode);
  }

  private persistLast(): void {
    if (!this.ctrl) return;
    saveGuiPrefs({ last: { sessionId: this.ctrl.sessionId, cwd: this.ctrl.cwd } }, this.prefsFile);
  }

  private schedule(): void {
    const ms = this.opts.throttleMs ?? 30;
    if (ms <= 0) return this.flush();
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, ms);
  }

  private flush(): void {
    if (this.closed) return;
    const patch = this.ctrl ? this.differ.diff(this.ctrl.transcript.items, this.ctrl.cwd) : null;
    if (patch) this.opts.emit({ type: 'transcript', payload: patch });
    this.opts.emit({ type: 'state', payload: this.snapshot() });
  }

  snapshot(): GuiSnapshot {
    const c = this.ctrl;
    const cwd = c?.cwd ?? this.opts.cwd ?? this.opts.defaultCwd;
    const id = c?.sessionId ?? null;
    // Saved title first; until the runtime has written one, the first thing the user typed.
    const firstPrompt = c?.transcript.items.find((i) => i.kind === 'user');
    const title =
      (id ? this.sessions.flatMap((g) => g.sessions).find((s) => s.id === id)?.title : undefined) ??
      (firstPrompt?.kind === 'user' ? redact(firstPrompt.text).replace(/\s+/g, ' ').slice(0, 120) : null);
    const usage = c?.cost.snapshot();
    return {
      phase: c ? this.phase : 'starting',
      cwd,
      projectName: basename(cwd) || cwd,
      projectLabel: shortenPath(cwd),
      sessionId: id,
      title,
      busy: c?.busy ?? false,
      busySince: c?.busySince ?? null,
      finished: [...this.finished],
      running: [c, ...this.background.keys()].flatMap((x) => (x?.busy && x.sessionId ? [x.sessionId] : [])),
      waiting: [...this.background.keys()].flatMap((x) => (x.pending.length && x.sessionId ? [x.sessionId] : [])),
      mode: c?.mode ?? this.mode,
      model: this.model,
      modelLabel: c?.modelLabel ?? 'default',
      models: (c?.models ?? []).map((m) => ({ value: m.value, displayName: m.displayName, description: m.description })),
      prompt: c?.pending[0] ? this.promptView(c.pending[0].request, cwd) : null,
      queuedPrompts: Math.max(0, (c?.pending.length ?? 0) - 1),
      usage: {
        sessionUsd: usage?.sessionUsd ?? 0,
        contextTokens: usage?.contextTokens ?? 0,
        contextWindow: usage?.contextWindow ?? 0,
        turns: usage?.turns ?? 0,
      },
    };
  }

  private promptView(req: NonNullable<AppController['pending'][number]>['request'], cwd: string): GuiPrompt {
    if (req.kind !== 'tool') return req;
    const { verb, arg } = toolHeader(req.toolName, req.input, cwd);
    let diff: GuiPrompt['diff'];
    if (isEditTool(req.toolName)) {
      try {
        diff = diffLines(proposedPatch(req.toolName, req.input, cwd), 200).lines.map((l) => ({ ...l, text: redact(l.text) }));
      } catch {
        diff = undefined;
      }
    }
    const input = JSON.parse(redact(JSON.stringify(req.input))) as Record<string, unknown>;
    return { ...req, input, verb, arg: redact(arg), diff };
  }

  initial(): GuiInitial {
    const transcript: TranscriptPatch = this.ctrl
      ? { reset: true, order: this.ctrl.transcript.items.map((i) => i.id), changed: this.ctrl.transcript.items.map((i) => toGuiItem(i, this.ctrl!.cwd)) }
      : { reset: true, order: [], changed: [] };
    return { snapshot: this.snapshot(), transcript, sessions: this.sessions };
  }

  // ---- session management --------------------------------------------------

  async refreshSessions(emit = true): Promise<GuiProjectGroup[]> {
    const saved = await listAllSavedSessions(1000);
    this.sessions = groupSessions(saved, loadProjects());
    if (emit && !this.closed) {
      this.opts.emit({ type: 'sessions', payload: this.sessions });
      this.opts.emit({ type: 'state', payload: this.snapshot() });
    }
    return this.sessions;
  }

  /** Conversations with a turn running, the open one included. */
  get runningCount(): number {
    return [this.ctrl, ...this.background.keys()].filter((c) => c?.busy).length;
  }

  get sessionGroups(): GuiProjectGroup[] {
    return this.sessions;
  }

  async newSession(cwd?: string): Promise<void> {
    const dir = cwd ?? this.ctrl?.cwd ?? this.opts.defaultCwd;
    if (!existsSync(dir)) throw new Error(`Project folder no longer exists: ${shortenPath(dir)}`);
    rememberProject(dir);
    await this.activate(dir);
    await this.refreshSessions();
  }

  async openSession(id: string, cwd: string): Promise<void> {
    if (this.ctrl?.sessionId === id && this.ctrl.cwd === cwd) return;
    await this.activate(cwd, id);
  }

  async openProject(path: string): Promise<void> {
    const dir = resolveProjectPath(path, this.ctrl?.cwd ?? this.opts.defaultCwd);
    await this.newSession(dir);
  }

  recentProjects(): RecentProject[] {
    const seen = new Set<string>();
    const out: RecentProject[] = [];
    for (const p of loadProjects()) {
      if (!existsSync(p.path)) continue;
      const path = realOrSelf(p.path);
      if (seen.has(path)) continue;
      seen.add(path);
      out.push({ path, name: basename(path) || path, label: shortenPath(path) });
    }
    return out;
  }

  async renameSession(id: string, cwd: string, title: string): Promise<void> {
    const t = title.replace(/\s+/g, ' ').trim();
    if (!t) throw new Error('A title cannot be empty.');
    await renameSavedSession(id, t, cwd);
    await this.refreshSessions();
  }

  async deleteSession(id: string, cwd: string): Promise<void> {
    // Close the runtime first so it cannot write the transcript back after deletion.
    if (this.ctrl?.sessionId === id) await this.activate(this.ctrl.cwd);
    for (const [c, entry] of this.background) {
      if (c.sessionId !== id) continue;
      entry.unsubscribe();
      this.background.delete(c);
      await c.shutdown();
    }
    this.finished.delete(id);
    await deleteSavedSession(id, cwd);
    await this.refreshSessions();
  }

  // ---- conversation ---------------------------------------------------------

  private requireCtrl(): AppController {
    if (!this.ctrl) throw new Error('The conversation is still starting.');
    return this.ctrl;
  }

  async submit(text: string): Promise<void> {
    const ctrl = this.requireCtrl();
    const trimmed = text.trim();
    if (!trimmed) return;
    const cmd = /^\/(\S+)/.exec(trimmed)?.[1];
    if (cmd === 'clear' || cmd === 'new') return this.newSession(ctrl.cwd);
    if (cmd === 'exit' || cmd === 'quit') {
      ctrl.transcript.addSystem('Close the window (⌘W) or quit (⌘Q) to leave the desktop app.');
      return;
    }
    await ctrl.submit(trimmed);
    if (ctrl.overlay) {
      // Terminal pickers have no desktop rendering; point at the desktop control instead.
      ctrl.closeOverlay();
      ctrl.transcript.addSystem(DESKTOP_EQUIVALENT[cmd ?? ''] ?? 'That picker is only available in the terminal app.');
    }
  }

  async interrupt(): Promise<void> {
    if (this.ctrl?.busy) this.stopped.add(this.ctrl);
    await this.ctrl?.interrupt();
  }

  answer(answer: PromptAnswer): void {
    this.requireCtrl().answer(answer);
  }

  async setModel(model: string | null): Promise<void> {
    const ctrl = this.requireCtrl();
    await ctrl.setModel(model ?? undefined);
    this.model = model;
    saveGuiPrefs({ model }, this.prefsFile);
    this.flush();
  }

  async setMode(mode: GuiMode): Promise<void> {
    if (!GUI_MODES.includes(mode)) throw new Error(`Unsupported mode ${mode}`);
    const ctrl = this.requireCtrl();
    await ctrl.setMode(mode);
    this.mode = ctrl.mode;
    this.rememberMode(ctrl);
    this.flush();
  }

  /** The composer's per-conversation "Auto mode" switch, like Claude's: auto on, Ask off. */
  async setAutoMode(on: boolean): Promise<void> {
    await this.setMode(on ? 'auto' : 'default');
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.generation++;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.unsubscribe?.();
    if (this.ctrl) this.persistLast();
    const ctrl = this.ctrl;
    this.ctrl = null;
    const background = [...this.background];
    this.background.clear();
    for (const [, entry] of background) entry.unsubscribe();
    await Promise.all([this.close(ctrl), ...background.map(([c]) => c.shutdown())]);
  }
}
