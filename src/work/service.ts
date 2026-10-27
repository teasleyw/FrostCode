import { currentApiKey, redact } from '../config/env.js';
import { writeBrief, type MessagesClient } from './brief.js';
import { fetchGitHub, runGh, type GhRunner } from './github.js';
import { fetchJira, jiraWhoAmI, normalizeSite, type FetchFn } from './jira.js';
import { fetchChats, fetchMail, fetchMe, fetchMeetings, pollDeviceCode, refreshAccess, startDeviceCode, type MsTokens } from './microsoft.js';
import { DEFAULT_BRIEF_MODEL, DEFAULT_FOCUS, deleteSecret, loadBrief, loadConfig, loadSecret, saveBrief, saveConfig, saveSecret, type SecretBox, type WorkConfig } from './store.js';
import type { SourceState, WorkSnapshot } from './types.js';
import { localDate, workWindow } from './util.js';

export interface WorkServiceOptions {
  secrets: SecretBox;
  emit(snapshot: WorkSnapshot): void;
  /** Test seams. */
  fetchFn?: FetchFn;
  gh?: GhRunner;
  briefClient?: MessagesClient;
  apiKey?: () => string | undefined;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** Sources older than this are fetched again when the tab is opened. */
const STALE_MS = 10 * 60_000;

const errorText = (e: unknown) => redact(e instanceof Error ? e.message : String(e));

/**
 * The Work tab's backend in the desktop app's main process: Jira, GitHub, Outlook, Teams and the
 * calendar, plus Claude's daily list. Each source updates the snapshot as it lands.
 */
export class WorkService {
  private snap: WorkSnapshot;
  private loading: Promise<WorkSnapshot> | null = null;
  private ms: MsTokens | null = null;
  private msMeId: string | null = null;
  private msSignIn: AbortController | null = null;

  constructor(private readonly opts: WorkServiceOptions) {
    this.snap = this.fresh(loadConfig(), this.now());
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private get fetchFn(): FetchFn {
    return this.opts.fetchFn ?? fetch;
  }

  snapshot(): WorkSnapshot {
    return this.snap;
  }

  private fresh(cfg: WorkConfig, now: Date): WorkSnapshot {
    const { since, label } = workWindow(now);
    const idle = { status: 'idle' as const };
    return {
      since: since.toISOString(),
      sinceLabel: label,
      focus: cfg.focus ?? DEFAULT_FOCUS,
      jiraConnection: cfg.jira ?? null,
      microsoft: cfg.microsoft ?? null,
      microsoftPending: null,
      jira: idle,
      github: idle,
      email: idle,
      teams: idle,
      calendar: idle,
      brief: { status: 'idle' },
      loadedAt: null,
    };
  }

  private set(patch: Partial<WorkSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.opts.emit(this.snap);
  }

  /** Fetch every source (again when asked, or when the last fetch is stale) and the day's list. Refresh also rewrites the list. */
  load(refresh = false): Promise<WorkSnapshot> {
    if (this.loading) return this.loading;
    const fresh = this.snap.loadedAt && this.now().getTime() - this.snap.loadedAt < STALE_MS && localDate(new Date(this.snap.loadedAt)) === localDate(this.now());
    if (!refresh && fresh) return Promise.resolve(this.snap);
    this.loading = this.run(refresh).finally(() => (this.loading = null));
    return this.loading;
  }

  private async run(rewriteBrief: boolean): Promise<WorkSnapshot> {
    const now = this.now();
    const cfg = loadConfig();
    const { since, label } = workWindow(now);
    const loading = <T>(prev: SourceState<T>): SourceState<T> => ({ ...prev, status: 'loading', error: undefined });
    const ms = cfg.microsoft ? loading : () => ({ status: 'not-connected' as const });
    this.set({
      since: since.toISOString(),
      sinceLabel: label,
      focus: cfg.focus ?? DEFAULT_FOCUS,
      jiraConnection: cfg.jira ?? null,
      microsoft: cfg.microsoft ?? null,
      jira: cfg.jira ? loading(this.snap.jira) : { status: 'not-connected' },
      github: loading(this.snap.github),
      email: ms(this.snap.email),
      teams: ms(this.snap.teams),
      calendar: ms(this.snap.calendar),
      brief: { ...this.snap.brief, status: 'waiting', error: undefined },
    });
    await Promise.all([this.loadJira(cfg, since, now), this.loadGitHub(cfg, since), this.loadMicrosoft(cfg, since, now)]);
    this.set({ loadedAt: now.getTime() });
    await this.loadBrief(cfg, rewriteBrief, now);
    return this.snap;
  }

  private async loadJira(cfg: WorkConfig, since: Date, now: Date): Promise<void> {
    if (!cfg.jira) return;
    const token = loadSecret('jira', this.opts.secrets);
    if (!token) return this.set({ jira: { status: 'not-connected', error: 'The saved Jira token could not be read. Connect Jira again.' } });
    try {
      this.set({ jira: { status: 'ok', data: await fetchJira(cfg.jira, token, since, this.fetchFn, now), updatedAt: now.getTime() } });
    } catch (e) {
      this.set({ jira: { ...this.snap.jira, status: 'error', error: errorText(e) } });
    }
  }

  private async loadGitHub(cfg: WorkConfig, since: Date): Promise<void> {
    try {
      const data = await fetchGitHub({ org: cfg.org, focus: cfg.focus ?? DEFAULT_FOCUS, since }, this.opts.gh ?? runGh);
      this.set({ github: { status: 'ok', data, updatedAt: this.now().getTime() } });
    } catch (e) {
      this.set({ github: { ...this.snap.github, status: 'error', error: errorText(e) } });
    }
  }

  /** An access token from the saved sign-in, refreshed when it is about to expire. */
  private async msToken(): Promise<string> {
    const now = this.now().getTime();
    if (this.ms && this.ms.expiresAt - 60_000 > now) return this.ms.accessToken;
    const saved = loadSecret('microsoft', this.opts.secrets);
    if (!saved) throw new Error('The saved Microsoft sign-in could not be read. Connect Microsoft again.');
    this.ms = await refreshAccess(saved, this.fetchFn, now);
    if (this.ms.refreshToken !== saved) saveSecret('microsoft', this.ms.refreshToken, this.opts.secrets);
    return this.ms.accessToken;
  }

  private async loadMicrosoft(cfg: WorkConfig, since: Date, now: Date): Promise<void> {
    if (!cfg.microsoft) return;
    let token: string;
    try {
      token = await this.msToken();
      this.msMeId ??= (await fetchMe(token, this.fetchFn)).id;
    } catch (e) {
      const failed = { status: 'error' as const, error: errorText(e) };
      return this.set({ email: { ...this.snap.email, ...failed }, teams: { ...this.snap.teams, ...failed }, calendar: { ...this.snap.calendar, ...failed } });
    }
    const one = async <K extends 'email' | 'teams' | 'calendar'>(key: K, get: () => Promise<NonNullable<WorkSnapshot[K]['data']>>) => {
      try {
        this.set({ [key]: { status: 'ok', data: await get(), updatedAt: now.getTime() } } as Partial<WorkSnapshot>);
      } catch (e) {
        this.set({ [key]: { ...this.snap[key], status: 'error', error: errorText(e) } } as Partial<WorkSnapshot>);
      }
    };
    await Promise.all([
      one('email', () => fetchMail(token, since, this.fetchFn)),
      one('teams', () => fetchChats(token, since, this.msMeId!, this.fetchFn)),
      one('calendar', () => fetchMeetings(token, now, this.fetchFn)),
    ]);
  }

  /** Today's list: the saved one unless asked to rewrite it, else Claude writes one from what loaded. */
  private async loadBrief(cfg: WorkConfig, rewrite: boolean, now: Date): Promise<void> {
    const saved = loadBrief(localDate(now));
    if (saved && !rewrite) return this.set({ brief: { status: 'ok', brief: saved } });
    const s = this.snap;
    const ok = <T>(st: SourceState<T>) => (st.status === 'ok' ? st.data : undefined);
    const input = { now, sinceLabel: s.sinceLabel, focus: s.focus, jira: ok(s.jira), github: ok(s.github), email: ok(s.email), teams: ok(s.teams), calendar: ok(s.calendar) };
    if (!input.jira && !input.github && !input.email && !input.teams && !input.calendar) {
      return this.set({ brief: { status: 'error', brief: saved ?? undefined, error: 'Nothing loaded to build the list from.' } });
    }
    const apiKey = (this.opts.apiKey ?? currentApiKey)();
    if (!apiKey && !this.opts.briefClient) return this.set({ brief: { status: 'needs-key', brief: saved ?? undefined } });
    this.set({ brief: { status: 'writing', brief: saved ?? undefined } });
    try {
      const brief = await writeBrief(input, { model: cfg.model ?? DEFAULT_BRIEF_MODEL, apiKey, client: this.opts.briefClient });
      saveBrief(brief);
      this.set({ brief: { status: 'ok', brief } });
    } catch (e) {
      const status = (e as { status?: number }).status;
      const error = status === 401 ? 'Anthropic did not accept the API key FrostCode is using. Check ANTHROPIC_API_KEY or your saved account.' : errorText(e);
      this.set({ brief: { status: 'error', brief: saved ?? undefined, error } });
    }
  }

  /** Check the email + API token against the site, save them (the token encrypted) and reload. */
  async connectJira(siteInput: string, email: string, token: string): Promise<string> {
    const site = normalizeSite(siteInput);
    if (!/^[^\s@]+@[^\s@]+$/.test(email.trim())) throw new Error('Enter the email address you sign in to Jira with.');
    if (!token.trim()) throw new Error('Paste a Jira API token.');
    const name = await jiraWhoAmI(site, email.trim(), token.trim(), this.fetchFn);
    saveSecret('jira', token.trim(), this.opts.secrets);
    saveConfig({ jira: { site, email: email.trim() } });
    void this.load(true);
    return `Connected to ${new URL(site).host} as ${name}.`;
  }

  /**
   * Start the Microsoft device-code sign-in. Returns at once with the code to enter; the snapshot's
   * microsoftPending shows it until the sign-in completes, fails or is cancelled.
   */
  async connectMicrosoft(): Promise<{ userCode: string; verificationUri: string }> {
    this.msSignIn?.abort();
    const abort = new AbortController();
    this.msSignIn = abort;
    const dc = await startDeviceCode(this.fetchFn, this.now().getTime());
    this.set({ microsoftPending: { userCode: dc.userCode, verificationUri: dc.verificationUri, expiresAt: dc.expiresAt } });
    void (async () => {
      try {
        const tokens = await pollDeviceCode(dc, { fetchFn: this.fetchFn, signal: abort.signal, sleep: this.opts.sleep, now: () => this.now().getTime() });
        if (abort.signal.aborted) return;
        const me = await fetchMe(tokens.accessToken, this.fetchFn);
        saveSecret('microsoft', tokens.refreshToken, this.opts.secrets);
        saveConfig({ microsoft: { account: me.account || me.name } });
        this.ms = tokens;
        this.msMeId = me.id;
        this.set({ microsoftPending: null, microsoft: { account: me.account || me.name } });
        void this.load(true);
      } catch (e) {
        if (abort.signal.aborted && this.msSignIn !== abort) return; // replaced by a newer sign-in
        const failed = { status: 'not-connected' as const, error: errorText(e) };
        this.set({ microsoftPending: null, email: failed, teams: failed, calendar: failed });
      } finally {
        if (this.msSignIn === abort) this.msSignIn = null;
      }
    })();
    return { userCode: dc.userCode, verificationUri: dc.verificationUri };
  }

  cancelMicrosoft(): void {
    this.msSignIn?.abort();
    this.msSignIn = null;
    this.set({ microsoftPending: null });
  }

  disconnect(source: 'jira' | 'microsoft'): void {
    if (source === 'jira') {
      deleteSecret('jira');
      saveConfig({ jira: undefined });
      this.set({ jiraConnection: null, jira: { status: 'not-connected' } });
    } else {
      this.cancelMicrosoft();
      deleteSecret('microsoft');
      saveConfig({ microsoft: undefined });
      this.ms = null;
      this.msMeId = null;
      const off = { status: 'not-connected' as const };
      this.set({ microsoft: null, email: off, teams: off, calendar: off });
    }
  }

  shutdown(): void {
    this.msSignIn?.abort();
  }
}
