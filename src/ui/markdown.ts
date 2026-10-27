import chalk from 'chalk';

/**
 * A small terminal Markdown renderer: headings, emphasis, inline code, fenced code,
 * lists, quotes, links, rules. Returns ANSI text that Ink's <Text> passes through.
 */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceLang = '';
  for (const raw of lines) {
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(raw);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceLang = fence[2];
        if (fenceLang) out.push(chalk.dim(fenceLang));
      } else {
        inFence = false;
        fenceLang = '';
      }
      continue;
    }
    if (inFence) {
      out.push(chalk.hex('#A5B4FC')(raw));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      const text = inline(heading[2]);
      out.push(heading[1].length <= 2 ? chalk.bold.underline(text) : chalk.bold(text));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push(chalk.dim('─'.repeat(40)));
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      out.push(chalk.dim('│ ') + chalk.italic(inline(quote[1])));
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(\[[ xX]\]\s+)?(.*)$/.exec(raw);
    if (bullet) {
      const box = bullet[2] ? (bullet[2].includes(' ]') ? '☐ ' : '☒ ') : '';
      out.push(`${bullet[1]}${chalk.dim('•')} ${box}${inline(bullet[3])}`);
      continue;
    }
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(raw);
    if (numbered) {
      out.push(`${numbered[1]}${chalk.dim(numbered[2] + '.')} ${inline(numbered[3])}`);
      continue;
    }
    out.push(inline(raw));
  }
  // Collapse runs of blank lines.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

export function inline(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(chalk.hex('#A5B4FC')(c));
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, t: string) => chalk.bold(t));
  s = s.replace(/__([^_]+)__/g, (_, t: string) => chalk.bold(t));
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, (_, pre: string, t: string) => pre + chalk.italic(t));
  s = s.replace(/~~([^~]+)~~/g, (_, t: string) => chalk.strikethrough(t));
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, label: string, url: string) => `${chalk.underline(label)} ${chalk.dim(`(${url})`)}`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
}
