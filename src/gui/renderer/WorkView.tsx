import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { BriefState, ChatItem, GitHubPr, GitHubPushGroup, JiraIssue, MailItem, MeetingItem, SourceState, WorkGitHub, WorkJira, WorkSnapshot } from '../protocol.js';
import { IconChevron, IconExternal, IconRefresh, IconWarn } from './icons.js';
import { ipcErrorMessage } from './store.js';
import { askText, groupByStatus, refSource, shortRepo, whenLabel } from './work.js';

const open = (url: string | null | undefined) => {
  if (url) void window.frost.openExternal(url).catch(() => {});
};

function Link({ url, children, className = '' }: { url: string | null | undefined; children: ReactNode; className?: string }) {
  return url ? (
    <button className={`work-link ${className}`} onClick={() => open(url)} title={url}>
      {children}
    </button>
  ) : (
    <span className={className}>{children}</span>
  );
}

function Card(p: { title: string; sub?: ReactNode; state: SourceState<unknown>; right?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`work-card ${p.wide ? 'wide' : ''}`}>
      <header className="work-card-head">
        <h2>{p.title}</h2>
        {p.sub && <span className="work-sub">{p.sub}</span>}
        <span className="spacer" />
        {p.state.status === 'loading' && <span className="spinner" aria-label="Loading" />}
        {p.right}
      </header>
      {p.state.status === 'error' && (
        <div className="work-error">
          <IconWarn /> {p.state.error}
        </div>
      )}
      {p.children}
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <div className="work-empty">{children}</div>;
const Waiting = ({ state }: { state: SourceState<unknown> }) => (state.status === 'loading' && !state.data ? <Empty>Loading…</Empty> : null);

// ---- daily list ----

function Today({ brief, onAsk, onRefresh }: { brief: BriefState; onAsk(text: string): void; onRefresh(): void }) {
  const b = brief.brief;
  return (
    <section className="work-card today wide">
      <header className="work-card-head">
        <h2>Today</h2>
        {b?.model && <span className="work-sub">Written by Claude ({b.model}) at {whenLabel(new Date(b.generatedAt).toISOString())}</span>}
        <span className="spacer" />
        {(brief.status === 'writing' || brief.status === 'waiting') && <span className="spinner" aria-label="Working" />}
      </header>
      {brief.status === 'waiting' && !b && <Empty>Gathering today's items…</Empty>}
      {brief.status === 'writing' && <Empty>Claude is writing today's list…</Empty>}
      {brief.status === 'needs-key' && (
        <div className="work-error">
          <IconWarn /> Claude writes the daily list with your FrostCode API key, and none is set. Restart FrostCode and enter one on its setup screen, or run{' '}
          <code>frostcode account add work</code>, then press Refresh.
        </div>
      )}
      {brief.status === 'error' && (
        <div className="work-error">
          <IconWarn /> The daily list could not be written: {brief.error}{' '}
          <button className="work-link" onClick={onRefresh}>
            Try again
          </button>
        </div>
      )}
      {b && (
        <div className={brief.status === 'writing' ? 'stale' : ''}>
          {b.headline && <p className="today-headline">{b.headline}</p>}
          {b.todo.length ? (
            <ol className="today-list">
              {b.todo.map((t) => (
                <li key={t.ref}>
                  <div className="today-main">
                    <Link url={t.url} className="today-title">
                      {t.title}
                    </Link>
                    <span className="chip">{refSource(t.ref)}</span>
                    <span className="today-ref">{t.ref.slice(t.ref.indexOf(':') + 1)}</span>
                  </div>
                  <div className="today-why">{t.why}</div>
                  <button className="work-ask" onClick={() => onAsk(askText(t))} title="Start a conversation about this">
                    Ask Claude
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <Empty>Nothing needs you today.</Empty>
          )}
          {b.headsUp.length > 0 && (
            <div className="today-heads">
              <h3>Heads up</h3>
              <ul>
                {b.headsUp.map((h, i) => (
                  <li key={i}>
                    {h.text} <span className="today-ref">{h.refs.map((r) => r.slice(r.indexOf(':') + 1)).join(', ')}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {b.dropped > 0 && <div className="work-note">{b.dropped} suggestion(s) that matched none of your items were left out.</div>}
        </div>
      )}
    </section>
  );
}

function Meetings({ state }: { state: SourceState<MeetingItem[]> }) {
  if (state.status === 'not-connected') return null;
  const list = state.data ?? [];
  return (
    <section className="work-card wide meetings">
      <header className="work-card-head">
        <h2>Meetings today</h2>
        <span className="spacer" />
        {state.status === 'loading' && <span className="spinner" />}
      </header>
      {state.status === 'error' && (
        <div className="work-error">
          <IconWarn /> {state.error}
        </div>
      )}
      {state.status === 'ok' && !list.length && <Empty>No meetings on your calendar today.</Empty>}
      {list.length > 0 && (
        <ul className="work-rows">
          {list.map((m) => (
            <li key={m.id} className={`work-row ${m.cancelled ? 'cancelled' : ''}`}>
              <span className="work-time">
                {whenLabel(m.start)}–{whenLabel(m.end)}
              </span>
              <Link url={m.url} className="work-row-title">
                {m.subject}
              </Link>
              {m.location && <span className="work-muted">{m.location}</span>}
              <span className="spacer" />
              {m.joinUrl && !m.cancelled && (
                <button className="btn small" onClick={() => open(m.joinUrl)}>
                  Join
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- Jira ----

function IssueRow({ i }: { i: JiraIssue }) {
  return (
    <li className="work-row">
      <Link url={i.url} className="mono">
        {i.key}
      </Link>
      <span className="work-row-title" title={i.summary}>
        {i.summary}
      </span>
      <span className={`pill cat-${i.statusCategory}`}>{i.status}</span>
      <span className="work-when">{whenLabel(i.updated)}</span>
    </li>
  );
}

function JiraConnect({ error }: { error?: string }) {
  const [site, setSite] = useState('popdock.atlassian.net');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(error ?? null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setMsg(await window.frost.workConnectJira(site, email, token));
      setToken('');
    } catch (err) {
      setMsg(ipcErrorMessage(err));
    }
    setBusy(false);
  };
  return (
    <form className="work-connect" onSubmit={submit}>
      <p>
        Connect with your Jira email and an API token (
        <button type="button" className="work-link" onClick={() => open('https://id.atlassian.com/manage-profile/security/api-tokens')}>
          create one <IconExternal />
        </button>
        ). The token is stored encrypted on this computer, readable only by your account.
      </p>
      <label>
        Site <input value={site} onChange={(e) => setSite(e.target.value)} spellCheck={false} />
      </label>
      <label>
        Email <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" spellCheck={false} autoComplete="username" />
      </label>
      <label>
        API token <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
      </label>
      <div className="work-connect-bar">
        <button className="btn primary" disabled={busy || !email || !token}>
          {busy ? 'Checking…' : 'Connect Jira'}
        </button>
        {msg && <span className="work-muted">{msg}</span>}
      </div>
    </form>
  );
}

function JiraCard({ snap, onDisconnect }: { snap: WorkSnapshot; onDisconnect(): void }) {
  const st = snap.jira;
  const d = st.data as WorkJira | undefined;
  const conn = snap.jiraConnection;
  return (
    <Card
      title="Jira"
      sub={d ? `${d.assigned.length} open · ${d.changed.length} changed ${snap.sinceLabel}` : undefined}
      state={st}
      right={
        conn && (
          <button className="work-link muted" onClick={onDisconnect} title={`${conn.email} on ${conn.site}`}>
            Disconnect
          </button>
        )
      }
    >
      {st.status === 'not-connected' && <JiraConnect error={st.error} />}
      <Waiting state={st} />
      {d && (
        <>
          {d.changed.length > 0 && (
            <>
              <h3>Changed {snap.sinceLabel}</h3>
              <ul className="work-rows">
                {d.changed.slice(0, 12).map((i) => (
                  <IssueRow key={i.key} i={i} />
                ))}
              </ul>
            </>
          )}
          <h3>Assigned to you</h3>
          {!d.assigned.length && <Empty>No open issues assigned to you.</Empty>}
          {groupByStatus(d.assigned).map((g) => (
            <details key={g.status} className="work-group" open={g.category !== 'done' && g.issues.length <= 10}>
              <summary>
                <span className="chev">
                  <IconChevron />
                </span>
                {g.status} <span className="work-count">{g.issues.length}</span>
              </summary>
              <ul className="work-rows">
                {g.issues.map((i) => (
                  <IssueRow key={i.key} i={i} />
                ))}
              </ul>
            </details>
          ))}
        </>
      )}
    </Card>
  );
}

// ---- GitHub ----

const CHECKS: Record<string, string> = { SUCCESS: 'checks pass', FAILURE: 'checks fail', ERROR: 'checks error', PENDING: 'checks running', EXPECTED: 'checks waiting' };

function PrRow({ p, mine }: { p: GitHubPr; mine?: boolean }) {
  return (
    <li className="work-row">
      <Link url={p.url} className="mono">
        {shortRepo(p.repo)}#{p.number}
      </Link>
      <span className="work-row-title" title={p.title}>
        {p.title}
      </span>
      {p.draft && <span className="pill">draft</span>}
      {mine && p.checks && <span className={`pill checks-${p.checks.toLowerCase()}`}>{CHECKS[p.checks] ?? p.checks}</span>}
      {mine && p.reviewDecision && <span className="pill">{p.reviewDecision.toLowerCase().replace(/_/g, ' ')}</span>}
      {!mine && <span className="work-muted">{p.author}</span>}
      <span className="work-when">{whenLabel(p.updatedAt)}</span>
    </li>
  );
}

function PushGroup({ g }: { g: GitHubPushGroup }) {
  const n = g.commits.length;
  const count = n ? `${n} commit${n === 1 ? '' : 's'}` : `${g.pushes} push${g.pushes === 1 ? '' : 'es'}`;
  return (
    <details className="work-group push">
      <summary>
        <span className="chev">
          <IconChevron />
        </span>
        <span className="mono">{shortRepo(g.repo)}</span>
        <span className="work-branch">{g.branch}</span>
        <span className="work-muted work-push-meta" title={`${count} · pushed by ${g.pushers.join(', ')}`}>
          {count} · {g.pushers.join(', ')}
        </span>
        <span className="work-when">{whenLabel(g.lastPushAt)}</span>
      </summary>
      <ul className="work-rows commits">
        {g.commits.map((c) => (
          <li key={c.sha} className="work-row">
            <Link url={c.url} className="mono">
              {c.sha}
            </Link>
            <span className="work-row-title" title={c.message}>
              {c.message}
            </span>
            <span className="work-muted">{c.author}</span>
          </li>
        ))}
        {!g.commits.length && <Empty>No commits on this branch since the window began (it may have been rewritten or deleted).</Empty>}
      </ul>
    </details>
  );
}

function GitHubCard({ snap }: { snap: WorkSnapshot }) {
  const st = snap.github;
  const d = st.data as WorkGitHub | undefined;
  return (
    <Card title="GitHub" sub={d ? `${d.org} · signed in as ${d.login}` : undefined} state={st}>
      <Waiting state={st} />
      {d && (
        <>
          <h3>Waiting on your review</h3>
          {d.reviewRequests.length ? (
            <ul className="work-rows">
              {d.reviewRequests.map((p) => (
                <PrRow key={p.url} p={p} />
              ))}
            </ul>
          ) : (
            <Empty>Nothing is waiting on your review.</Empty>
          )}
          <h3>Your pull requests</h3>
          {d.myPrs.length ? (
            <ul className="work-rows">
              {d.myPrs.map((p) => (
                <PrRow key={p.url} p={p} mine />
              ))}
            </ul>
          ) : (
            <Empty>You have no open pull requests.</Empty>
          )}
          <h3>
            What's changing in {d.org} {snap.sinceLabel}
          </h3>
          {!d.pushes.length && !d.merged.length && !d.opened.length && !d.events.length && <Empty>No activity {snap.sinceLabel}.</Empty>}
          {d.pushes.map((g) => (
            <PushGroup key={`${g.repo}@${g.branch}`} g={g} />
          ))}
          {d.merged.length > 0 && (
            <>
              <h4>Merged</h4>
              <ul className="work-rows">
                {d.merged.map((p) => (
                  <PrRow key={p.url} p={p} />
                ))}
              </ul>
            </>
          )}
          {d.opened.length > 0 && (
            <>
              <h4>Opened</h4>
              <ul className="work-rows">
                {d.opened.map((p) => (
                  <PrRow key={p.url} p={p} />
                ))}
              </ul>
            </>
          )}
          {d.events.length > 0 && (
            <>
              <h4>Releases, branches and tags</h4>
              <ul className="work-rows">
                {d.events.map((e, i) => (
                  <li key={i} className="work-row">
                    <span className="pill">{e.kind.replace('-', ' ')}</span>
                    <Link url={e.url} className="work-row-title">
                      {e.title}
                    </Link>
                    <span className="work-repo" title={`${e.repo} · ${e.actor}`}>
                      {shortRepo(e.repo)}
                    </span>
                    <span className="work-when">{whenLabel(e.at)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Card>
  );
}

// ---- Microsoft 365 ----

function MicrosoftConnect({ snap, error }: { snap: WorkSnapshot; error?: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const pending = snap.microsoftPending;
  const start = () => window.frost.workConnectMicrosoft().catch((e) => setMsg(ipcErrorMessage(e)));
  if (pending) {
    return (
      <div className="work-connect">
        <p>
          Open <b>{pending.verificationUri.replace(/^https?:\/\//, '')}</b>, enter this code and sign in with your work account:
        </p>
        <div className="device-code">{pending.userCode}</div>
        <div className="work-connect-bar">
          <button className="btn primary" onClick={() => open(pending.verificationUri)}>
            Open sign-in page <IconExternal />
          </button>
          <button className="btn" onClick={() => void navigator.clipboard.writeText(pending.userCode).then(() => setMsg('Code copied.'), () => setMsg(null))}>
            Copy code
          </button>
          <button className="btn" onClick={() => void window.frost.workCancelMicrosoft()}>
            Cancel
          </button>
          <span className="spinner" />
          <span className="work-muted">{msg ?? 'Waiting for you to finish signing in…'}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="work-connect">
      <p>Connect Microsoft 365 to see your inbox, Teams chats and today's meetings here (read-only; nothing is sent or changed).</p>
      {(error || msg) && (
        <div className="work-error">
          <IconWarn /> {msg ?? error}
        </div>
      )}
      <div className="work-connect-bar">
        <button className="btn primary" onClick={() => void start()}>
          Connect Microsoft 365
        </button>
      </div>
    </div>
  );
}

function MailCard({ snap, onDisconnect }: { snap: WorkSnapshot; onDisconnect(): void }) {
  const st = snap.email;
  const list = st.data ?? [];
  const unread = list.filter((m: MailItem) => !m.isRead).length;
  return (
    <Card
      title="Email"
      sub={st.data ? `${list.length} ${snap.sinceLabel}${unread ? ` · ${unread} unread` : ''}` : undefined}
      state={st}
      right={
        snap.microsoft && (
          <button className="work-link muted" onClick={onDisconnect} title={snap.microsoft.account}>
            Disconnect
          </button>
        )
      }
    >
      {st.status === 'not-connected' && <MicrosoftConnect snap={snap} error={st.error} />}
      <Waiting state={st} />
      {st.status === 'ok' && !list.length && <Empty>No new mail {snap.sinceLabel}.</Empty>}
      {list.length > 0 && (
        <ul className="work-rows mail">
          {list.map((m) => (
            <li key={m.id} className={`work-row two-line ${m.isRead ? '' : 'unread'}`}>
              <span className="dot" />
              <div className="work-row-body">
                <div className="work-row-line">
                  <span className="work-from">{m.from}</span>
                  {m.important && <span className="pill warn">important</span>}
                  {m.flagged && <span className="pill warn">flagged</span>}
                  <span className="spacer" />
                  <span className="work-when">{whenLabel(m.receivedAt)}</span>
                </div>
                <Link url={m.url} className="work-row-title">
                  {m.subject}
                </Link>
                <div className="work-preview">{m.preview}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TeamsCard({ snap }: { snap: WorkSnapshot }) {
  const st = snap.teams;
  const list = st.data ?? [];
  const unread = list.filter((c: ChatItem) => c.unread).length;
  return (
    <Card title="Teams" sub={st.data ? `${list.length} chats ${snap.sinceLabel}${unread ? ` · ${unread} unread` : ''}` : undefined} state={st}>
      {st.status === 'not-connected' && (
        <Empty>{snap.microsoftPending ? 'Finish the Microsoft sign-in in the Email card; Teams comes with it.' : 'Teams comes with Microsoft 365: connect it in the Email card.'}</Empty>
      )}
      <Waiting state={st} />
      {st.status === 'ok' && !list.length && <Empty>No new chat messages {snap.sinceLabel}.</Empty>}
      {list.length > 0 && (
        <ul className="work-rows mail">
          {list.map((c) => (
            <li key={c.id} className={`work-row two-line ${c.unread ? 'unread' : ''}`}>
              <span className="dot" />
              <div className="work-row-body">
                <div className="work-row-line">
                  <Link url={c.url} className="work-from">
                    {c.title}
                  </Link>
                  <span className="spacer" />
                  <span className="work-when">{whenLabel(c.at)}</span>
                </div>
                <div className="work-preview">
                  {c.chatType !== 'oneOnOne' && c.from ? `${c.from}: ` : ''}
                  {c.preview}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---- the tab ----

/** The Work tab: Claude's list for today, then Jira, GitHub, email and Teams. */
export function WorkView({ onAsk }: { onAsk(text: string): void }) {
  const api = window.frost;
  const [snap, setSnap] = useState<WorkSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const off = api.on('work', setSnap);
    api.workLoad(false).then(setSnap, (e) => setError(ipcErrorMessage(e)));
    return off;
  }, [api]);

  const refresh = () => api.workLoad(true).then(setSnap, (e) => setError(ipcErrorMessage(e)));
  const disconnect = (source: 'jira' | 'microsoft', name: string) => {
    if (window.confirm(`Disconnect ${name}? The saved sign-in is deleted from this computer.`)) void api.workDisconnect(source);
  };
  const busy = !!snap && ([snap.jira, snap.github, snap.email, snap.teams, snap.calendar].some((s) => s.status === 'loading') || snap.brief.status === 'writing');
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const focus = snap?.focus ? snap.focus[0].toUpperCase() + snap.focus.slice(1) : '';

  return (
    <div className="work">
      <header className="topbar drag work-top">
        <div className="work-title">
          {focus ? `${focus} work` : 'Work'} <span className="work-muted">· {today}</span>
        </div>
        <span className="spacer" />
        {snap?.loadedAt && <span className="work-muted">Updated {whenLabel(new Date(snap.loadedAt).toISOString())}</span>}
        <button className="btn no-drag" onClick={() => void refresh()} disabled={!snap || busy} title="Fetch everything again and rewrite today's list">
          <IconRefresh /> {busy ? 'Updating…' : 'Refresh'}
        </button>
      </header>
      <div className="work-scroll">
        {error && (
          <div className="work-error">
            <IconWarn /> {error}
          </div>
        )}
        {!snap ? (
          <div className="work-boot">
            <span className="spinner" /> Loading your work…
          </div>
        ) : (
          <div className="work-grid">
            <Today brief={snap.brief} onAsk={onAsk} onRefresh={() => void refresh()} />
            <Meetings state={snap.calendar} />
            <JiraCard snap={snap} onDisconnect={() => disconnect('jira', 'Jira')} />
            <GitHubCard snap={snap} />
            <MailCard snap={snap} onDisconnect={() => disconnect('microsoft', 'Microsoft 365')} />
            <TeamsCard snap={snap} />
          </div>
        )}
      </div>
    </div>
  );
}
