import React from 'react';
import { render } from 'ink';
import { hasApiKey, MissingApiKeyError, prepareProcessEnv, redact } from './config/env.js';
import { resolveProjectPath, shortenPath } from './core/projects.js';
import { AppController } from './app/controller.js';
import { App } from './ui/App.js';
import { History } from './ui/editor.js';
import { loadHistory, saveHistory } from './app/history-file.js';
import { runPrint } from './app/print.js';
import { findCodexSession, listCodexSessions } from './codex/sessions.js';
import { parseArgs, type Args } from './cli-args.js';
import { launchGui } from './gui/launch.js';

async function runCodexCommand(argv: string[]): Promise<number> {
  const [, sub, ref] = argv;
  if (sub === 'show' && ref) {
    const d = await findCodexSession(ref);
    if (!d) {
      console.error(`No Codex session matching "${ref}"`);
      return 1;
    }
    console.log(`${d.id}  ${d.status}  ${d.model ?? '?'}  ${d.cwd ?? '?'}`);
    console.log(`log: ${d.file} (read-only)\n`);
    for (const e of d.timeline.slice(-30)) console.log(`[${e.role}] ${e.text.replace(/\s+/g, ' ').slice(0, 200)}`);
    return 0;
  }
  const all = sub === 'all';
  const sessions = await listCodexSessions({ unfinishedOnly: !all, limit: 40 });
  if (!sessions.length) {
    console.log(all ? 'No Codex sessions found.' : 'No unfinished Codex sessions. Use `frostcode codex all` to list recent ones.');
    return 0;
  }
  for (const s of sessions) {
    const req = (s.firstUserMessage ?? '').replace(/\s+/g, ' ').slice(0, 70);
    console.log(`${s.id.slice(0, 13)}  ${s.status.padEnd(11)}  ${new Date(s.updatedAt).toLocaleString().padEnd(22)}  ${(s.cwd ? shortenPath(s.cwd) : '?').padEnd(40)}  ${req}`);
  }
  return 0;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (args.sub?.[0] === 'gui') return launchGui(args.sub.slice(1));
  if (args.sub) return runCodexCommand(args.sub);

  if (!hasApiKey()) {
    console.error(new MissingApiKeyError().message);
    return 1;
  }
  prepareProcessEnv();

  let cwd: string;
  try {
    cwd = resolveProjectPath(args.cwd ?? '.', process.cwd());
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const permissionMode = args.permissionMode ?? 'default';

  if (args.print) {
    let prompt = args.prompt;
    if (!prompt && !process.stdin.isTTY) prompt = await readStdin();
    if (!prompt.trim()) {
      console.error('Provide a prompt: frostcode -p "your prompt"');
      return 2;
    }
    return runPrint({
      prompt,
      cwd,
      model: args.model,
      permissionMode,
      allowTools: args.yes,
      resume: typeof args.resume === 'string' ? args.resume : undefined,
      json: args.json,
    });
  }

  if (!process.stdin.isTTY) {
    console.error('FrostCode needs an interactive terminal. For scripts, use: frostcode -p "prompt"');
    return 2;
  }

  const history = new History(loadHistory());
  let instance: ReturnType<typeof render> | null = null;
  const ctrl = new AppController({
    cwd,
    model: args.model,
    permissionMode,
    resume: typeof args.resume === 'string' ? args.resume : undefined,
    continueLast: args.continueLast,
    allowBypass: args.allowBypass,
    onExit: () => {
      void ctrl.shutdown().then(() => instance?.unmount());
    },
  });
  ctrl.onClearScreen = () => process.stdout.write('\u001b[2J\u001b[3J\u001b[H');

  instance = render(<App ctrl={ctrl} history={history} />, { exitOnCtrlC: false });
  try {
    await ctrl.boot();
    if (args.resume === true) await ctrl.openResumePicker();
    if (args.prompt) await ctrl.submit(args.prompt);
  } catch (e) {
    ctrl.transcript.addSystem(redact((e as Error).message), 'error');
  }
  await instance.waitUntilExit();
  saveHistory(history.all());
  await ctrl.shutdown();
  const c = ctrl.cost.snapshot();
  if (c.runUsd > 0) process.stdout.write(`\nTotal cost this run: $${c.runUsd.toFixed(4)}${ctrl.sessionId ? ` · resume with: frostcode --resume ${ctrl.sessionId}` : ''}\n`);
  return 0;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => resolve(data));
  });
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(redact(String(e?.stack ?? e)));
    process.exit(1);
  },
);
