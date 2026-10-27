import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { buildAgentEnv, prepareProcessEnv, redact, stashApiKey, hasApiKey } from '../src/config/env.js';
import { GuiBackend, groupSessions, loadGuiPrefs, toGuiItem, TranscriptDiffer, type BackendEvent } from '../src/gui/backend.js';
import { TranscriptModel } from '../src/core/transcript.js';
import { parseArgs } from '../src/cli-args.js';
import { assistantText, assistantToolUse, initMsg, makeFakeQuery, resultMsg, toolResult, until } from './helpers/fake-query.js';
import { makeProject, projectFolder, writeTranscript } from './helpers/transcripts.js';

beforeAll(() => prepareProcessEnv());

const live: GuiBackend[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((b) => b.shutdown()));
});

/** A backend wired to the fake SDK. The responder plays the runtime, including saving the transcript. */
function backendFor(opts: { defaultCwd: string; cwd?: string; prefsFile: string }, responder: Parameters<typeof makeFakeQuery>[0] = () => {}) {
  const fake = makeFakeQuery(responder);
  const events: BackendEvent[] = [];
  const backend = new GuiBackend({ ...opts, emit: (e) => events.push(e), queryFn: fake.queryFn, costStore: null, throttleMs: 0 });
  live.push(backend);
  return { backend, events, ...fake };
}

const texts = (b: GuiBackend) => b.controller!.transcript.items.filter((i) => i.kind === 'user' || i.kind === 'assistant').map((i) => (i as { text: string }).text);
const prefsIn = (dir: string) => join(dir, 'gui-state.json');

describe('desktop session list', () => {
  it('shows existing saved FrostCode sessions grouped by project, newest first', async () => {
    const a = makeProject();
    const b = makeProject();
    const old = writeTranscript(a, [['Fix the flaky login test', 'Done.']], { at: Date.now() - 3 * 86_400_000 });
    const recent = writeTranscript(a, [['Add a dark mode toggle', 'Added.']]);
    const other = writeTranscript(b, [['Explain the build script', 'It bundles…']], { at: Date.now() - 86_400_000 });
    const { backend } = backendFor({ defaultCwd: a, prefsFile: prefsIn(makeProject()) });

    const groups = await backend.refreshSessions(false);
    const ga = groups.find((g) => g.cwd === a)!;
    const gb = groups.find((g) => g.cwd === b)!;
    expect(ga.sessions.map((s) => s.id)).toEqual([recent, old]);
    expect(ga.sessions[0]).toMatchObject({ title: 'Add a dark mode toggle', cwd: a });
    expect(ga.sessions[0].lastModified).toBeGreaterThan(ga.sessions[1].lastModified);
    expect(gb.sessions.map((s) => s.title)).toEqual(['Explain the build script']);
    expect(gb.sessions[0].id).toBe(other);
    expect(groups.indexOf(ga)).toBeLessThan(groups.indexOf(gb));
  });

  // Needs a temp dir that is not already its own real path (true on macOS, and on Windows when TEMP holds an 8.3 name).
  it.skipIf(realpathSync.native(tmpdir()) === tmpdir())('merges a recent project stored as an unresolved path with its sessions (/tmp vs /private/tmp)', () => {
    const real = makeProject();
    const unresolved = join(tmpdir(), basename(real)); // macOS: /var/folders/... -> /private/var/folders/...; Windows: WILLIA~1 -> WilliamTeasley
    expect(unresolved).not.toBe(real);
    const groups = groupSessions([{ id: 's1', title: 't', lastModified: 100, cwd: real }], [{ path: unresolved, lastOpened: 50 }]);
    expect(groups.map((g) => g.cwd)).toEqual([real]);
  });

  it('groups recent projects that have no sessions yet', () => {
    const groups = groupSessions(
      [{ id: 's1', title: 't', lastModified: 100, cwd: '/x/a' }],
      [{ path: '/x/b', lastOpened: 200 }],
    );
    expect(groups.map((g) => [g.name, g.sessions.length])).toEqual([
      ['b', 0],
      ['a', 1],
    ]);
  });
});

describe('opening, switching and resuming', () => {
  it('opens a saved session: loads its history and resumes the runtime on it', async () => {
    const cwd = makeProject();
    const id = writeTranscript(cwd, [['What does main.ts do?', 'It starts the server.']]);
    const { backend, runs, events } = backendFor({ defaultCwd: cwd, prefsFile: prefsIn(makeProject()) }, (p, run) => {
      run.emit(initMsg(id));
      run.emit(assistantText(`reply to ${p}`));
      run.emit(resultMsg(0.002, id));
    });
    await backend.refreshSessions(false);
    await backend.openSession(id, cwd);
    expect(texts(backend)).toEqual(['What does main.ts do?', 'It starts the server.']);
    expect(runs[0].options.resume).toBe(id);
    expect(runs[0].options.cwd).toBe(cwd);

    await backend.submit('and the tests?');
    await until(() => !backend.controller!.busy && texts(backend).length === 4);
    expect(texts(backend).slice(2)).toEqual(['and the tests?', 'reply to and the tests?']);
    expect(backend.snapshot()).toMatchObject({ sessionId: id, phase: 'ready', title: 'What does main.ts do?' });
    // The renderer received the history as a reset patch followed by incremental ones.
    const patches = events.filter((e) => e.type === 'transcript').map((e) => e.payload as { reset: boolean });
    expect(patches.some((p) => p.reset)).toBe(true);
  });

  it('switches between sessions in different projects without mixing transcripts', async () => {
    const p1 = makeProject();
    const p2 = makeProject();
    const s1 = writeTranscript(p1, [['first project question', 'first answer']]);
    const s2 = writeTranscript(p2, [['second project question', 'second answer']]);
    const { backend, runs, events } = backendFor({ defaultCwd: p1, prefsFile: prefsIn(makeProject()) });
    await backend.refreshSessions(false);

    await backend.openSession(s1, p1);
    expect(texts(backend)).toEqual(['first project question', 'first answer']);
    const first = backend.controller!;

    events.length = 0;
    await backend.openSession(s2, p2);
    expect(backend.controller).not.toBe(first);
    expect(first.session.closed).toBe(true); // the old runtime was shut down
    expect(texts(backend)).toEqual(['second project question', 'second answer']);
    expect(backend.snapshot()).toMatchObject({ sessionId: s2, cwd: p2 });
    expect(runs.map((r) => r.options.resume)).toEqual([s1, s2]);
    const firstPatch = events.find((e) => e.type === 'transcript')!.payload as { reset: boolean; changed: { text?: string }[] };
    expect(firstPatch.reset).toBe(true);
    expect(JSON.stringify(firstPatch)).not.toContain('first answer');

    // Back again: resumes s1 with its own history.
    await backend.openSession(s1, p1);
    expect(texts(backend)).toEqual(['first project question', 'first answer']);
    expect(runs[2].options.resume).toBe(s1);
  });

  it('a quick second switch wins over a slower first one', async () => {
    const p = makeProject();
    const s1 = writeTranscript(p, [['one', 'uno']]);
    const s2 = writeTranscript(p, [['two', 'dos']]);
    const { backend } = backendFor({ defaultCwd: p, prefsFile: prefsIn(makeProject()) });
    await Promise.all([backend.openSession(s1, p), backend.openSession(s2, p)]);
    expect(backend.snapshot().sessionId).toBe(s2);
    expect(texts(backend)).toEqual(['two', 'dos']);
  });
});

describe('persistence across restarts', () => {
  it('reopens the conversation that was open when the app quit', async () => {
    const cwd = makeProject();
    const state = makeProject();
    const older = writeTranscript(cwd, [['older chat', 'older reply']], { at: Date.now() - 60_000 });
    writeTranscript(cwd, [['newest chat', 'newest reply']]);

    const first = backendFor({ defaultCwd: cwd, prefsFile: prefsIn(state) });
    await first.backend.start();
    await first.backend.openSession(older, cwd);
    await first.backend.shutdown();
    expect(loadGuiPrefs(prefsIn(state)).last).toEqual({ sessionId: older, cwd });

    // "Restart": a fresh backend with the same state file restores the older chat, not the newest.
    const second = backendFor({ defaultCwd: makeProject(), prefsFile: prefsIn(state) });
    await second.backend.start();
    expect(second.backend.snapshot()).toMatchObject({ sessionId: older, cwd, phase: 'ready' });
    expect(texts(second.backend)).toEqual(['older chat', 'older reply']);
    expect(second.runs[0].options.resume).toBe(older);
  });

  it('a new conversation is remembered once the runtime saves it, and restored after restart', async () => {
    const cwd = makeProject();
    const state = makeProject();
    const newId = '11111111-2222-4333-8444-555555555555';
    const first = backendFor({ defaultCwd: cwd, prefsFile: prefsIn(state) }, (p, run) => {
      run.emit(initMsg(newId));
      run.emit(assistantText('Created hello.py'));
      // What the real runtime does: append the turn to the session's transcript file.
      writeTranscript(cwd, [[p, 'Created hello.py']], { id: newId });
      run.emit(resultMsg(0.003, newId));
    });
    await first.backend.start();
    expect(first.backend.snapshot().sessionId).toBeNull();
    await first.backend.submit('write hello.py');
    await until(() => first.backend.snapshot().sessionId === newId && !first.backend.controller!.busy);
    await until(() => first.backend.sessionGroups.some((g) => g.sessions.some((s) => s.id === newId)));
    expect(loadGuiPrefs(prefsIn(state)).last).toEqual({ sessionId: newId, cwd });
    await first.backend.shutdown();

    const second = backendFor({ defaultCwd: cwd, prefsFile: prefsIn(state) });
    await second.backend.start();
    expect(second.backend.snapshot().sessionId).toBe(newId);
    expect(texts(second.backend)).toEqual(['write hello.py', 'Created hello.py']);
    expect(second.runs[0].options.resume).toBe(newId);
  });

  it('starts fresh when the remembered session was deleted, and honours an explicit project', async () => {
    const cwd = makeProject();
    const other = makeProject();
    const state = makeProject();
    const id = writeTranscript(cwd, [['soon gone', 'ok']]);
    const a = backendFor({ defaultCwd: cwd, prefsFile: prefsIn(state) });
    await a.backend.start();
    await a.backend.openSession(id, cwd);
    await a.backend.deleteSession(id, cwd);
    await a.backend.shutdown();

    const b = backendFor({ defaultCwd: cwd, prefsFile: prefsIn(state) });
    await b.backend.start();
    expect(b.backend.snapshot()).toMatchObject({ sessionId: null, cwd });
    expect(b.runs[0].options.resume).toBeUndefined();
    await b.backend.shutdown();

    const c = backendFor({ defaultCwd: cwd, cwd: other, prefsFile: prefsIn(state) });
    await c.backend.start();
    expect(c.backend.snapshot()).toMatchObject({ sessionId: null, cwd: other });
  });
});

describe('last activity dates', () => {
  /** Like the real runtime: a resumed session appends bookkeeping to its transcript when it closes. */
  function bookkeepingBackend(cwd: string, responder: Parameters<typeof makeFakeQuery>[0] = () => {}) {
    const fake = makeFakeQuery(responder);
    const queryFn = ((args: Parameters<typeof fake.queryFn>[0]) => {
      const q = fake.queryFn(args);
      const close = q.close.bind(q);
      const resume = args.options?.resume;
      q.close = () => {
        if (resume) appendFileSync(join(projectFolder(cwd), `${resume}.jsonl`), JSON.stringify({ type: 'mode', mode: 'normal', sessionId: resume }) + '\n');
        close();
      };
      return q;
    }) as typeof fake.queryFn;
    const backend = new GuiBackend({ defaultCwd: cwd, prefsFile: prefsIn(makeProject()), emit: () => {}, queryFn, costStore: null, throttleMs: 0 });
    live.push(backend);
    return backend;
  }
  const mtimeOf = (cwd: string, id: string) => statSync(join(projectFolder(cwd), `${id}.jsonl`)).mtimeMs;

  it('viewing a conversation without sending anything keeps its date', async () => {
    const cwd = makeProject();
    const at = Date.now() - 5 * 86_400_000;
    const id = writeTranscript(cwd, [['old question', 'old answer']], { at });
    const other = writeTranscript(cwd, [['other', 'x']]);
    const backend = bookkeepingBackend(cwd);
    await backend.openSession(id, cwd);
    await backend.openSession(other, cwd); // closes id: the runtime appends, the backend restores mtime
    expect(readFileSync(join(projectFolder(cwd), `${id}.jsonl`), 'utf8')).toContain('"type":"mode"');
    expect(Math.abs(mtimeOf(cwd, id) - at)).toBeLessThan(1000);
  });

  it('sending a message does move the date', async () => {
    const cwd = makeProject();
    const at = Date.now() - 5 * 86_400_000;
    const id = writeTranscript(cwd, [['old question', 'old answer']], { at });
    const backend = bookkeepingBackend(cwd, (_p, run) => {
      run.emit(initMsg(id));
      run.emit(resultMsg(0.001, id));
    });
    await backend.openSession(id, cwd);
    await backend.submit('follow-up');
    await until(() => backend.controller!.cost.snapshot().turns === 1 && !backend.controller!.busy);
    await backend.newSession(cwd);
    expect(mtimeOf(cwd, id) - at).toBeGreaterThan(60_000);
  });
});

describe('rename, delete and new', () => {
  it('renames through the SDK and the new title shows in the list', async () => {
    const cwd = makeProject();
    const id = writeTranscript(cwd, [['original prompt text', 'ok']]);
    const { backend, events } = backendFor({ defaultCwd: cwd, prefsFile: prefsIn(makeProject()) });
    await backend.refreshSessions(false);
    await backend.renameSession(id, cwd, '  Login   bug  ');
    const g = backend.sessionGroups.find((x) => x.cwd === cwd)!;
    expect(g.sessions[0]).toMatchObject({ id, title: 'Login bug' });
    expect(events.some((e) => e.type === 'sessions')).toBe(true);
    await expect(backend.renameSession(id, cwd, '   ')).rejects.toThrow(/empty/);
  });

  it('deletes a session from disk; deleting the open one starts a new conversation', async () => {
    const cwd = makeProject();
    const keep = writeTranscript(cwd, [['keep me', 'ok']], { at: Date.now() - 1000 });
    const drop = writeTranscript(cwd, [['delete me', 'ok']]);
    const { backend, runs } = backendFor({ defaultCwd: cwd, prefsFile: prefsIn(makeProject()) });
    await backend.refreshSessions(false);
    await backend.openSession(drop, cwd);
    const opened = backend.controller!;
    await backend.deleteSession(drop, cwd);
    expect(opened.session.closed).toBe(true);
    expect(existsSync(join(projectFolder(cwd), `${drop}.jsonl`))).toBe(false);
    expect(backend.sessionGroups.find((g) => g.cwd === cwd)!.sessions.map((s) => s.id)).toEqual([keep]);
    expect(backend.snapshot()).toMatchObject({ sessionId: null, cwd });
    expect(runs.at(-1)!.options.resume).toBeUndefined();
    expect(readdirSync(projectFolder(cwd)).filter((f) => f.endsWith('.jsonl'))).toEqual([`${keep}.jsonl`]);
  });

  it('/clear in the composer opens a new conversation instead of the terminal behaviour', async () => {
    const cwd = makeProject();
    const id = writeTranscript(cwd, [['hi', 'hello']]);
    const { backend, runs } = backendFor({ defaultCwd: cwd, prefsFile: prefsIn(makeProject()) });
    await backend.refreshSessions(false);
    await backend.openSession(id, cwd);
    await backend.submit('/clear');
    expect(backend.snapshot().sessionId).toBeNull();
    expect(texts(backend)).toEqual([]);
    expect(runs).toHaveLength(2);
    await backend.submit('/model');
    expect(JSON.stringify(backend.controller!.transcript.items)).toContain('top bar');
    expect(backend.controller!.overlay).toBeNull();
  });
});

describe('sidebar status', () => {
  it('marks a session done when its turn finishes, not while running and not when stopped', async () => {
    const cwd = makeProject();
    let release = () => {};
    const { backend } = backendFor({ defaultCwd: cwd, prefsFile: prefsIn(makeProject()) }, async (p, run) => {
      run.emit(initMsg('s-status'));
      if (p === 'slow') await new Promise<void>((r) => (release = r));
      run.emit(assistantText('ok'));
      run.emit(resultMsg(0.001, 's-status'));
    });
    await backend.start();
    expect(backend.snapshot().finished).toEqual([]);

    await backend.submit('quick');
    await until(() => !backend.controller!.busy && backend.snapshot().sessionId === 's-status');
    expect(backend.snapshot().finished).toEqual(['s-status']);

    await backend.submit('slow');
    await until(() => backend.controller!.busy);
    expect(backend.snapshot()).toMatchObject({ busy: true, finished: [] });

    await backend.interrupt();
    release();
    await until(() => !backend.controller!.busy);
    expect(backend.snapshot().finished).toEqual([]);

    await backend.submit('quick');
    await until(() => !backend.controller!.busy && backend.snapshot().finished.length === 1);
    expect(backend.snapshot().finished).toEqual(['s-status']);
  });
});

describe('several conversations running at once', () => {
  /** Two saved sessions whose turns wait for release(id); "ask" turns stop at a permission prompt. */
  function twoSessions() {
    const cwd = makeProject();
    const s1 = writeTranscript(cwd, [['first', 'ok']], { at: Date.now() - 2000 });
    const s2 = writeTranscript(cwd, [['second', 'ok']], { at: Date.now() - 1000 });
    const gates = new Map<string, () => void>();
    const release = (id: string) => gates.get(id)?.();
    const fake = backendFor({ defaultCwd: cwd, prefsFile: prefsIn(makeProject()) }, async (p, run) => {
      const id = run.options.resume as string;
      run.emit(initMsg(id));
      if (p === 'ask') {
        run.emit(assistantToolUse('tu-' + id, 'Bash', { command: 'npm test' }));
        await run.options.canUseTool!('Bash', { command: 'npm test' }, { signal: new AbortController().signal, toolUseID: 'tu-' + id, requestId: 'r' } as never);
      } else await new Promise<void>((r) => gates.set(id, r));
      run.emit(assistantText(`done ${p}`));
      run.emit(resultMsg(0.001, id));
    });
    return { cwd, s1, s2, release, ...fake };
  }

  it('keeps a switched-away turn running and marks it done when it finishes', async () => {
    const { backend, cwd, s1, s2, release, runs } = twoSessions();
    await backend.refreshSessions(false);
    await backend.openSession(s1, cwd);
    const c1 = backend.controller!;
    await backend.submit('long job');
    await until(() => c1.busy);

    await backend.openSession(s2, cwd);
    expect(c1.session.closed).toBe(false);
    expect(backend.snapshot()).toMatchObject({ sessionId: s2, busy: false, running: [s1] });
    await backend.submit('other job');
    await until(() => backend.snapshot().running.length === 2);
    expect(backend.snapshot().running.sort()).toEqual([s1, s2].sort());

    release(s1);
    await until(() => backend.snapshot().finished.includes(s1));
    await until(() => c1.session.closed);
    expect(backend.snapshot()).toMatchObject({ running: [s2], sessionId: s2 });
    expect(texts(backend)).toEqual(['second', 'ok', 'other job']); // s1's reply never leaked into the open view

    release(s2);
    await until(() => backend.snapshot().finished.includes(s2));
    // Reopening the finished background conversation resumes it from disk.
    await backend.openSession(s1, cwd);
    expect(runs.at(-1)!.options.resume).toBe(s1);
  });

  it('reopening a still-running conversation reattaches to the live turn', async () => {
    const { backend, cwd, s1, s2, release, runs } = twoSessions();
    await backend.refreshSessions(false);
    await backend.openSession(s1, cwd);
    const c1 = backend.controller!;
    await backend.submit('long job');
    await until(() => c1.busy);
    await backend.openSession(s2, cwd);
    const started = runs.length;

    await backend.openSession(s1, cwd);
    expect(backend.controller).toBe(c1);
    expect(runs).toHaveLength(started);
    expect(backend.snapshot()).toMatchObject({ phase: 'ready', sessionId: s1, busy: true, running: [s1] });
    expect(texts(backend)).toEqual(['first', 'ok', 'long job']);

    release(s1);
    await until(() => !c1.busy);
    expect(texts(backend)).toEqual(['first', 'ok', 'long job', 'done long job']);
    expect(c1.session.closed).toBe(false); // in view: stays open
  });

  it('flags a background conversation stopped at a prompt, and shows the prompt when reopened', async () => {
    const { backend, cwd, s1, s2 } = twoSessions();
    await backend.refreshSessions(false);
    await backend.openSession(s1, cwd);
    await backend.submit('ask');
    await until(() => backend.snapshot().prompt !== null);
    await backend.openSession(s2, cwd);
    expect(backend.snapshot()).toMatchObject({ prompt: null, waiting: [s1], running: [s1] });

    await backend.openSession(s1, cwd);
    expect(backend.snapshot()).toMatchObject({ waiting: [], prompt: { kind: 'tool', toolName: 'Bash' } });
    backend.answer({ kind: 'allow' });
    await until(() => backend.snapshot().finished.includes(s1));
  });

  it('keeps a new conversation in the list after switching away mid-turn, before its transcript is saved', async () => {
    const cwd = makeProject();
    const saved = writeTranscript(cwd, [['older', 'ok']]);
    let release = () => {};
    const { backend, events } = backendFor({ defaultCwd: cwd, prefsFile: prefsIn(makeProject()) }, async (p, run) => {
      run.emit(initMsg('fresh-1')); // the runtime has an id but has written nothing the list can read
      await new Promise<void>((r) => (release = r));
      run.emit(assistantText('done'));
      run.emit(resultMsg(0.001, 'fresh-1'));
    });
    await backend.refreshSessions(false);
    await backend.newSession(cwd);
    const c = backend.controller!;
    await backend.submit('brand new job');
    await until(() => c.busy && c.sessionId === 'fresh-1');

    await backend.openSession(saved, cwd);
    await until(() => backend.sessionGroups.some((g) => g.sessions.some((s) => s.id === 'fresh-1')));
    const row = backend.sessionGroups.flatMap((g) => g.sessions).find((s) => s.id === 'fresh-1')!;
    expect(row.title).toBe('brand new job');
    const last = events.filter((e) => e.type === 'sessions').at(-1)!;
    expect((last.payload as typeof backend.sessionGroups).flatMap((g) => g.sessions).map((s) => s.id)).toContain('fresh-1');
    release();
  });

  it('keeps a conversation whose turn ended alive while its background agents run, after switching away', async () => {
    const cwd = makeProject();
    const s1 = writeTranscript(cwd, [['first', 'ok']], { at: Date.now() - 2000 });
    const s2 = writeTranscript(cwd, [['second', 'ok']], { at: Date.now() - 1000 });
    let agentRun: Parameters<Parameters<typeof makeFakeQuery>[0]>[1] | null = null;
    const { backend } = backendFor({ defaultCwd: cwd, prefsFile: prefsIn(makeProject()) }, (p, run) => {
      const id = run.options.resume as string;
      run.emit(initMsg(id));
      if (p === 'launch agents') {
        agentRun = run;
        run.emit({ type: 'system', subtype: 'task_started', task_id: 't1', description: 'season build', session_id: id, uuid: 'u1' } as never);
      }
      run.emit(assistantText('started'));
      run.emit(resultMsg(0.001, id));
    });
    await backend.refreshSessions(false);
    await backend.openSession(s1, cwd);
    const c1 = backend.controller!;
    await backend.submit('launch agents');
    await until(() => !c1.busy && c1.backgroundTasks === 1);

    await backend.openSession(s2, cwd);
    expect(c1.session.closed).toBe(false); // switching away must not kill the agent
    expect(backend.snapshot().running).toEqual([s1]);
    expect(backend.runningCount).toBe(1); // quitting warns

    // The agent reports back; the runtime answers on its own, then the conversation is freed.
    agentRun!.emit({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', output_file: '/tmp/x', summary: 'done', session_id: s1, uuid: 'u2' } as never);
    agentRun!.emit(assistantText('the season build finished'));
    agentRun!.emit(resultMsg(0.001, s1));
    await until(() => c1.session.closed);
    expect(backend.snapshot().finished).toContain(s1);
  });

  it('deleting or quitting shuts background turns down', async () => {
    const { backend, cwd, s1, s2 } = twoSessions();
    await backend.refreshSessions(false);
    await backend.openSession(s1, cwd);
    const c1 = backend.controller!;
    await backend.submit('long job');
    await until(() => c1.busy);
    await backend.openSession(s2, cwd);
    await backend.deleteSession(s1, cwd);
    expect(c1.session.closed).toBe(true);
    expect(backend.snapshot().running).toEqual([]);

    const c2 = backend.controller!;
    await backend.submit('other job');
    await until(() => c2.busy);
    await backend.newSession(cwd);
    expect(c2.session.closed).toBe(false);
    await backend.shutdown();
    expect(c2.session.closed).toBe(true);
  });
});

describe('prompts, model and mode', () => {
  it('surfaces a permission prompt in the snapshot and routes the answer back', async () => {
    const cwd = makeProject();
    const { backend } = backendFor({ defaultCwd: cwd, prefsFile: prefsIn(makeProject()) }, async (_p, run) => {
      run.emit(initMsg('s-perm'));
      run.emit(assistantToolUse('tu1', 'Bash', { command: 'npm test' }));
      const d = await run.options.canUseTool!('Bash', { command: 'npm test' }, { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r' } as never);
      run.emit(toolResult('tu1', d.behavior === 'allow' ? 'all green' : 'denied', d.behavior !== 'allow'));
      run.emit(resultMsg(0.001, 's-perm'));
    });
    await backend.start();
    await backend.submit('run the tests');
    await until(() => backend.snapshot().prompt !== null);
    expect(backend.snapshot().prompt).toMatchObject({ kind: 'tool', toolName: 'Bash', verb: 'Bash', arg: 'npm test', ruleLabel: 'Bash(npm:*)' });
    backend.answer({ kind: 'allow' });
    await until(() => !backend.controller!.busy);
    expect(backend.snapshot().prompt).toBeNull();
    expect(backend.controller!.transcript.items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'done', result: 'all green' });
  });

  it('remembers the model choice across restarts and only offers the desktop modes', async () => {
    const cwd = makeProject();
    const state = makeProject();
    const a = backendFor({ defaultCwd: cwd, prefsFile: prefsIn(state) });
    await a.backend.start();
    await a.backend.setModel('claude-sonnet-5-5');
    await a.backend.setMode('plan');
    expect(a.backend.snapshot()).toMatchObject({ model: 'claude-sonnet-5-5', mode: 'plan' });
    await expect(a.backend.setMode('bypassPermissions' as never)).rejects.toThrow(/Unsupported/);
    await a.backend.shutdown();

    const b = backendFor({ defaultCwd: cwd, prefsFile: prefsIn(state) });
    await b.backend.start();
    expect(b.runs[0].options.model).toBe('claude-sonnet-5-5');
  });
});

describe('transcript transport', () => {
  it('sends only changed items, redacted, with tool rows pre-summarized', () => {
    const model = new TranscriptModel();
    const differ = new TranscriptDiffer();
    model.addUser('hello');
    const first = differ.diff(model.items, '/tmp')!;
    expect(first.reset).toBe(true);
    expect(first.changed).toHaveLength(1);
    expect(differ.diff(model.items, '/tmp')).toBeNull();

    model.apply(assistantToolUse('t9', 'Bash', { command: `echo ${process.env.ANTHROPIC_API_KEY}` }));
    model.apply(toolResult('t9', `key is ${process.env.ANTHROPIC_API_KEY}`));
    const next = differ.diff(model.items, '/tmp')!;
    expect(next.reset).toBe(false);
    expect(next.changed.map((c) => c.kind)).toEqual(['tool']);
    const wire = JSON.stringify(next);
    expect(wire).not.toContain(process.env.ANTHROPIC_API_KEY!);
    expect(next.changed[0]).toMatchObject({ verb: 'Bash', status: 'done' });
    expect(next.order).toHaveLength(2);
  });

  it('edit tool rows carry a diff', () => {
    const model = new TranscriptModel();
    model.apply(assistantToolUse('e1', 'Edit', { file_path: '/nope/a.txt', old_string: 'cold', new_string: 'frozen' }));
    model.apply(toolResult('e1', 'ok'));
    const item = toGuiItem(model.items[0], '/nope');
    expect(item.kind === 'tool' && item.diff?.map((l) => `${l.type}:${l.text}`)).toEqual(['remove:cold', 'add:frozen']);
  });
});

describe('API key isolation', () => {
  it('stashApiKey removes the key from process.env but keeps it for the runtime and the redactor', () => {
    const key = process.env.ANTHROPIC_API_KEY!;
    try {
      stashApiKey();
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(hasApiKey()).toBe(true);
      expect(buildAgentEnv().ANTHROPIC_API_KEY).toBe(key);
      expect(redact(`x ${key} y`)).not.toContain(key);
      expect(hasApiKey({})).toBe(false);
    } finally {
      process.env.ANTHROPIC_API_KEY = key;
    }
  });
});

describe('frostcode gui', () => {
  it('is parsed as a subcommand', () => {
    expect(parseArgs(['gui']).sub).toEqual(['gui']);
    expect(parseArgs(['gui', '~/code/app', '--wait']).sub).toEqual(['gui', '~/code/app', '--wait']);
  });
});

