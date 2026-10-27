// Display types for the MCP screen, shared by the terminal UI, the desktop backend and the
// renderer. Types only: the renderer bundle and the sandboxed preload import nothing at runtime.

export type McpEntryState =
  /** Found, never approved: not connected until the user says so. */
  | 'needs-approval'
  /** Approved once, but its command / url / env changed since: needs approving again. */
  | 'changed'
  | 'rejected'
  | 'disabled'
  /** Same name defined in a closer scope; that one is used. */
  | 'shadowed'
  /** Transport FrostCode cannot run (e.g. an in-process or proxy server). */
  | 'unsupported'
  | 'connected'
  | 'pending'
  | 'failed'
  | 'needs-auth'
  /** Approved and enabled; the runtime has not reported on it yet. */
  | 'starting';

export interface McpToolView {
  name: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  /** Needs explicit approval before each call (not read-only, or unknown), unless trusted. */
  sensitive: boolean;
  /** The user chose "don't ask before each call" for this tool. */
  trusted: boolean;
}

export interface McpEntryView {
  id: string;
  name: string;
  scope: string;
  scopeLabel: string;
  /** File the definition lives in (read-only). */
  source: string;
  transport: string | null;
  /** Command line or URL. Env and header VALUES are never included. */
  summary: string;
  envKeys: string[];
  headerKeys: string[];
  state: McpEntryState;
  /** Error text, why a server is unsupported, or which definition shadows it. */
  detail?: string;
  /** Turned off in the app it came from (the desktop app's extension switch). */
  offInSource: boolean;
  serverInfo?: { name: string; version: string };
  tools: McpToolView[];
}

export type McpAction = 'approve' | 'reject' | 'enable' | 'disable' | 'reconnect' | 'refresh';

export const MCP_STATE_LABELS: Record<McpEntryState, string> = {
  'needs-approval': 'needs approval',
  changed: 'changed, needs approval',
  rejected: 'rejected',
  disabled: 'disabled',
  shadowed: 'shadowed',
  unsupported: 'unsupported',
  connected: 'connected',
  pending: 'connecting',
  failed: 'failed',
  'needs-auth': 'needs sign-in',
  starting: 'starting',
};
