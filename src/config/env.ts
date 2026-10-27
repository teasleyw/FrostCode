import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_NAME = 'FrostCode';
export const APP_VERSION = '0.1.0';

/** Root of FrostCode's own state: ~/.frostcode (override with FROSTCODE_HOME). */
export function frostHome(): string {
  return process.env.FROSTCODE_HOME || join(homedir(), '.frostcode');
}

/**
 * Isolated config directory handed to the Agent SDK's runtime as CLAUDE_CONFIG_DIR.
 * Keeping it separate from ~/.claude means the runtime never sees a Claude
 * subscription login (OAuth credentials live under the default config dir and its
 * keychain entry), so every request is authenticated with ANTHROPIC_API_KEY and
 * billed to the API account. FrostCode's transcripts also live here.
 */
export function agentConfigDir(): string {
  return join(frostHome(), 'agent');
}

/** Variables that would let the runtime authenticate some other way than the API key. */
const STRIPPED_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  // Set when FrostCode itself is launched from inside a Claude Code session.
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
];

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      'ANTHROPIC_API_KEY is not set. FrostCode bills to the Anthropic API, so export a key first:\n' +
        (process.platform === 'win32' ? '  $env:ANTHROPIC_API_KEY = "sk-ant-..."   (PowerShell; setx ANTHROPIC_API_KEY sk-ant-... keeps it)\n' : '  export ANTHROPIC_API_KEY=sk-ant-...\n') +
        'Create one at https://platform.claude.com/settings/keys\n' +
        'Or save one as a named account: frostcode account add <name>',
    );
  }
}

/** Key moved out of process.env by stashApiKey(); only this module can read it. */
let stashedKey: string | undefined;
/** Key of a saved account picked with /account (accounts.ts); wins over the shell's key. */
let accountKey: string | undefined;

function envKeyIn(env: NodeJS.ProcessEnv): string | undefined {
  const key = env.ANTHROPIC_API_KEY ?? (env === process.env ? stashedKey : undefined);
  return typeof key === 'string' && key.trim() ? key : undefined;
}

function keyIn(env: NodeJS.ProcessEnv): string | undefined {
  return (env === process.env ? accountKey : undefined) ?? envKeyIn(env);
}

export function hasApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return keyIn(env) !== undefined;
}

/** The key runtimes are started with (saved account, else ANTHROPIC_API_KEY): for direct API calls such as the Work tab's daily list. */
export function currentApiKey(): string | undefined {
  return keyIn(process.env);
}

/** Whether the shell's own ANTHROPIC_API_KEY is set (the "env" account). */
export function hasEnvApiKey(): boolean {
  return envKeyIn(process.env) !== undefined;
}

/** Use a saved account's key for runtimes started from now on (undefined = back to ANTHROPIC_API_KEY). */
export function selectAccountKey(key: string | undefined): void {
  accountKey = key?.trim() || undefined;
}

/**
 * Remove ANTHROPIC_API_KEY from this process's environment (unsetenv) while keeping it for
 * the agent runtime. The desktop app calls this first thing, so the Chromium renderer and
 * helper processes Electron launches later never inherit the key.
 */
export function stashApiKey(): void {
  const key = envKeyIn(process.env);
  if (!key) return;
  stashedKey = key;
  delete process.env.ANTHROPIC_API_KEY;
}

/**
 * Point this process (the SDK's session helpers read it here) and the runtime
 * subprocess at the isolated config dir. Must run before any SDK call.
 */
export function prepareProcessEnv(): void {
  const dir = agentConfigDir();
  mkdirSync(dir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = dir;
}

/** Environment for the Agent SDK runtime: the API key only, no other auth path. */
export function buildAgentEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  if (!hasApiKey(base)) throw new MissingApiKeyError();
  const env: Record<string, string | undefined> = { ...base };
  for (const v of STRIPPED_VARS) delete env[v];
  env.ANTHROPIC_API_KEY = keyIn(base);
  env.CLAUDE_CONFIG_DIR = agentConfigDir();
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `frostcode/${APP_VERSION}`;
  // No telemetry/update chatter from the embedded runtime.
  env.DISABLE_AUTOUPDATER = '1';
  return env;
}

const KEY_PATTERN = /sk-ant-[A-Za-z0-9_\-]{8,}/g;

/** Mask anything that looks like an Anthropic key before it is shown or written. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text.replace(KEY_PATTERN, 'sk-ant-***');
  for (const key of new Set([keyIn(env), envKeyIn(env)])) {
    if (key && key.length >= 8) out = out.split(key).join('***');
  }
  return out;
}
