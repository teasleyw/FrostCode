import type { ChatItem, MailItem, MeetingItem } from './types.js';
import { stripHtml } from './util.js';

/**
 * Outlook, Teams chats and today's calendar through Microsoft Graph, read-only. Sign-in is the OAuth
 * device-code flow with Microsoft's own public "Microsoft Graph Command Line Tools" app, so no app
 * registration is needed unless the organization blocks users from approving it themselves.
 */

export type FetchFn = typeof fetch;

export const MS_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const AUTHORITY = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
export const MS_SCOPES = 'offline_access User.Read Mail.Read Chat.Read Calendars.Read';
const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresAt: number;
}

export interface MsTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

async function form(url: string, body: Record<string, string>, fetchFn: FetchFn): Promise<any> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  } catch (e) {
    throw new Error(`Could not reach Microsoft sign-in: ${(e as Error).message}`);
  }
  return res.json();
}

/** Microsoft's error codes, said plainly; the ones that mean "your organization must approve this" first. */
function signInError(data: any): Error {
  const desc = String(data?.error_description ?? data?.error ?? 'unknown error');
  if (/AADSTS(65001|90094|90095)|admin(istrator)? (approval|consent)/i.test(desc)) {
    return new Error('Your organization requires an administrator to approve this app before it can read mail and Teams. Ask IT to approve "Microsoft Graph Command Line Tools", or register an app for FrostCode.');
  }
  if (data?.error === 'authorization_declined') return new Error('The Microsoft sign-in was declined.');
  if (data?.error === 'expired_token') return new Error('The sign-in code expired before it was entered. Connect again for a new one.');
  if (data?.error === 'invalid_grant') return new Error('The saved Microsoft sign-in is no longer valid. Connect Microsoft again.');
  return new Error(`Microsoft sign-in failed: ${desc.split('\r\n')[0]}`);
}

export async function startDeviceCode(fetchFn: FetchFn = fetch, now = Date.now()): Promise<DeviceCode> {
  const d = await form(`${AUTHORITY}/devicecode`, { client_id: MS_CLIENT_ID, scope: MS_SCOPES }, fetchFn);
  if (!d.device_code) throw signInError(d);
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri ?? 'https://microsoft.com/devicelogin',
    interval: Number(d.interval ?? 5),
    expiresAt: now + Number(d.expires_in ?? 900) * 1000,
  };
}

const tokensFrom = (t: any, now: number): MsTokens => ({ accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: now + Number(t.expires_in ?? 3600) * 1000 });

/** Waits until the code is entered (or declined / expired / cancelled). */
export async function pollDeviceCode(
  dc: DeviceCode,
  opts: { fetchFn?: FetchFn; signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<MsTokens> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  let interval = dc.interval;
  while (now() < dc.expiresAt) {
    await sleep(interval * 1000);
    if (opts.signal?.aborted) throw new Error('Microsoft sign-in cancelled.');
    const t = await form(`${AUTHORITY}/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: MS_CLIENT_ID, device_code: dc.deviceCode }, fetchFn);
    if (t.access_token) return tokensFrom(t, now());
    if (t.error === 'authorization_pending') continue;
    if (t.error === 'slow_down') {
      interval += 5;
      continue;
    }
    throw signInError(t);
  }
  throw signInError({ error: 'expired_token' });
}

/** A fresh access token from the saved refresh token (Microsoft rotates the refresh token too). */
export async function refreshAccess(refreshToken: string, fetchFn: FetchFn = fetch, now = Date.now()): Promise<MsTokens> {
  const t = await form(`${AUTHORITY}/token`, { grant_type: 'refresh_token', client_id: MS_CLIENT_ID, refresh_token: refreshToken, scope: MS_SCOPES }, fetchFn);
  if (!t.access_token) throw signInError(t);
  return { ...tokensFrom(t, now), refreshToken: t.refresh_token ?? refreshToken };
}

async function graph(token: string, path: string, fetchFn: FetchFn, what: string): Promise<any> {
  let res: Response;
  try {
    res = await fetchFn(`${GRAPH}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  } catch (e) {
    throw new Error(`Could not reach Microsoft Graph: ${(e as Error).message}`);
  }
  if (res.status === 401) throw new Error('The Microsoft sign-in expired. Connect Microsoft again.');
  if (res.status === 403) throw new Error(`Microsoft did not allow reading ${what} with this sign-in (your organization may restrict it).`);
  if (!res.ok) throw new Error(`Microsoft Graph answered ${res.status} for ${what}.`);
  return res.json();
}

const q = (params: Record<string, string>) => '?' + new URLSearchParams(params).toString().replace(/\+/g, '%20');

export async function fetchMe(token: string, fetchFn: FetchFn = fetch): Promise<{ id: string; name: string; account: string }> {
  const me = await graph(token, `/me${q({ $select: 'id,displayName,userPrincipalName,mail' })}`, fetchFn, 'your profile');
  return { id: String(me.id), name: String(me.displayName ?? ''), account: String(me.mail ?? me.userPrincipalName ?? '') };
}

/** Inbox mail received since `since`, newest first. */
export async function fetchMail(token: string, since: Date, fetchFn: FetchFn = fetch): Promise<MailItem[]> {
  const data = await graph(
    token,
    `/me/mailFolders/inbox/messages${q({
      $filter: `receivedDateTime ge ${since.toISOString()}`,
      $orderby: 'receivedDateTime desc',
      $top: '50',
      $select: 'id,subject,from,receivedDateTime,isRead,importance,webLink,bodyPreview,flag',
    })}`,
    fetchFn,
    'mail',
  );
  return (data.value ?? []).map(
    (m: any): MailItem => ({
      id: String(m.id),
      subject: String(m.subject || '(no subject)'),
      from: String(m.from?.emailAddress?.name || m.from?.emailAddress?.address || ''),
      receivedAt: String(m.receivedDateTime ?? ''),
      isRead: !!m.isRead,
      important: m.importance === 'high',
      flagged: m.flag?.flagStatus === 'flagged',
      preview: String(m.bodyPreview ?? '').replace(/\s+/g, ' ').trim(),
      url: String(m.webLink ?? ''),
    }),
  );
}

/** Teams chats whose latest message is from someone else and arrived since `since`. */
export async function fetchChats(token: string, since: Date, meId: string, fetchFn: FetchFn = fetch): Promise<ChatItem[]> {
  const data = await graph(
    token,
    `/me/chats${q({ $expand: 'lastMessagePreview', $orderby: 'lastMessagePreview/createdDateTime desc', $top: '50' })}`,
    fetchFn,
    'Teams chats',
  );
  const out: ChatItem[] = [];
  for (const c of data.value ?? []) {
    const m = c.lastMessagePreview;
    if (!m || m.isDeleted || m.messageType === 'systemEventMessage') continue;
    const at = String(m.createdDateTime ?? '');
    if (!at || new Date(at).getTime() < since.getTime()) continue;
    const fromId = m.from?.user?.id;
    if (fromId && fromId === meId) continue;
    const from = String(m.from?.user?.displayName ?? m.from?.application?.displayName ?? '');
    const readAt = c.viewpoint?.lastMessageReadDateTime;
    out.push({
      id: String(c.id),
      title: String(c.topic || from || 'Chat'),
      chatType: String(c.chatType ?? ''),
      from,
      preview: stripHtml(String(m.body?.content ?? '')),
      at,
      unread: !readAt || new Date(readAt).getTime() < new Date(at).getTime(),
      url: String(c.webUrl ?? ''),
    });
  }
  return out;
}

/** Graph returns event times as wall-clock strings in UTC unless asked otherwise. */
const utc = (t: { dateTime?: string; timeZone?: string } | undefined) =>
  !t?.dateTime ? '' : t.timeZone && t.timeZone !== 'UTC' ? t.dateTime : new Date(t.dateTime.replace(/(\.\d{3})\d*$/, '$1') + 'Z').toISOString();

/** Today's meetings (local day), in start order. */
export async function fetchMeetings(token: string, now = new Date(), fetchFn: FetchFn = fetch): Promise<MeetingItem[]> {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + 86_400_000);
  const data = await graph(
    token,
    `/me/calendarView${q({
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      $orderby: 'start/dateTime',
      $top: '50',
      $select: 'id,subject,start,end,location,isOnlineMeeting,onlineMeeting,organizer,isCancelled,webLink',
    })}`,
    fetchFn,
    'your calendar',
  );
  return (data.value ?? []).map(
    (e: any): MeetingItem => ({
      id: String(e.id),
      subject: String(e.subject || '(no title)'),
      start: utc(e.start),
      end: utc(e.end),
      location: String(e.location?.displayName ?? ''),
      online: !!e.isOnlineMeeting,
      joinUrl: e.onlineMeeting?.joinUrl ?? null,
      organizer: String(e.organizer?.emailAddress?.name ?? ''),
      cancelled: !!e.isCancelled,
      url: String(e.webLink ?? ''),
    }),
  );
}
