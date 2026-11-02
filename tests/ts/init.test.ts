import { it, expect, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeImageTag, firewallPorts, renderSingbox, loadSingboxTemplate } from '../../src/index.js';
import { invoke, keyDeps, project, read, root } from './helpers/cli.js';
import { creds, fixtureModel, fixtureText, isp } from './helpers/fixtures.js';

const secrets = [creds.realityPrivateKey, creds.ssPassword, creds.vlessUuid, isp.user, isp.pass];
const childOutput = secrets.join(' | ') + '\n';
const pinnedTag = 'v1.14.4';
function fakeStart(withIsp = false) {
  const output = (withIsp ? secrets : secrets.slice(0, 3)).join(' | ') + '\n';
  return {
    run: vi.fn(async (file: string, args: string[]) => ({
      code: 0,
      stdout: file === 'ss' ? 'UNCONN 0 0 *:8388 *:*\n' : args[0] === 'inspect' ? 'running\n' : output,
      stderr: output,
    })),
    tcpOpen: vi.fn(async () => true),
    sleep: vi.fn(async () => {}),
  };
}
function privateOutput(result: { stdout: string; stderr: string }) {
  for (const secret of secrets) expect(result.stdout + result.stderr).not.toContain(secret);
}

it.each([undefined, '', 'v1.15.0'])('init: full flow with version override %s; arguments ignored', async (version) => {
  const dir = project(null), deps = keyDeps(), start = fakeStart();
  rmSync(join(dir, 'compose.yaml'));
  const result = await invoke('init', dir, { env: { SING_BOX_VERSION: version }, deps, start }, ['extra', '--unknown']);
  expect(result.code).toBe(0);
  expect(read(dir, 'compose.yaml')).toBe(readFileSync(join(root, 'compose.yaml'), 'utf8'));
  expect(result.stdout).toContain('Wrote compose.yaml\n');
  expect(read(dir, '.env')).toContain(`SING_BOX_VERSION=${version || pinnedTag}\n`);
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
  expect(existsSync(join(dir, 'config.json'))).toBe(true);
  expect(existsSync(join(dir, 'clash.yaml'))).toBe(true);
  expect(result.stdout).toContain('Self-check passed. Ports: 8388 8443\n');
  expect(result.stdout).toContain('Open these ports in the server firewall and the cloud security group (this tool never changes them):\n  8388/tcp\n  8388/udp\n  8443/tcp\n');
  expect(result.stdout).toContain(`Import clash.yaml into your Mihomo client: ${dir}/clash.yaml\n`);
  expect(start.run).toHaveBeenCalledWith('docker', ['compose', '--project-directory', dir, 'up', '-d']);
  privateOutput(result);
});

it('init: takes the default image tag from the project compose.yaml', async () => {
  const dir = project(null);
  const compose = read(dir, 'compose.yaml').replaceAll(pinnedTag, 'v1.13.9');
  writeFileSync(join(dir, 'compose.yaml'), compose);
  const result = await invoke('init', dir, { env: {}, start: fakeStart() });
  expect(result.code).toBe(0);
  expect(read(dir, '.env')).toContain('SING_BOX_VERSION=v1.13.9\n');
  expect(read(dir, 'compose.yaml')).toBe(compose);
  expect(result.stdout).not.toContain('Wrote compose.yaml');
});

it('init: re-runs keep existing files byte-for-byte and report them', async () => {
  const dir = project(fixtureText(true)), start = fakeStart(true), deps = keyDeps();
  expect((await invoke('init', dir, { start })).code).toBe(0);
  const files = ['compose.yaml', '.env', 'config.json', 'clash.yaml'];
  const before = files.map((file) => read(dir, file));
  const result = await invoke('init', dir, { start, deps });
  expect(result.code).toBe(0);
  expect(files.map((file) => read(dir, file))).toEqual(before);
  for (const file of files.slice(1)) expect(result.stdout).toContain(`${file} already exists, keeping it.\n`);
  expect(result.stdout).toContain('  8388/tcp\n  8388/udp\n  8443/tcp\n');
  expect(result.stdout).not.toMatch(/13839|18444/);
  expect(deps.runSingbox).not.toHaveBeenCalled();
  privateOutput(result);
});

it.each(['.env', 'config.json', 'clash.yaml'])('init: regenerates only missing %s', async (missing) => {
  const dir = project(null), deps = keyDeps(), start = fakeStart();
  expect((await invoke('init', dir, { start })).code).toBe(0);
  const files = ['.env', 'config.json', 'clash.yaml'].filter((f) => f !== missing);
  const before = files.map((f) => read(dir, f));
  rmSync(join(dir, missing));
  const result = await invoke('init', dir, { start, deps });
  expect(result.code).toBe(0);
  expect(existsSync(join(dir, missing))).toBe(true);
  expect(files.map((f) => read(dir, f))).toEqual(before);
  for (const file of files) expect(result.stdout).toContain(`${file} already exists, keeping it.\n`);
  expect(deps.runSingbox).toHaveBeenCalledTimes(missing === '.env' ? 2 : 0);
  privateOutput(result);
});

it.each(['compose missing', 'socket inaccessible'])('init: doctor failure (%s) writes nothing and never escalates', async (failure) => {
  const dir = project(null), start = fakeStart(), deps = keyDeps();
  rmSync(join(dir, 'compose.yaml'));
  const exec = vi.fn(async (file: string) => {
    if (failure === 'compose missing' && file !== 'id') throw new Error(childOutput);
    return 'fixture';
  });
  const result = await invoke('init', dir, {
    start, deps,
    system: {
      nodeVersion: '22.0.0', platform: 'linux', arch: 'x64', glibcVersionRuntime: '2.36',
      exec, socketAccessible: () => failure !== 'socket inaccessible', username: () => 'fixture',
    },
  });
  expect(result.code).toBe(1);
  for (const file of ['compose.yaml', '.env', 'config.json', 'clash.yaml']) expect(existsSync(join(dir, file))).toBe(false);
  expect(exec.mock.calls.some(([file]) => file === 'sudo' || file === 'apt-get')).toBe(false);
  expect(start.run).not.toHaveBeenCalled();
  expect(deps.runSingbox).not.toHaveBeenCalled();
  expect(result.stdout).toContain('sudo');
  if (failure === 'socket inaccessible') expect(result.stdout).toContain('Commands to run as root (printed only):');
  privateOutput(result);
});

it('init: prints the ss installation command once without executing it', async () => {
  const dir = project(null), exec = vi.fn(async (file: string) => {
    if (file === 'ss') throw new Error('missing');
    return '';
  });
  const result = await invoke('init', dir, {
    start: fakeStart(),
    system: { nodeVersion: '22.0.0', platform: 'linux', arch: 'x64', glibcVersionRuntime: '2.36', exec, socketAccessible: () => true, username: () => 'fixture' },
  });
  expect(result.code).toBe(0);
  const note = 'Note: ss (iproute2) not found; start will skip the UDP check. Install it as root: sudo apt-get install -y iproute2\n';
  expect(result.stdout.split(note)).toHaveLength(2);
  expect(exec.mock.calls.map(([file]) => file)).toEqual(['docker', 'ss']);
  privateOutput(result);
});

it.each(['generation', 'start'])('init: stops after %s failure and keeps secrets out of output', async (failure) => {
  const dir = project(failure === 'generation' ? null : fixtureText(true)), start = fakeStart(), deps = keyDeps();
  if (failure === 'generation') deps.dockerDaemonUp = async () => false;
  else {
    const run = start.run.getMockImplementation()!;
    start.run.mockImplementation(async (file, args) => ({ ...await run(file, args), ...(args.includes('exec') ? { code: 1 } : {}) }));
  }
  const result = await invoke('init', dir, { start, deps });
  expect(result.code).toBe(1);
  expect(result.stdout).not.toContain('Import clash.yaml');
  if (failure === 'generation') {
    expect(start.run).not.toHaveBeenCalled();
    for (const file of ['.env', 'config.json', 'clash.yaml']) expect(existsSync(join(dir, file))).toBe(false);
  }
  privateOutput(result);
});

it('init: --help is handled generically without writing files', async () => {
  const dir = project(null);
  for (const help of ['--help', '-h']) expect(await invoke('init', dir, {}, [help])).toEqual({ code: 0, stdout: 'Usage: my-singbox init [args]\n', stderr: '' });
  expect(existsSync(join(dir, '.env'))).toBe(false);
});

it('composeImageTag: reads the pinned repository tag and ignores comments and other images', () => {
  expect(composeImageTag(readFileSync(join(root, 'compose.yaml'), 'utf8'))).toBe(pinnedTag);
  expect(composeImageTag('# image: ghcr.io/sagernet/sing-box:wrong\nimage: other:wrong\n  image: ghcr.io/sagernet/sing-box:v1.13.9 # pinned\n')).toBe('v1.13.9');
  expect(() => composeImageTag('image: other:tag')).toThrow('sing-box image tag not found in compose.yaml.');
});
it('firewallPorts: derives TCP and Shadowsocks UDP ports independently of ISP', () => {
  for (const enabled of [false, true])
    expect(firewallPorts(JSON.stringify(renderSingbox(fixtureModel(enabled), loadSingboxTemplate())))).toEqual(['8388/tcp', '8388/udp', '8443/tcp']);
  const custom = renderSingbox(fixtureModel(), loadSingboxTemplate());
  custom.inbounds.push({ type: 'shadowsocks', tag: 'custom', listen_port: 9000 });
  expect(firewallPorts(JSON.stringify(custom))).toEqual(['8388/tcp', '8388/udp', '8443/tcp', '9000/tcp', '9000/udp']);
});
