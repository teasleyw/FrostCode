import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { APP_VERSION } from './config/env.js';

export const HELP = `FrostCode v${APP_VERSION} — interactive coding assistant on the Claude Agent SDK (API-key billing)

Usage
  frostcode [options] [prompt]          start an interactive session (optionally with a first prompt)
  frostcode -p "prompt" [options]       run one prompt non-interactively and print the result
  frostcode codex [all|show <id>]       list unfinished OpenAI Codex sessions (read-only)
  frostcode gui [dir] [--wait]          open the desktop app (reopens your last conversation)

Options
  -m, --model <id>                      model to use (e.g. claude-sonnet-5-5, opus, haiku)
  -C, --cwd <dir>                       project directory (default: current directory)
  -c, --continue                        continue the most recent conversation in this project
  -r, --resume [id]                     resume a conversation (opens a picker without an id)
      --permission-mode <mode>          default | acceptEdits | plan | bypassPermissions
      --plan                            start in plan mode
      --dangerously-skip-permissions    allow bypass mode (approves every tool call)
  -p, --print                           non-interactive mode
  -y, --yes                             with -p: approve tool calls that would prompt
      --output-format <text|stream-json> with -p: raw SDK messages as JSON lines
  -v, --version                         print version
  -h, --help                            show this help

Requires ANTHROPIC_API_KEY. FrostCode keeps its own state in ~/.frostcode.`;

export interface Args {
  prompt: string;
  model?: string;
  cwd?: string;
  continueLast: boolean;
  resume?: string | true;
  permissionMode?: PermissionMode;
  allowBypass: boolean;
  print: boolean;
  yes: boolean;
  json: boolean;
  sub?: string[];
}

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'];

export function parseArgs(argv: string[]): Args {
  const a: Args = { prompt: '', continueLast: false, allowBypass: false, print: false, yes: false, json: false };
  const rest: string[] = [];
  if (argv[0] === 'codex' || argv[0] === 'gui') return { ...a, sub: argv };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
      case '-v':
      case '--version':
        console.log(APP_VERSION);
        process.exit(0);
      case '-m':
      case '--model':
        a.model = next();
        break;
      case '-C':
      case '--cwd':
        a.cwd = next();
        break;
      case '-c':
      case '--continue':
        a.continueLast = true;
        break;
      case '-r':
      case '--resume': {
        const v = argv[i + 1];
        if (v && !v.startsWith('-')) {
          a.resume = v;
          i++;
        } else a.resume = true;
        break;
      }
      case '--permission-mode': {
        const m = next() as PermissionMode;
        if (!MODES.includes(m)) throw new Error(`Unknown permission mode "${m}". Use: ${MODES.join(', ')}`);
        a.permissionMode = m;
        break;
      }
      case '--plan':
        a.permissionMode = 'plan';
        break;
      case '--dangerously-skip-permissions':
        a.allowBypass = true;
        a.permissionMode = a.permissionMode ?? 'bypassPermissions';
        break;
      case '-p':
      case '--print':
        a.print = true;
        break;
      case '-y':
      case '--yes':
        a.yes = true;
        break;
      case '--output-format':
        a.json = next() === 'stream-json';
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}. See frostcode --help`);
        rest.push(arg);
    }
  }
  a.prompt = rest.join(' ');
  return a;
}
