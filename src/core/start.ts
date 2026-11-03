import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { envUnquote } from './env.js';

export function parseListenPorts(configText: string): number[] {
  const ports = new Set<number>();
  for (const m of configText.matchAll(/"listen_port"\s*:\s*([0-9]+)/g)) {
    const port = Number(m[1]);
    if (port < 1 || port > 65535)
      throw new Error(`Invalid listen_port in config.json: ${m[1]}`);
    ports.add(port);
  }
  if (!ports.size) throw new Error('config.json has no listen_port.');
  return [...ports];
}

function shadowsocksPorts(configText: string): number[] {
  // Keep parseListenPorts' raw-text compatibility for old/custom configs.
  let config: { inbounds?: { type?: string; listen_port?: number }[] } | null;
  try {
    config = JSON.parse(configText);
  } catch {
    return [];
  }
  if (!Array.isArray(config?.inbounds)) return [];
  return [...new Set(config.inbounds.flatMap((inbound) => {
    const port = inbound?.listen_port;
    return inbound?.type === 'shadowsocks' && typeof port === 'number' &&
      Number.isInteger(port) && port >= 1 && port <= 65535 ? [port] : [];
  }))];
}

export function secretValues(envText: string): string[] {
  return [...envText.matchAll(/^(?:REALITY_PRIVATE_KEY|SS_PASSWORD|VLESS_UUID|ISP_SOCKS_USER|ISP_SOCKS_PASS)=([^\r\n]*)\r?$/gm)]
    .map((m) => envUnquote(m[1]))
    .filter((value): value is string => value !== null && value !== '');
}

export function redact(text: string, secrets: string[]): string {
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    text = text.replaceAll(secret, '***');
  return text;
}

export function composeImageTag(text: string): string {
  const m = /^\s*image:\s*ghcr\.io\/sagernet\/sing-box:([^\s#]+)/m.exec(text);
  if (!m) throw new Error('sing-box image tag not found in compose.yaml.');
  return m[1];
}

export function firewallPorts(configText: string): string[] {
  const config: { inbounds: { type: string; listen_port: number }[] } = JSON.parse(configText);
  return config.inbounds.flatMap((i) =>
    i.type === 'shadowsocks'
      ? [`${i.listen_port}/tcp`, `${i.listen_port}/udp`]
      : [`${i.listen_port}/tcp`],
  );
}

export interface StartDeps {
  run(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  tcpOpen(port: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export function realStartDeps(): StartDeps {
  return {
    run: (file, args) => new Promise((resolve) => {
      execFile(file, args, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : error.code === 'ENOENT' ? 127 : 1) : 0;
        resolve({ code, stdout, stderr });
      });
    }),
    tcpOpen: (port) => new Promise((resolve) => {
      const socket = connect(port, '127.0.0.1');
      const finish = (open: boolean) => { socket.destroy(); resolve(open); };
      socket.setTimeout(500, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export async function startNode(opts: {
  project: string;
  deps: StartDeps;
  dockerAvailable(): Promise<boolean>;
  dockerDaemonUp(): Promise<boolean>;
  stdout(t: string): void;
  stderr(t: string): void;
}): Promise<void> {
  const { project, deps } = opts;
  if (!existsSync(join(project, 'compose.yaml')))
    throw new Error('compose.yaml does not exist.');
  if (!existsSync(join(project, 'config.json')))
    throw new Error('config.json does not exist. Run my-singbox gen-config first.');
  const configText = readFileSync(join(project, 'config.json'), 'utf8');
  const ports = parseListenPorts(configText);
  const udpPorts = shadowsocksPorts(configText);
  if (!(await opts.dockerAvailable())) throw new Error('docker is not installed.');
  if ((await deps.run('docker', ['compose', 'version'])).code)
    throw new Error('docker compose is not available.');
  if (!(await opts.dockerDaemonUp())) throw new Error('Docker daemon is not running.');
  const envPath = join(project, '.env');
  const secrets = secretValues(existsSync(envPath) ? readFileSync(envPath, 'utf8') : '');
  const compose = (...args: string[]) => deps.run('docker', ['compose', '--project-directory', project, ...args]);
  const forward = (output: { stdout: string; stderr: string }) => {
    opts.stdout(redact(output.stdout, secrets));
    opts.stderr(redact(output.stderr, secrets));
  };
  const fail = async (message: string) => {
    const logs = await compose('logs', '--tail', '50', 'sing-box');
    opts.stderr(redact(logs.stdout, secrets));
    opts.stderr(redact(logs.stderr, secrets));
    throw new Error(redact(message, secrets));
  };
  const status = async () => {
    const output = await deps.run('docker', ['inspect', '-f', '{{.State.Status}}', 'sing-box']);
    return output.code ? 'missing' : output.stdout.trim();
  };
  opts.stdout('Starting sing-box...\n');
  const up = await compose('up', '-d');
  forward(up);
  if (up.code) throw new Error('docker compose up failed.');
  let state = 'missing';
  for (let i = 0; i < 15; i++) {
    state = await status();
    if (state === 'running') break;
    await deps.sleep(1000);
  }
  if (state !== 'running') await fail(`sing-box did not stay running (status: ${state}).`);
  const check = await compose('exec', '-T', 'sing-box', 'sing-box', 'check', '-c', '/etc/sing-box/config.json');
  forward(check);
  if (check.code) await fail('sing-box config check failed.');
  for (const port of ports) {
    let open = false;
    for (let i = 0; i < 10; i++) {
      open = await deps.tcpOpen(port);
      if (open) break;
      await deps.sleep(1000);
    }
    if (!open) await fail(`Port ${port} is not accepting connections.`);
  }
  for (const port of udpPorts) {
    const listener = new RegExp(`:${port}\\s`);
    let listening = false;
    for (let i = 0; i < 10; i++) {
      const udp = await deps.run('ss', ['-uln']);
      if (udp.code === 127) {
        opts.stderr(`Warning: ss is not installed. Skipping UDP listener check for port ${port}.\n`);
        listening = true;
        break;
      }
      if (udp.code === 0 && listener.test(udp.stdout)) {
        const owners = await deps.run('ss', ['-ulnp']);
        const lines = owners.stdout.split('\n').filter((l) => listener.test(l)).join('\n');
        if (lines.includes('users:') && !lines.includes('sing-box'))
          await fail(`UDP port ${port} is not owned by sing-box.`);
        listening = true;
        break;
      }
      await deps.sleep(1000);
    }
    if (!listening) await fail(`UDP port ${port} is not listening.`);
  }
  state = await status();
  if (state !== 'running') await fail(`sing-box did not stay running (status: ${state}).`);
  opts.stdout(`Self-check passed. Ports: ${ports.join(' ')}\n`);
}
