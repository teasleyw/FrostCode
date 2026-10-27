import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import type { AppController } from '../../app/controller.js';
import { shortenPath } from '../../core/projects.js';
import { MCP_STATE_LABELS, type McpEntryState, type McpEntryView } from '../../mcp/types.js';
import { SelectList, type SelectItem } from './SelectList.js';
import { theme } from '../theme.js';

const STATE_COLOR: Partial<Record<McpEntryState, string>> = {
  connected: theme.success,
  failed: theme.error,
  'needs-auth': theme.warning,
  'needs-approval': theme.warning,
  changed: theme.warning,
  pending: theme.warning,
  starting: theme.warning,
};

/** Poll the runtime while the screen is open, so "connecting" turns into "connected". */
function useMcpPolling(ctrl: AppController): void {
  useEffect(() => {
    const t = setInterval(() => void ctrl.mcp.refreshStatus().catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [ctrl]);
}

export function McpList({ ctrl }: { ctrl: AppController }) {
  useMcpPolling(ctrl);
  const entries = ctrl.mcp.entries();
  const items: SelectItem<string>[] = entries.map((e) => ({
    label: `${e.name}  ${MCP_STATE_LABELS[e.state]}${e.tools.length ? ` · ${e.tools.length} tools` : ''}`,
    value: e.id,
    hint: `${e.scopeLabel}${e.offInSource ? ' · off in the desktop app' : ''}${e.detail ? ` · ${e.detail}` : ''}`,
    keywords: `${e.scope} ${e.summary}`,
    color: STATE_COLOR[e.state],
  }));
  return (
    <SelectList
      title="MCP servers"
      subtitle={`Read from ~/.claude.json, .mcp.json and the Claude desktop app for ${shortenPath(ctrl.cwd)}. Those files are never modified.`}
      items={items}
      onSelect={(i) => ctrl.openMcp(i.value)}
      onCancel={() => ctrl.closeOverlay()}
      emptyText="No MCP servers configured"
      footer="enter to manage · esc to close"
    />
  );
}

function actionsFor(e: McpEntryView): { label: string; value: string }[] {
  const a: { label: string; value: string }[] = [];
  switch (e.state) {
    case 'needs-approval':
    case 'changed':
      a.push({ label: 'Approve and connect', value: 'approve' }, { label: 'Reject (never connect)', value: 'reject' });
      break;
    case 'rejected':
      a.push({ label: 'Approve and connect', value: 'approve' });
      break;
    case 'disabled':
      a.push({ label: 'Enable', value: 'enable' });
      break;
    case 'connected':
    case 'pending':
    case 'failed':
    case 'needs-auth':
    case 'starting':
      a.push({ label: 'Reconnect', value: 'reconnect' }, { label: 'Disable', value: 'disable' });
      break;
  }
  if (e.tools.length) a.push({ label: `Inspect tools (${e.tools.length})`, value: 'tools' });
  a.push({ label: 'Back', value: 'back' });
  return a;
}

export function McpServerPage({ ctrl, id }: { ctrl: AppController; id: string }) {
  useMcpPolling(ctrl);
  const e = ctrl.mcp.entries().find((x) => x.id === id);
  if (!e) return <McpList ctrl={ctrl} />;
  const color = STATE_COLOR[e.state];
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
        <Text bold>
          {e.name} <Text color={color}>{MCP_STATE_LABELS[e.state]}</Text>
          {e.serverInfo ? <Text dimColor>{`  ${e.serverInfo.name} ${e.serverInfo.version}`}</Text> : null}
        </Text>
        <Text dimColor>{`${e.scopeLabel} · ${shortenPath(e.source)}`}</Text>
        <Text>{`${e.transport ?? '?'}: ${e.summary}`}</Text>
        {e.envKeys.length ? <Text dimColor>{`env: ${e.envKeys.join(', ')} (values hidden)`}</Text> : null}
        {e.headerKeys.length ? <Text dimColor>{`headers: ${e.headerKeys.join(', ')} (values hidden)`}</Text> : null}
        {e.detail ? <Text color={e.state === 'failed' ? theme.error : theme.warning}>{e.detail}</Text> : null}
        {e.offInSource ? <Text color={theme.warning}>Turned off in the Claude desktop app; FrostCode can still use it if you approve it here.</Text> : null}
        {e.state === 'needs-approval' || e.state === 'changed' ? (
          <Text color={theme.warning}>Approving runs the command above on this machine with these environment variables.</Text>
        ) : null}
      </Box>
      <SelectList
        title="Actions"
        items={actionsFor(e)}
        filterable={false}
        onSelect={(i) => {
          if (i.value === 'back') return ctrl.openMcp();
          if (i.value === 'tools') {
            ctrl.overlay = { type: 'mcp-tools', id: e.id };
            return ctrl.emit();
          }
          void ctrl.mcpAct(e.id, i.value as 'approve' | 'reject' | 'enable' | 'disable' | 'reconnect');
        }}
        onCancel={() => ctrl.openMcp()}
        footer="↑/↓ to choose · esc for the list"
      />
    </Box>
  );
}

export function McpToolsPage({ ctrl, id }: { ctrl: AppController; id: string }) {
  const e = ctrl.mcp.entries().find((x) => x.id === id);
  if (!e) return <McpList ctrl={ctrl} />;
  const items: SelectItem<string>[] = e.tools.map((t) => ({
    label: `${t.name}${t.sensitive ? (t.trusted ? '  · trusted' : '  · asks first') : ''}`,
    value: t.name,
    hint: `${t.readOnly ? 'read-only' : t.destructive ? 'destructive' : 'can change things'} · ${t.description.replace(/\s+/g, ' ').slice(0, 110)}`,
    color: t.sensitive && !t.trusted ? theme.warning : undefined,
  }));
  return (
    <SelectList
      title={`${e.name} tools`}
      subtitle="Tools that are not read-only ask before each call. Enter toggles trust for a tool (no approval before each call)."
      items={items}
      onSelect={(i) => {
        const t = e.tools.find((x) => x.name === i.value);
        if (t?.sensitive || t?.trusted) ctrl.setMcpToolTrusted(e.name, i.value, !t.trusted);
      }}
      onCancel={() => ctrl.openMcp(e.id)}
      maxVisible={14}
      footer="type to filter · enter to toggle trust · esc to go back"
    />
  );
}
