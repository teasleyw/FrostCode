import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuiMode, GuiProjectGroup, GuiSession, GuiSnapshot, PromptAnswer } from '../protocol.js';
import { Composer } from './Composer.js';
import { McpPanel } from './McpPanel.js';
import { PromptPanel } from './PromptPanel.js';
import { Sidebar } from './Sidebar.js';
import { applyPatch, emptyTranscript, filterGroups, flatSessions, ipcErrorMessage, nextMode, transcriptList, type TranscriptState } from './store.js';
import { TopBar } from './TopBar.js';
import { Transcript } from './Transcript.js';

const SHORTCUTS: [string, string][] = [
  ['Enter', 'Send message (queues while running)'],
  ['Shift + Enter', 'New line'],
  ['Esc', 'Stop the running turn'],
  ['Shift + Tab', 'Cycle mode: Ask → Auto-edit → Plan → Auto'],
  ['⌘ N', 'New conversation'],
  ['⌘ O', 'Open project folder'],
  ['⌘ K', 'Search conversations'],
  ['⌘ R', 'Rename conversation'],
  ['⌘ [  /  ⌘ ]', 'Previous / next conversation'],
  ['⌘ L', 'Focus the message box'],
  ['⌘ .', 'Stop'],
  ['1 / 2 / 3', 'Answer a permission prompt'],
  ['⌘ /', 'Show this list'],
];

export function App() {
  const api = window.frost;
  const [snap, setSnap] = useState<GuiSnapshot | null>(null);
  const [transcript, setTranscript] = useState<TranscriptState>(emptyTranscript);
  const [groups, setGroups] = useState<GuiProjectGroup[]>([]);
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const closeMcp = useCallback(() => setShowMcp(false), []);
  const searchRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const call = useCallback(<T,>(p: Promise<T>): Promise<T | undefined> => {
    return p.catch((e) => {
      setToast(ipcErrorMessage(e));
      return undefined;
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // Subscribe first, then ask for the current state, so no update is lost in between.
  useEffect(() => {
    const offs = [
      api.on('state', setSnap),
      api.on('transcript', (p) => setTranscript((t) => applyPatch(t, p))),
      api.on('sessions', setGroups),
      api.on('command', (c) => {
        if (c === 'focus-search') searchRef.current?.focus();
        if (c === 'focus-composer') inputRef.current?.focus();
        if (c === 'show-shortcuts') setShowShortcuts((s) => !s);
        if (c === 'rename-session' && snapRef.current?.sessionId) setRenamingId(snapRef.current.sessionId);
      }),
    ];
    void call(api.init()).then((init) => {
      if (!init) return;
      setSnap(init.snapshot);
      setTranscript(applyPatch(emptyTranscript(), init.transcript));
      setGroups(init.sessions);
    });
    return () => offs.forEach((off) => off());
  }, [api, call]);

  // A different conversation was opened: move focus to the composer.
  const sessionKey = `${snap?.cwd}|${snap?.phase === 'starting' ? 'starting' : snap?.sessionId}`;
  useEffect(() => {
    if (snap?.phase === 'ready') inputRef.current?.focus();
  }, [sessionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const openSession = (s: GuiSession) => void call(api.openSession(s.id, s.cwd));

  // Global keys that are not menu accelerators.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = snapRef.current;
      if (!s) return;
      if (e.key === 'Escape' && !e.defaultPrevented) {
        if (showShortcuts) return setShowShortcuts(false);
        if (showMcp) return;
        if (s.busy && !s.prompt) {
          e.preventDefault();
          void call(api.interrupt());
        }
      } else if (e.key === 'Tab' && e.shiftKey && s.phase === 'ready' && !s.prompt) {
        const t = e.target as HTMLElement;
        if (t === document.body || t === inputRef.current) {
          e.preventDefault();
          void call(api.setMode(nextMode(s.mode)));
        }
      } else if (e.metaKey && (e.key === '[' || e.key === ']')) {
        e.preventDefault();
        const list = flatSessions(filterGroups(groupsRef.current, queryRef.current));
        if (!list.length) return;
        const i = list.findIndex((x) => x.id === s.sessionId);
        const next = i < 0 ? list[0] : list[(i + (e.key === ']' ? 1 : -1) + list.length) % list.length];
        if (next && next.id !== s.sessionId) openSession(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // re-bound each render to see current state

  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const queryRef = useRef(query);
  queryRef.current = query;

  if (!snap) {
    return (
      <div className="boot">
        <span className="spinner" /> Starting FrostCode…
      </div>
    );
  }

  const items = transcriptList(transcript);
  return (
    <div className="app">
      <Sidebar
        groups={groups}
        activeId={snap.sessionId}
        activeCwd={snap.cwd}
        activeTitle={snap.title}
        busy={snap.busy}
        finished={snap.finished}
        running={snap.running}
        waiting={snap.waiting}
        query={query}
        setQuery={setQuery}
        searchRef={searchRef}
        renamingId={renamingId}
        setRenamingId={setRenamingId}
        onOpen={openSession}
        onNew={(cwd) => void call(api.newSession(cwd))}
        onRename={(s, title) => void call(api.renameSession(s.id, s.cwd, title))}
        onDelete={(s) => void call(api.deleteSession(s.id, s.cwd))}
      />
      <main className="main">
        <TopBar
          snap={snap}
          onModel={(m) => void call(api.setModel(m))}
          onMode={(m: GuiMode) => void call(api.setMode(m))}
          onOpenProject={(p) => void call(api.openProject(p))}
          onChooseProject={() => void call(api.chooseProject())}
          onMcp={() => setShowMcp(true)}
        />
        <Transcript items={items} projectLabel={snap.projectLabel} starting={snap.phase === 'starting'} />
        <div className="bottom">
          {snap.prompt && <PromptPanel key={snap.prompt.id} prompt={snap.prompt} queued={snap.queuedPrompts} onAnswer={(a: PromptAnswer) => void call(api.answer(a))} />}
          <Composer
            snap={snap}
            inputRef={inputRef}
            draft={draft}
            setDraft={setDraft}
            blocked={!!snap.prompt}
            onSend={(text) => void call(api.submit(text))}
            onStop={() => void call(api.interrupt())}
            onAutoMode={(on) => void call(api.setAutoMode(on))}
          />
        </div>
      </main>
      {showShortcuts && (
        <div className="overlay" onClick={() => setShowShortcuts(false)}>
          <div className="shortcuts" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
            <h2>Keyboard shortcuts</h2>
            <dl>
              {SHORTCUTS.map(([k, v]) => (
                <div key={k}>
                  <dt>
                    <kbd>{k}</kbd>
                  </dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
      {showMcp && <McpPanel onClose={closeMcp} />}
      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
