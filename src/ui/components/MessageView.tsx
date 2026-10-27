import React from 'react';
import { Box, Text } from 'ink';
import type { TranscriptItem } from '../../core/transcript.js';
import { renderMarkdown } from '../markdown.js';
import { isEditTool, patchFor, toolHeader, toolSummary } from '../tools.js';
import { DiffView } from './Diff.js';
import { theme } from '../theme.js';

interface Props {
  item: TranscriptItem;
  cwd: string;
  width: number;
  /** While streaming, only the tail of long text is drawn (the full text lands in scrollback when done). */
  maxLines?: number;
  verbose?: boolean;
  /** The tool call is waiting on a permission prompt. */
  awaitingApproval?: boolean;
}

function tail(text: string, maxLines?: number): string {
  if (!maxLines) return text;
  const lines = text.split('\n');
  return lines.length > maxLines ? lines.slice(-maxLines).join('\n') : text;
}

export function MessageView({ item, cwd, width, maxLines, verbose, awaitingApproval }: Props) {
  switch (item.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Box width={2} flexShrink={0}>
            <Text color="gray">{'>'}</Text>
          </Box>
          <Box width={width - 2}>
            <Text color="gray">{item.text}</Text>
          </Box>
        </Box>
      );
    case 'assistant':
      if (!item.text.trim()) return null;
      return (
        <Box marginTop={1} marginLeft={item.parentId ? 4 : 0}>
          <Box width={2} flexShrink={0}>
            <Text>●</Text>
          </Box>
          <Box flexDirection="column" width={width - 2 - (item.parentId ? 4 : 0)}>
            <Text>{renderMarkdown(tail(item.text, maxLines))}</Text>
          </Box>
        </Box>
      );
    case 'thinking': {
      const text = item.text.trim();
      return (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor italic>
            {item.streaming ? '✻ Thinking…' : '✻ Thought'}
          </Text>
          {text && (verbose || item.streaming) ? (
            <Box marginLeft={2} width={width - 2}>
              <Text dimColor italic>
                {tail(text, item.streaming ? 6 : maxLines)}
              </Text>
            </Box>
          ) : null}
        </Box>
      );
    }
    case 'system': {
      const color = item.tone === 'error' ? theme.error : item.tone === 'warn' ? theme.warning : item.tone === 'success' ? theme.success : undefined;
      return (
        <Box marginTop={1} width={width}>
          <Text color={color} dimColor={item.tone === 'info'}>
            {item.text}
          </Text>
        </Box>
      );
    }
    case 'tool':
      return <ToolView item={item} cwd={cwd} width={width} awaitingApproval={awaitingApproval} />;
  }
}

function ToolView({ item, cwd, width, awaitingApproval }: { item: Extract<TranscriptItem, { kind: 'tool' }>; cwd: string; width: number; awaitingApproval?: boolean }) {
  const { verb, arg } = toolHeader(item.name, item.input, cwd);
  const bulletColor = item.status === 'running' ? theme.dim : item.status === 'done' ? theme.success : theme.error;
  const summary = awaitingApproval && item.status === 'running' ? 'Waiting for your approval…' : toolSummary(item, cwd);
  const indent = item.parentId ? 4 : 0;
  const showDiff = item.status === 'done' && isEditTool(item.name);
  const hunks = showDiff ? patchFor(item, cwd) : [];
  const summaryColor = item.status === 'error' || item.status === 'denied' ? theme.error : undefined;
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={indent}>
      <Box>
        <Box width={2} flexShrink={0}>
          <Text color={bulletColor}>●</Text>
        </Box>
        <Box width={width - indent - 2}>
          <Text>
            <Text bold>{verb}</Text>
            {arg ? `(${arg})` : ''}
          </Text>
        </Box>
      </Box>
      {summary ? (
        <Box marginLeft={2}>
          <Box width={3} flexShrink={0}>
            <Text dimColor>⎿</Text>
          </Box>
          <Box flexDirection="column" width={width - indent - 5}>
            <Text color={summaryColor} dimColor={!summaryColor}>
              {summary}
            </Text>
          </Box>
        </Box>
      ) : null}
      {hunks.length ? (
        <Box marginLeft={5} flexDirection="column">
          <DiffView hunks={hunks} width={width - indent - 5} maxLines={item.parentId ? 12 : 40} />
        </Box>
      ) : null}
    </Box>
  );
}
