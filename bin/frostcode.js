#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(root, 'dist', 'cli.js');
if (!existsSync(built)) {
  console.error('FrostCode is not built yet. Run `npm run build` in ' + root);
  process.exit(1);
}
await import(built);
