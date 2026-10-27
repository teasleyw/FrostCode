// Types shared by the Electron main process and the renderer. No runtime code here:
// the sandboxed preload cannot load local modules, and the renderer bundle only needs types.
import type { PromptAnswer, PromptRequest } from '../core/permissions.js';
import type { McpAction, McpEntryView } from '../mcp/types.js';
import type { WorkSnapshot } from '../work/types.js';

export type { McpAction, McpEntryView, PromptAnswer, PromptRequest, WorkSnapshot };
export type * from '../work/types.js';

/** Same shape as ui/tools.ts DiffLine (not imported: that module pulls in node:fs types). */
export type DiffLine = { type: 'add' | 'remove' | 'context' | 'gap'; text: string; oldNo?: number; newNo?: number };

/** Permission modes the desktop app offers (bypass stays a CLI-only, opt-in flag). */
export type GuiMode = 'default' | 'acceptEdits' | 'plan' | 'auto';

export interface GuiSession {
  id: string;
  title: string;
  lastModified: number;
  cwd: string;
  gitBranch?: string;
}

export interface GuiProjectGroup {
  cwd: string;
  name: string;
  /** Display path with ~ for the home directory. */
  label: string;
  exists: boolean;
  lastActivity: number;
  sessions: GuiSession[];
}

export interface GuiModel {
  value: string;
  displayName: string;
  description: string;
}

/** A transcript item as the renderer sees it: display-ready, redacted, no raw tool payloads. */
export type GuiItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'thinking'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      verb: string;
      arg: string;
      status: 'running' | 'done' | 'error' | 'denied';
      summary: string;
      /** Full (clipped) input and result, shown when the row is expanded. */
      input: string;
      result: string;
      diff?: DiffLine[];
      subagent: boolean;
    }
  | { kind: 'system'; id: string; text: string; tone: 'info' | 'warn' | 'error' | 'success' };

/** Incremental transcript update: the full id order plus every item that changed since the last patch. */
export interface TranscriptPatch {
  reset: boolean;
  order: string[];
  changed: GuiItem[];
}

/** A permission / plan / question prompt with the display extras the renderer needs. */
export type GuiPrompt = PromptRequest & { verb?: string; arg?: string; diff?: DiffLine[] };

export interface GuiSnapshot {
  phase: 'starting' | 'ready';
  cwd: string;
  projectName: string;
  projectLabel: string;
  sessionId: string | null;
  title: string | null;
  busy: boolean;
  busySince: number | null;
  /** Sessions whose last turn ran to completion during this run of the app (not stopped, not still running). */
  finished: string[];
  /** Sessions with a turn running: the open one and any left running in the background. */
  running: string[];
  /** Background sessions stopped at a permission / plan / question prompt until they are opened. */
  waiting: string[];
  mode: string;
  model: string | null;
  modelLabel: string;
  models: GuiModel[];
  prompt: GuiPrompt | null;
  queuedPrompts: number;
  usage: { sessionUsd: number; contextTokens: number; contextWindow: number; turns: number };
  /** MCP at a glance for the top bar: connected servers, and servers that need the user. */
  mcp: { connected: number; awaiting: number; failed: number };
}

export interface GuiInitial {
  snapshot: GuiSnapshot;
  transcript: TranscriptPatch;
  sessions: GuiProjectGroup[];
}

export interface RecentProject {
  path: string;
  name: string;
  label: string;
}

/** Commands the main process (menu accelerators) sends to the renderer. */
export type GuiCommand = 'focus-search' | 'focus-composer' | 'rename-session' | 'show-shortcuts';

export interface GuiEvents {
  state: GuiSnapshot;
  transcript: TranscriptPatch;
  sessions: GuiProjectGroup[];
  command: GuiCommand;
  /** The Work tab: each source updates it as it lands. */
  work: WorkSnapshot;
}

/** What the preload exposes as window.frost. Every call is an IPC round trip to the main process. */
export interface FrostApi {
  /** True when no API key was found at launch: the renderer shows the key setup screen first. */
  needsKey(): Promise<boolean>;
  /** Checks the key with Anthropic, saves it as the "default" account and starts the app. */
  saveApiKey(key: string): Promise<void>;
  init(): Promise<GuiInitial>;
  refreshSessions(): Promise<GuiProjectGroup[]>;
  newSession(cwd?: string): Promise<void>;
  openSession(id: string, cwd: string): Promise<void>;
  renameSession(id: string, cwd: string, title: string): Promise<void>;
  deleteSession(id: string, cwd: string): Promise<boolean>;
  submit(text: string): Promise<void>;
  interrupt(): Promise<void>;
  answer(answer: PromptAnswer): Promise<void>;
  setModel(model: string | null): Promise<void>;
  setMode(mode: GuiMode): Promise<void>;
  /** Per-conversation switch: on = auto (the runtime's classifier approves safe calls), off = default (Ask). Never bypassPermissions. */
  setAutoMode(on: boolean): Promise<void>;
  recentProjects(): Promise<RecentProject[]>;
  chooseProject(): Promise<void>;
  openProject(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** MCP servers for the open project (refresh = re-read the config files first; they are never written). */
  mcpList(refresh?: boolean): Promise<McpEntryView[]>;
  mcpAction(id: string, action: McpAction): Promise<string>;
  /** Trusted tools run without the per-call approval prompt. */
  mcpTrust(server: string, tool: string, trusted: boolean): Promise<void>;
  /** The Work tab's sources and daily list (refresh = fetch everything and rewrite the list). */
  workLoad(refresh?: boolean): Promise<WorkSnapshot>;
  /** Checks the email + API token against the site; the token is stored encrypted in the main process. */
  workConnectJira(site: string, email: string, token: string): Promise<string>;
  /** Starts the Microsoft device-code sign-in; the code to enter also arrives as work.microsoftPending. */
  workConnectMicrosoft(): Promise<{ userCode: string; verificationUri: string }>;
  workCancelMicrosoft(): Promise<void>;
  workDisconnect(source: 'jira' | 'microsoft'): Promise<void>;
  on<K extends keyof GuiEvents>(event: K, fn: (payload: GuiEvents[K]) => void): () => void;
}
