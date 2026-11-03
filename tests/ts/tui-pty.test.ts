import { afterAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { creds } from './helpers/fixtures.js';

// Opt-in: drives the production CLI in a real PTY; Docker/network dependencies are local stubs.
const enabled = process.env.TUI_PTY_TEST === '1';
let directory: string | undefined;
const socket = `singbox-test-${process.pid}`;
const servers: Server[] = [];
const tmux = (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' });
const capture = () => tmux('capture-pane', '-p', '-t', 'tui');
const keys = (...args: string[]) => tmux('send-keys', '-t', 'tui', ...args);
async function waitFor(text: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const output = capture(); if (output.includes(text)) return output;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`TUI did not reach ${text}:\n${capture()}`);
}
async function settleKeys(...args: string[]) { for (const key of args) { keys(key); await new Promise((resolve) => setTimeout(resolve, 100)); } }
function launch(project: string, bin: string, preload: string) {
  tmux('new-session', '-d', '-s', 'tui', '-x', '100', '-y', '30', '-c', project,
    '/usr/bin/env', `PATH=${bin}:${process.env.PATH}`, 'NO_COLOR=1',
    'CI=true', 'CONTINUOUS_INTEGRATION=1', 'CI_BUILD=1',
    process.execPath, '--import', preload, resolve('dist/cli.js'), 'tui');
  tmux('set-window-option', '-t', 'tui', 'remain-on-exit', 'on');
}
async function expectExit(code: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = tmux('display-message', '-p', '-t', 'tui', '#{pane_dead}:#{pane_dead_status}').trim();
    if (status.startsWith('1:')) {
      expect(status).toBe(`1:${code}`);
      tmux('kill-session', '-t', 'tui');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`TUI did not exit:\n${capture()}`);
}
afterAll(async () => {
  if (enabled) { try { tmux('kill-server'); } catch { /* already exited */ } }
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it.skipIf(!enabled)('drives deployment, masked ISP add/remove, compact resize and terminal exit', async () => {
  directory = mkdtempSync(join(tmpdir(), 'singbox-pty-'));
  const project = join(directory, 'project'), bin = join(directory, 'bin'); mkdirSync(project); mkdirSync(bin);
  const ports: number[] = [];
  for (let index = 0; index < 2; index++) {
    const server = createServer((connection) => connection.end()); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); ports.push((server.address() as AddressInfo).port);
  }
  const preload = join(directory, 'platform.mjs');
  writeFileSync(preload, `import fs from 'node:fs';\nimport {syncBuiltinESMExports} from 'node:module';\nObject.defineProperty(process, 'platform', {value:'linux'});\nprocess.report.getReport=()=>({header:{glibcVersionRuntime:'2.36'}});\nconst original=fs.readFileSync; fs.readFileSync=(path,...args)=>path==='/etc/os-release'?'ID=debian\\n':original(path,...args);\nsyncBuiltinESMExports();\n`);
  const stub = `#!${process.execPath}\nconst a=process.argv.slice(2),s=a.join(' ');\nconst fs=require('node:fs');\nif(a[0]==='info'&&fs.existsSync('.deny-docker')) {console.error('permission denied while connecting to the Docker socket');process.exit(1);}\nif(a[0]==='compose'&&a.includes('up')&&fs.existsSync('.hold-restart')) {\n fs.unlinkSync('.hold-restart');fs.writeFileSync('.restart-started',String(process.pid));setInterval(()=>{},1000);\n} else if(s.includes('context inspect')) console.log('unix:///var/run/docker.sock');\nelse if(s.includes('generate reality-keypair')) console.log('PrivateKey: ${creds.realityPrivateKey}\\nPublicKey: ${creds.realityPublicKey}');\nelse if(s.includes('generate rand')) console.log('${creds.ssPassword}');\nelse if(s.includes('.Config.Image')) console.log('ghcr.io/sagernet/sing-box:v1.14.4');\nelse if(a[0]==='inspect') console.log('running');\nelse if(a[0]==='-V'||a[0]==='--version'||s==='compose version') console.log('available');\nelse if(a[0]==='-uln'||a[0]==='-ulnp'||(a[0]==='-H'&&(a[1]==='-ltn'||a[1]==='-lun'))) {\n if(require('node:fs').existsSync('config.json')) {\n  const p=require('node:fs').readFileSync('config.json','utf8');\n  for(const port of [...p.matchAll(/"listen_port"\\s*:\\s*(\\d+)/g)].map(m=>m[1])) console.log('LISTEN 0 0 *:'+port+' *:* users:(("sing-box",pid=1))');\n }\n}\n`;
  writeFileSync(join(bin, 'docker'), stub, { mode: 0o755 }); writeFileSync(join(bin, 'ss'), stub, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log('198.51.100.20'));\n`, { mode: 0o755 });
  const cli = resolve('dist/cli.js'); expect(existsSync(cli)).toBe(true);
  // tmux executes each argument directly, keeping shell quoting out of paths and secrets.
  launch(project, bin, preload);
  await waitFor('状态首页'); await settleKeys('Enter'); await waitFor('1/5'); await settleKeys('Enter'); await waitFor('0 项阻塞');
  await settleKeys('BTab', 'BTab', 'Enter'); await waitFor('2/5');
  await settleKeys('node.example.test', 'Tab', 'C-u', String(ports[0]), 'Tab', 'C-u', String(ports[1]));
  await settleKeys('Tab', 'Tab', 'Enter'); await waitFor('未发现占用');
  await settleKeys('Tab', 'Tab', 'Enter'); await waitFor('3/5');
  await settleKeys('Tab', 'Enter'); await waitFor('4/5'); expect(capture()).toContain(String(ports[0]));
  await settleKeys('Enter'); await waitFor('操作完成');
  const server = JSON.parse(readFileSync(join(project, 'config.json'), 'utf8')); expect(server.inbounds.map((value: { listen_port: number }) => value.listen_port)).toEqual(ports);
  await settleKeys('Tab', 'Enter'); await waitFor('状态首页');
  await settleKeys('Tab', 'Tab', 'Tab', 'Enter'); await waitFor('ISP 出口配置');
  await settleKeys('198.51.100.20', 'Enter', 'C-u', '1080', 'Enter', 'pty-user', 'Enter', 'private-pty-password');
  expect(capture()).not.toContain('private-pty-password');
  expect(capture()).not.toContain('pty-user');
  await settleKeys('C-r');
  expect(capture()).toContain('private-pty-password');
  expect(capture()).not.toContain('pty-user');
  await settleKeys('BTab', 'C-r');
  expect(capture()).toContain('pty-user');
  expect(capture()).not.toContain('private-pty-password');
  await settleKeys('Tab', 'Tab'); expect(capture()).not.toContain('private-pty-password');
  expect(capture()).not.toContain('pty-user');
  await settleKeys('Tab', 'Enter'); await waitFor('出口校验通过');
  await settleKeys('Tab', 'Enter'); await waitFor('变更预览');
  const client = readFileSync(join(project, 'clash.yaml'), 'utf8');
  await settleKeys('Enter'); await waitFor('操作完成');
  expect(readFileSync(join(project, 'clash.yaml'), 'utf8')).toBe(client);
  await settleKeys('Tab', 'Enter'); await waitFor('状态首页'); await settleKeys('Tab', 'Tab', 'Tab', 'Enter'); await waitFor('ISP 出口配置');
  // Existing ISP has one extra 'restore credentials' action and an operation-record action.
  for (let index = 0; index < 9; index++) await settleKeys('Tab');
  await settleKeys('Enter'); await waitFor('移除 ISP 出站'); await settleKeys('Enter'); await waitFor('操作完成');
  expect(readFileSync(join(project, 'clash.yaml'), 'utf8')).toBe(client);
  expect(JSON.parse(readFileSync(join(project, 'config.json'), 'utf8')).outbounds.some((value: { tag: string }) => value.tag === 'isp-socks')).toBe(false);
  tmux('resize-window', '-t', 'tui', '-x', '60', '-y', '18'); await new Promise((resolve) => setTimeout(resolve, 150)); expect(capture()).toContain('执行结果');
  await settleKeys('Tab', 'Enter'); await waitFor('状态首页');
  await settleKeys('Tab', 'Tab', 'Tab', 'Enter'); await waitFor('ISP 出口配置');
  await settleKeys('198.51.100.99');
  tmux('resize-window', '-t', 'tui', '-x', '50', '-y', '16'); await waitFor('至少 60 列');
  await settleKeys('C-c'); await waitFor('草稿尚未保存');
  await settleKeys('Enter'); await waitFor('至少 60 列');
  await settleKeys('C-c', 'Tab', 'Enter');
  await expectExit(130);
}, 45000);

it.skipIf(!enabled)('handles an external SIGINT through the TUI exit path', async () => {
  launch(join(directory!, 'project'), join(directory!, 'bin'), join(directory!, 'platform.mjs'));
  await waitFor('状态首页');
  const pid = Number(tmux('display-message', '-p', '-t', 'tui', '#{pane_pid}').trim());
  process.kill(pid, 'SIGINT');
  await expectExit(130);
}, 10000);

it.skipIf(!enabled)('restores ISP files and service before exiting on external SIGINT during restart', async () => {
  const project = join(directory!, 'project');
  const beforeEnv = readFileSync(join(project, '.env'), 'utf8');
  const beforeConfig = readFileSync(join(project, 'config.json'), 'utf8');
  writeFileSync(join(project, '.hold-restart'), '');
  launch(project, join(directory!, 'bin'), join(directory!, 'platform.mjs'));
  await waitFor('状态首页');
  await settleKeys('Tab', 'Tab', 'Tab', 'Enter'); await waitFor('ISP 出口配置');
  await settleKeys('198.51.100.20', 'Enter', 'Enter', 'cancel-user', 'Enter', 'cancel-password');
  await settleKeys('Tab', 'Tab', 'Tab', 'Enter'); await waitFor('变更预览');
  await settleKeys('Enter');
  for (let attempt = 0; attempt < 200 && !existsSync(join(project, '.restart-started')); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  expect(existsSync(join(project, '.restart-started')), capture()).toBe(true);
  const pid = Number(tmux('display-message', '-p', '-t', 'tui', '#{pane_pid}').trim());
  process.kill(pid, 'SIGINT');
  await expectExit(130);
  expect(readFileSync(join(project, '.env'), 'utf8')).toBe(beforeEnv);
  expect(readFileSync(join(project, 'config.json'), 'utf8')).toBe(beforeConfig);
  const record = JSON.parse(readFileSync(join(project, '.tui-isp-operation.json'), 'utf8'));
  expect(record.recovery).toMatchObject({ files: 'restored', service: 'restored' });
  expect(existsSync(join(project, '.isp.lock'))).toBe(false);
}, 20000);

it.skipIf(!enabled)('shows Docker permission remedies when starting from the status page', async () => {
  const project = join(directory!, 'project');
  const beforeEnv = readFileSync(join(project, '.env'), 'utf8');
  const beforeConfig = readFileSync(join(project, 'config.json'), 'utf8');
  const denied = join(project, '.deny-docker');
  writeFileSync(denied, '');
  try {
    launch(project, join(directory!, 'bin'), join(directory!, 'platform.mjs'));
    await waitFor('状态首页');
    await settleKeys('Enter'); await waitFor('变更预览');
    await settleKeys('Enter'); await waitFor('Docker daemon 权限不足');
    expect(await waitFor('sudo')).toContain('docker 组');
    expect(readFileSync(join(project, '.env'), 'utf8')).toBe(beforeEnv);
    expect(readFileSync(join(project, 'config.json'), 'utf8')).toBe(beforeConfig);
    expect(existsSync(join(project, '.isp.lock'))).toBe(false);
    await settleKeys('C-c'); await expectExit(130);
  } finally { rmSync(denied, { force: true }); }
}, 10000);
