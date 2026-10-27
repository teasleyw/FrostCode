import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { frostHome, hasEnvApiKey, selectAccountKey } from './env.js';

/**
 * Named API keys (one per Anthropic Console account) the user can switch between mid-session.
 * accounts.json holds only names and which one is active; the keys live in the macOS login
 * Keychain (service "frostcode-account"), or in a 0600 file elsewhere / when FROSTCODE_KEYSTORE=file.
 * "env" is the built-in account: the shell's ANTHROPIC_API_KEY.
 */

export const ENV_ACCOUNT = 'env';
const KEYCHAIN_SERVICE = 'frostcode-account';
const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;
const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{8,}$/;

interface AccountsFile {
  active?: string;
  accounts: string[];
}

function accountsPath(): string {
  return join(frostHome(), 'accounts.json');
}

function keysPath(): string {
  return join(frostHome(), 'account-keys.json');
}

function useKeychain(): boolean {
  return process.platform === 'darwin' && process.env.FROSTCODE_KEYSTORE !== 'file';
}

function readFile(): AccountsFile {
  try {
    const data = JSON.parse(readFileSync(accountsPath(), 'utf8')) as Partial<AccountsFile>;
    return { active: typeof data.active === 'string' ? data.active : undefined, accounts: Array.isArray(data.accounts) ? data.accounts.filter((n) => typeof n === 'string') : [] };
  } catch {
    return { accounts: [] };
  }
}

function writeFile(f: AccountsFile): void {
  mkdirSync(frostHome(), { recursive: true });
  writeFileSync(accountsPath(), JSON.stringify(f, null, 2) + '\n');
}

function readKeyFile(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(keysPath(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeKeyFile(keys: Record<string, string>): void {
  mkdirSync(frostHome(), { recursive: true });
  writeFileSync(keysPath(), JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  chmodSync(keysPath(), 0o600);
}

function storeKey(name: string, key: string): void {
  if (useKeychain()) {
    // `security -i` reads the command from stdin, so the key never appears in a process listing.
    execFileSync('/usr/bin/security', ['-i'], {
      input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${name} -l "FrostCode account ${name}" -w "${key}"\n`,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    return;
  }
  writeKeyFile({ ...readKeyFile(), [name]: key });
}

function loadKey(name: string): string | undefined {
  if (useKeychain()) {
    try {
      const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return out || undefined;
    } catch {
      return undefined;
    }
  }
  return readKeyFile()[name];
}

function deleteKey(name: string): void {
  if (useKeychain()) {
    try {
      execFileSync('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
    return;
  }
  const keys = readKeyFile();
  delete keys[name];
  if (existsSync(keysPath())) writeKeyFile(keys);
}

export interface AccountEntry {
  name: string;
  active: boolean;
  /** The env account only exists while ANTHROPIC_API_KEY is set. */
  available: boolean;
}

/** The account the runtime is (or will be) using. */
export function activeAccount(): string {
  const f = readFile();
  return f.active && (f.active === ENV_ACCOUNT || f.accounts.includes(f.active)) ? f.active : ENV_ACCOUNT;
}

export function listAccounts(): AccountEntry[] {
  const f = readFile();
  const active = activeAccount();
  return [
    { name: ENV_ACCOUNT, active: active === ENV_ACCOUNT, available: hasEnvApiKey() },
    ...f.accounts.map((name) => ({ name, active: active === name, available: true })),
  ];
}

export function addAccount(name: string, key: string): void {
  if (!NAME_PATTERN.test(name)) throw new Error('Account names use letters, digits, "-", "_" or "." (up to 32 characters).');
  if (name === ENV_ACCOUNT) throw new Error(`"${ENV_ACCOUNT}" is reserved for the shell's ANTHROPIC_API_KEY.`);
  key = key.trim();
  if (!KEY_SHAPE.test(key)) throw new Error('That does not look like an Anthropic API key (sk-ant-...).');
  storeKey(name, key);
  const f = readFile();
  if (!f.accounts.includes(name)) f.accounts.push(name);
  writeFile(f);
}

export function removeAccount(name: string): void {
  const f = readFile();
  if (!f.accounts.includes(name)) throw new Error(`No saved account "${name}".`);
  deleteKey(name);
  f.accounts = f.accounts.filter((n) => n !== name);
  if (f.active === name) f.active = undefined;
  writeFile(f);
  if (activeAccount() === ENV_ACCOUNT) selectAccountKey(undefined);
}

/** Make an account active for every runtime started from now on, and remember it for next launch. */
export function useAccount(name: string): void {
  const f = readFile();
  if (name === ENV_ACCOUNT) {
    if (!hasEnvApiKey()) throw new Error('ANTHROPIC_API_KEY is not set in this environment, so the "env" account has no key.');
    selectAccountKey(undefined);
  } else {
    if (!f.accounts.includes(name)) throw new Error(`No saved account "${name}". Add it from a shell: frostcode account add ${name}`);
    const key = loadKey(name);
    if (!key) throw new Error(`The key for "${name}" is missing from the ${useKeychain() ? 'Keychain' : 'key file'}. Re-add it: frostcode account add ${name}`);
    selectAccountKey(key);
  }
  f.active = name;
  writeFile(f);
}

/** At startup: load the remembered account's key. A broken saved account falls back to the env key. */
export function applySavedAccount(): string | null {
  const name = activeAccount();
  if (name === ENV_ACCOUNT) return null;
  const key = loadKey(name);
  if (!key) return `Saved account "${name}" has no key stored; using ANTHROPIC_API_KEY.`;
  selectAccountKey(key);
  return null;
}
