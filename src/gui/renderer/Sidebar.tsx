import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { GuiProjectGroup, GuiSession } from '../protocol.js';
import { IconAsk, IconCheck, IconChevron, IconPencil, IconPlus, IconSearch, IconTrash } from './icons.js';
import { filterGroups, relativeTime } from './store.js';

const PER_GROUP = 8;

interface Props {
  groups: GuiProjectGroup[];
  activeId: string | null;
  activeCwd: string;
  activeTitle: string | null;
  /** The open conversation has a turn running. */
  busy: boolean;
  /** Sessions whose last turn finished on its own this run. */
  finished: string[];
  /** Sessions with a turn running, open or in the background. */
  running: string[];
  /** Background sessions waiting on a prompt. */
  waiting: string[];
  query: string;
  setQuery(q: string): void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  renamingId: string | null;
  setRenamingId(id: string | null): void;
  onOpen(s: GuiSession): void;
  onNew(cwd?: string): void;
  onRename(s: GuiSession, title: string): void;
  onDelete(s: GuiSession): void;
}

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem('collapsed') ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function Sidebar(p: Props) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const finished = new Set(p.finished);
  const running = new Set(p.running);
  const waiting = new Set(p.waiting);
  const statusOf = (id: string): Status =>
    waiting.has(id) ? 'waiting' : running.has(id) || (id === p.activeId && p.busy) ? 'running' : finished.has(id) ? 'done' : null;

  const searching = p.query.trim().length > 0;
  let groups = filterGroups(p.groups, p.query);
  // The open conversation's project always shows, even before its first message is saved.
  if (!searching && !groups.some((g) => g.cwd === p.activeCwd)) {
    const name = p.activeCwd.split('/').filter(Boolean).pop() ?? p.activeCwd;
    groups = [{ cwd: p.activeCwd, name, label: p.activeCwd, exists: true, lastActivity: Date.now(), sessions: [] }, ...groups];
  }

  const toggle = (cwd: string) => {
    const next = new Set(collapsed);
    if (next.has(cwd)) next.delete(cwd);
    else next.add(cwd);
    setCollapsed(next);
    localStorage.setItem('collapsed', JSON.stringify([...next]));
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      p.setQuery('');
      e.currentTarget.blur();
    } else if (e.key === 'Enter') {
      const first = groups.flatMap((g) => g.sessions)[0];
      if (first) p.onOpen(first);
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <button className="btn-new no-drag" onClick={() => p.onNew()} title="New conversation (⌘N)">
          <IconPlus /> New conversation <kbd>⌘N</kbd>
        </button>
        <label className="search no-drag">
          <IconSearch />
          <input
            ref={p.searchRef}
            value={p.query}
            onChange={(e) => p.setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Search conversations"
            spellCheck={false}
          />
          {!p.query && <kbd>⌘K</kbd>}
        </label>
      </div>
      <nav className="sessions" aria-label="Conversations">
        {searching && !groups.length && <div className="empty-note">No conversations match “{p.query}”.</div>}
        {groups.map((g) => {
          const isCollapsed = !searching && collapsed.has(g.cwd);
          const showAll = searching || expanded.has(g.cwd);
          const list = showAll ? g.sessions : g.sessions.slice(0, PER_GROUP);
          // The open conversation before it is in the saved list (new, or its first turn still running).
          const showDraft = !searching && g.cwd === p.activeCwd && !g.sessions.some((s) => s.id === p.activeId);
          return (
            <section key={g.cwd} className="group">
              <div className="group-head">
                <button className={`group-toggle ${isCollapsed ? 'collapsed' : ''}`} onClick={() => toggle(g.cwd)} title={g.label}>
                  <IconChevron />
                  <span className="group-name">{g.name}</span>
                  {!g.exists && <span className="badge">missing</span>}
                </button>
                {g.exists && (
                  <button className="icon-btn" onClick={() => p.onNew(g.cwd)} title={`New conversation in ${g.name}`}>
                    <IconPlus />
                  </button>
                )}
              </div>
              {!isCollapsed && (
                <ul>
                  {showDraft && (
                    <li>
                      <div className="session active draft">
                        <StatusMark status={p.busy ? 'running' : null} />
                        <span className="session-title">{p.activeTitle ?? 'New conversation'}</span>
                      </div>
                    </li>
                  )}
                  {list.map((s) => (
                    <SessionRow
                      key={s.id}
                      s={s}
                      status={statusOf(s.id)}
                      now={now}
                      active={s.id === p.activeId}
                      renaming={p.renamingId === s.id}
                      startRename={() => p.setRenamingId(s.id)}
                      stopRename={() => p.setRenamingId(null)}
                      onOpen={() => p.onOpen(s)}
                      onRename={(t) => p.onRename(s, t)}
                      onDelete={() => p.onDelete(s)}
                    />
                  ))}
                  {!showAll && g.sessions.length > PER_GROUP && (
                    <li>
                      <button className="more" onClick={() => setExpanded(new Set(expanded).add(g.cwd))}>
                        Show {g.sessions.length - PER_GROUP} more
                      </button>
                    </li>
                  )}
                  {!g.sessions.length && !showDraft && <li className="empty-note">No conversations yet</li>}
                </ul>
              )}
            </section>
          );
        })}
      </nav>
    </aside>
  );
}

type Status = 'running' | 'waiting' | 'done' | null;

/** In-progress spinner, needs-you question mark or done check before a session title (shape, not just colour, tells them apart). */
function StatusMark({ status }: { status: Status }) {
  if (status === 'running') return <span className="session-status running" role="img" aria-label="In progress" title="In progress"><span className="spinner" /></span>;
  if (status === 'waiting') return <span className="session-status waiting" role="img" aria-label="Needs your answer" title="Needs your answer"><IconAsk /></span>;
  if (status === 'done') return <span className="session-status done" role="img" aria-label="Done" title="Done"><IconCheck /></span>;
  return <span className="session-status" aria-hidden="true" />;
}

interface RowProps {
  s: GuiSession;
  status: Status;
  now: number;
  active: boolean;
  renaming: boolean;
  startRename(): void;
  stopRename(): void;
  onOpen(): void;
  onRename(title: string): void;
  onDelete(): void;
}

function SessionRow({ s, status, now, active, renaming, startRename, stopRename, onOpen, onRename, onDelete }: RowProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  if (renaming) {
    const commit = () => {
      const t = input.current?.value.trim() ?? '';
      if (t && t !== s.title) onRename(t);
      stopRename();
    };
    return (
      <li>
        <div className="session active renaming">
          <input
            ref={input}
            defaultValue={s.title}
            maxLength={200}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') stopRename();
            }}
            aria-label="Conversation title"
          />
        </div>
      </li>
    );
  }
  return (
    <li>
      <div
        className={`session ${active ? 'active' : ''}`}
        role="button"
        tabIndex={0}
        aria-current={active ? 'true' : undefined}
        onClick={onOpen}
        onDoubleClick={startRename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onOpen();
          if (e.key === 'F2') startRename();
          if (e.key === 'Backspace' && e.metaKey) onDelete();
        }}
        title={`${s.title}\n${new Date(s.lastModified).toLocaleString()}${s.gitBranch ? ` · ${s.gitBranch}` : ''}`}
      >
        <StatusMark status={status} />
        <span className="session-title">{s.title}</span>
        <span className="session-date">{relativeTime(s.lastModified, now)}</span>
        <span className="session-actions">
          <button className="icon-btn" onClick={(e) => (e.stopPropagation(), startRename())} title="Rename (⌘R)">
            <IconPencil />
          </button>
          <button className="icon-btn" onClick={(e) => (e.stopPropagation(), onDelete())} title="Delete">
            <IconTrash />
          </button>
        </span>
      </div>
    </li>
  );
}
