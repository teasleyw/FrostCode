import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export interface CommandContext {
  print(text: string, tone?: 'info' | 'warn' | 'error' | 'success'): void;
  clear(): Promise<void>;
  exit(): void;
  setModel(model: string | undefined): Promise<void>;
  openModelPicker(): void;
  setMode(mode: PermissionMode): Promise<void>;
  currentMode(): PermissionMode;
  openResumePicker(): void;
  resume(sessionId: string): Promise<void>;
  openProjectPicker(): void;
  switchProject(path: string): Promise<void>;
  openCodexBrowser(unfinishedOnly: boolean): void;
  codexShow(ref: string): Promise<void>;
  codexImport(ref: string): Promise<void>;
  showCost(): void;
  showContext(): Promise<void>;
  showStatus(): void;
  showPermissions(): void;
  clearPermissions(): void;
  rename(title: string): Promise<void>;
  /** Send text to the agent as-is (used for the runtime's own commands like /compact). */
  passthrough(text: string): void;
  commands(): CommandSpec[];
}

export interface CommandSpec {
  name: string;
  aliases?: string[];
  description: string;
  args?: string;
  run(ctx: CommandContext, args: string): void | Promise<void>;
}

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export const MODE_LABELS: Record<string, string> = {
  default: 'default (ask before edits and commands)',
  acceptEdits: 'accept edits (auto-approve file edits)',
  plan: 'plan mode (read-only research, then propose a plan)',
  bypassPermissions: 'bypass permissions (approve everything)',
  dontAsk: "don't ask (deny anything not pre-approved)",
  auto: 'auto (classifier decides)',
};

export const COMMANDS: CommandSpec[] = [
  {
    name: 'help',
    aliases: ['?'],
    description: 'Show commands and keyboard shortcuts',
    run(ctx) {
      const lines = ctx.commands().map((c) => {
        const name = `/${c.name}${c.args ? ' ' + c.args : ''}`;
        const alias = c.aliases?.length ? ` (${c.aliases.map((a) => '/' + a).join(', ')})` : '';
        return `  ${name.padEnd(30)} ${c.description}${alias}`;
      });
      ctx.print(
        [
          'Commands',
          ...lines,
          '',
          'Shortcuts',
          '  enter              send          \\ + enter        newline',
          '  esc                interrupt Claude / close dialogs',
          '  shift+tab          cycle permission mode (default → accept edits → plan)',
          '  ↑ / ↓              prompt history   tab            complete a command',
          '  ctrl+c             clear input / interrupt; twice on an empty prompt to exit',
          '  ctrl+a/e/u/k/w     line editing     alt+←/→        move by word',
        ].join('\n'),
      );
    },
  },
  {
    name: 'clear',
    aliases: ['new', 'reset'],
    description: 'Start a fresh conversation (the old one stays resumable)',
    run: (ctx) => ctx.clear(),
  },
  {
    name: 'model',
    args: '[model]',
    description: 'Switch model (opens a picker without an argument)',
    async run(ctx, args) {
      if (!args) return ctx.openModelPicker();
      await ctx.setModel(args === 'default' ? undefined : args);
    },
  },
  {
    name: 'plan',
    description: 'Toggle plan mode (research and propose before editing)',
    async run(ctx) {
      await ctx.setMode(ctx.currentMode() === 'plan' ? 'default' : 'plan');
    },
  },
  {
    name: 'mode',
    args: '[default|acceptEdits|plan|bypassPermissions]',
    description: 'Show or set the permission mode',
    async run(ctx, args) {
      if (!args) {
        ctx.print(`Permission mode: ${MODE_LABELS[ctx.currentMode()] ?? ctx.currentMode()}\nAvailable: ${MODES.join(', ')}`);
        return;
      }
      const mode = MODES.find((m) => m.toLowerCase() === args.toLowerCase());
      if (!mode) return ctx.print(`Unknown mode "${args}". Use one of: ${MODES.join(', ')}`, 'error');
      await ctx.setMode(mode);
    },
  },
  {
    name: 'permissions',
    aliases: ['allowed-tools'],
    args: '[clear]',
    description: 'List (or clear) the tools you allowed for this session',
    run(ctx, args) {
      if (args === 'clear') ctx.clearPermissions();
      else ctx.showPermissions();
    },
  },
  {
    name: 'resume',
    aliases: ['sessions', 'continue'],
    args: '[session-id]',
    description: 'Resume a saved conversation for this project',
    async run(ctx, args) {
      if (args) await ctx.resume(args);
      else ctx.openResumePicker();
    },
  },
  {
    name: 'project',
    aliases: ['cd', 'projects'],
    args: '[path]',
    description: 'Switch project directory (picker of recent projects without an argument)',
    async run(ctx, args) {
      if (args) await ctx.switchProject(args);
      else ctx.openProjectPicker();
    },
  },
  {
    name: 'codex',
    args: '[all | show <id> | import <id>]',
    description: 'Browse unfinished OpenAI Codex sessions (read-only) and hand one to Claude',
    async run(ctx, args) {
      const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
      const ref = rest.join(' ');
      if (!sub) return ctx.openCodexBrowser(true);
      if (sub === 'all') return ctx.openCodexBrowser(false);
      if (sub === 'show' && ref) return ctx.codexShow(ref);
      if (sub === 'import' && ref) return ctx.codexImport(ref);
      ctx.print('Usage: /codex [all | show <id> | import <id>]', 'error');
    },
  },
  {
    name: 'compact',
    args: '[instructions]',
    description: 'Summarize the conversation to free context',
    run(ctx, args) {
      ctx.passthrough(`/compact${args ? ' ' + args : ''}`);
    },
  },
  { name: 'context', description: 'Show context window usage', run: (ctx) => ctx.showContext() },
  { name: 'cost', aliases: ['usage'], description: 'Show token usage and estimated cost for this session', run: (ctx) => ctx.showCost() },
  { name: 'status', description: 'Show model, auth source, project and session', run: (ctx) => ctx.showStatus() },
  {
    name: 'rename',
    args: '<title>',
    description: 'Name the current session',
    async run(ctx, args) {
      if (!args) return ctx.print('Usage: /rename <title>', 'error');
      await ctx.rename(args);
    },
  },
  { name: 'exit', aliases: ['quit', 'q'], description: 'Quit FrostCode', run: (ctx) => ctx.exit() },
];

export interface ParsedCommand {
  name: string;
  args: string;
}

export function parseSlash(input: string): ParsedCommand | null {
  const m = /^\/([\w:.\-?]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() };
}

export function findCommand(name: string, list: CommandSpec[] = COMMANDS): CommandSpec | undefined {
  return list.find((c) => c.name === name || c.aliases?.includes(name));
}

/** Commands whose name starts with what the user has typed after "/". */
export function completeCommand(partial: string, list: CommandSpec[] = COMMANDS, extra: string[] = []): string[] {
  const p = partial.replace(/^\//, '').toLowerCase();
  const names = [...list.map((c) => c.name), ...extra.filter((e) => !findCommand(e, list))];
  return names.filter((n) => n.startsWith(p)).sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** shift+tab order, matching Claude Code. Bypass joins the cycle only when enabled at launch. */
export function nextMode(mode: PermissionMode, allowBypass: boolean): PermissionMode {
  const cycle: PermissionMode[] = allowBypass ? ['default', 'acceptEdits', 'plan', 'bypassPermissions'] : ['default', 'acceptEdits', 'plan'];
  const i = cycle.indexOf(mode);
  return cycle[(i + 1) % cycle.length];
}
