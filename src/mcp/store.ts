import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { frostHome } from '../config/env.js';

/**
 * FrostCode's own MCP decisions, in ~/.frostcode/mcp.json. The configs these refer to stay
 * where the user keeps them (~/.claude.json, .mcp.json, the desktop app); only the choice to
 * trust and use a server, and per-tool trust, is stored here.
 */
export interface McpDecision {
  decision: 'approved' | 'rejected';
  /** Config hash the decision was made for; a changed config needs a new decision. */
  fingerprint: string;
  enabled: boolean;
  decidedAt: string;
}

export interface McpStoreData {
  version: 1;
  servers: Record<string, McpDecision>;
  /** Server name -> tools the user marked as not needing approval before each call. */
  trustedTools: Record<string, string[]>;
}

export function mcpStoreFile(): string {
  return join(frostHome(), 'mcp.json');
}

const empty = (): McpStoreData => ({ version: 1, servers: {}, trustedTools: {} });

export class McpStore {
  private data: McpStoreData;

  constructor(private readonly file = mcpStoreFile()) {
    this.data = this.read();
  }

  private read(): McpStoreData {
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!d || typeof d !== 'object') return empty();
      return { version: 1, servers: d.servers ?? {}, trustedTools: d.trustedTools ?? {} };
    } catch {
      return empty();
    }
  }

  reload(): void {
    this.data = this.read();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  get(id: string): McpDecision | undefined {
    return this.data.servers[id];
  }

  decide(id: string, decision: McpDecision['decision'], fingerprint: string): void {
    this.data.servers[id] = { decision, fingerprint, enabled: decision === 'approved', decidedAt: new Date().toISOString() };
    this.save();
  }

  setEnabled(id: string, enabled: boolean): void {
    const d = this.data.servers[id];
    if (!d) return;
    d.enabled = enabled;
    this.save();
  }

  isTrusted(server: string, tool: string): boolean {
    return this.data.trustedTools[server]?.includes(tool) ?? false;
  }

  setTrusted(server: string, tool: string, trusted: boolean): void {
    const list = new Set(this.data.trustedTools[server] ?? []);
    if (trusted) list.add(tool);
    else list.delete(tool);
    if (list.size) this.data.trustedTools[server] = [...list].sort();
    else delete this.data.trustedTools[server];
    this.save();
  }
}
