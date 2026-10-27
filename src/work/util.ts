/** The "what changed" window: since this time on the previous working day (Monday and Sunday look back to Friday). */
export function workWindow(now = new Date()): { since: Date; label: string } {
  const day = now.getDay();
  const back = day === 1 ? 3 : day === 0 ? 2 : 1;
  const since = new Date(now.getTime() - back * 86_400_000);
  const label = back === 1 ? 'since yesterday' : `since ${since.toLocaleDateString('en-US', { weekday: 'long' })}`;
  return { since, label };
}

/** Local calendar date as YYYY-MM-DD (the daily list is one per local day). */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Plain text from a Teams / Outlook HTML fragment. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Whether a repo / project name matches the focus keyword (case-insensitive). */
export const matchesFocus = (name: string, focus: string) => !!focus && name.toLowerCase().includes(focus.toLowerCase());
