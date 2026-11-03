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
  const stub = `#!${process.execPath}\nconst a=process.argv.slice(2),s=a.join(' ');\nif(s.includes('context inspect')) console.log('unix:///var/run/docker.sock');\nelse if(s.includes('generate reality-keypair')) console.log('PrivateKey: ${creds.realityPrivateKey}\\nPublicKey: ${creds.realityPublicKey}');\nelse if(s.includes('generate rand')) console.log('${creds.ssPassword}');\nelse if(s.includes('.Config.Image')) console.log('ghcr.io/sagernet/sing-box:v1.14.4');\nelse if(a[0]==='inspect') console.log('running');\nelse if(a[0]==='-V'||a[0]==='--version'||s==='compose version') console.log('available');\nelse if(a[0]==='-uln'||a[0]==='-ulnp'||(a[0]==='-H'&&(a[1]==='-ltn'||a[1]==='-lun'))) {\n if(require('node:fs').existsSync('config.json')) {\n  const p=require('node:fs').readFileSync('config.json','utf8');\n  for(const port of [...p.matchAll(/"listen_port"\\s*:\\s*(\\d+)/g)].map(m=>m[1])) console.log('LISTEN 0 0 *:'+port+' *:* users:(("sing-box",pid=1))');\n }\n}\n`;
  writeFileSync(join(bin, 'docker'), stub, { mode: 0o755 }); writeFileSync(join(bin, 'ss'), stub, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log('198.51.100.20'));\n`, { mode: 0o755 });
  const cli = resolve('dist/cli.js'); expect(existsSync(cli)).toBe(true);
  // tmux executes each argument directly, keeping shell quoting out of paths and secrets.
  tmux('new-session', '-d', '-s', 'tui', '-x', '100', '-y', '30', '-c', project, '/usr/bin/env', `PATH=${bin}:${process.env.PATH}`, 'NO_COLOR=1', process.execPath, '--import', preload, cli, 'tui');
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
  await settleKeys('C-r'); expect(capture()).toContain('private-pty-password');
  await settleKeys('Tab'); expect(capture()).not.toContain('private-pty-password');
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
  tmux('resize-window', '-t', 'tui', '-x', '50', '-y', '16'); await waitFor('至少 60 列');
  await settleKeys('C-c');
}, 45000);
