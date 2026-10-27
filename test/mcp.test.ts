import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import { describeConfig, discoverMcpServers } from '../src/mcp/discovery.js';
import { McpManager, splitMcpToolName, type McpRuntime } from '../src/mcp/manager.js';
import { PermissionController, type PromptAnswer, type PromptRequest } from '../src/core/permissions.js';
import { AppController } from '../src/app/controller.js';
import { initMsg, makeFakeQuery, until } from './helpers/fake-query.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const write = (f: string, data: unknown) => {
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};
const hash = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

/** A home with Claude Code config, a project with .mcp.json and a Claude desktop app dir with one extension. */
function fixture() {
  const home = tmp('fc-mcp-home-');
  const project = join(home, 'code', 'proj');
  mkdirSync(join(project, 'sub'), { recursive: true });
  const desktop = join(home, 'desktop');
  write(join(home, '.claude.json'), {
    numStartups: 3,
    mcpServers: {
      remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer secret-token' } },
      shared: { command: 'user-shared' },
      weird: { type: 'ws', url: 'ws://x' },
    },
    projects: { [project]: { mcpServers: { shared: { command: 'local-shared', env: { TOKEN: 'abc' } } } } },
  });
  write(join(project, '.mcp.json'), { mcpServers: { meshy: { command: 'npx', args: ['-y', 'meshy'], env: { MESHY_API_KEY: 'msy_secret' } } } });
  const ext = join(desktop, 'Claude Extensions', 'ant.dir.gh.blender.blender-mcp');
  write(join(desktop, 'extensions-installations.json'), { extensions: { 'ant.dir.gh.blender.blender-mcp': { id: 'ant.dir.gh.blender.blender-mcp' } } });
  write(join(ext, 'manifest.json'), {
    name: 'Blender',
    server: { type: 'uv', entry_point: 'blmcp/__init__.py', mcp_config: { command: 'uv', args: ['run', 'blender-mcp'], env: { BLENDER_PATH: '/Applications/Blender.app/Contents/MacOS/Blender' } } },
  });
  write(join(desktop, 'Claude Extensions Settings', 'ant.dir.gh.blender.blender-mcp.json'), { isEnabled: true });
  write(join(desktop, 'claude_desktop_config.json'), { mcpServers: { unityMCP: { command: 'uvx', args: ['unity'] } } });
  return { home, project, desktop, ext, roots: { home, desktopDir: desktop } };
}

describe('MCP discovery (read-only)', () => {
  it('finds Claude Code and Claude desktop servers, closest scope first', () => {
    const f = fixture();
    const list = discoverMcpServers(join(f.project, 'sub'), f.roots);
    const by = (id: string) => list.find((s) => s.id.startsWith(id))!;
    expect(list.map((s) => `${s.scope}:${s.name}`)).toEqual(['local:shared', 'project:meshy', 'user:remote', 'user:shared', 'user:weird', 'desktop-extension:blender', 'desktop:unityMCP']);
    expect(by('local:shared').shadowedBy).toBeUndefined();
    expect(by('user:shared').shadowedBy).toBe(by('local:shared').id);
    expect(by('user:remote').config).toMatchObject({ type: 'http', url: 'https://mcp.example.com/mcp' });
    expect(by('user:weird').config).toBeNull();
    expect(by('user:weird').problem).toMatch(/not supported/);
    // The desktop app runs uv extensions in their folder; a stdio config has no cwd, so --directory carries it.
    const blender = by('desktop-extension:');
    expect(blender.name).toBe('blender');
    expect(blender.config).toMatchObject({ type: 'stdio', args: ['run', '--directory', f.ext, 'blender-mcp'], env: { BLENDER_PATH: '/Applications/Blender.app/Contents/MacOS/Blender' } });
  });

  it('never writes to the config files it reads', () => {
    const f = fixture();
    const files = [join(f.home, '.claude.json'), join(f.project, '.mcp.json'), join(f.desktop, 'claude_desktop_config.json'), join(f.ext, 'manifest.json')];
    const before = files.map(hash);
    const m = new McpManager(f.project, { roots: f.roots, storeFile: join(f.home, 'frost-mcp.json') });
    const meshy = m.find('meshy')!;
    void m.act(meshy.id, 'approve');
    m.refresh();
    expect(files.map(hash)).toEqual(before);
  });

  it('shows env and header names, never their values', () => {
    const f = fixture();
    const list = discoverMcpServers(f.project, f.roots);
    const remote = describeConfig(list.find((s) => s.name === 'remote')!.config);
    expect(remote.headerKeys).toEqual(['Authorization']);
    expect(JSON.stringify(remote)).not.toContain('secret-token');
    const m = new McpManager(f.project, { roots: f.roots, storeFile: join(f.home, 'frost-mcp.json') });
    expect(JSON.stringify(m.entries())).not.toMatch(/msy_secret|secret-token|"abc"/);
  });

  it('finds a project keyed the way Claude Code writes it on Windows (C:/x/y)', () => {
    const f = fixture();
    const claudeJson = JSON.parse(readFileSync(join(f.home, '.claude.json'), 'utf8'));
    claudeJson.projects = { [f.project.replace(/\\/g, '/')]: claudeJson.projects[f.project] };
    write(join(f.home, '.claude.json'), claudeJson);
    expect(discoverMcpServers(join(f.project, 'sub'), f.roots).find((s) => s.name === 'shared')?.scope).toBe('local');
  });
});

function fakeRuntime(status: McpServerStatus[] = []) {
  const calls: string[] = [];
  const rt: McpRuntime = {
    mcpServerStatus: async () => status,
    toggleMcpServer: async (n, on) => void calls.push(`toggle ${n} ${on}`),
    reconnectMcpServer: async (n) => void calls.push(`reconnect ${n}`),
    setMcpServers: async (s) => {
      calls.push(`set ${Object.keys(s).sort().join(',')}`);
      return { added: [], removed: [], errors: {} };
    },
  };
  return { rt, calls };
}

describe('MCP manager', () => {
  it('connects nothing until approved, and asks again when a config changes', async () => {
    const f = fixture();
    const store = join(f.home, 'frost-mcp.json');
    const m = new McpManager(f.project, { roots: f.roots, storeFile: store });
    expect(m.runtimeConfig()).toEqual({});
    expect(m.awaitingApproval().map((s) => s.name).sort()).toEqual(['blender', 'meshy', 'remote', 'shared', 'unityMCP']);
    const { rt, calls } = fakeRuntime();
    m.attach(rt);
    await m.act('blender', 'approve');
    expect(Object.keys(m.runtimeConfig())).toEqual(['blender']);
    expect(calls).toContain('set blender');
    // The command changes in the desktop app: the old approval no longer covers it.
    const manifest = JSON.parse(readFileSync(join(f.ext, 'manifest.json'), 'utf8'));
    manifest.server.mcp_config.args = ['run', 'something-else'];
    write(join(f.ext, 'manifest.json'), manifest);
    m.refresh();
    expect(m.entries().find((e) => e.name === 'blender')!.state).toBe('changed');
    expect(m.runtimeConfig()).toEqual({});
  });

  it('disables, enables, reconnects and rejects through the runtime', async () => {
    const f = fixture();
    const m = new McpManager(f.project, { roots: f.roots, storeFile: join(f.home, 'frost-mcp.json') });
    const { rt, calls } = fakeRuntime([{ name: 'meshy', status: 'connected', tools: [] }]);
    m.attach(rt);
    await m.act('meshy', 'approve');
    await m.act('meshy', 'disable');
    expect(m.entries().find((e) => e.name === 'meshy')!.state).toBe('disabled');
    expect(m.runtimeConfig()).toEqual({});
    await m.act('meshy', 'enable');
    await m.act('meshy', 'reconnect');
    await m.act('meshy', 'reject');
    expect(calls).toEqual(['set meshy', 'toggle meshy false', 'toggle meshy true', 'reconnect meshy', 'set ']);
    await expect(m.act('meshy', 'enable')).rejects.toThrow(/not approved/);
  });

  it('decisions persist in FrostCode’s own store', async () => {
    const f = fixture();
    const store = join(f.home, 'frost-mcp.json');
    const a = new McpManager(f.project, { roots: f.roots, storeFile: store });
    await a.act('blender', 'approve');
    a.setToolTrusted('blender', 'jump_to_tab_by_name', true);
    const b = new McpManager(f.project, { roots: f.roots, storeFile: store });
    expect(Object.keys(b.runtimeConfig())).toEqual(['blender']);
    expect(b.store.isTrusted('blender', 'jump_to_tab_by_name')).toBe(true);
  });

  it('splits tool names even when the server name has underscores', () => {
    expect(splitMcpToolName('mcp__fl_studio__play', ['fl_studio'])).toEqual({ server: 'fl_studio', tool: 'play' });
    expect(splitMcpToolName('mcp__blender__search_api_docs')).toEqual({ server: 'blender', tool: 'search_api_docs' });
    expect(splitMcpToolName('Bash')).toBeNull();
  });
});

describe('sensitive MCP calls need explicit approval', () => {
  const status: McpServerStatus[] = [
    {
      name: 'blender',
      status: 'connected',
      tools: [
        { name: 'search_api_docs', annotations: { readOnly: true } },
        { name: 'execute_blender_code', annotations: { destructive: true } },
        { name: 'jump_to_tab_by_name', annotations: {} },
      ],
    },
  ];

  async function setup(answer: PromptAnswer) {
    const f = fixture();
    const m = new McpManager(f.project, { roots: f.roots, storeFile: join(f.home, 'frost-mcp.json') });
    m.attach(fakeRuntime(status).rt);
    await m.refreshStatus();
    const asked: PromptRequest[] = [];
    const denied: string[] = [];
    const perms = new PermissionController({ ask: async (r) => (asked.push(r), answer) });
    perms.onDenied = (id) => denied.push(id);
    const matcher = m.approvalHook((req, signal) => perms.askExplicit(req, signal));
    const run = (tool: string) =>
      matcher.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: `mcp__blender__${tool}`, tool_input: { code: 'print(1)' }, tool_use_id: `tu-${tool}` } as never, `tu-${tool}`, {
        signal: new AbortController().signal,
      });
    return { m, run, asked, denied, matcher };
  }

  it('read-only tools fall through to normal permissions; others are asked every call', async () => {
    const { run, asked, matcher } = await setup({ kind: 'allow' });
    expect(matcher.matcher).toBe('mcp__.*');
    expect(await run('search_api_docs')).toEqual({});
    expect(asked).toHaveLength(0);
    const out = await run('execute_blender_code');
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: 'tool', toolName: 'mcp__blender__execute_blender_code', allowAlways: false, defaultToNo: true, sensitive: true });
    await run('execute_blender_code');
    expect(asked).toHaveLength(2); // no "don't ask again"
  });

  it('a "no" denies the call and marks it denied in the transcript', async () => {
    const { run, denied } = await setup({ kind: 'deny' });
    expect(await run('jump_to_tab_by_name')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(denied).toEqual(['tu-jump_to_tab_by_name']);
  });

  it('unknown tools count as sensitive; trusted tools do not ask', async () => {
    const { m, run, asked } = await setup({ kind: 'allow' });
    await run('brand_new_tool');
    expect(asked).toHaveLength(1);
    m.setToolTrusted('blender', 'execute_blender_code', true);
    expect(await run('execute_blender_code')).toEqual({});
    expect(asked).toHaveLength(1);
  });
});

describe('controller + MCP', () => {
  it('hands the runtime only approved servers, in strict mode, and says what awaits approval', async () => {
    const f = fixture();
    const store = join(f.home, 'frost-mcp.json');
    await new McpManager(f.project, { roots: f.roots, storeFile: store }).act('blender', 'approve');
    const fake = makeFakeQuery(() => {});
    const ctrl = new AppController({ cwd: f.project, permissionMode: 'default', queryFn: fake.queryFn, costStore: null, mcp: { roots: f.roots, storeFile: store } });
    await ctrl.boot();
    fake.runs[0].emit(initMsg());
    await until(() => ctrl.transcript.items.some((i) => i.kind === 'system' && /not yet approved/.test(i.text)));
    const opts = fake.runs[0].options;
    expect(Object.keys(opts.mcpServers ?? {})).toEqual(['blender']);
    expect(opts.strictMcpConfig).toBe(true);
    const notice = ctrl.transcript.items.find((i) => i.kind === 'system' && /not yet approved/.test(i.text));
    expect(notice && notice.kind === 'system' && notice.text).toMatch(/meshy/);
    await ctrl.submit('/mcp');
    expect(ctrl.overlay).toEqual({ type: 'mcp' });
    await ctrl.submit('/mcp blender');
    expect(ctrl.overlay).toEqual({ type: 'mcp-server', id: expect.stringContaining('blender') });
    await ctrl.shutdown();
  });
});
