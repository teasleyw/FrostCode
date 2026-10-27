import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';

export interface SelectItem<T> {
  label: string;
  value: T;
  hint?: string;
  /** Extra text matched by the filter but not shown. */
  keywords?: string;
  color?: string;
}

interface Props<T> {
  title: string;
  subtitle?: string;
  items: SelectItem<T>[];
  onSelect(item: SelectItem<T>): void;
  onCancel(): void;
  /** Called on enter when the filter matches nothing (e.g. a custom model id or path). */
  onSubmitText?(text: string): void;
  filterable?: boolean;
  placeholder?: string;
  emptyText?: string;
  maxVisible?: number;
  initialIndex?: number;
  footer?: string;
}

export function SelectList<T>({
  title,
  subtitle,
  items,
  onSelect,
  onCancel,
  onSubmitText,
  filterable = true,
  placeholder = 'type to filter',
  emptyText = 'Nothing to show',
  maxVisible = 10,
  initialIndex = 0,
  footer,
}: Props<T>) {
  const [filter, setFilter] = useState('');
  const [index, setIndex] = useState(initialIndex);

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return items;
    return items.filter((i) => `${i.label} ${i.hint ?? ''} ${i.keywords ?? ''}`.toLowerCase().includes(f));
  }, [items, filter]);

  const clamped = Math.min(index, Math.max(0, visible.length - 1));

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) return setIndex((i) => (i <= 0 ? Math.max(0, visible.length - 1) : i - 1));
    if (key.downArrow) return setIndex((i) => (i >= visible.length - 1 ? 0 : i + 1));
    if (key.return) {
      const item = visible[clamped];
      if (item) return onSelect(item);
      if (filter.trim() && onSubmitText) return onSubmitText(filter.trim());
      return;
    }
    if (!filterable) {
      const n = Number(input);
      if (n >= 1 && n <= visible.length) onSelect(visible[n - 1]);
      return;
    }
    if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
      setIndex(0);
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.tab) {
      setFilter((f) => f + input.replace(/[\r\n]/g, ''));
      setIndex(0);
    }
  });

  const start = Math.max(0, Math.min(clamped - Math.floor(maxVisible / 2), visible.length - maxVisible));
  const shown = visible.slice(start, start + maxVisible);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold color={theme.accent}>
        {title}
      </Text>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
      {filterable ? (
        <Box marginTop={1}>
          <Text color={theme.accent}>{'⌕ '}</Text>
          {filter ? <Text>{filter}</Text> : <Text dimColor>{placeholder}</Text>}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {shown.length === 0 ? (
          <Text dimColor>{filter && onSubmitText ? `Press enter to use "${filter.trim()}"` : emptyText}</Text>
        ) : (
          shown.map((item, i) => {
            const selected = start + i === clamped;
            return (
              <Box key={`${start + i}-${item.label}`}>
                <Box width={2} flexShrink={0}>
                  <Text color={selected ? theme.accent : undefined}>{selected ? '❯' : ' '}</Text>
                </Box>
                <Box flexShrink={0}>
                  <Text color={selected ? theme.accent : item.color} bold={selected}>
                    {item.label}
                  </Text>
                </Box>
                {item.hint ? (
                  <Box flexShrink={1} marginLeft={2}>
                    <Text dimColor wrap="truncate-end">
                      {item.hint}
                    </Text>
                  </Box>
                ) : null}
              </Box>
            );
          })
        )}
        {visible.length > maxVisible ? <Text dimColor>{`  … ${visible.length} total`}</Text> : null}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{footer ?? '↑/↓ to move · enter to select · esc to cancel'}</Text>
      </Box>
    </Box>
  );
}
