import { beforeAll, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, readdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { envQuote, envWithIsp } from '../../src/core/env.js';
import { creds, fixtureText, isp } from './helpers/fixtures.js';
import { invoke, project, root, keyDeps, shellEnv, stubKeyCommands, read } from './helpers/cli.js';

const secrets = [creds.realityPrivateKey, creds.realityPublicKey, creds.ssPassword, creds.vlessUuid, isp.user, isp.pass];
function assertNoSecrets(text: string) {
  for (const value of secrets) {
    expect(text).not.toContain(value);
    expect(text).not.toContain(envQuote(value));
  }
}

function built(cmd: string, dir: string, env = shellEnv, input?: string) {
  const stdout = openSync(join(dir, 'stdout.log'), 'w');
  const stderr = openSync(join(dir, 'stderr.log'), 'w');
  let stdin: number | undefined;
  if (input !== undefined) {
    writeFileSync(join(dir, 'stdin.txt'), input);
    stdin = openSync(join(dir, 'stdin.txt'), 'r');
  }
  try {
    const args: string[] = [];
    if (cmd === 'gen-keys') {
      const offline = join(dir, 'offline.mjs');
      writeFileSync(offline, `import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
https.get = () => { throw new Error('Offline fixture.'); };
syncBuiltinESMExports();
`);
      args.push('--import', offline);
    }
    const result = spawnSync(process.execPath, [...args, join(root, 'dist/cli.js'), cmd], { cwd: dir, env, stdio: [stdin ?? 'ignore', stdout, stderr] });
    expect(result.error).toBeUndefined();
    return { status: result.status, stdout: read(dir, 'stdout.log'), stderr: read(dir, 'stderr.log') };
  } finally {
    closeSync(stdout);
    closeSync(stderr);
    if (stdin !== undefined) closeSync(stdin);
  }
}

beforeAll(() => {
  execFileSync(process.execPath, ['tools/build.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
}, 30000);

it.each(['gen-config', 'conf-clash'])('AC9 %s success and invalid input paths never echo secrets', async (cmd) => {
  const base = fixtureText(true);
  const cases = [
    { id: 'success', text: base, code: 0 },
    { id: 'invalid uuid', text: base.replace(creds.vlessUuid, isp.pass), code: 1 },
    { id: 'invalid ss', text: base.replace(creds.ssPassword, isp.pass), code: 1 },
    { id: 'missing uuid', text: base.replace(/^VLESS_UUID=.*\n/m, ''), code: 1 },
    { id: 'invalid short id', text: base.replace(creds.realityShortId, isp.pass), code: 1 },
    { id: 'unknown key', text: base + `UNKNOWN=${creds.realityPrivateKey}\n`, code: 1 },
    { id: 'malformed line', text: base + `junk ${creds.realityPrivateKey} ${isp.pass}\n`, code: 1 },
    { id: 'duplicate', text: base + `SS_PASSWORD=${isp.pass}\n`, code: 1 },
    { id: 'partial ISP block', text: fixtureText() + `ISP_SOCKS_USER=${envQuote(isp.user)}\n`, code: cmd === 'gen-config' ? 1 : 0 },
    { id: 'invalid ISP addr', text: base.replace(isp.addr, isp.pass), code: cmd === 'gen-config' ? 1 : 0 },
    { id: 'invalid ISP user', text: envWithIsp(fixtureText(), { ...isp, user: `${isp.user}:invalid` }), code: cmd === 'gen-config' ? 1 : 0 },
    { id: 'invalid ISP pass', text: envWithIsp(fixtureText(), { ...isp, pass: `${isp.pass}\t` }), code: cmd === 'gen-config' ? 1 : 0 },
    { id: 'invalid egress', text: base.replace(isp.egressIp, isp.pass), code: cmd === 'gen-config' ? 1 : 0 },
    { id: 'invalid private key', text: base.replace(creds.realityPrivateKey, isp.pass), code: cmd === 'gen-config' ? 1 : 0 },
    { id: 'invalid public key', text: base.replace(creds.realityPublicKey, isp.pass), code: cmd === 'conf-clash' ? 1 : 0 },
    { id: 'invalid server', text: base.replace(creds.serverAddress, isp.pass), code: cmd === 'conf-clash' ? 1 : 0 },
  ];
  let allOutput = '';
  for (const { id, text, code } of cases) {
    const dir = project(text);
    const result = await invoke(cmd, dir);
    expect(result.code, id).toBe(code);
    allOutput += result.stdout + result.stderr;
    if (code === 1) expect(existsSync(join(dir, cmd === 'gen-config' ? 'config.json' : 'clash.yaml')), id).toBe(false);
  }
  for (const kind of ['missing', 'exists', 'invalid defaults']) {
    const dir = project(kind === 'missing' ? null : base);
    if (kind === 'exists') writeFileSync(join(dir, cmd === 'gen-config' ? 'config.json' : 'clash.yaml'), creds.realityPrivateKey);
    if (kind === 'invalid defaults') {
      if (cmd === 'gen-config') continue;
      writeFileSync(join(dir, 'templates/.env.template'), `junk ${isp.pass}`);
    }
    const result = await invoke(cmd, dir);
    expect(result.code).toBe(1);
    allOutput += result.stdout + result.stderr;
  }
  assertNoSecrets(allOutput);
});

it('AC9 gen-keys success and failure paths never echo generated or child-process secrets', async () => {
  let allOutput = '';
  for (const kind of ['success', 'invalid keys', 'missing version', 'exists', 'docker missing', 'daemon down', 'prompt EOF', 'prompt success']) {
    const dir = project(kind === 'exists' ? fixtureText(true) : null), deps = keyDeps();
    if (kind === 'invalid keys') deps.randomUuid = () => isp.pass;
    if (kind === 'docker missing') deps.dockerAvailable = async () => false;
    if (kind === 'daemon down') deps.dockerDaemonUp = async () => false;
    if (kind.startsWith('prompt')) deps.detectPublicIp = async () => null;
    const answers = [isp.pass, '8.8.4.4'];
    const result = await invoke('gen-keys', dir, {
      deps,
      env: kind === 'missing version' ? {} : { SING_BOX_VERSION: creds.singBoxVersion },
      readLine: async () => kind === 'prompt EOF' ? null : answers.shift()!,
    });
    expect(result.code, kind).toBe(['success', 'prompt success'].includes(kind) ? 0 : 1);
    if (!['success', 'prompt success', 'exists'].includes(kind)) expect(readdirSync(dir).filter((name) => name.startsWith('.env'))).toEqual([]);
    allOutput += result.stdout + result.stderr;
  }
  assertNoSecrets(allOutput);
});

it('AC9 unexpected exceptions print only their message without a stack', async () => {
  const result = await invoke('gen-keys', project(null), { deps: { ...keyDeps(), randomUuid: () => { throw new Error('Unexpected fixture failure.'); } } });
  expect(result.code).toBe(1);
  expect(result.stderr).toBe('Error: Unexpected fixture failure.\n');
});

it('AC9 built dist/cli.js never echoes a secret-looking junk line', () => {
  const junk = `junk-private-material ${creds.realityPrivateKey} ${isp.pass}`;
  const dir = project(fixtureText(true) + junk + '\n');
  const result = built('gen-config', dir);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/^Error: Invalid line \d+ in .env\n$/);
  const output = result.stdout + result.stderr;
  expect(output).not.toContain(junk);
  expect(output).not.toContain('junk-private-material');
  assertNoSecrets(output);
});

it('AC9 built gen-keys suppresses docker stderr/stdout on failure', () => {
  const dir = project(null);
  const env = stubKeyCommands(dir);
  writeFileSync(join(dir, 'stubs/docker'), '#!/bin/bash\nif [[ $1 == run ]]; then printf "%s\\n" "$FIX_PRIVATE"; printf "%s\\n" "$FIX_SS" >&2; exit 1; fi\n', { mode: 0o755 });
  const result = built('gen-keys', dir, { ...shellEnv, ...env }, '8.8.8.8\n');
  expect(result.status).toBe(1);
  expect(result.stderr).toBe('Could not detect a public IP address.\nError: Docker command failed.\n');
  expect(existsSync(join(dir, '.env'))).toBe(false);
  assertNoSecrets(result.stdout + result.stderr);
});

it.each(['', '10.0.0.1\n8.8.4.4\n'])('built readLine handles EOF and repeated non-TTY input case %#', (input) => {
  const dir = project(null), env = stubKeyCommands(dir);
  const result = built('gen-keys', dir, { ...shellEnv, ...env }, input);
  expect(result.status).toBe(input ? 0 : 1);
  expect(result.stderr).toBe(input
    ? 'Could not detect a public IP address.\nError: Enter a public IP address.\n'
    : 'Could not detect a public IP address.\nError: Failed to read the public IP address.\n');
  expect(result.stderr).not.toContain('Public IP address of this machine: ');
  if (input) expect(read(dir, '.env')).toContain('SERVER_ADDRESS=8.8.4.4\n');
  else expect(existsSync(join(dir, '.env'))).toBe(false);
  assertNoSecrets(result.stdout + result.stderr);
});
