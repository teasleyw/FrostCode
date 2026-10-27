import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import type { AppController } from '../app/controller.js';
import { isFinal, type TranscriptItem } from '../core/transcript.js';
import { completeCommand, COMMANDS, findCommand } from '../commands/registry.js';
import { formatTokens, formatUsd } from '../core/cost.js';
import { shortenPath } from '../core/projects.js';
import { History } from './editor.js';
import { MessageView } from './components/MessageView.js';
import { PromptInput, type Suggestion } from './components/PromptInput.js';
import { PermissionPrompt } from './components/PermissionPrompt.js';
import { SelectList, type SelectItem } from './components/SelectList.js';
import { McpList, McpServerPage, McpToolsPage } from './components/McpScreen.js';
import { SPINNER_FRAMES, SPINNER_WORDS, theme } from './theme.js';
import { APP_VERSION, frostHome } from '../config/env.js';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexSessionSummary } from '../codex/sessions.js';

type StaticEntry = { kind: 'welcome'; id: string } | TranscriptItem;

function useController(ctrl: AppController): number {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => ctrl.subscribe(bump), [ctrl]);
  return version;
}

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

export function App({ ctrl, history }: { ctrl: AppController; history: History }) {
  useController(ctrl);
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const width = Math.max(40, columns - 2);
  const [exitArmed, setExitArmed] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const exitTimer = useRef<NodeJS.Timeout | null>(null);
  const [inputEmpty, setInputEmpty] = useState(true);

  // Items whose content can no longer change go to <Static> (terminal scrollback);
  // the rest re-render live below them.
  const items = ctrl.transcript.items;
  let firstLive = items.findIndex((i) => !isFinal(i));
  if (firstLive === -1) firstLive = items.length;
  const committedRef = useRef<{ epoch: number; entries: StaticEntry[] }>({ epoch: -1, entries: [] });
  if (committedRef.current.epoch !== ctrl.epoch) {
    committedRef.current = { epoch: ctrl.epoch, entries: [{ kind: 'welcome', id: `welcome-${ctrl.epoch}` }] };
  }
  // <Static> memoizes on the array identity, so growth must produce a new array.
  if (committedRef.current.entries.length - 1 < firstLive) {
    const prev = committedRef.current.entries;
    committedRef.current = { epoch: ctrl.epoch, entries: [...prev, ...items.slice(prev.length - 1, firstLive)] };
  }
  const committed = committedRef.current.entries;
  const live = items.slice(committed.length - 1);

  const prompt = ctrl.pending[0];
  const overlay = ctrl.overlay;
  const inputActive = !prompt && !overlay;

  useInput((input, key) => {
    if (process.env.FROSTCODE_DEBUG_KEYS) debugKey(input, key);
    if (key.ctrl && input === 'c') {
      if (!inputEmpty && inputActive) return; // the prompt clears itself below
      if (ctrl.busy || ctrl.pending.length) {
        void ctrl.interrupt();
        return;
      }
      if (exitArmed) {
        void ctrl.shutdown().then(() => exit());
        return;
      }
      setExitArmed(true);
      if (exitTimer.current) clearTimeout(exitTimer.current);
      exitTimer.current = setTimeout(() => setExitArmed(false), 1500);
      return;
    }
    if (key.ctrl && input === 'd' && inputEmpty && inputActive) {
      void ctrl.shutdown().then(() => exit());
      return;
    }
    if (key.escape && inputActive && ctrl.busy) {
      void ctrl.interrupt();
      return;
    }
    if (key.tab && key.shift && !overlay) {
      void ctrl.cycleMode();
      return;
    }
    if (input === '?' && inputEmpty && inputActive) {
      setShowShortcuts((s) => !s);
    }
  });

  const suggest = useMemo(
    () =>
      (value: string): Suggestion[] => {
        const extra = ctrl.session?.info.slashCommands ?? [];
        return completeCommand(value, COMMANDS, extra).map((name) => ({
          name,
          description: findCommand(name)?.description ?? 'agent command',
        }));
      },
    [ctrl],
  );

  const modeColor =
    ctrl.mode === 'plan' ? theme.plan : ctrl.mode === 'acceptEdits' ? theme.acceptEdits : ctrl.mode === 'bypassPermissions' ? theme.bypass : undefined;

  return (
    <Box flexDirection="column">
      <Static key={`static-${ctrl.epoch}`} items={committed}>
        {(entry) =>
          entry.kind === 'welcome' ? (
            <Welcome key={entry.id} cwd={ctrl.cwd} />
          ) : (
            <Box key={entry.id} paddingX={1}>
              <MessageView item={entry} cwd={ctrl.cwd} width={width} />
            </Box>
          )
        }
      </Static>

      <Box flexDirection="column" paddingX={1}>
        {live.map((item) => (
          <MessageView
            key={item.id}
            item={item}
            cwd={ctrl.cwd}
            width={width}
            maxLines={Math.max(8, rows - 14)}
            awaitingApproval={ctrl.pending.some((p) => p.request.toolUseId === item.id)}
          />
        ))}
      </Box>

      <Box flexDirection="column" paddingX={1} marginTop={1}>
        {ctrl.busy && !prompt ? <Spinner since={ctrl.busySince} /> : null}
        {prompt ? (
          <PermissionPrompt request={prompt.request} cwd={ctrl.cwd} width={width} onAnswer={(a) => ctrl.answer(a)} />
        ) : overlay ? (
          <OverlayView ctrl={ctrl} />
        ) : null}
        <PromptInput
          active={inputActive}
          history={history}
          placeholder={ctrl.busy ? 'Queue a follow-up… (esc to interrupt)' : 'Try "explain this project" or /help'}
          suggest={suggest}
          onSubmit={(v) => {
            setShowShortcuts(false);
            void ctrl.submit(v);
          }}
          onChange={(v) => setInputEmpty(v.length === 0)}
          borderColor={modeColor}
          width={width}
        />
        <StatusBar ctrl={ctrl} exitArmed={exitArmed} />
        {showShortcuts ? <Shortcuts /> : null}
      </Box>
    </Box>
  );
}

/** FROSTCODE_DEBUG_KEYS=1: record key events (never the text typed) to ~/.frostcode/keys.log. */
function debugKey(input: string, key: Record<string, unknown>) {
  const flags = Object.entries(key)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  const shape = input.length > 1 ? `${input.length} chars, ends ${JSON.stringify(input.slice(-1))}` : JSON.stringify(input.replace(/[a-z0-9]/gi, 'x'));
  try {
    appendFileSync(join(frostHome(), 'keys.log'), `${new Date().toISOString()} ${shape} [${flags.join(',')}]\n`);
  } catch {
    /* debug only */
  }
}

function Welcome({ cwd }: { cwd: string }) {
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={0}>
      <Box borderStyle="round" borderColor={theme.accent} paddingX={1} flexDirection="column" width={Math.min(70, (process.stdout.columns || 80) - 2)}>
        <Text>
          <Text color={theme.accent}>✻</Text> Welcome to <Text bold>FrostCode</Text>
          <Text dimColor>{`  v${APP_VERSION}`}</Text>
        </Text>
        <Text> </Text>
        <Text dimColor>  /help for help, /status for your current setup</Text>
        <Text dimColor>  billed to your Anthropic API key</Text>
        <Text> </Text>
        <Text dimColor>{`  cwd: ${shortenPath(cwd)}`}</Text>
      </Box>
    </Box>
  );
}

function Spinner({ since }: { since: number | null }) {
  const [tick, setTick] = useState(0);
  const word = useMemo(() => SPINNER_WORDS[Math.floor(Math.random() * SPINNER_WORDS.length)], [since]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 120);
    return () => clearInterval(t);
  }, []);
  const secs = since ? Math.floor((Date.now() - since) / 1000) : 0;
  return (
    <Box marginBottom={1}>
      <Text color={theme.accent}>{SPINNER_FRAMES[tick % SPINNER_FRAMES.length]} </Text>
      <Text color={theme.accent}>{word}…</Text>
      <Text dimColor>{` (${secs}s · esc to interrupt)`}</Text>
    </Box>
  );
}

function StatusBar({ ctrl, exitArmed }: { ctrl: AppController; exitArmed: boolean }) {
  const c = ctrl.cost.snapshot();
  const pct = c.contextWindow ? Math.round((c.contextTokens / c.contextWindow) * 100) : null;
  const left = exitArmed ? (
    <Text color={theme.warning}>Press Ctrl-C again to exit</Text>
  ) : ctrl.mode === 'plan' ? (
    <Text color={theme.plan}>⏸ plan mode on <Text dimColor>(shift+tab to cycle)</Text></Text>
  ) : ctrl.mode === 'acceptEdits' ? (
    <Text color={theme.acceptEdits}>⏵⏵ accept edits on <Text dimColor>(shift+tab to cycle)</Text></Text>
  ) : ctrl.mode === 'bypassPermissions' ? (
    <Text color={theme.bypass}>⏵⏵ bypass permissions on <Text dimColor>(shift+tab to cycle)</Text></Text>
  ) : (
    <Text dimColor>? for shortcuts</Text>
  );
  const parts = [
    ctrl.modelLabel,
    pct !== null ? `ctx ${pct}%` : null,
    c.tokens.input + c.tokens.output + c.tokens.cacheRead > 0
      ? `${formatTokens(c.tokens.input + c.tokens.cacheRead + c.tokens.cacheWrite)}↑ ${formatTokens(c.tokens.output)}↓`
      : null,
    formatUsd(c.sessionUsd),
  ].filter(Boolean);
  return (
    <Box paddingX={2} justifyContent="space-between">
      {left}
      <Text dimColor>{parts.join(' · ')}</Text>
    </Box>
  );
}

function Shortcuts() {
  const rows = [
    ['/ for commands', 'shift+tab to cycle modes'],
    ['\\⏎ for newline', 'esc to interrupt'],
    ['↑↓ for history', 'ctrl+c twice to exit'],
  ];
  return (
    <Box flexDirection="column" paddingX={2}>
      {rows.map(([a, b]) => (
        <Box key={a}>
          <Text dimColor>{a.padEnd(28)}</Text>
          <Text dimColor>{b}</Text>
        </Box>
      ))}
    </Box>
  );
}

const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const statusLabel: Record<CodexSessionSummary['status'], { text: string; color?: string }> = {
  in_progress: { text: 'in progress', color: theme.warning },
  interrupted: { text: 'interrupted', color: theme.error },
  completed: { text: 'completed', color: theme.success },
  unknown: { text: 'unknown' },
};

function OverlayView({ ctrl }: { ctrl: AppController }) {
  const o = ctrl.overlay!;
  const cancel = () => ctrl.closeOverlay();
  switch (o.type) {
    case 'model': {
      const current = ctrl.model;
      const items: SelectItem<string | undefined>[] = o.models.map((m) => ({
        label: m.displayName + (m.value === current || (!current && m.value === 'default') ? '  ✓' : ''),
        value: m.value === 'default' ? undefined : m.value,
        hint: `${m.resolvedModel && m.resolvedModel !== m.value ? m.resolvedModel + ' · ' : m.value !== 'default' ? m.value + ' · ' : ''}${m.description}`,
        keywords: m.value,
      }));
      return (
        <SelectList
          title="Select model"
          subtitle="Switches for the rest of this conversation. Type a full model id to use one not listed."
          items={items}
          onSelect={(i) => void ctrl.setModel(i.value)}
          onSubmitText={(t) => void ctrl.setModel(t)}
          onCancel={cancel}
          placeholder="filter, or type a model id"
        />
      );
    }
    case 'resume':
      return (
        <SelectList
          title="Resume a conversation"
          subtitle={shortenPath(ctrl.cwd)}
          items={o.sessions.map((s) => ({
            label: s.title.length > 70 ? s.title.slice(0, 69) + '…' : s.title,
            value: s.id,
            hint: `${ago(s.lastModified)} · ${s.id.slice(0, 8)}${o.costs[s.id] ? ' · ' + formatUsd(o.costs[s.id]) : ''}${s.gitBranch && s.gitBranch !== 'HEAD' ? ' · ' + s.gitBranch : ''}`,
            keywords: s.id,
          }))}
          onSelect={(i) => void ctrl.resume(i.value)}
          onCancel={cancel}
        />
      );
    case 'project':
      return (
        <SelectList
          title="Switch project"
          subtitle="Recent projects. Type a path and press enter to open another directory."
          items={o.projects.map((p) => ({ label: p.name, value: p.path, hint: shortenPath(p.path) + (p.path === ctrl.cwd ? '  (current)' : '') }))}
          onSelect={(i) => void ctrl.switchProject(i.value).catch((e) => ctrl.commandContext.print((e as Error).message, 'error'))}
          onSubmitText={(t) => void ctrl.switchProject(t).catch((e) => ctrl.commandContext.print((e as Error).message, 'error'))}
          onCancel={cancel}
          placeholder="filter, or type a path"
          emptyText="No recent projects"
        />
      );
    case 'codex':
      return (
        <SelectList
          title={o.unfinishedOnly ? 'Unfinished Codex sessions' : 'Recent Codex sessions'}
          subtitle="From ~/.codex/sessions — read-only. Enter for options."
          items={o.sessions.map((s) => {
            const st = statusLabel[s.status];
            const req = (s.firstUserMessage ?? '(no request recorded)').replace(/\s+/g, ' ');
            return {
              label: req.length > 60 ? req.slice(0, 59) + '…' : req,
              value: s,
              hint: `${st.text} · ${ago(s.updatedAt)} · ${s.cwd ? shortenPath(s.cwd) : '?'}`,
              keywords: s.id,
              color: st.color,
            };
          })}
          onSelect={(i) => ctrl.openCodexActions(i.value)}
          onCancel={cancel}
          emptyText="No Codex sessions found"
        />
      );
    case 'mcp':
      return <McpList ctrl={ctrl} />;
    case 'mcp-server':
      return <McpServerPage ctrl={ctrl} id={o.id} />;
    case 'mcp-tools':
      return <McpToolsPage ctrl={ctrl} id={o.id} />;
    case 'codex-actions': {
      const s = o.session;
      const differentProject = s.cwd && s.cwd !== ctrl.cwd;
      const items: SelectItem<string>[] = [
        { label: 'Show details', value: 'show' },
        { label: 'Continue it here (send a handoff to Claude in this project)', value: 'import' },
      ];
      if (differentProject) items.push({ label: `Switch to ${shortenPath(s.cwd!)} and continue it there`, value: 'import-switch' });
      items.push({ label: 'Back', value: 'back' });
      return (
        <SelectList
          title={(s.firstUserMessage ?? s.id).replace(/\s+/g, ' ').slice(0, 70)}
          subtitle={`${statusLabel[s.status].text} · ${s.model ?? '?'} · ${s.turns} turns · log is never modified`}
          items={items}
          filterable={false}
          onSelect={(i) => {
            if (i.value === 'show') void ctrl.codexShow(s.file);
            else if (i.value === 'import') void ctrl.codexImport(s.file);
            else if (i.value === 'import-switch') void ctrl.codexImport(s.file, true);
            else void ctrl.openCodexBrowser(true);
          }}
          onCancel={cancel}
          footer="↑/↓ or number to choose · esc to close"
        />
      );
    }
  }
}
