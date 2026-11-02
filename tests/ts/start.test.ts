/* Bats -> Vitest:
start: dies when config.json is missing -> start: shell compatibility: config.json missing
start: dies when config.json has no listen_port -> start: shell compatibility: config.json has no listen_port
start: rejects an out-of-range listen_port -> start: shell compatibility: invalid listen_port
start: dies when docker is not installed -> start: shell compatibility: docker missing
start: dies when the Docker daemon is down -> start: shell compatibility: daemon down
start: self-check passes against a stubbed docker and a live local port -> start: self-check passes with a live local port; extra/unknown args are ignored
init: refuses to run as a non-root user -> intentionally dropped (TS init never needs root, AC12)
init: installs jq (needed by scripts/isp-outbound.sh) and reports it -> intentionally dropped (TS init does not apt-install packages, AC12)
*/
import { it, expect, vi } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { parseListenPorts, realStartDeps, redact, secretValues, startNode, type StartDeps } from '../../src/index.js';
import { envQuote } from '../../src/core/env.js';
import { invoke, project, shellEnv } from './helpers/cli.js';
import { creds, fixtureText, isp } from './helpers/fixtures.js';

const secrets = [creds.realityPrivateKey, creds.ssPassword, creds.vlessUuid, isp.user, isp.pass];
const childOutput = `child: ${secrets.join(' | ')}\n`;
const udpLine = 'UNCONN 0 0 0.0.0.0:8388 0.0.0.0:*\n';
function fakeStart(): StartDeps {
  return {
    run: vi.fn(async (file, args) => ({
      code: 0,
      stdout: file === 'ss' ? udpLine : args[0] === 'inspect' ? 'running\n' : childOutput,
      stderr: childOutput,
    })),
    tcpOpen: vi.fn(async () => true),
    sleep: vi.fn(async () => {}),
  };
}
function config(dir: string, port = 8443) {
  writeFileSync(join(dir, 'config.json'), `{"inbounds":[{"listen_port":${port}}]}`);
}
function privateOutput(result: { stdout: string; stderr: string }) {
  for (const secret of secrets) expect(result.stdout + result.stderr).not.toContain(secret);
}

it.each([
  ['config.json missing', 'config.json does not exist. Run scripts/gen-config.sh first.'],
  ['config.json has no listen_port', 'config.json has no listen_port.'],
  ['invalid listen_port', 'Invalid listen_port in config.json: 70000'],
  ['compose.yaml missing', 'compose.yaml does not exist.'],
  ['docker missing', 'docker is not installed.'],
  ['compose unavailable', 'docker compose is not available.'],
  ['daemon down', 'Docker daemon is not running.'],
])('start: shell compatibility: %s', async (failure, message) => {
  const dir = project(fixtureText(true)), deps = fakeStart();
  config(dir);
  if (failure === 'config.json missing') rmSync(join(dir, 'config.json'));
  if (failure === 'config.json has no listen_port') writeFileSync(join(dir, 'config.json'), '{}');
  if (failure === 'invalid listen_port') config(dir, 70000);
  if (failure === 'compose.yaml missing') {
    rmSync(join(dir, 'compose.yaml'));
    rmSync(join(dir, 'config.json'));
  }
  const bin = join(dir, 'stubs');
  mkdirSync(bin);
  for (const tool of ['bash', 'dirname', 'grep', 'cat']) symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
  if (failure !== 'docker missing') writeFileSync(join(bin, 'docker'), `#!/bin/bash
case "$*" in
  'compose version') exit ${failure === 'compose unavailable' ? 1 : 0} ;;
  info) exit ${failure === 'daemon down' ? 1 : 0} ;;
esac
`, { mode: 0o755 });
  if (failure === 'compose unavailable') deps.run = vi.fn(async () => ({ code: 1, stdout: childOutput, stderr: childOutput }));
  const args = ['extra', '--unknown'];
  const shell = spawnSync('/bin/bash', [join(dir, 'scripts/start.sh'), ...args], {
    cwd: dir, env: { ...shellEnv, PATH: bin }, encoding: 'utf8',
  });
  const result = await invoke('start', dir, {
    start: deps,
    deps: { dockerAvailable: async () => failure !== 'docker missing', dockerDaemonUp: async () => failure !== 'daemon down' },
  }, args);
  expect(result.code).toBe(1);
  expect(result.code).toBe(shell.status);
  // Only wording difference from v1.1.0: npx installs ship no scripts/, so point at the CLI.
  expect(result.stderr).toBe(`Error: ${message.replace('scripts/gen-config.sh', 'my-singbox gen-config')}\n`);
  expect(shell.stderr).toBe(`Error: ${message}\n`);
  expect(result.stdout).toBe(shell.stdout);
  expect(deps.tcpOpen).not.toHaveBeenCalled();
  privateOutput(result);
});

it('start: self-check passes with a live local port; extra/unknown args are ignored', async (ctx) => {
  const server = createServer((socket) => socket.resume());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') ctx.skip('Sandbox denies loopback listeners');
    throw error;
  }
  try {
    const port = (server.address() as AddressInfo).port;
    const dir = project(fixtureText(true) + 'malformed line\n'), deps = fakeStart();
    config(dir, port);
    deps.tcpOpen = realStartDeps().tcpOpen;
    const result = await invoke('start', dir, { start: deps }, ['extra', '--unknown']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Self-check passed. Ports: ${port}\n`);
    expect(result.stdout).toContain('Starting sing-box...\n');
    expect(deps.run).toHaveBeenCalledWith('docker', ['compose', '--project-directory', dir, 'up', '-d']);
    expect(vi.mocked(deps.run).mock.calls.filter(([, args]) => args.includes('up'))).toHaveLength(1);
    expect(deps.run).toHaveBeenCalledWith('docker', ['compose', '--project-directory', dir, 'exec', '-T', 'sing-box', 'sing-box', 'check', '-c', '/etc/sing-box/config.json']);
    expect(deps.run).toHaveBeenCalledTimes(5);
    privateOutput(result);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([
  ['container never running', 'sing-box did not stay running (status: exited).'],
  ['container missing', 'sing-box did not stay running (status: missing).'],
  ['config check fails', 'sing-box config check failed.'],
  ['TCP closed', 'Port 8443 is not accepting connections.'],
  ['UDP wrong owner', 'UDP port 8388 is not owned by sing-box.'],
  ['UDP not listening', 'UDP port 8388 is not listening.'],
  ['UDP command fails', 'UDP port 8388 is not listening.'],
  ['final status fails', 'sing-box did not stay running (status: exited).'],
  ['up fails', 'docker compose up failed.'],
])('start: %s, with redacted child output', async (failure, message) => {
  const dir = project(fixtureText(true)), deps = fakeStart(), run = deps.run;
  config(dir, failure.startsWith('UDP') ? 8388 : 8443);
  let inspections = 0;
  deps.run = vi.fn(async (file, args) => {
    const result = await run(file, args);
    if (args[0] === 'inspect') {
      inspections++;
      if (failure === 'container never running' || (failure === 'final status fails' && inspections === 2)) result.stdout = 'exited\n';
      if (failure === 'container missing') { result.code = 1; result.stdout = childOutput; }
    }
    if (failure === 'config check fails' && args.includes('exec')) result.code = 1;
    if (failure === 'up fails' && args.includes('up')) result.code = 1;
    if (args.includes('logs')) result.code = 17;
    if (file === 'ss' && failure === 'UDP wrong owner' && args[0] === '-ulnp') result.stdout = udpLine.trimEnd() + ' users:(("other",pid=42))\n';
    if (file === 'ss' && failure === 'UDP not listening') result.stdout = 'UNCONN 0 0 0.0.0.0:18388 0.0.0.0:*\n';
    if (file === 'ss' && failure === 'UDP command fails') result.code = 1;
    return result;
  });
  if (failure === 'TCP closed') deps.tcpOpen = vi.fn(async () => false);
  const result = await invoke('start', dir, { start: deps });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`Error: ${message}\n`);
  expect(result.stdout).not.toContain('Self-check passed.');
  const calls = vi.mocked(deps.run).mock.calls;
  if (failure !== 'up fails') {
    expect(deps.run).toHaveBeenLastCalledWith('docker', ['compose', '--project-directory', dir, 'logs', '--tail', '50', 'sing-box']);
    expect(result.stderr).toContain(redact(childOutput, secrets));
  }
  if (failure.startsWith('container')) {
    expect(inspections).toBe(15);
    expect(deps.sleep).toHaveBeenCalledTimes(15);
  }
  if (failure === 'TCP closed') {
    expect(deps.tcpOpen).toHaveBeenCalledTimes(10);
    expect(deps.sleep).toHaveBeenCalledTimes(10);
  }
  if (failure === 'UDP not listening' || failure === 'UDP command fails') {
    expect(calls.filter(([file]) => file === 'ss')).toHaveLength(10);
    expect(deps.sleep).toHaveBeenCalledTimes(10);
  }
  privateOutput(result);
});

it.each(['missing', 'hidden owner', 'sing-box owner'])('start: UDP %s succeeds', async (owner) => {
  const dir = project(fixtureText(true)), deps = fakeStart(), run = deps.run;
  config(dir, 8388);
  deps.run = vi.fn(async (file, args) => file !== 'ss' ? run(file, args) : {
    code: owner === 'missing' ? 127 : 0,
    stdout: udpLine.trimEnd() + (owner === 'sing-box owner' ? ' users:(("sing-box",pid=42))\n' : '\n'),
    stderr: childOutput,
  });
  const result = await invoke('start', dir, { start: deps });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('Self-check passed. Ports: 8388\n');
  expect(result.stderr.includes('Warning: ss is not installed. Skipping UDP listener check for port 8388.\n')).toBe(owner === 'missing');
  expect(vi.mocked(deps.run).mock.calls.filter(([file]) => file === 'ss')).toHaveLength(owner === 'missing' ? 1 : 2);
  privateOutput(result);
});

it('start: extra/unknown args are ignored on success and help is handled generically', async () => {
  const dir = project(fixtureText(true)), deps = fakeStart();
  config(dir);
  const result = await invoke('start', dir, { start: deps }, ['extra', '--unknown']);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('Self-check passed. Ports: 8443\n');
  privateOutput(result);
  for (const help of ['--help', '-h']) expect(await invoke('start', dir, {}, [help])).toEqual({ code: 0, stdout: 'Usage: my-singbox start [args]\n', stderr: '' });
});

it('start: redacts unexpected inspect status in errors', async () => {
  const dir = project(fixtureText(true)), deps = fakeStart(), run = deps.run;
  config(dir);
  deps.run = async (file, args) => args[0] === 'inspect'
    ? { code: 0, stdout: childOutput, stderr: childOutput }
    : run(file, args);
  const result = await invoke('start', dir, { start: deps });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Error: sing-box did not stay running (status: child: ***');
  privateOutput(result);
});

it('start: retries container, TCP and UDP checks with one-second sleeps', async () => {
  const dir = project(), deps = fakeStart(), run = deps.run;
  config(dir, 8388);
  let inspections = 0, udpChecks = 0;
  deps.run = vi.fn(async (file, args) => {
    const result = await run(file, args);
    if (args[0] === 'inspect' && ++inspections === 1) result.stdout = 'created\n';
    if (file === 'ss' && args[0] === '-uln' && ++udpChecks === 1) result.stdout = '';
    return result;
  });
  deps.tcpOpen = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  expect((await invoke('start', dir, { start: deps })).code).toBe(0);
  expect(vi.mocked(deps.sleep).mock.calls).toEqual([[1000], [1000], [1000]]);
});

it('startNode: works without .env and checks every port in first-seen order', async () => {
  const dir = project(null), deps = fakeStart();
  writeFileSync(join(dir, 'config.json'), '{"listen_port":8443,"listen_port":12345,"listen_port":8443}');
  let stdout = '';
  await startNode({ project: dir, deps, dockerAvailable: async () => true, dockerDaemonUp: async () => true, stdout: (s) => { stdout += s; }, stderr: () => {} });
  expect(vi.mocked(deps.tcpOpen).mock.calls).toEqual([[8443], [12345]]);
  expect(stdout).toContain('Self-check passed. Ports: 8443 12345\n');
});

it('parseListenPorts: scans raw text, deduplicates and preserves order', () => {
  expect(parseListenPorts('text "listen_port" : 8443 "listen_port":8388 "listen_port":8443')).toEqual([8443, 8388]);
  expect(parseListenPorts('"listen_port":1 "listen_port":65535')).toEqual([1, 65535]);
});
it.each(['0', '70000', '00000', '999999999999999999999999999'])('parseListenPorts: rejects %s as written', (port) => {
  expect(() => parseListenPorts(`{"listen_port":${port}}`)).toThrow(`Invalid listen_port in config.json: ${port}`);
});
it.each(['{}', '"listen_port":-1', '"listen_port":"8388"'])('parseListenPorts: rejects text with no numeric listen_port: %s', (text) => {
  expect(() => parseListenPorts(text)).toThrow('config.json has no listen_port.');
});

it('secretValues: unquotes fixture secrets, skips empty/invalid values and tolerates malformed .env', () => {
  expect(secretValues(fixtureText(true))).toEqual([creds.vlessUuid, creds.realityPrivateKey, creds.ssPassword, isp.user, isp.pass]);
  expect(secretValues(`broken line\nSS_PASSWORD=\nVLESS_UUID=""\nREALITY_PRIVATE_KEY="bad\\q"\nISP_SOCKS_USER=${envQuote(isp.user)}\r\nISP_SOCKS_PASS=${envQuote(isp.pass)}\n`)).toEqual([isp.user, isp.pass]);
});
it('redact: replaces repeated literal secrets and handles overlapping values', () => {
  expect(redact(childOutput + childOutput, secrets)).toBe('child: *** | *** | *** | *** | ***\n'.repeat(2));
  expect(redact('prefix-value prefix', ['prefix', 'prefix-value'])).toBe('*** ***');
  expect(redact('unchanged', [])).toBe('unchanged');
});

it('realStartDeps: resolves child exit codes and captures both output streams', async () => {
  const deps = realStartDeps();
  expect(await deps.run('/bin/bash', ['-c', 'printf out; printf err >&2; exit 7'])).toEqual({ code: 7, stdout: 'out', stderr: 'err' });
  expect(await deps.run('/bin/bash', ['-c', 'exit 0'])).toEqual({ code: 0, stdout: '', stderr: '' });
  expect((await deps.run('/nonexistent/my-singbox-test-command', [])).code).toBe(127);
  expect(await deps.tcpOpen(1)).toBe(false);
  await deps.sleep(1);
});
