import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { frostHome, redact } from '../config/env.js';

const file = () => join(frostHome(), 'prompt-history.json');

export function loadHistory(): string[] {
  try {
    const data = JSON.parse(readFileSync(file(), 'utf8'));
    return Array.isArray(data) ? data.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveHistory(entries: string[]): void {
  try {
    mkdirSync(frostHome(), { recursive: true });
    // Never persist anything that looks like a key someone pasted into the prompt.
    writeFileSync(file(), JSON.stringify(entries.slice(-200).map((e) => redact(e)), null, 0));
  } catch {
    /* best effort */
  }
}
