// Types for the desktop app's Work tab, shared by the main process (src/work/service.ts) and the
// renderer. No runtime code here: the renderer bundle only needs the types.

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  /** Jira's status category: new (to do), indeterminate (in progress) or done. */
  statusCategory: 'new' | 'indeterminate' | 'done';
  priority: string | null;
  project: string;
  projectName: string;
  type: string;
  assignee: string | null;
  updated: string;
  url: string;
}

export interface WorkJira {
  site: string;
  /** Open issues assigned to you, most recently updated first. */
  assigned: JiraIssue[];
  /** Issues you are assigned to, reported or watch that changed in the window. */
  changed: JiraIssue[];
}

export interface GitHubPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  updatedAt: string;
  draft?: boolean;
  /** Your own PRs: the review decision and the latest commit's combined checks. */
  reviewDecision?: string | null;
  checks?: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null;
}

export interface GitHubCommit {
  sha: string;
  author: string;
  message: string;
  url: string;
  date: string;
}

/** Pushes to one branch of one repo in the window, with the commits now on it since the window began. */
export interface GitHubPushGroup {
  repo: string;
  branch: string;
  pushers: string[];
  pushes: number;
  lastPushAt: string;
  commits: GitHubCommit[];
  /** Matches the focus keyword (Popdock), so it is listed first. */
  focus: boolean;
}

export interface GitHubEvent {
  repo: string;
  kind: 'release' | 'branch-created' | 'branch-deleted' | 'tag-created' | 'pr-opened' | 'pr-merged' | 'pr-closed';
  title: string;
  actor: string;
  at: string;
  url: string;
  focus: boolean;
}

export interface WorkGitHub {
  org: string;
  login: string;
  reviewRequests: GitHubPr[];
  myPrs: GitHubPr[];
  merged: GitHubPr[];
  opened: GitHubPr[];
  pushes: GitHubPushGroup[];
  events: GitHubEvent[];
}

export interface MailItem {
  id: string;
  subject: string;
  from: string;
  receivedAt: string;
  isRead: boolean;
  important: boolean;
  flagged: boolean;
  preview: string;
  url: string;
}

export interface ChatItem {
  id: string;
  title: string;
  chatType: string;
  from: string;
  preview: string;
  at: string;
  unread: boolean;
  url: string;
}

export interface MeetingItem {
  id: string;
  subject: string;
  start: string;
  end: string;
  location: string;
  online: boolean;
  joinUrl: string | null;
  organizer: string;
  cancelled: boolean;
  url: string;
}

export type SourceName = 'jira' | 'github' | 'email' | 'teams' | 'calendar';

export interface SourceState<T> {
  status: 'idle' | 'loading' | 'ok' | 'error' | 'not-connected';
  data?: T;
  error?: string;
  updatedAt?: number;
}

/** One item of Claude's daily list. `ref` names an item from the sources (jira:KEY, pr:owner/repo#N, ...). */
export interface BriefTodo {
  ref: string;
  title: string;
  why: string;
  url: string | null;
}

export interface Brief {
  date: string;
  generatedAt: number;
  model: string;
  headline: string;
  todo: BriefTodo[];
  headsUp: { text: string; refs: string[] }[];
  /** Items Claude listed that matched nothing in the sources and were left out. */
  dropped: number;
}

export interface BriefState {
  status: 'idle' | 'waiting' | 'writing' | 'ok' | 'error' | 'needs-key';
  brief?: Brief;
  error?: string;
}

export interface WorkSnapshot {
  /** Start of the "what changed" window: the previous working day at this time. */
  since: string;
  sinceLabel: string;
  focus: string;
  jiraConnection: { site: string; email: string } | null;
  microsoft: { account: string } | null;
  /** A Microsoft sign-in waiting for the code to be entered. */
  microsoftPending: { userCode: string; verificationUri: string; expiresAt: number } | null;
  jira: SourceState<WorkJira>;
  github: SourceState<WorkGitHub>;
  email: SourceState<MailItem[]>;
  teams: SourceState<ChatItem[]>;
  calendar: SourceState<MeetingItem[]>;
  brief: BriefState;
  loadedAt: number | null;
}
