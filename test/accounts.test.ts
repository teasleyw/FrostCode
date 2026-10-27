import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppController } from '../src/app/controller.js';
import { activeAccount, addAccount, applySavedAccount, checkApiKey, listAccounts, removeAccount, useAccount } from '../src/config/accounts.js';
import { buildAgentEnv, frostHome, redact, selectAccountKey } from '../src/config/env.js';
import { initMsg, makeFakeQuery, resultMsg, until } from './helpers/fake-query.js';

const WORK = 'sk-ant-work-aaaaaaaaaaaaaaaa';
const PERSONAL = 'sk-ant-personal-bbbbbbbbbbbb';

afterEach(() => {
  for (const a of listAccounts()) if (a.name !== 'env') removeAccount(a.name);
  useAccount('env');
});

describe('saved accounts', () => {
  it('stores keys outside accounts.json and switches the runtime key', () => {
    addAccount('work', WORK);
    addAccount('personal', PERSONAL);
    expect(listAccounts().map((a) => a.name)).toEqual(['env', 'work', 'personal']);
    expect(activeAccount()).toBe('env');
    expect(buildAgentEnv().ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);

    useAccount('work');
    expect(buildAgentEnv().ANTHROPIC_API_KEY).toBe(WORK);
    useAccount('env');
    expect(buildAgentEnv().ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);

    // Windows has no Unix modes (the file is guarded by the profile folder's ACL instead).
    if (process.platform !== 'win32') expect(statSync(join(frostHome(), 'account-keys.json')).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(listAccounts())).not.toContain('sk-ant');
  });

  it('remembers the active account across launches', () => {
    addAccount('work', WORK);
    useAccount('work');
    selectAccountKey(undefined); // a fresh process
    expect(applySavedAccount()).toBeNull();
    expect(buildAgentEnv().ANTHROPIC_API_KEY).toBe(WORK);
  });

  it('rejects bad names, non-keys and unknown accounts', () => {
    expect(() => addAccount('env', WORK)).toThrow(/reserved/);
    expect(() => addAccount('a b', WORK)).toThrow(/names/);
    expect(() => addAccount('x', 'not-a-key')).toThrow(/API key/);
    expect(() => useAccount('nope')).toThrow(/No saved account/);
  });

  it('redacts the active saved key and the shell key', () => {
    addAccount('work', WORK);
    useAccount('work');
    const out = redact(`a ${WORK.slice(0)} b ${process.env.ANTHROPIC_API_KEY}`);
    expect(out).not.toContain(WORK);
    expect(out).not.toContain(process.env.ANTHROPIC_API_KEY!);
  });
});

describe('checking a key before it is saved', () => {
  it('rejects a malformed key without calling Anthropic, and explains a rejected one', async () => {
    let called = 0;
    const ok = async () => void called++;
    await expect(checkApiKey('not-a-key', ok)).rejects.toThrow(/does not look like/);
    expect(called).toBe(0);
    await expect(checkApiKey(` ${WORK} `, ok)).resolves.toBeUndefined();
    expect(called).toBe(1);
    const reject = async () => Promise.reject(Object.assign(new Error('401 invalid x-api-key'), { status: 401 }));
    await expect(checkApiKey(WORK, reject)).rejects.toThrow(/did not accept that key/);
    const offline = async () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.anthropic.com'));
    await expect(checkApiKey(WORK, offline)).rejects.toThrow(/Could not reach Anthropic.*ENOTFOUND/);
  });
});

describe('/account in a session', () => {
  it('restarts the runtime on the new key and resumes the same conversation', async () => {
    addAccount('work', WORK);
    const fake = makeFakeQuery((_p, run) => {
      run.emit(initMsg('sess-acct'));
      run.emit(resultMsg(0.001, 'sess-acct'));
    });
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'fc-proj-')));
    const ctrl = new AppController({ cwd, permissionMode: 'default', queryFn: fake.queryFn, costStore: null });
    await ctrl.boot();
    await ctrl.submit('hello');
    await until(() => !ctrl.busy && ctrl.sessionId === 'sess-acct');
    expect(fake.runs[0].options.env?.ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);

    await ctrl.submit('/account work');
    const last = fake.runs[fake.runs.length - 1];
    expect(last.options.env?.ANTHROPIC_API_KEY).toBe(WORK);
    expect(last.options.resume).toBe('sess-acct');
    expect(activeAccount()).toBe('work');

    await ctrl.submit('/account');
    await ctrl.shutdown();
  });
});
