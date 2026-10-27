import React from 'react';
import { Box, Text } from 'ink';
import { diffLines, type Hunk } from '../tools.js';
import { theme } from '../theme.js';

/** Claude Code-style diff: line numbers, red removals, green additions. */
export function DiffView({ hunks, maxLines = 40, width }: { hunks: Hunk[]; maxLines?: number; width?: number }) {
  const { lines, truncated } = diffLines(hunks, maxLines);
  if (!lines.length) return null;
  const numWidth = Math.max(3, ...lines.map((l) => String(l.newNo ?? l.oldNo ?? '').length));
  const textWidth = width ? Math.max(10, width - numWidth - 4) : undefined;
  const fit = (s: string) => {
    const t = s.replace(/\t/g, '  ');
    return textWidth && t.length > textWidth ? t.slice(0, textWidth - 1) + '…' : t;
  };
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => {
        if (l.type === 'gap') return <Text key={i} dimColor>{' '.repeat(numWidth)}  ...</Text>;
        const no = String(l.type === 'remove' ? l.oldNo : l.newNo).padStart(numWidth);
        if (l.type === 'add')
          return (
            <Text key={i} backgroundColor={theme.diffAddBg} color={theme.diffAddFg}>
              {`${no} + ${fit(l.text)}`}
            </Text>
          );
        if (l.type === 'remove')
          return (
            <Text key={i} backgroundColor={theme.diffRemoveBg} color={theme.diffRemoveFg}>
              {`${no} - ${fit(l.text)}`}
            </Text>
          );
        return <Text key={i} dimColor>{`${no}   ${fit(l.text)}`}</Text>;
      })}
      {truncated > 0 ? <Text dimColor>{`… ${truncated} more diff lines`}</Text> : null}
    </Box>
  );
}
