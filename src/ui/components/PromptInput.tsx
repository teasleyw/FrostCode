import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import * as ed from '../editor.js';
import { theme } from '../theme.js';

export interface Suggestion {
  name: string;
  description: string;
}

interface Props {
  active: boolean;
  history: ed.History;
  placeholder: string;
  /** Command suggestions for the current input (empty when not typing a command). */
  suggest(value: string): Suggestion[];
  onSubmit(value: string): void;
  onChange?(value: string): void;
  borderColor?: string;
  width: number;
}

export function PromptInput({ active, history, placeholder, suggest, onSubmit, onChange, borderColor, width }: Props) {
  const [state, setStateRaw] = useState<ed.EditorState>(ed.empty);
  const [selected, setSelected] = useState(0);
  const stateRef = useRef(state);

  const setState = (next: ed.EditorState) => {
    stateRef.current = next;
    setStateRaw(next);
    onChange?.(next.value);
  };

  const suggestions = state.value.startsWith('/') && !state.value.includes(' ') ? suggest(state.value) : [];
  const sel = Math.min(selected, Math.max(0, suggestions.length - 1));

  useInput(
    (input, key) => {
      const s = stateRef.current;
      if (key.escape) return; // handled by the app (interrupt / dismiss)
      if (key.return) {
        if (suggestions.length && s.value !== '/' + suggestions[sel].name) {
          // Enter on a partial command completes it and runs it.
          const full = '/' + suggestions[sel].name;
          history.push(full);
          setState(ed.empty);
          setSelected(0);
          onSubmit(full);
          return;
        }
        if (s.value.endsWith('\\') && s.cursor === s.value.length) {
          setState(ed.insert(ed.backspace(s), '\n'));
          return;
        }
        if (key.meta || key.shift) {
          setState(ed.insert(s, '\n'));
          return;
        }
        const value = s.value;
        if (!value.trim()) return;
        history.push(value);
        setState(ed.empty);
        setSelected(0);
        onSubmit(value);
        return;
      }
      if (key.tab && !key.shift) {
        if (suggestions.length) {
          setState(ed.setValue('/' + suggestions[sel].name + ' '));
          setSelected(0);
        }
        return;
      }
      if (key.upArrow) {
        if (suggestions.length) return setSelected((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
        const moved = ed.vertical(s, -1);
        if (moved) return setState(moved);
        const prev = history.prev(s.value);
        if (prev !== null) setState(ed.setValue(prev));
        return;
      }
      if (key.downArrow) {
        if (suggestions.length) return setSelected((i) => (i >= suggestions.length - 1 ? 0 : i + 1));
        const moved = ed.vertical(s, 1);
        if (moved) return setState(moved);
        const next = history.next();
        if (next !== null) setState(ed.setValue(next));
        return;
      }
      if (key.leftArrow) return setState(key.meta || key.ctrl ? ed.wordLeft(s) : ed.left(s));
      if (key.rightArrow) return setState(key.meta || key.ctrl ? ed.wordRight(s) : ed.right(s));
      // Terminals send DEL (0x7f) for Backspace, which Ink reports as `delete`.
      if (key.backspace || key.delete) {
        setSelected(0);
        return setState(key.meta ? ed.deleteWord(s) : ed.backspace(s));
      }
      if (key.ctrl) {
        switch (input) {
          case 'c':
            return setState(ed.empty);
          case 'a':
            return setState(ed.lineStart(s));
          case 'e':
            return setState(ed.lineEnd(s));
          case 'u':
            return setState(ed.killToStart(s));
          case 'k':
            return setState(ed.killToEnd(s));
          case 'w':
            return setState(ed.deleteWord(s));
          case 'b':
            return setState(ed.left(s));
          case 'f':
            return setState(ed.right(s));
          case 'd':
            return setState(ed.deleteForward(s));
          case 'j':
            return setState(ed.insert(s, '\n'));
          default:
            return;
        }
      }
      if (key.meta) {
        if (input === 'b') return setState(ed.wordLeft(s));
        if (input === 'f') return setState(ed.wordRight(s));
        return;
      }
      if (input === '?' && s.value === '') return; // toggles the shortcut list (handled by the app)
      if (input) {
        setSelected(0);
        // Typed-ahead text and Enter can arrive in one chunk when the event loop was busy.
        if (input.length > 1 && input.endsWith('\r') && !input.endsWith('\\\r')) {
          const value = ed.insert(s, input.slice(0, -1)).value;
          if (value.trim()) {
            history.push(value);
            setState(ed.empty);
            onSubmit(value);
            return;
          }
        }
        setState(ed.insert(s, input));
      }
    },
    { isActive: active },
  );

  const lines = renderWithCursor(state, active);
  return (
    <Box flexDirection="column" width={width}>
      <Box borderStyle="round" borderColor={borderColor ?? theme.border} paddingX={1} flexDirection="column">
        {state.value.length === 0 ? (
          <Box>
            <Text>{'> '}</Text>
            {active ? <Text inverse>{' '}</Text> : null}
            <Text dimColor>{placeholder}</Text>
          </Box>
        ) : (
          lines.map((line, i) => (
            <Box key={i}>
              <Text>{i === 0 ? '> ' : '  '}</Text>
              <Text>{line}</Text>
            </Box>
          ))
        )}
      </Box>
      {suggestions.length ? (
        <Box flexDirection="column" paddingX={2}>
          {suggestions.slice(0, 8).map((sg, i) => (
            <Box key={sg.name}>
              <Text color={i === sel ? theme.accent : undefined} bold={i === sel}>
                {('/' + sg.name).padEnd(20)}
              </Text>
              <Text dimColor>{sg.description}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

/** Split into lines and mark the cursor with an inverse cell (ANSI inverse escape). */
function renderWithCursor(s: ed.EditorState, showCursor: boolean): string[] {
  const INV = '\u001b[7m';
  const OFF = '\u001b[27m';
  if (!showCursor) return s.value.split('\n');
  const before = s.value.slice(0, s.cursor);
  const at = s.value[s.cursor];
  const after = s.value.slice(s.cursor + 1);
  const cursorCell = at === undefined || at === '\n' ? `${INV} ${OFF}${at === '\n' ? '\n' : ''}` : `${INV}${at}${OFF}`;
  return (before + cursorCell + after).split('\n');
}
