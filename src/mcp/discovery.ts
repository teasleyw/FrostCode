import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import type { McpServerConfigForProcessTransport } from '@anthropic-ai/claude-agent-sdk';

/**
 * Where a server definition was found. Claude Code's own scopes come first (local beats
 * project beats user, as in Claude Code); the Claude desktop app's servers come after.
 */
export type McpScope = 'local' | 'project' | 'user' | 'desktop-extension' | 'desktop';

export const SCOPE_ORDER: McpScope[] = ['local', 'project', 'user', 'desktop-extension', 'desktop'];

export const SCOPE_LABELS: Record<McpScope, string> = {
  local: 'Claude Code (this project, ~/.claude.json)',
  project: 'Claude Code (.mcp.json)',
  user: 'Claude Code (user, ~/.claude.json)',
  'desktop-extension': 'Claude desktop app extension',
  desktop: 'Claude desktop app config',
};

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface DiscoveredServer {
  /** Stable key for approvals: scope + name (+ file for .mcp.json, which can sit in a parent folder). */
  id: string;
  /** Name the runtime uses (tools are mcp__<name>__<tool>). */
  name: string;
  scope: McpScope;
  /** File the definition was read from. Never written. */
  source: string;
  transport: McpTransport | null;
  /** Normalized config for the runtime, or null when the server cannot be used from here. */
  config: McpServerConfigForProcessTransport | null;
  /** Why config is null. */
  problem?: string;
  /** Another definition of the same name wins (closer scope). */
  shadowedBy?: string;
  /** Turned off in the app it came from (desktop extensions). Shown, not connected unless enabled here. */
  offInSource?: boolean;
  /** Hash of config: approval is tied to it, so a changed command needs approving again. */
  fingerprint: string;
}

export interface DiscoveryRoots {
  /** Home directory used for ~/.claude.json. */
  home?: string;
  /** Claude desktop app support dir (macOS: ~/Library/Application Support/Claude). null disables it. */
  desktopDir?: string | null;
}

export function defaultDesktopDir(home = homedir()): string | null {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude');
  if (process.platform === 'win32') return process.env.APPDATA ? join(process.env.APPDATA, 'Claude') : null;
  return join(home, '.config', 'Claude');
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function fingerprint(config: unknown): string {
  return createHash('sha256').update(stableStringify(config ?? null)).digest('hex').slice(0, 16);
}

const strRecord = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
};

/** Turn a Claude Code style entry into a runtime config (stdio, http or sse only). */
export function normalizeConfig(raw: unknown): { config: McpServerConfigForProcessTransport | null; transport: McpTransport | null; problem?: string } {
  if (!raw || typeof raw !== 'object') return { config: null, transport: null, problem: 'Not a server definition' };
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === 'string' ? r.type : undefined;
  const timeout = typeof r.timeout === 'number' ? r.timeout : undefined;
  if (type === 'http' || type === 'sse' || (!type && typeof r.url === 'string' && typeof r.command !== 'string')) {
    if (typeof r.url !== 'string') return { config: null, transport: null, problem: `${type} server has no url` };
    const t = (type ?? 'http') as 'http' | 'sse';
    const headers = strRecord(r.headers);
    return { config: { type: t, url: r.url, ...(headers ? { headers } : {}), ...(timeout ? { timeout } : {}) }, transport: t };
  }
  if (!type || type === 'stdio') {
    if (typeof r.command !== 'string' || !r.command) return { config: null, transport: null, problem: 'stdio server has no command' };
    const args = Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string') : [];
    const env = strRecord(r.env);
    return { config: { type: 'stdio', command: r.command, args, ...(env ? { env } : {}), ...(timeout ? { timeout } : {}) }, transport: 'stdio' };
  }
  return { config: null, transport: null, problem: `"${type}" servers are not supported here (stdio, http and sse are)` };
}

/**
 * ~/.claude.json keys projects by folder; the closest ancestor of cwd with an entry applies.
 * On Windows Claude Code writes C:/x/y (older versions C:\x\y, and both can be present), and
 * the file system ignores case, so keys are compared in one form there; the C:/ form wins.
 */
function closestProjectEntry(projects: Record<string, any> | undefined, cwd: string): { path: string; entry: any } | null {
  if (!projects || typeof projects !== 'object') return null;
  const norm = (p: string) => (process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p);
  const keys = new Map<string, string>();
  for (const k of Object.keys(projects)) if (!keys.has(norm(k)) || k.includes('/')) keys.set(norm(k), k);
  let dir = resolve(cwd);
  for (;;) {
    const key = keys.get(norm(dir));
    if (key && projects[key]) return { path: key, entry: projects[key] };
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Nearest .mcp.json at or above cwd. */
function closestMcpJson(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const f = join(dir, '.mcp.json');
    if (existsSync(f)) return f;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

const UV_CANDIDATES = (home: string) => [join(home, '.local', 'bin', 'uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv', join(home, '.cargo', 'bin', 'uv')];

/** A command's file names on disk: on Windows a bare name needs one of PATHEXT's extensions (uv -> uv.exe). */
function executableNames(p: string): string[] {
  if (process.platform !== 'win32' || extname(p)) return [p];
  return (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => p + ext.toLowerCase());
}

/** Absolute path for a bare command name, so servers start even when the app was launched without a shell PATH. */
function resolveCommand(cmd: string, home: string): string {
  if (cmd.includes('/') || cmd.includes(sep) || isAbsolute(cmd)) return cmd;
  const extra = process.platform === 'win32' ? [join(home, '.local', 'bin')] : [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...extra];
  if (cmd === 'uv') for (const c of UV_CANDIDATES(home).flatMap(executableNames)) if (existsSync(c)) return c;
  for (const d of dirs) {
    for (const p of executableNames(join(d, cmd))) if (existsSync(p)) return p;
  }
  return cmd;
}

/**
 * A Claude desktop extension (MCPB manifest) as a stdio server: the manifest's mcp_config with
 * ${__dirname} / ${user_config.*} filled in. "uv" extensions run in their own folder, which the
 * desktop app does by setting the working directory; stdio configs have no cwd, so uv gets --directory.
 */
export function extensionServer(dir: string, manifest: any, settings: any, home: string): { config: McpServerConfigForProcessTransport | null; problem?: string } {
  const server = manifest?.server;
  let mc = server?.mcp_config;
  const override = mc?.platform_overrides?.[process.platform];
  if (override) mc = { ...mc, ...override };
  if (!mc || typeof mc.command !== 'string') return { config: null, problem: 'Extension manifest has no mcp_config command' };
  const userConfig: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries((manifest?.user_config ?? {}) as Record<string, any>)) if (spec && 'default' in spec) userConfig[k] = spec.default;
  Object.assign(userConfig, settings?.userConfig ?? {});
  const fill = (s: string) =>
    s
      .replace(/\$\{__dirname\}/g, dir)
      .replace(/\$\{HOME\}/g, home)
      .replace(/\$\{user_config\.([\w-]+)\}/g, (_m, k: string) => (userConfig[k] == null ? '' : String(userConfig[k])));
  let command = fill(mc.command);
  let args: string[] = (Array.isArray(mc.args) ? mc.args : []).filter((a: unknown): a is string => typeof a === 'string').map(fill);
  const env = strRecord(mc.env);
  const filledEnv = env ? Object.fromEntries(Object.entries(env).map(([k, v]) => [k, fill(v)])) : undefined;
  if (server?.type === 'uv' && command === 'uv') {
    if (args[0] === 'run' && !args.includes('--directory')) args = ['run', '--directory', dir, ...args.slice(1)];
  }
  command = resolveCommand(command, home);
  return { config: { type: 'stdio', command, args, ...(filledEnv ? { env: filledEnv } : {}) } };
}

function desktopExtensions(desktopDir: string, home: string): Omit<DiscoveredServer, 'shadowedBy'>[] {
  const installs = readJson(join(desktopDir, 'extensions-installations.json'));
  const entries = installs?.extensions && typeof installs.extensions === 'object' ? installs.extensions : installs;
  if (!entries || typeof entries !== 'object') return [];
  const out: Omit<DiscoveredServer, 'shadowedBy'>[] = [];
  for (const [extId, info] of Object.entries(entries as Record<string, any>)) {
    const dir = join(desktopDir, 'Claude Extensions', extId);
    const manifestFile = join(dir, 'manifest.json');
    // The folder's manifest is newer than the copy in the installations index after an update.
    const manifest = readJson(manifestFile) ?? info?.manifest;
    if (!manifest) continue;
    const settings = readJson(join(desktopDir, 'Claude Extensions Settings', `${extId}.json`));
    const name = slug(String(manifest.name ?? extId));
    const { config, problem } = existsSync(dir) ? extensionServer(dir, manifest, settings, home) : { config: null, problem: 'Extension folder is missing' };
    out.push({
      id: `desktop-extension:${extId}`,
      name,
      scope: 'desktop-extension',
      source: existsSync(manifestFile) ? manifestFile : join(desktopDir, 'extensions-installations.json'),
      transport: config ? 'stdio' : null,
      config,
      problem,
      offInSource: settings?.isEnabled === false,
      fingerprint: fingerprint(config),
    });
  }
  return out;
}

/**
 * Every MCP server FrostCode can see for a project, read-only: Claude Code's ~/.claude.json
 * (user and per-project servers), the nearest .mcp.json, and the Claude desktop app's
 * extensions and config. Nothing here writes to any of those files.
 */
export function discoverMcpServers(cwd: string, roots: DiscoveryRoots = {}): DiscoveredServer[] {
  const home = roots.home ?? (process.env.FROSTCODE_CLAUDE_HOME || homedir());
  const found: Omit<DiscoveredServer, 'shadowedBy'>[] = [];
  const add = (scope: McpScope, name: string, raw: unknown, source: string, idSuffix = '') => {
    const { config, transport, problem } = normalizeConfig(raw);
    found.push({ id: `${scope}:${name}${idSuffix}`, name, scope, source, transport, config, problem, fingerprint: fingerprint(config) });
  };

  const claudeJsonFile = join(home, '.claude.json');
  const claudeJson = readJson(claudeJsonFile);
  const proj = closestProjectEntry(claudeJson?.projects, cwd);
  for (const [name, raw] of Object.entries((proj?.entry?.mcpServers ?? {}) as Record<string, unknown>)) add('local', name, raw, claudeJsonFile, `@${proj!.path}`);

  const mcpJson = closestMcpJson(cwd);
  if (mcpJson) {
    const data = readJson(mcpJson);
    for (const [name, raw] of Object.entries((data?.mcpServers ?? {}) as Record<string, unknown>)) add('project', name, raw, mcpJson, `@${dirname(mcpJson)}`);
  }

  for (const [name, raw] of Object.entries((claudeJson?.mcpServers ?? {}) as Record<string, unknown>)) add('user', name, raw, claudeJsonFile);

  // FROSTCODE_CLAUDE_DESKTOP_DIR moves the desktop app lookup (empty string turns it off; tests use that).
  const envDesktop = process.env.FROSTCODE_CLAUDE_DESKTOP_DIR;
  const desktopDir = roots.desktopDir !== undefined ? roots.desktopDir : envDesktop !== undefined ? envDesktop || null : defaultDesktopDir(home);
  if (desktopDir && existsSync(desktopDir)) {
    found.push(...desktopExtensions(desktopDir, home));
    const cfgFile = join(desktopDir, 'claude_desktop_config.json');
    const cfg = readJson(cfgFile);
    for (const [name, raw] of Object.entries((cfg?.mcpServers ?? {}) as Record<string, unknown>)) add('desktop', name, raw, cfgFile);
  }

  // One definition per name, by scope order; the rest are listed as shadowed.
  found.sort((a, b) => SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope));
  const winner = new Map<string, string>();
  return found.map((s) => {
    const w = winner.get(s.name);
    if (w) return { ...s, shadowedBy: w };
    winner.set(s.name, s.id);
    return s;
  });
}

/** Display form of a config: env values and header values are never shown. */
export function describeConfig(config: McpServerConfigForProcessTransport | null): { summary: string; envKeys: string[]; headerKeys: string[] } {
  if (!config) return { summary: '(unusable)', envKeys: [], headerKeys: [] };
  if (config.type === 'http' || config.type === 'sse') {
    return { summary: `${config.type.toUpperCase()} ${config.url}`, envKeys: [], headerKeys: Object.keys(config.headers ?? {}) };
  }
  if (config.type === 'sdk') return { summary: 'in-process', envKeys: [], headerKeys: [] };
  return { summary: [config.command, ...(config.args ?? [])].join(' '), envKeys: Object.keys(config.env ?? {}), headerKeys: [] };
}
