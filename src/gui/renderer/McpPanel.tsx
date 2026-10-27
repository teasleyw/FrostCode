import { useCallback, useEffect, useState } from 'react';
import type { McpAction, McpEntryView } from '../protocol.js';
import { IconChevron, IconX } from './icons.js';
import { ipcErrorMessage } from './store.js';

const STATE_LABEL: Record<McpEntryView['state'], string> = {
  'needs-approval': 'Needs approval',
  changed: 'Changed — needs approval',
  rejected: 'Rejected',
  disabled: 'Disabled',
  shadowed: 'Shadowed',
  unsupported: 'Unsupported',
  connected: 'Connected',
  pending: 'Connecting…',
  failed: 'Failed',
  'needs-auth': 'Needs sign-in',
  starting: 'Starting…',
};

const tone = (s: McpEntryView['state']) =>
  s === 'connected' ? 'ok' : s === 'failed' || s === 'needs-auth' ? 'err' : s === 'needs-approval' || s === 'changed' || s === 'pending' || s === 'starting' ? 'warn' : 'muted';

function actions(e: McpEntryView): { action: McpAction; label: string; primary?: boolean; danger?: boolean }[] {
  switch (e.state) {
    case 'needs-approval':
    case 'changed':
      return [
        { action: 'approve', label: 'Approve & connect', primary: true },
        { action: 'reject', label: 'Reject', danger: true },
      ];
    case 'rejected':
      return [{ action: 'approve', label: 'Approve & connect' }];
    case 'disabled':
      return [{ action: 'enable', label: 'Enable', primary: true }];
    case 'connected':
    case 'pending':
    case 'failed':
    case 'needs-auth':
    case 'starting':
      return [
        { action: 'reconnect', label: 'Reconnect' },
        { action: 'disable', label: 'Disable' },
      ];
    default:
      return [];
  }
}

/** The MCP management screen: servers from Claude Code and the Claude desktop app, their status, tools and actions. */
export function McpPanel({ onClose }: { onClose(): void }) {
  const api = window.frost;
  const [entries, setEntries] = useState<McpEntryView[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  const load = useCallback(
    (refresh = false) =>
      api
        .mcpList(refresh)
        .then(setEntries)
        .catch((e) => setNote({ text: ipcErrorMessage(e), error: true })),
    [api],
  );

  useEffect(() => {
    void load(true);
    const t = setInterval(() => void load(false), 1500);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearInterval(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [load, onClose]);

  const act = async (e: McpEntryView, action: McpAction) => {
    if (action === 'approve' && !window.confirm(`Approve ${e.name}?\n\nFrostCode will run:\n${e.summary}${e.envKeys.length ? `\n\nwith environment variables: ${e.envKeys.join(', ')}` : ''}`)) return;
    setBusy(e.id);
    try {
      setNote({ text: await api.mcpAction(e.id, action), error: false });
    } catch (err) {
      setNote({ text: ipcErrorMessage(err), error: true });
    }
    setBusy(null);
    void load(false);
  };

  const trust = async (e: McpEntryView, tool: string, trusted: boolean) => {
    try {
      await api.mcpTrust(e.name, tool, trusted);
    } catch (err) {
      setNote({ text: ipcErrorMessage(err), error: true });
    }
    void load(false);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="mcp-panel" role="dialog" aria-label="MCP servers" onClick={(ev) => ev.stopPropagation()}>
        <div className="mcp-head">
          <h2>MCP servers</h2>
          <button className="btn" onClick={() => void load(true)} title="Re-read ~/.claude.json, .mcp.json and the Claude desktop app">
            Reload configs
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </div>
        <p className="mcp-sub">
          Read from your Claude Code configuration (~/.claude.json, .mcp.json) and the Claude desktop app. Those files are never modified; approvals live in
          ~/.frostcode/mcp.json. Tools that are not read-only ask before each call.
        </p>
        {note && <div className={`mcp-note ${note.error ? 'err' : ''}`}>{note.text}</div>}
        {!entries ? (
          <div className="mcp-empty">
            <span className="spinner" /> Loading…
          </div>
        ) : !entries.length ? (
          <div className="mcp-empty">No MCP servers configured.</div>
        ) : (
          <ul className="mcp-list">
            {entries.map((e) => {
              const expanded = open === e.id;
              return (
                <li key={e.id} className={`mcp-row ${expanded ? 'open' : ''}`}>
                  <div className="mcp-row-head">
                    <button className="mcp-expand" onClick={() => setOpen(expanded ? null : e.id)} aria-expanded={expanded}>
                      <span className={`chev ${expanded ? 'down' : ''}`}>
                        <IconChevron />
                      </span>
                      <span className="mcp-name">{e.name}</span>
                      <span className={`mcp-pill ${tone(e.state)}`}>{STATE_LABEL[e.state]}</span>
                      {e.tools.length > 0 && <span className="mcp-count">{e.tools.length} tools</span>}
                      <span className="mcp-scope">{e.scopeLabel}</span>
                    </button>
                    <div className="mcp-actions">
                      {actions(e).map((a) => (
                        <button
                          key={a.action}
                          className={`btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`}
                          disabled={busy === e.id}
                          onClick={() => void act(e, a.action)}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {e.detail && <div className={`mcp-detail ${e.state === 'failed' ? 'err' : ''}`}>{e.detail}</div>}
                  {expanded && (
                    <div className="mcp-body">
                      <dl className="mcp-meta">
                        <dt>Transport</dt>
                        <dd>{e.transport ?? '—'}</dd>
                        <dt>{e.transport === 'stdio' ? 'Command' : 'URL'}</dt>
                        <dd>
                          <code>{e.summary}</code>
                        </dd>
                        {e.envKeys.length > 0 && (
                          <>
                            <dt>Env</dt>
                            <dd>{e.envKeys.join(', ')} (values hidden)</dd>
                          </>
                        )}
                        {e.headerKeys.length > 0 && (
                          <>
                            <dt>Headers</dt>
                            <dd>{e.headerKeys.join(', ')} (values hidden)</dd>
                          </>
                        )}
                        <dt>Defined in</dt>
                        <dd>
                          <code>{e.source}</code>
                        </dd>
                        {e.serverInfo && (
                          <>
                            <dt>Server</dt>
                            <dd>
                              {e.serverInfo.name} {e.serverInfo.version}
                            </dd>
                          </>
                        )}
                      </dl>
                      {e.offInSource && <div className="mcp-detail">Turned off in the Claude desktop app. FrostCode can still use it once approved here.</div>}
                      {e.tools.length > 0 ? (
                        <table className="mcp-tools">
                          <thead>
                            <tr>
                              <th>Tool</th>
                              <th>Kind</th>
                              <th>Before each call</th>
                            </tr>
                          </thead>
                          <tbody>
                            {e.tools.map((t) => (
                              <tr key={t.name}>
                                <td>
                                  <div className="mcp-tool-name">{t.name}</div>
                                  {t.description && <div className="mcp-tool-desc">{t.description.split('\n')[0].slice(0, 160)}</div>}
                                </td>
                                <td className={t.readOnly ? 'ok' : t.destructive ? 'err' : 'warn'}>{t.readOnly ? 'Read-only' : t.destructive ? 'Destructive' : 'Can change things'}</td>
                                <td>
                                  {t.sensitive || t.trusted ? (
                                    <label className="mcp-trust">
                                      <input type="checkbox" checked={!t.trusted} onChange={(ev) => void trust(e, t.name, !ev.target.checked)} /> Ask me
                                    </label>
                                  ) : (
                                    <span className="muted">Normal permissions</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <div className="mcp-empty small">{e.state === 'connected' ? 'This server has no tools.' : 'Tools are listed once the server is connected.'}</div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
