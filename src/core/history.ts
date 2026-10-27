import {
  deleteSession,
  getSessionMessages,
  listSessions,
  renameSession,
  type SDKMessage,
  type SDKSessionInfo,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { TranscriptModel } from './transcript.js';

export interface SavedSession {
  id: string;
  title: string;
  lastModified: number;
  cwd?: string;
  gitBranch?: string;
  sizeBytes?: number;
}

function toSaved(s: SDKSessionInfo): SavedSession {
  return {
    id: s.sessionId,
    title: (s.customTitle || s.summary || s.firstPrompt || '(untitled)').replace(/\s+/g, ' ').trim(),
    lastModified: s.lastModified,
    cwd: s.cwd,
    gitBranch: s.gitBranch,
    sizeBytes: s.fileSize,
  };
}

/** Sessions saved by FrostCode for a project directory, newest first. */
export async function listSavedSessions(dir: string, limit = 50): Promise<SavedSession[]> {
  let sessions: SDKSessionInfo[] = [];
  try {
    sessions = await listSessions({ dir, limit });
  } catch {
    return [];
  }
  return sessions.map(toSaved).sort((a, b) => b.lastModified - a.lastModified);
}

/** Sessions saved by FrostCode across every project, newest first. */
export async function listAllSavedSessions(limit = 500): Promise<SavedSession[]> {
  let sessions: SDKSessionInfo[] = [];
  try {
    sessions = await listSessions({ limit });
  } catch {
    return [];
  }
  return sessions.map(toSaved).sort((a, b) => b.lastModified - a.lastModified);
}

export async function renameSavedSession(sessionId: string, title: string, dir?: string): Promise<void> {
  await renameSession(sessionId, title, dir ? { dir } : undefined);
}

export async function deleteSavedSession(sessionId: string, dir?: string): Promise<void> {
  await deleteSession(sessionId, dir ? { dir } : undefined);
}

/** Rebuild the visible transcript of a saved session. */
export async function loadSessionTranscript(sessionId: string, dir: string, into: TranscriptModel): Promise<number> {
  const messages = await getSessionMessages(sessionId, { dir });
  replayInto(into, messages);
  return messages.length;
}

export function replayInto(model: TranscriptModel, messages: SessionMessage[]): void {
  for (const m of messages) {
    if (m.parent_tool_use_id) continue;
    const message = m.message as { role?: string; content?: unknown; id?: string } | undefined;
    if (!message) continue;
    if (m.type === 'user') {
      const text = userText(message.content);
      if (text !== null) {
        model.addUser(text);
        continue;
      }
      model.apply({ type: 'user', message, parent_tool_use_id: null } as unknown as SDKMessage);
    } else if (m.type === 'assistant') {
      model.apply({
        type: 'assistant',
        message: { ...message, id: message.id ?? m.uuid },
        parent_tool_use_id: null,
      } as unknown as SDKMessage);
    }
  }
  model.settle();
}

/** The typed text of a user message, or null when it only carries tool results. */
export function userText(content: unknown): string | null {
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result')) return null;
    text = content
      .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n');
  } else return null;
  text = text.trim();
  if (!text) return null;
  // Runtime-injected context, not something the user typed.
  if (/^<(system-reminder|local-command-caveat)>/.test(text)) return null;
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] ?? '';
    return `${cmd[1]} ${args}`.trim();
  }
  const out = /<local-command-stdout>([\s\S]*)<\/local-command-stdout>/.exec(text);
  if (out) return null;
  return text;
}
