import { memo, useLayoutEffect, useRef, useState } from 'react';
import type { DiffLine, GuiItem } from '../protocol.js';
import { IconBan, IconCheck, IconChevron, IconInfo, IconWarn, IconX } from './icons.js';
import { Markdown } from './Markdown.js';

export function Transcript({ items, projectLabel, starting }: { items: GuiItem[]; projectLabel: string; starting: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the stream while the user is at the bottom; leave them alone once they scroll up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <div className="transcript" ref={scroller} onScroll={onScroll}>
      <div className="transcript-inner">
        {items.length === 0 && (
          <div className="welcome">
            <div className="welcome-mark">✻</div>
            <h1>FrostCode</h1>
            <p>{starting ? 'Starting the agent…' : `Working in ${projectLabel}`}</p>
            <p className="muted">Ask for a change, a review or an explanation. Tool calls and edits show up here as they happen.</p>
          </div>
        )}
        {items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}

const Item = memo(function Item({ item }: { item: GuiItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user">
          <div className="bubble">{item.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className={`msg-assistant ${item.streaming ? 'streaming' : ''}`}>
          <Markdown text={item.text} />
        </div>
      );
    case 'thinking':
      return <Thinking text={item.text} streaming={item.streaming} />;
    case 'tool':
      return <ToolRow item={item} />;
    case 'system':
      return (
        <div className={`msg-system tone-${item.tone}`}>
          {item.tone === 'error' ? <IconX /> : item.tone === 'warn' ? <IconWarn /> : item.tone === 'success' ? <IconCheck /> : <IconInfo />}
          <pre>{item.text}</pre>
        </div>
      );
  }
});

function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking">
      <button className={`disclosure ${open ? 'open' : ''}`} onClick={() => setOpen(!open)}>
        <IconChevron /> {streaming ? 'Thinking…' : 'Thought process'}
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

function StatusIcon({ status }: { status: Extract<GuiItem, { kind: 'tool' }>['status'] }) {
  if (status === 'running') return <span className="spinner" aria-label="running" />;
  if (status === 'done') return <span className="st st-done" aria-label="done"><IconCheck /></span>;
  if (status === 'denied') return <span className="st st-denied" aria-label="denied"><IconBan /></span>;
  return <span className="st st-error" aria-label="error"><IconX /></span>;
}

const ToolRow = memo(function ToolRow({ item }: { item: Extract<GuiItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tool status-${item.status} ${item.subagent ? 'subagent' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <StatusIcon status={item.status} />
        <span className="tool-verb">{item.verb}</span>
        {item.arg && <span className="tool-arg">{item.arg}</span>}
        <span className={`chev ${open ? 'open' : ''}`}>
          <IconChevron />
        </span>
      </button>
      {!open && item.summary && <pre className="tool-summary">{item.summary}</pre>}
      {open && (
        <div className="tool-body">
          {item.diff?.length ? (
            <Diff lines={item.diff} />
          ) : (
            <>
              <div className="tool-label">Input</div>
              <pre className="tool-pre">{item.input}</pre>
            </>
          )}
          {item.result && (
            <>
              <div className="tool-label">{item.status === 'error' ? 'Error' : 'Output'}</div>
              <pre className="tool-pre">{item.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
});

export function Diff({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="diff">
      {lines.map((l, i) => (
        <div key={i} className={`diff-line diff-${l.type}`}>
          <span className="ln">{l.type === 'gap' ? '' : (l.newNo ?? l.oldNo ?? '')}</span>
          <span className="sign">{l.type === 'add' ? '+' : l.type === 'remove' ? '−' : ' '}</span>
          <span className="text">{l.type === 'gap' ? '⋯' : l.text}</span>
        </div>
      ))}
    </div>
  );
}
