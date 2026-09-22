// Bundles src/index.ts into index.js (the file manifest.json points at).
// Host modules are never imported statically; the runtime reaches SillyTavern
// through the global `SillyTavern.getContext()` and dynamic URL imports, so
// esbuild has nothing to resolve outside this package.
import { build, context } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');
const packageRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('esbuild').BuildOptions} */
const options = {
  absWorkingDir: packageRoot,
  entryPoints: [path.join(packageRoot, 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  outfile: path.join(packageRoot, 'index.js'),
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  banner: { js: '// RP Director — built by build.mjs. Edit src/, not this file.' },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching src/ …');
} else {
  await build(options);
}
