import { execFile } from 'node:child_process';
import type { GitHubCommit, GitHubEvent, GitHubPr, GitHubPushGroup, WorkGitHub } from './types.js';
import { matchesFocus } from './util.js';

/** GitHub through the gh CLI: its existing sign-in (gh auth login) is used as is; nothing is stored here. */

export type GhRunner = (args: string[]) => Promise<string>;

export const runGh: GhRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('gh', args, { maxBuffer: 32 * 1024 * 1024, timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('The GitHub CLI (gh) is not installed. Install it from https://cli.github.com, then run: gh auth login'));
      const first = String(stderr || err.message).trim().split('\n')[0];
      reject(new Error(/auth login|not logged in/i.test(first) ? 'gh is not signed in. Run: gh auth login' : first));
    });
  });

const json = async (gh: GhRunner, args: string[]) => JSON.parse((await gh(args)) || 'null');

/** Your login, and the org to report on: the configured one, else your only org. */
export async function githubIdentity(gh: GhRunner, org?: string): Promise<{ login: string; org: string }> {
  const user = await json(gh, ['api', 'user']);
  if (org) return { login: user.login, org };
  const orgs: string[] = ((await json(gh, ['api', 'user/orgs'])) ?? []).map((o: { login: string }) => o.login);
  if (!orgs.length) throw new Error(`${user.login} is not a member of any GitHub organization.`);
  return { login: user.login, org: orgs[0] };
}

const prFrom = (r: any): GitHubPr => ({
  repo: String(r.repository?.nameWithOwner ?? r.repository?.name ?? ''),
  number: Number(r.number),
  title: String(r.title ?? ''),
  url: String(r.url ?? ''),
  author: String(r.author?.login ?? ''),
  updatedAt: String(r.updatedAt ?? r.closedAt ?? r.createdAt ?? ''),
  draft: !!r.isDraft,
});

const MY_PRS = `query { viewer { pullRequests(first: 40, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes {
  number title url updatedAt isDraft reviewDecision author { login } repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }`;

/** Run async jobs a few at a time. */
async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function fetchGitHub(opts: { org?: string; focus: string; since: Date }, gh: GhRunner = runGh): Promise<WorkGitHub> {
  const { login, org } = await githubIdentity(gh, opts.org);
  const since = opts.since;
  const day = since.toISOString().slice(0, 10);
  const after = (iso: string) => new Date(iso).getTime() >= since.getTime();
  const focus = (repo: string) => matchesFocus(repo, opts.focus);

  const [review, mine, merged, opened] = await Promise.all([
    json(gh, ['search', 'prs', '--review-requested=@me', '--state=open', '--json', 'number,title,repository,url,updatedAt,author,isDraft', '--limit', '50']),
    json(gh, ['api', 'graphql', '-f', `query=${MY_PRS}`]),
    json(gh, ['search', 'prs', `--owner=${org}`, '--merged-at', `>=${day}`, '--json', 'number,title,repository,url,author,closedAt', '--limit', '100']),
    json(gh, ['search', 'prs', `--owner=${org}`, '--created', `>=${day}`, '--json', 'number,title,repository,url,author,createdAt,isDraft', '--limit', '100']),
  ]);

  const myPrs: GitHubPr[] = (mine?.data?.viewer?.pullRequests?.nodes ?? []).map((n: any) => ({
    ...prFrom(n),
    reviewDecision: n.reviewDecision ?? null,
    checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
  }));

  // The member activity feed (private repos included), newest first, until it is older than the window.
  const events: any[] = [];
  for (let page = 1; page <= 3; page++) {
    const batch: any[] = (await json(gh, ['api', `users/${login}/events/orgs/${org}?per_page=100&page=${page}`])) ?? [];
    events.push(...batch);
    if (batch.length < 100 || !after(batch[batch.length - 1].created_at)) break;
  }

  const groups = new Map<string, GitHubPushGroup>();
  const other: GitHubEvent[] = [];
  for (const e of events) {
    if (!after(e.created_at)) continue;
    const repo = String(e.repo?.name ?? '');
    const p = e.payload ?? {};
    if (e.type === 'PushEvent' && typeof p.ref === 'string' && p.ref.startsWith('refs/heads/')) {
      const branch = p.ref.slice('refs/heads/'.length);
      const key = `${repo}@${branch}`;
      const g: GitHubPushGroup = groups.get(key) ?? { repo, branch, pushers: [], pushes: 0, lastPushAt: e.created_at, commits: [], focus: focus(repo) };
      const actor = String(e.actor?.login ?? '');
      g.pushes++;
      if (actor && !g.pushers.includes(actor)) g.pushers.push(actor);
      if (e.created_at > g.lastPushAt) g.lastPushAt = e.created_at;
      groups.set(key, g);
    } else if ((e.type === 'CreateEvent' || e.type === 'DeleteEvent') && (p.ref_type === 'branch' || p.ref_type === 'tag')) {
      const kind = e.type === 'DeleteEvent' ? 'branch-deleted' : p.ref_type === 'tag' ? 'tag-created' : 'branch-created';
      if (kind === 'branch-deleted' && p.ref_type !== 'branch') continue;
      other.push({ repo, kind, title: String(p.ref), actor: e.actor?.login ?? '', at: e.created_at, url: `https://github.com/${repo}${kind === 'branch-deleted' ? '' : `/tree/${encodeURIComponent(p.ref)}`}`, focus: focus(repo) });
    } else if (e.type === 'ReleaseEvent' && p.release) {
      other.push({ repo, kind: 'release', title: String(p.release.name || p.release.tag_name), actor: e.actor?.login ?? '', at: e.created_at, url: String(p.release.html_url ?? `https://github.com/${repo}/releases`), focus: focus(repo) });
    }
  }

  const byFocusThenRecent = <T extends { focus: boolean }>(get: (t: T) => string) => (a: T, b: T) => Number(b.focus) - Number(a.focus) || get(b).localeCompare(get(a));
  const pushes = [...groups.values()].sort(byFocusThenRecent((g) => g.lastPushAt));
  // What each pushed branch gained: its commits since the window began (push events no longer list them).
  await pool(pushes.slice(0, 20), 4, async (g) => {
    try {
      const commits: any[] = (await json(gh, ['api', `repos/${g.repo}/commits?sha=${encodeURIComponent(g.branch)}&since=${since.toISOString()}&per_page=20`])) ?? [];
      g.commits = commits.map(
        (c): GitHubCommit => ({
          sha: String(c.sha).slice(0, 7),
          author: String(c.commit?.author?.name ?? c.author?.login ?? ''),
          message: String(c.commit?.message ?? '').split('\n')[0],
          url: String(c.html_url ?? ''),
          date: String(c.commit?.author?.date ?? ''),
        }),
      );
    } catch {
      g.commits = []; // a branch deleted since, or no access
    }
  });

  const focusFirst = (prs: GitHubPr[]) => prs.sort((a, b) => Number(focus(b.repo)) - Number(focus(a.repo)) || b.updatedAt.localeCompare(a.updatedAt));
  return {
    org,
    login,
    reviewRequests: focusFirst((review ?? []).map(prFrom)),
    myPrs,
    merged: focusFirst((merged ?? []).filter((r: any) => after(r.closedAt)).map(prFrom)),
    opened: focusFirst((opened ?? []).filter((r: any) => after(r.createdAt)).map(prFrom)),
    pushes,
    events: other.sort(byFocusThenRecent((e) => e.at)),
  };
}
