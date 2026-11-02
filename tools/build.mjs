import { build } from 'esbuild';
import { chmod, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await build({
  entryPoints: { cli: 'src/cli/main.ts', index: 'src/index.ts' },
  outdir: 'dist',
  platform: 'node',
  target: 'node22',
  format: 'esm',
  bundle: true,
  minify: false,
  sourcemap: false,
  // yaml's Node entry uses require('process') inside the ESM bundle.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  define: { __VERSION__: JSON.stringify(pkg.version) },
});
const { writeFile } = await import('node:fs/promises');
await writeFile('dist/cli.js', '#!/usr/bin/env node\n' + (await readFile('dist/cli.js', 'utf8')));
await chmod('dist/cli.js', 0o755);
execFileSync(
  'node_modules/.bin/tsc',
  [
    '--ignoreConfig',
    '--types',
    'node',
    '--declaration',
    '--emitDeclarationOnly',
    '--noEmit',
    'false',
    '--outDir',
    'dist',
    '--rootDir',
    'src',
    '--target',
    'ES2022',
    '--module',
    'ESNext',
    '--moduleResolution',
    'Bundler',
    '--strict',
    '--skipLibCheck',
    'src/index.ts',
  ],
  { stdio: 'inherit' },
);
