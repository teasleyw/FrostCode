import { useEffect, useLayoutEffect, useState, type KeyboardEvent } from 'react';
import type { GuiSnapshot } from '../protocol.js';
import { IconSend, IconStop } from './icons.js';
import { formatElapsed, formatTokens, formatUsd, modeLabel } from './store.js';

interface Props {
  snap: GuiSnapshot;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft(t: string): void;
  onSend(text: string): void;
  onStop(): void;
  onAutoMode(on: boolean): void;
  blocked: boolean;
}

export function Composer({ snap, inputRef, draft, setDraft, onSend, onStop, onAutoMode, blocked }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!snap.busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [snap.busy]);

  // Grow with the text up to a cap (CSS max-height), then scroll.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, inputRef]);

  const ready = snap.phase === 'ready';
  const send = () => {
    if (!draft.trim() || !ready || blocked) return;
    onSend(draft);
    setDraft('');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const u = snap.usage;
  const pct = u.contextWindow > 0 ? Math.min(100, (u.contextTokens / u.contextWindow) * 100) : null;
  const status = !ready ? 'starting' : snap.busy ? 'running' : 'idle';
  const autoMode = snap.mode === 'auto';

  return (
    <div className="composer-wrap">
      <div className={`composer ${status}`}>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          rows={1}
          disabled={blocked}
          placeholder={
            blocked ? 'Answer the prompt above to continue' : snap.busy ? 'Queue a follow-up…' : 'Message FrostCode   (Enter to send · Shift+Enter for a new line)'
          }
          spellCheck={false}
          aria-label="Message"
        />
        <div className="composer-bar">
          <span className={`run-state ${status}`} role="status">
            {status === 'running' && (
              <>
                <span className="spinner" /> Running · {formatElapsed(now - (snap.busySince ?? now))}
                <span className="muted"> · Esc to stop</span>
              </>
            )}
            {status === 'idle' && (
              <>
                <span className="dot" /> Ready
              </>
            )}
            {status === 'starting' && (
              <>
                <span className="spinner" /> Starting…
              </>
            )}
          </span>
          <span className="spacer" />
          <span className={`mode-badge mode-${snap.mode}`} data-testid="permission-mode" title="Active permission mode for this conversation">
            <span className="mode-key">Mode:</span> {modeLabel(snap.mode)}
          </span>
          <label
            className="auto-edits"
            title="Auto mode, like Claude's: a safety classifier approves routine edits and commands in this conversation without asking, and still asks about anything risky. Edits and diffs still appear in the conversation."
          >
            <input
              type="checkbox"
              role="switch"
              checked={autoMode}
              aria-checked={autoMode}
              disabled={!ready}
              onChange={(e) => onAutoMode(e.target.checked)}
            />
            <span className="switch" aria-hidden="true" />
            Auto mode
          </label>
          {snap.busy ? (
            <button className="btn stop" onClick={onStop} title="Stop (Esc)">
              <IconStop /> Stop
            </button>
          ) : null}
          <button className="btn send" onClick={send} disabled={!draft.trim() || !ready || blocked} title="Send (Enter)">
            <IconSend />
          </button>
        </div>
      </div>
      <div className="usage" title="Estimates from the SDK price table; the Claude Console usage page is authoritative.">
        <span>{formatUsd(u.sessionUsd)}</span>
        {/* Context is only known after a turn in this run; a resumed session has none yet. */}
        {u.contextTokens > 0 && (
          <>
            <span className="sep">·</span>
            <span>
              {formatTokens(u.contextTokens)}
              {pct !== null ? ` / ${formatTokens(u.contextWindow)} context (${pct.toFixed(0)}%)` : ' context tokens'}
            </span>
          </>
        )}
        {pct !== null && (
          <span className="meter" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </span>
        )}
      </div>
    </div>
  );
}
