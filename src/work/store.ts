import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { frostHome } from '../config/env.js';
import type { Brief } from './types.js';

/**
 * Encrypts saved sign-ins. The desktop app passes Electron's safeStorage (DPAPI on Windows, the
 * Keychain on macOS); where that is unavailable the secret is kept in a 0600 file like saved API keys.
 */
export interface SecretBox {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface WorkConfig {
  /** GitHub organization (default: your only one, from gh). */
  org?: string;
  /** Repos and Jira projects containing this word are listed first. */
  focus?: string;
  jira?: { site: string; email: string };
  microsoft?: { account: string };
  /** Model that writes the daily list. */
  model?: string;
}

export const DEFAULT_FOCUS = 'popdock';
export const DEFAULT_BRIEF_MODEL = 'claude-sonnet-5-5';

export function workDir(): string {
  return join(frostHome(), 'work');
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown, mode?: number): void {
  mkdirSync(workDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', mode ? { mode } : undefined);
  renameSync(tmp, file);
  if (mode) chmodSync(file, mode);
}

const configFile = () => join(workDir(), 'config.json');
const secretsFile = () => join(workDir(), 'secrets.json');
const briefFile = (date: string) => join(workDir(), `brief-${date}.json`);

export function loadConfig(): WorkConfig {
  return readJson<WorkConfig>(configFile(), {});
}

export function saveConfig(update: Partial<WorkConfig>): WorkConfig {
  const next = { ...loadConfig(), ...update };
  for (const k of Object.keys(next) as (keyof WorkConfig)[]) if (next[k] === undefined) delete next[k];
  writeJson(configFile(), next);
  return next;
}

type SecretRecord = { enc: 'safeStorage' | 'plain'; data: string };

export function saveSecret(name: string, value: string, box: SecretBox): void {
  const all = readJson<Record<string, SecretRecord>>(secretsFile(), {});
  all[name] = box.available() ? { enc: 'safeStorage', data: box.encrypt(value).toString('base64') } : { enc: 'plain', data: value };
  writeJson(secretsFile(), all, 0o600);
}

export function loadSecret(name: string, box: SecretBox): string | undefined {
  const rec = readJson<Record<string, SecretRecord>>(secretsFile(), {})[name];
  if (!rec) return undefined;
  if (rec.enc === 'plain') return rec.data;
  if (!box.available()) return undefined;
  try {
    return box.decrypt(Buffer.from(rec.data, 'base64'));
  } catch {
    return undefined;
  }
}

export function deleteSecret(name: string): void {
  const file = secretsFile();
  if (!existsSync(file)) return;
  const all = readJson<Record<string, SecretRecord>>(file, {});
  delete all[name];
  writeJson(file, all, 0o600);
}

export function loadBrief(date: string): Brief | null {
  return readJson<Brief | null>(briefFile(date), null);
}

export function saveBrief(brief: Brief): void {
  writeJson(briefFile(brief.date), brief);
}
