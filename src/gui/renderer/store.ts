// Pure renderer state helpers (no DOM), unit-tested in test/gui-renderer.test.ts.
import type { GuiItem, GuiProjectGroup, GuiSession, TranscriptPatch } from '../protocol.js';

export interface TranscriptState {
  order: string[];
  items: Map<string, GuiItem>;
}

export const emptyTranscript = (): TranscriptState => ({ order: [], items: new Map() });

/** Merge a main-process patch: replace changed items, adopt the new order, drop items no longer in it. */
export function applyPatch(state: TranscriptState, patch: TranscriptPatch): TranscriptState {
  const items = patch.reset ? new Map<string, GuiItem>() : new Map(state.items);
  for (const item of patch.changed) items.set(item.id, item);
  const keep = new Set(patch.order);
  for (const id of items.keys()) if (!keep.has(id)) items.delete(id);
  return { order: patch.order.filter((id) => items.has(id)), items };
}

export function transcriptList(state: TranscriptState): GuiItem[] {
  return state.order.map((id) => state.items.get(id)!).filter(Boolean);
}

/** Sessions whose title (or project) matches every word of the query; empty groups are dropped while searching. */
export function filterGroups(groups: GuiProjectGroup[], query: string): GuiProjectGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return groups;
  const out: GuiProjectGroup[] = [];
  for (const g of groups) {
    const project = `${g.name} ${g.label}`.toLowerCase();
    const sessions = g.sessions.filter((s) => {
      const hay = `${s.title} ${project} ${s.gitBranch ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    if (sessions.length) out.push({ ...g, sessions });
  }
  return out;
}

/** Sessions in sidebar order, for previous / next navigation. */
export function flatSessions(groups: GuiProjectGroup[]): GuiSession[] {
  return groups.flatMap((g) => g.sessions);
}

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const min = 60_000;
  if (diff < min) return 'just now';
  if (diff < 60 * min) return `${Math.floor(diff / min)}m ago`;
  const d = new Date(ts);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= startOfToday) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (ts >= startOfToday - 86_400_000) return 'Yesterday';
  if (ts >= startOfToday - 6 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: 'short' });
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
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

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Strip Electron's "Error invoking remote method 'x': Error: " wrapper from IPC errors. */
export function ipcErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** The menu accelerators are CmdOrCtrl: ⌘ on macOS, Ctrl on Windows and Linux. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** A Cmd/Ctrl shortcut as the platform writes it: ⌘N / Ctrl+N (spaced, ⌘ N / Ctrl + N, in the shortcuts list). */
export function modKey(key: string, spaced = false): string {
  if (IS_MAC) return spaced ? `⌘ ${key}` : `⌘${key}`;
  return spaced ? `Ctrl + ${key}` : `Ctrl+${key}`;
}

export const MODES = [
  { value: 'default', label: 'Ask', title: 'Ask before edits and commands' },
  { value: 'acceptEdits', label: 'Auto-edit', title: 'Accept file edits automatically' },
  { value: 'plan', label: 'Plan', title: 'Plan mode: read-only research, then propose a plan' },
  { value: 'auto', label: 'Auto', title: 'Auto mode: a safety classifier approves routine actions and asks about risky ones' },
] as const;

/** Plain name of the active permission mode, shown beside the composer. */
export function modeLabel(mode: string): string {
  switch (mode) {
    case 'default':
      return 'Ask before edits';
    case 'acceptEdits':
      return 'Auto-accept edits';
    case 'plan':
      return 'Plan mode';
    case 'auto':
      return 'Auto mode';
    case 'bypassPermissions':
      return 'Bypass permissions';
    default:
      return mode;
  }
}

export function nextMode(mode: string): (typeof MODES)[number]['value'] {
  const i = MODES.findIndex((m) => m.value === mode);
  return MODES[(i + 1) % MODES.length].value;
}
