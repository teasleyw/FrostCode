import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frostHome, hasApiKey, MissingApiKeyError } from '../config/env.js';
import { resolveProjectPath, shortenPath } from '../core/projects.js';

export const GUI_HELP = `frostcode gui [dir] [--wait]

Opens the FrostCode desktop app. Without a directory it reopens the conversation you had open
last; with one it opens that project. --wait keeps the terminal attached and shows the app's logs.`;

/** `frostcode gui`: start the Electron app (dist/gui/main.js) on the same backend as the CLI. */
export async function launchGui(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(GUI_HELP);
    return 0;
  }
  if (!hasApiKey()) {
    console.error(new MissingApiKeyError().message);
    return 1;
  }
  const wait = argv.includes('--wait');
  const dirArg = argv.find((a) => !a.startsWith('-'));
  let cwd = '';
  if (dirArg) {
    try {
      cwd = resolveProjectPath(dirArg, process.cwd());
    } catch (e) {
      console.error((e as Error).message);
      return 2;
    }
  }

  const here = dirname(fileURLToPath(import.meta.url));
  let electron: string;
  try {
    electron = createRequire(import.meta.url)('electron') as string;
  } catch {
    console.error(`Electron is not installed. Run \`npm install\` in ${join(here, '..', '..')} to add the desktop app.`);
    return 1;
  }

  const env: NodeJS.ProcessEnv = { ...process.env, FROSTCODE_GUI_CWD: cwd, FROSTCODE_GUI_DEFAULT_CWD: process.cwd() };
  delete env.ELECTRON_RUN_AS_NODE; // would make Electron behave as plain Node
  const main = join(here, 'main.js');

  if (wait) {
    const child = spawn(electron, [main], { env, stdio: 'inherit' });
    return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
  }
  mkdirSync(frostHome(), { recursive: true });
  const logFile = join(frostHome(), 'gui.log');
  const log = openSync(logFile, 'a');
  const child = spawn(electron, [main], { env, stdio: ['ignore', log, log], detached: true });
  child.unref();
  console.log(`FrostCode desktop app opened${cwd ? ` in ${shortenPath(cwd)}` : ''}. Logs: ${shortenPath(logFile)}`);
  return 0;
}
