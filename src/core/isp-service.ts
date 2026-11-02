import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import type { IspSocks } from '../model.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firewallPorts } from './start.js';
import { isIpv4, isIpv6Strict } from './validate.js';
import { IspError } from './isp.js';

export interface IspServiceIO {
  projectDir: string;
  env?: NodeJS.ProcessEnv;
  sleep?(ms: number): Promise<void>;
  stdout(text: string): void;
  stderr(text: string): void;
  signal?: AbortSignal;
}

export type DockerInfo = 'ok' | 'permission-denied' | 'down';
export type ListenerStatus = boolean | 'unknown';
type Result = { code: number | null; stdout: string; stderr: string; missing: boolean };
const container = 'sing-box';
const containerConfig = '/etc/sing-box/config.json';

/** External commands use this run's environment, including its PATH. */
export class IspService {
  constructor(private readonly io: IspServiceIO) {}

  private warn(message: string): void {
    this.io.stderr(`Warning: ${message}\n`);
  }

  private async command(
    file: string,
    args: string[],
    output: 'capture' | 'forward' | 'stderr' = 'capture',
    input?: string,
  ): Promise<Result> {
    this.io.signal?.throwIfAborted();
    const result = await new Promise<Result>((resolve, reject) => {
      const child = spawn(file, args, {
        cwd: this.io.projectDir,
        env: this.io.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '', missing = false;
      const abort = () => { child.kill('SIGTERM'); };
      this.io.signal?.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (text: string) => {
        if (output === 'capture') stdout += text;
        else if (output === 'stderr') this.io.stderr(text);
        else this.io.stdout(text);
      });
      child.stderr.on('data', (text: string) => {
        if (output === 'capture') stderr += text;
        else this.io.stderr(text);
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') missing = true;
        else reject(error);
      });
      // A command may exit before consuming its config; EPIPE carries no diagnostic.
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') reject(error);
      });
      child.on('close', (code) => {
        this.io.signal?.removeEventListener('abort', abort);
        resolve({ code, stdout, stderr, missing });
      });
      child.stdin.end(input);
    });
    this.io.signal?.throwIfAborted();
    return result;
  }

  private compose(args: string[], output: 'capture' | 'forward' | 'stderr' = 'forward') {
    return this.command('docker', ['compose', '--project-directory', this.io.projectDir, ...args], output);
  }

  private async pause(): Promise<void> {
    const signal = this.io.signal;
    signal?.throwIfAborted();
    let abort: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(signal!.reason);
      signal?.addEventListener('abort', abort, { once: true });
    });
    try {
      await Promise.race([
        this.io.sleep ? this.io.sleep(1000) : new Promise<void>((resolve) => setTimeout(resolve, 1000)),
        interrupted,
      ]);
    } finally {
      signal?.removeEventListener('abort', abort!);
    }
    signal?.throwIfAborted();
  }

  async dockerInfo(): Promise<DockerInfo> {
    const result = await this.command('docker', ['info']);
    if (result.code === 0) return 'ok';
    return /[Pp]ermission denied|access denied/.test(result.stdout + result.stderr)
      ? 'permission-denied' : 'down';
  }

  async composeAvailable(): Promise<boolean> {
    const result = await this.command('docker', ['compose', 'version']);
    if (result.missing) throw new IspError('docker is not installed.');
    return result.code === 0;
  }

  async containerImage(): Promise<string> {
    const result = await this.command('docker', ['inspect', '-f', '{{.Config.Image}}', container]);
    return result.code === 0 ? result.stdout.replace(/\n+$/, '') : '';
  }

  async containerStatus(): Promise<string> {
    const result = await this.command('docker', ['inspect', '-f', '{{.State.Status}}', container]);
    return result.code === 0 ? result.stdout.replace(/\n+$/, '') : 'missing';
  }

  async recreate(): Promise<boolean> {
    return (await this.compose(['up', '-d', '--force-recreate'])).code === 0;
  }

  async composeExecCheck(): Promise<boolean> {
    return (await this.compose(['exec', '-T', container, 'sing-box', 'check', '-c', containerConfig])).code === 0;
  }

  async showLogs(): Promise<void> {
    await this.compose(['logs', '--tail', '50', container], 'stderr');
  }

  async checkCandidate(image: string, candidatePath: string): Promise<boolean> {
    return (await this.command('docker', [
      'run', '--rm', '-v', `${candidatePath}:${containerConfig}:ro`,
      image, 'check', '-c', containerConfig,
    ], 'forward')).code === 0;
  }

  async portListening(proto: 'tcp' | 'udp', port: number): Promise<ListenerStatus> {
    const result = await this.command('ss', ['-H', proto === 'tcp' ? '-ltn' : '-lun']);
    if (!result.missing) return new RegExp(`[:.]${port}\\s`).test(result.stdout);
    if (proto === 'udp') return 'unknown';
    this.io.signal?.throwIfAborted();
    const listening = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      const finish = (ok: boolean) => {
        this.io.signal?.removeEventListener('abort', abort);
        socket.destroy();
        resolve(ok);
      };
      const abort = () => finish(false);
      this.io.signal?.addEventListener('abort', abort, { once: true });
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
    this.io.signal?.throwIfAborted();
    return listening;
  }

  async waitListening(proto: 'tcp' | 'udp', port: number): Promise<boolean> {
    for (let i = 0; i < 15; i++) {
      const status = await this.portListening(proto, port);
      if (status === true) return true;
      if (status === 'unknown') {
        this.warn(`ss is not installed. Skipping the ${proto.toUpperCase()} listener check for port ${port}.`);
        return true;
      }
      await this.pause();
    }
    return false;
  }

  async verifyService(): Promise<boolean> {
    let status = 'missing';
    for (let i = 0; i < 15; i++) {
      status = await this.containerStatus();
      if (status === 'running') break;
      await this.pause();
    }
    if (status !== 'running') {
      this.warn(`sing-box did not stay running (status: ${status}).`);
      return false;
    }
    if (!await this.composeExecCheck()) {
      this.warn('sing-box config check failed inside the container.');
      return false;
    }
    const listeners = firewallPorts(readFileSync(join(this.io.projectDir, 'config.json'), 'utf8'));
    for (const listener of new Set(listeners)) {
      const [number, proto] = listener.split('/');
      const port = Number(number);
      if (!await this.waitListening(proto as 'tcp' | 'udp', port)) {
        this.warn(`Port ${port}/${proto} is not listening.`);
        return false;
      }
    }
    return true;
  }

  async socksEgressIp(isp: IspSocks): Promise<string | undefined> {
    const quote = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    for (const url of [
      'https://api.ipify.org', 'https://ipinfo.io/ip',
      'https://ipv4.icanhazip.com', 'https://ifconfig.me/ip',
    ]) {
      const result = await this.command('curl', ['-K', '-'], 'capture',
        `proxy = "socks5h://${quote(isp.addr)}"\n` +
        `proxy-user = "${quote(isp.user)}:${quote(isp.pass)}"\n` +
        `url = "${url}"\nsilent\nshow-error\nfail\nmax-time = 15\n`);
      const ip = result.stdout.trim();
      if (isIpv4(ip) || isIpv6Strict(ip)) return ip;
    }
    return undefined;
  }
}
