// Bundles the desktop renderer (React) into dist/gui/renderer. The main process and preload
// are compiled by tsc with the rest of FrostCode.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src/gui/renderer');
const out = join(root, 'dist/gui/renderer');
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(src, 'main.tsx')],
  outfile: join(out, 'renderer.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  jsx: 'automatic',
  minify: process.argv.includes('--minify'),
  sourcemap: true,
  define: { 'process.env.NODE_ENV': JSON.stringify(process.argv.includes('--dev') ? 'development' : 'production') },
  logLevel: 'warning',
});
for (const f of ['index.html', 'styles.css']) copyFileSync(join(src, f), join(out, f));
console.log('built dist/gui/renderer');
