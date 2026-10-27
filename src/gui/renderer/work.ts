// Pure helpers for the Work tab (kept apart from the component so they can be tested).
import type { BriefTodo, JiraIssue } from '../protocol.js';

/** Assigned issues grouped by status: in progress first, then to do, then the rest by size. */
export function groupByStatus(issues: JiraIssue[]): { status: string; category: JiraIssue['statusCategory']; issues: JiraIssue[] }[] {
  const groups = new Map<string, { status: string; category: JiraIssue['statusCategory']; issues: JiraIssue[] }>();
  for (const i of issues) {
    const g = groups.get(i.status) ?? { status: i.status, category: i.statusCategory, issues: [] };
    g.issues.push(i);
    groups.set(i.status, g);
  }
  const rank = (c: JiraIssue['statusCategory']) => (c === 'indeterminate' ? 0 : c === 'new' ? 1 : 2);
  return [...groups.values()].sort((a, b) => rank(a.category) - rank(b.category) || b.issues.length - a.issues.length);
}

/** owner/repo → repo (the org is shown once, in the section title). */
export const shortRepo = (repo: string) => repo.slice(repo.indexOf('/') + 1);

/** 9:05 AM today, "Mon 4:10 PM" this week, else the date. */
export function whenLabel(iso: string, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return t;
  if (now.getTime() - d.getTime() < 6 * 86_400_000) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${t}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The source a daily-list ref points at, for its chip. */
export function refSource(ref: string): string {
  const kind = ref.slice(0, ref.indexOf(':'));
  return ({ jira: 'Jira', pr: 'GitHub', push: 'GitHub', gh: 'GitHub', mail: 'Email', chat: 'Teams', meet: 'Meeting' } as Record<string, string>)[kind] ?? 'Item';
}

/** What "Ask Claude" puts in the message box for a daily-list item. */
export function askText(t: BriefTodo): string {
  const label = t.ref.startsWith('jira:') ? `Jira ${t.ref.slice(5)}` : t.ref.startsWith('pr:') ? `pull request ${t.ref.slice(3)}` : null;
  return `Help me with this${label ? ` (${label})` : ''}: ${t.title}. ${t.why}${t.url ? `\n${t.url}` : ''}`;
}
