import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { frostHome } from '../config/env.js';

export interface Project {
  path: string;
  name: string;
  lastOpened: number;
}

function storeFile(): string {
  return join(frostHome(), 'projects.json');
}

export function loadProjects(): Project[] {
  try {
    const data = JSON.parse(readFileSync(storeFile(), 'utf8')) as Project[];
    return data.filter((p) => p && typeof p.path === 'string').sort((a, b) => b.lastOpened - a.lastOpened);
  } catch {
    return [];
  }
}

export function rememberProject(path: string): Project[] {
  const list = loadProjects().filter((p) => p.path !== path);
  list.unshift({ path, name: basename(path) || path, lastOpened: Date.now() });
  const trimmed = list.slice(0, 30);
  try {
    mkdirSync(dirname(storeFile()), { recursive: true });
    const tmp = `${storeFile()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
    renameSync(tmp, storeFile());
  } catch {
    /* best effort */
  }
  return trimmed;
}

/** Resolve a user-typed directory (~, relative to the current project) to an existing absolute path. */
export function resolveProjectPath(input: string, from: string): string {
  let p = input.trim().replace(/^['"]|['"]$/g, '');
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = join(homedir(), p.slice(1));
  const abs = isAbsolute(p) ? p : resolve(from, p);
  if (!existsSync(abs)) throw new Error(`No such directory: ${abs}`);
  if (!statSync(abs).isDirectory()) throw new Error(`Not a directory: ${abs}`);
  // The agent runtime reports real paths (/tmp -> /private/tmp); match it so paths display relative.
  // Native, as the runtime's is: on Windows it also expands 8.3 short names (JOHNSM~1).
  return realpathSync.native(abs);
}

export function shortenPath(p: string): string {
  const home = homedir();
  return p === home ? '~' : p.startsWith(home + sep) ? '~' + p.slice(home.length) : p;
}
