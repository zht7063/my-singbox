import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { writeThirdPartyNotices } from './third-party-notices.mjs';
import { terminalBuildOptions } from './terminal-build-options.mjs';

const result = await build({
  entryPoints: { cli: 'src/cli/main.ts', index: 'src/index.ts' },
  outdir: 'dist',
  platform: 'node',
  target: 'node22',
  format: 'esm',
  bundle: true,
  ...terminalBuildOptions,
  minify: false,
  sourcemap: false,
  metafile: true,
  // yaml's Node entry uses require() inside the ESM bundle.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
writeThirdPartyNotices(result.metafile);
// esbuild preserves the CLI entry's shebang; avoid a second read/write pass.
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
