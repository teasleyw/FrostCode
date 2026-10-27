import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentConfigDir } from '../../src/config/env.js';

/** Real path the way the runtime resolves it (native: on Windows 8.3 names like WILLIA~1 are expanded too). */
export const makeProject = (prefix = 'fc-gui-') => realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));

/** The runtime's project folder name for a cwd (every non-alphanumeric character becomes '-'). */
export function projectFolder(cwd: string): string {
  return join(agentConfigDir(), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/**
 * Write a transcript the way the agent runtime saves one, so the SDK's own listSessions /
 * getSessionMessages / renameSession / deleteSession read it like a real FrostCode session.
 */
export function writeTranscript(cwd: string, turns: [user: string, assistant: string][], opts: { id?: string; at?: number } = {}): string {
  const id = opts.id ?? randomUUID();
  const at = opts.at ?? Date.now();
  const lines: object[] = [];
  let parent: string | null = null;
  turns.forEach(([user, assistant], i) => {
    const base = { isSidechain: false, userType: 'external', entrypoint: 'sdk-ts', cwd, sessionId: id, version: '2.1.310', gitBranch: 'main' };
    const u = randomUUID();
    lines.push({ ...base, parentUuid: parent, type: 'user', message: { role: 'user', content: user }, uuid: u, timestamp: new Date(at - (turns.length - i) * 1000).toISOString() });
    const a = randomUUID();
    lines.push({
      ...base,
      parentUuid: u,
      type: 'assistant',
      message: { id: `msg_${a}`, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: assistant }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
      uuid: a,
      timestamp: new Date(at - (turns.length - i) * 1000 + 500).toISOString(),
    });
    parent = a;
  });
  const dir = projectFolder(cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  utimesSync(file, at / 1000, at / 1000); // listSessions orders by file mtime
  return id;
}
