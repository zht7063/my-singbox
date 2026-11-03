import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { terminalBuildOptions } from '../../tools/terminal-build-options.mjs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { composeImageTag } from '../../src/index.js';
import { project, root, shellEnv } from './helpers/cli.js';
import { creds } from './helpers/fixtures.js';

let bundleDir: string;
beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'main-deps-'));
  await build({
    entryPoints: [join(root, 'src/cli/main.ts')],
    outfile: join(bundleDir, 'cli.mjs'),
    platform: 'node',
    target: 'node22',
    format: 'esm',
    bundle: true,
    ...terminalBuildOptions,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
});
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

it('AC3: init without SING_BOX_VERSION generates keys using the compose image tag', () => {
  const dir = project(null);
  const bin = join(dir, 'stubs');
  mkdirSync(bin);
  const logFile = join(dir, 'docker.log');
  writeFileSync(logFile, '');
  const stubs = {
    docker: `echo "docker $*" >> '${logFile}'
case "$*" in
  *'generate uuid') printf '%s\\n' '${creds.vlessUuid}' ;;
  *'generate reality-keypair') printf 'PrivateKey: %s\\nPublicKey: %s\\n' '${creds.realityPrivateKey}' '${creds.realityPublicKey}' ;;
  *'generate rand --base64 16') printf '%s\\n' '${creds.ssPassword}' ;;
  'inspect '*) echo running ;;
  # Stop after key/config generation, before start checks real TCP listeners.
  'compose '*' exec '*) exit 1 ;;
esac
exit 0`,
    ss: 'exit 0',
  };
  for (const [name, body] of Object.entries(stubs))
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });

  // These host checks use Node builtins rather than commands from PATH.
  const preload = join(dir, 'host.mjs');
  writeFileSync(preload, `
import fs from 'node:fs';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
const accessSync = fs.accessSync;
fs.accessSync = (path, mode) => {
  if (path !== '/var/run/docker.sock') accessSync(path, mode);
};
https.get = (url, options, callback) => {
  const request = new EventEmitter();
  process.nextTick(() => {
    const response = Readable.from(['8.8.8.8\\n']);
    response.statusCode = 200;
    response.on('end', () => request.emit('close'));
    callback(response);
  });
  return request;
};
syncBuiltinESMExports();
`);

  const result = spawnSync(process.execPath, ['--import', preload, join(bundleDir, 'cli.mjs'), 'init'], {
    cwd: dir,
    env: { PATH: `${bin}:${shellEnv.PATH}`, LC_ALL: shellEnv.LC_ALL },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  const runs = readFileSync(logFile, 'utf8').split('\n').filter((line) => line.startsWith('docker run '));
  expect(runs.join('\n'), 'key generation must never use an empty sing-box image tag')
    .not.toMatch(/sing-box:(\s|$)/);
  const tag = composeImageTag(readFileSync(join(dir, 'compose.yaml'), 'utf8'));
  expect(runs.some((line) => line.startsWith(`docker run --rm ghcr.io/sagernet/sing-box:${tag} generate `)),
    result.stdout + result.stderr).toBe(true);
});
