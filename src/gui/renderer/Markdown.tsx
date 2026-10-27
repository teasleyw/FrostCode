import MarkdownIt from 'markdown-it';
import { memo, useMemo, type MouseEvent } from 'react';

// html: false escapes any raw HTML in model output; markdown-it also refuses javascript: links.
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
const escape = md.utils.escapeHtml;

md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx];
  const lang = t.info.trim().split(/\s+/)[0] ?? '';
  return `<div class="code"><div class="code-head"><span>${escape(lang || 'text')}</span><button type="button" class="code-copy" data-copy>Copy</button></div><pre><code>${escape(t.content)}</code></pre></div>`;
};
md.renderer.rules.code_block = (tokens, idx) => `<div class="code"><pre><code>${escape(tokens[idx].content)}</code></pre></div>`;

export function renderMarkdown(text: string): string {
  return md.render(text);
}

function onClick(e: MouseEvent<HTMLDivElement>): void {
  const target = e.target as HTMLElement;
  const copy = target.closest('[data-copy]');
  if (copy) {
    const code = copy.closest('.code')?.querySelector('code')?.textContent ?? '';
    void navigator.clipboard.writeText(code).then(() => {
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1200);
    });
    return;
  }
  const link = target.closest('a');
  if (link) {
    e.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) void window.frost.openExternal(href);
  }
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={`md ${className ?? ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
