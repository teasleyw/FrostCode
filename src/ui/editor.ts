/** Pure line-editor state transitions for the prompt box. */
export interface EditorState {
  value: string;
  cursor: number;
}

export const empty: EditorState = { value: '', cursor: 0 };

export function insert(s: EditorState, text: string): EditorState {
  const clean = text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ');
  return { value: s.value.slice(0, s.cursor) + clean + s.value.slice(s.cursor), cursor: s.cursor + clean.length };
}

export function backspace(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  return { value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 };
}

export function deleteForward(s: EditorState): EditorState {
  if (s.cursor >= s.value.length) return s;
  return { value: s.value.slice(0, s.cursor) + s.value.slice(s.cursor + 1), cursor: s.cursor };
}

export function left(s: EditorState): EditorState {
  return { ...s, cursor: Math.max(0, s.cursor - 1) };
}

export function right(s: EditorState): EditorState {
  return { ...s, cursor: Math.min(s.value.length, s.cursor + 1) };
}

export function lineStart(s: EditorState): EditorState {
  return { ...s, cursor: s.value.lastIndexOf('\n', s.cursor - 1) + 1 };
}

export function lineEnd(s: EditorState): EditorState {
  const nl = s.value.indexOf('\n', s.cursor);
  return { ...s, cursor: nl === -1 ? s.value.length : nl };
}

export function killToStart(s: EditorState): EditorState {
  const start = s.value.lastIndexOf('\n', s.cursor - 1) + 1;
  return { value: s.value.slice(0, start) + s.value.slice(s.cursor), cursor: start };
}

export function killToEnd(s: EditorState): EditorState {
  const nl = s.value.indexOf('\n', s.cursor);
  const end = nl === -1 ? s.value.length : nl;
  return { value: s.value.slice(0, s.cursor) + s.value.slice(end), cursor: s.cursor };
}

export function deleteWord(s: EditorState): EditorState {
  let i = s.cursor;
  while (i > 0 && /\s/.test(s.value[i - 1])) i--;
  while (i > 0 && !/\s/.test(s.value[i - 1])) i--;
  return { value: s.value.slice(0, i) + s.value.slice(s.cursor), cursor: i };
}

export function wordLeft(s: EditorState): EditorState {
  let i = s.cursor;
  while (i > 0 && /\s/.test(s.value[i - 1])) i--;
  while (i > 0 && !/\s/.test(s.value[i - 1])) i--;
  return { ...s, cursor: i };
}

export function wordRight(s: EditorState): EditorState {
  let i = s.cursor;
  while (i < s.value.length && /\s/.test(s.value[i])) i++;
  while (i < s.value.length && !/\s/.test(s.value[i])) i++;
  return { ...s, cursor: i };
}

/** Move the cursor up/down a line; null when already on the first/last line (caller may use history). */
export function vertical(s: EditorState, dir: -1 | 1): EditorState | null {
  const lines = s.value.split('\n');
  let pos = 0;
  let row = 0;
  for (; row < lines.length; row++) {
    if (s.cursor <= pos + lines[row].length) break;
    pos += lines[row].length + 1;
  }
  const col = s.cursor - pos;
  const target = row + dir;
  if (target < 0 || target >= lines.length) return null;
  let tpos = 0;
  for (let r = 0; r < target; r++) tpos += lines[r].length + 1;
  return { ...s, cursor: tpos + Math.min(col, lines[target].length) };
}

export function setValue(value: string): EditorState {
  return { value, cursor: value.length };
}

/** Prompt history with a draft slot, like a shell. */
export class History {
  private entries: string[] = [];
  private index = -1;
  private draft = '';

  constructor(initial: string[] = []) {
    this.entries = initial.slice(-200);
  }

  push(entry: string): void {
    if (entry.trim() && this.entries[this.entries.length - 1] !== entry) this.entries.push(entry);
    this.index = -1;
    this.draft = '';
  }

  prev(current: string): string | null {
    if (!this.entries.length) return null;
    if (this.index === -1) {
      this.draft = current;
      this.index = this.entries.length - 1;
    } else if (this.index > 0) this.index--;
    else return null;
    return this.entries[this.index];
  }

  next(): string | null {
    if (this.index === -1) return null;
    if (this.index < this.entries.length - 1) {
      this.index++;
      return this.entries[this.index];
    }
    this.index = -1;
    return this.draft;
  }

  all(): string[] {
    return [...this.entries];
  }
}
