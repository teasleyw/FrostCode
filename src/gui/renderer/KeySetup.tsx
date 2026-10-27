import { useEffect, useRef, useState, type FormEvent } from 'react';
import { IconExternal, IconWarn } from './icons.js';
import { ipcErrorMessage } from './store.js';

const KEYS_URL = 'https://platform.claude.com/settings/keys';

/** First run without an API key: paste one here instead of setting an environment variable. */
export function KeySetup({ onDone }: { onDone(): void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await window.frost.saveApiKey(key);
      setKey('');
      onDone();
    } catch (err) {
      setError(ipcErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="setup">
      <header className="topbar drag setup-top" />
      <form className="setup-card" onSubmit={submit}>
        <h1>Welcome to FrostCode</h1>
        <p>
          FrostCode runs on your Anthropic API key, so what you use is billed to that API account. Paste a key to get started (
          <button type="button" className="work-link" onClick={() => void window.frost.openExternal(KEYS_URL)}>
            create one <IconExternal />
          </button>
          ).
        </p>
        <label className="setup-field">
          API key
          <input
            ref={input}
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-…"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
        </label>
        {error && (
          <div className="work-error">
            <IconWarn /> <span>{error}</span>
          </div>
        )}
        <div className="setup-bar">
          <button className="btn primary" disabled={busy || !key.trim()}>
            {busy ? 'Checking the key…' : 'Save and start'}
          </button>
        </div>
        <p className="setup-note">
          The key is checked with Anthropic, then saved on this computer as your <b>default</b> FrostCode account (the <code>frostcode</code> terminal command
          uses it too). Add or switch accounts later with <code>/account</code>.
        </p>
      </form>
    </div>
  );
}
