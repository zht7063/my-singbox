import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDeployment, planDeployment, readDeployment, startDeployment } from '../../src/app/deployment.js';
import { IMAGE_PULL_TIMEOUT_MS } from '../../src/core/isp-service.js';
import type { CommandRunner } from '../../src/app/system.js';
import { creds } from './helpers/fixtures.js';
import { parse as parseYaml } from 'yaml';

vi.mock('../../src/app/diagnostics.js', () => ({ diagnose: vi.fn(async () => []) }));
const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory() { const path = mkdtempSync(join(tmpdir(), 'tui-deploy-')); directories.push(path); return path; }
async function listener() {
  const server = createServer((socket) => socket.end()); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
function commands(ports: { ss: number; vless: number }, fail?: 'candidate' | 'start'): CommandRunner {
  return async (file, args) => {
    let stdout = '', code = 0;
    if (args.includes('reality-keypair')) stdout = `PrivateKey: ${creds.realityPrivateKey}\nPublicKey: ${creds.realityPublicKey}\n`;
    else if (args.includes('rand')) stdout = `${creds.ssPassword}\n`;
    else if (args[0] === 'inspect') stdout = 'running\n';
    else if (file === 'ss' && args[0] === '-uln') stdout = `UNCONN 0 0 *:${ports.ss} *:*\n`;
    else if (file === 'ss' && args[0] === '-ulnp') stdout = `UNCONN 0 0 *:${ports.ss} *:* users:(("sing-box",pid=1))\n`;
    if (fail === 'candidate' && args[0] === 'run' && args.includes('check')) code = 1;
    if (fail === 'start' && args.includes('up')) code = 1;
    return { code, stdout, stderr: '' };
  };
}

describe('initial deployment use case', () => {
  it('creates matching custom server/client ports, checks real local TCP, and keeps credentials private', async () => {
    const projectDir = directory(), ports = { ss: await listener(), vless: await listener() };
    const plan = planDeployment(projectDir, { serverAddress: 'node.example.test', ports });
    let output = '';
    const base = commands(ports);
    const run = vi.fn<CommandRunner>(async (file, args, options) => {
      const result = await base(file, args, options);
      if (args.includes('up')) result.stdout = `startup output ${creds.ssPassword}\n`;
      return result;
    });
    const result = await applyDeployment({ projectDir, run, onLog: (text) => { output += text; }, onEvent: (event) => { output += event.message; } }, plan);
    expect(result.ok).toBe(true);
    const server = JSON.parse(readFileSync(join(projectDir, 'config.json'), 'utf8'));
    const client = parseYaml(readFileSync(join(projectDir, 'clash.yaml'), 'utf8'));
    expect(server.inbounds.map((inbound: { listen_port: number }) => inbound.listen_port)).toEqual([ports.ss, ports.vless]);
    expect(client.proxies.map((proxy: { port: number }) => proxy.port)).toEqual([ports.ss, ports.vless]);
    for (const name of ['.env', 'config.json', 'clash.yaml', '.tui-operation.json']) expect(statSync(join(projectDir, name)).mode & 0o777).toBe(0o600);
    expect(output).not.toContain(creds.realityPrivateKey); expect(output).not.toContain(creds.ssPassword);
    expect(output.match(/startup output/g)).toHaveLength(1);
    const imageCommands = run.mock.calls.filter(([, args]) => args[0] === 'run' || args.includes('up'));
    expect(imageCommands).toHaveLength(4);
    for (const [, , options] of imageCommands) expect(options.timeout).toBe(IMAGE_PULL_TIMEOUT_MS);
    expect(readDeployment(projectDir).kind).toBe('ready');
    expect(readdirSync(projectDir).some((name) => name.startsWith('.tui-stage-') || name === '.isp.lock')).toBe(false);
  });
  it('normalizes raw form ports at the planning boundary and rejects invalid inputs', () => {
    const projectDir = directory();
    const plan = planDeployment(projectDir, {
      serverAddress: 'node.example.test', ports: { ss: '18388', vless: '18443' },
    });
    expect(plan.listeners).toEqual(['18388/tcp', '18388/udp', '18443/tcp']);
    for (const ports of [
      { ss: '', vless: '8443' }, { ss: '8388\n', vless: '8443' },
      { ss: '8388', vless: '8388' }, { ss: '65536', vless: '8443' },
    ]) {
      expect(() => planDeployment(projectDir, { serverAddress: 'node.example.test', ports })).toThrow();
    }
    expect(readdirSync(projectDir)).toEqual([]);
  });
  it('rejects stale plans before running external commands', async () => {
    const projectDir = directory();
    const plan = planDeployment(projectDir, { serverAddress: 'node.example.test', ports: { ss: 18388, vless: 18443 } });
    writeFileSync(join(projectDir, '.env'), 'external edit');
    const run = vi.fn(commands({ ss: 18388, vless: 18443 }));
    const result = await applyDeployment({ projectDir, run }, plan);
    expect(result.ok).toBe(false); expect(result.message).toContain('重新预览'); expect(run).not.toHaveBeenCalled();
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toBe('external edit');
  });
  it('blocks UDP-only conflicts without generating credentials or publishing files', async () => {
    const projectDir = directory(), ports = { ss: 18388, vless: 18443 };
    const run: CommandRunner = async (file, args) => ({ code: 0, stdout: file === 'ss' && args.includes('-lun') ? 'UNCONN 0 0 *:18388 *:*\n' : '', stderr: '' });
    const result = await applyDeployment({ projectDir, run }, planDeployment(projectDir, { serverAddress: 'node.example.test', ports }));
    expect(result.ok).toBe(false); expect(result.message).toContain('占用'); expect(existsSync(join(projectDir, '.env'))).toBe(false);
  });
  it('preserves published credentials after startup failure and refuses to generate a second set', async () => {
    const projectDir = directory(), ports = { ss: 18388, vless: 18443 };
    const result = await applyDeployment({ projectDir, run: commands(ports, 'start') }, planDeployment(projectDir, { serverAddress: 'node.example.test', ports }));
    expect(result.ok).toBe(false); expect(result.created).toHaveLength(4);
    const original = readFileSync(join(projectDir, '.env'), 'utf8');
    expect(readDeployment(projectDir).operation?.state).toBe('failed');
    expect(() => planDeployment(projectDir, { serverAddress: 'node.example.test', ports })).toThrow('已有部署文件');
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toBe(original);
  });
  it('allows image pulling when restarting an existing deployment', async () => {
    const projectDir = directory(), ports = { ss: await listener(), vless: await listener() };
    const first = await applyDeployment({ projectDir, run: commands(ports, 'start') }, planDeployment(projectDir, { serverAddress: 'node.example.test', ports }));
    expect(first.ok).toBe(false);
    const credentials = readFileSync(join(projectDir, '.env'), 'utf8');
    const run = vi.fn(commands(ports));
    const result = await startDeployment({ projectDir, run });
    expect(result.ok, result.message).toBe(true);
    expect(run.mock.calls.find(([, args]) => args.includes('up'))?.[2].timeout).toBe(IMAGE_PULL_TIMEOUT_MS);
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toBe(credentials);
    expect(readDeployment(projectDir).operation?.state).toBe('complete');
  });
  it('preserves published files and records cancellation during startup', async () => {
    const projectDir = directory(), ports = { ss: 18388, vless: 18443 }, controller = new AbortController();
    const base = commands(ports);
    const result = await applyDeployment({ projectDir, signal: controller.signal,
      run: async (file, args, options) => { options.signal?.throwIfAborted(); return base(file, args, options); },
      onEvent: (event) => { if (event.stage === 'start' && event.status === 'running') controller.abort(new Error('cancel startup')); },
    }, planDeployment(projectDir, { serverAddress: 'node.example.test', ports }));
    expect(result).toMatchObject({ ok: false, cancelled: true, created: ['compose.yaml', '.env', 'config.json', 'clash.yaml'] });
    expect(readDeployment(projectDir).operation?.state).toBe('interrupted');
    expect(readDeployment(projectDir).kind).toBe('ready');
    expect(existsSync(join(projectDir, '.isp.lock'))).toBe(false);
  });
  it('candidate rejection leaves no generated deployment files', async () => {
    const projectDir = directory(), ports = { ss: 18388, vless: 18443 };
    const result = await applyDeployment({ projectDir, run: commands(ports, 'candidate') }, planDeployment(projectDir, { serverAddress: 'node.example.test', ports }));
    expect(result.ok).toBe(false); expect(result.created).toEqual([]);
    expect(existsSync(join(projectDir, 'config.json'))).toBe(false);
    expect(readDeployment(projectDir).operation?.stage).toBe('validate');
  });
  it('partial deployments cannot enter the new-deployment workflow', () => {
    const projectDir = directory(); writeFileSync(join(projectDir, 'compose.yaml'), 'services: {}\n');
    expect(readDeployment(projectDir).kind).toBe('incomplete');
    expect(() => planDeployment(projectDir, { serverAddress: 'node.example.test', ports: { ss: 8388, vless: 8443 } })).toThrow('已有部署文件');
  });
});
