import { useEffect, useRef, useState } from 'react';
import type { GuiMode, GuiSnapshot, RecentProject } from '../protocol.js';
import { IconChevron, IconFolder } from './icons.js';
import { MODES } from './store.js';

interface Props {
  snap: GuiSnapshot;
  onModel(model: string | null): void;
  onMode(mode: GuiMode): void;
  onOpenProject(path: string): void;
  onChooseProject(): void;
}

export function TopBar({ snap, onModel, onMode, onOpenProject, onChooseProject }: Props) {
  const [menu, setMenu] = useState<RecentProject[] | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [menu]);

  const toggleMenu = async () => {
    if (menu) return setMenu(null);
    setMenu(await window.frost.recentProjects());
  };

  // Model choices: the runtime's list, plus the current pick if it is not in it.
  const models = snap.models.length ? snap.models : [];
  const hasCurrent = !snap.model || models.some((m) => m.value === snap.model);

  return (
    <header className="topbar drag">
      <div className="project-picker no-drag" ref={box}>
        <button className="project-btn" onClick={toggleMenu} title={`${snap.projectLabel} — choose project (⌘O)`} aria-haspopup="menu" aria-expanded={!!menu}>
          <IconFolder />
          <span className="project-name">{snap.projectName}</span>
          <span className="chev down">
            <IconChevron />
          </span>
        </button>
        {menu && (
          <div className="menu" role="menu">
            <div className="menu-label">Recent projects</div>
            {menu.map((p) => (
              <button
                key={p.path}
                role="menuitem"
                className={`menu-item ${p.path === snap.cwd ? 'current' : ''}`}
                onClick={() => {
                  setMenu(null);
                  if (p.path !== snap.cwd) onOpenProject(p.path);
                }}
              >
                <span className="menu-main">{p.name}</span>
                <span className="menu-sub">{p.label}</span>
              </button>
            ))}
            <div className="menu-sep" />
            <button
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setMenu(null);
                onChooseProject();
              }}
            >
              <span className="menu-main">Open folder…</span>
              <kbd>⌘O</kbd>
            </button>
          </div>
        )}
      </div>
      <div className="topbar-title" title={snap.sessionId ?? undefined}>
        {snap.title ?? 'New conversation'}
      </div>
      <div className="topbar-controls no-drag">
        <div className="segmented" role="radiogroup" aria-label="Permission mode (Shift+Tab cycles)">
          {MODES.map((m) => (
            <button
              key={m.value}
              role="radio"
              aria-checked={snap.mode === m.value}
              className={snap.mode === m.value ? 'on' : ''}
              title={`${m.title} (Shift+Tab cycles)`}
              onClick={() => onMode(m.value)}
              disabled={snap.phase !== 'ready'}
            >
              {m.label}
            </button>
          ))}
        </div>
        <label className="model-select" title="Model">
          <select value={snap.model ?? ''} onChange={(e) => onModel(e.target.value || null)} disabled={snap.phase !== 'ready'}>
            <option value="">Default{snap.model ? '' : ` (${snap.modelLabel})`}</option>
            {models
              .filter((m) => m.value !== 'default')
              .map((m) => (
                <option key={m.value} value={m.value}>
                  {m.displayName}
                </option>
              ))}
            {!hasCurrent && <option value={snap.model!}>{snap.model}</option>}
          </select>
          <span className="chev down">
            <IconChevron />
          </span>
        </label>
      </div>
    </header>
  );
}
