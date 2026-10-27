import type { JiraIssue, WorkJira } from './types.js';

/** Jira Cloud over REST with an API token (id.atlassian.com → Security → API tokens). */

export type FetchFn = typeof fetch;

const FIELDS = ['summary', 'status', 'priority', 'project', 'issuetype', 'assignee', 'updated'];

/** "popdock.atlassian.net", "https://popdock.atlassian.net/browse/X-1" → "https://popdock.atlassian.net". */
export function normalizeSite(input: string): string {
  const s = input.trim();
  if (!s) throw new Error('Enter your Jira site, e.g. your-team.atlassian.net.');
  const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  if (url.protocol !== 'https:') throw new Error('The Jira site must use https.');
  return url.origin;
}

function auth(email: string, token: string): string {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function call(site: string, email: string, token: string, path: string, init: RequestInit, fetchFn: FetchFn): Promise<any> {
  let res: Response;
  try {
    res = await fetchFn(`${site}${path}`, {
      ...init,
      headers: { Authorization: auth(email, token), Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (e) {
    throw new Error(`Could not reach ${site}: ${(e as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) throw new Error('Jira did not accept the email and API token. Reconnect Jira with a new token.');
  if (!res.ok) throw new Error(`Jira answered ${res.status} for ${path.split('?')[0]}.`);
  return res.json();
}

/** Checks the email + token and returns the Jira display name. */
export async function jiraWhoAmI(site: string, email: string, token: string, fetchFn: FetchFn = fetch): Promise<string> {
  const me = await call(site, email, token, '/rest/api/3/myself', { method: 'GET' }, fetchFn);
  return String(me.displayName ?? email);
}

function toIssue(site: string, raw: any): JiraIssue {
  const f = raw.fields ?? {};
  const cat = f.status?.statusCategory?.key;
  return {
    key: String(raw.key),
    summary: String(f.summary ?? ''),
    status: String(f.status?.name ?? ''),
    statusCategory: cat === 'done' ? 'done' : cat === 'indeterminate' ? 'indeterminate' : 'new',
    priority: f.priority?.name ?? null,
    project: String(f.project?.key ?? ''),
    projectName: String(f.project?.name ?? ''),
    type: String(f.issuetype?.name ?? ''),
    assignee: f.assignee?.displayName ?? null,
    updated: String(f.updated ?? ''),
    url: `${site}/browse/${raw.key}`,
  };
}

async function search(site: string, email: string, token: string, jql: string, limit: number, fetchFn: FetchFn): Promise<JiraIssue[]> {
  const out: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const page = await call(
      site,
      email,
      token,
      '/rest/api/3/search/jql',
      { method: 'POST', body: JSON.stringify({ jql, fields: FIELDS, maxResults: Math.min(100, limit - out.length), ...(nextPageToken ? { nextPageToken } : {}) }) },
      fetchFn,
    );
    for (const raw of page.issues ?? []) out.push(toIssue(site, raw));
    nextPageToken = page.isLast === false || (page.nextPageToken && page.isLast !== true) ? page.nextPageToken : undefined;
  } while (nextPageToken && out.length < limit);
  return out;
}

/** Your open issues, and issues you are on that changed since `since`. */
export async function fetchJira(conn: { site: string; email: string }, token: string, since: Date, fetchFn: FetchFn = fetch, now = new Date()): Promise<WorkJira> {
  const hours = Math.max(1, Math.ceil((now.getTime() - since.getTime()) / 3_600_000));
  const [assigned, changed] = await Promise.all([
    search(conn.site, conn.email, token, 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC', 200, fetchFn),
    search(
      conn.site,
      conn.email,
      token,
      `(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -${hours}h ORDER BY updated DESC`,
      50,
      fetchFn,
    ),
  ]);
  return { site: conn.site, assigned, changed };
}
