import { build } from 'esbuild';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

await build({
  entryPoints: { cli: 'src/cli/main.ts', index: 'src/index.ts' },
  outdir: 'dist',
  platform: 'node',
  target: 'node22',
  format: 'esm',
  bundle: true,
  minify: false,
  sourcemap: false,
});
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
