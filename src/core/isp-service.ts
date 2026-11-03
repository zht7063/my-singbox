import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import type { IspSocks } from '../model.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firewallPorts, redact, secretValues } from './start.js';
import { envQuote } from './env.js';
import { stripVTControlCharacters } from 'node:util';
import { isIpv4, isIpv6Strict } from './validate.js';
import { IspError } from './isp.js';

export interface CommandResult { code: number; stdout: string; stderr: string; missing?: boolean }
export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeout?: number;
  killGraceMs?: number;
  input?: string;
  /** Isolate cancellable operations so termination reaches their descendants. */
  processGroup?: boolean;
}
export type CommandRunner = (file: string, args: string[], options: CommandOptions) => Promise<CommandResult>;
export const IMAGE_PULL_TIMEOUT_MS = 15 * 60_000;
class CommandTimeoutError extends Error {}

/** Capture complete streams before forwarding, including secrets split across process chunks. */
export const runCommand: CommandRunner = (file, args, options) => new Promise((resolve, reject) => {
  options.signal?.throwIfAborted();
  const grouped = options.processGroup === true && process.platform !== 'win32';
  const child = spawn(file, args, { cwd: options.cwd, env: options.env, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', spawnError: NodeJS.ErrnoException | undefined, timedOut = false, tooLarge = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let killError: Error | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        killError ??= new Error(`Could not send ${signal} to ${file}: ${(error as Error).message}`, { cause: error });
    }
  };
  const stop = () => {
    kill('SIGTERM');
    killTimer ??= setTimeout(() => kill('SIGKILL'), options.killGraceMs ?? 1500);
    killTimer.unref();
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeout ?? 120_000);
  timer.unref();
  const abort = () => stop();
  options.signal?.addEventListener('abort', abort, { once: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const append = (text: string, error: boolean) => {
    if (tooLarge) return;
    if (stdout.length + stderr.length + text.length > 4 * 1024 * 1024) { tooLarge = true; stop(); return; }
    if (error) stderr += text; else stdout += text;
  };
  child.stdout.on('data', (text: string) => append(text, false));
  child.stderr.on('data', (text: string) => append(text, true));
  child.on('error', (error: NodeJS.ErrnoException) => { spawnError = error; });
  child.stdin.on('error', () => { /* A process may exit before reading stdin. */ });
  child.once('close', (code) => {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', abort);
    if (killError) { reject(killError); return; }
    if (options.signal?.aborted) { reject(options.signal.reason ?? new Error('操作已取消。')); return; }
    if (timedOut) { reject(new CommandTimeoutError(`${file} 执行超时。`)); return; }
    if (tooLarge) { reject(new Error(`${file} 输出超过限制。`)); return; }
    if (spawnError && spawnError.code !== 'ENOENT') { reject(spawnError); return; }
    resolve({ code: spawnError ? 127 : code ?? 1, stdout, stderr, ...(spawnError ? { missing: true } : {}) });
  });
  child.stdin.end(options.input);
});

export async function tcpOpen(port: number, signal?: AbortSignal, timeout = 500): Promise<boolean> {
  signal?.throwIfAborted();
  const open = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (value: boolean) => { signal?.removeEventListener('abort', abort); socket.destroy(); resolve(value); };
    const abort = () => finish(false);
    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
  signal?.throwIfAborted();
  return open;
}

export async function pause(ms: number, signal?: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(signal?.reason ?? new Error('操作已取消。'));
    signal?.addEventListener('abort', abort, { once: true });
    if (sleep) Promise.resolve().then(() => sleep(ms)).then(() => finish(), finish);
    else timer = setTimeout(() => finish(), ms);
  });
  signal?.throwIfAborted();
}

export function deploymentSecrets(projectDir: string): string[] {
  const secrets: string[] = [];
  try { secrets.push(...secretValues(readFileSync(join(projectDir, '.env'), 'utf8'))); } catch { /* Optional or invalid file. */ }
  try { secrets.push(...ispConfigSecrets(JSON.parse(readFileSync(join(projectDir, 'config.json'), 'utf8')))); } catch { /* Diagnosed separately. */ }
  return secrets;
}

/** Register configured credentials too: .env may disagree with the installed config. */
export function ispConfigSecrets(value: unknown, key = ''): string[] {
  if (typeof value === 'string' && /password|username|private_key|public_key|uuid|short_id/i.test(key)) return [value];
  if (Array.isArray(value)) return value.flatMap((item) => ispConfigSecrets(item, key));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([name, item]) => ispConfigSecrets(item, name));
  return [];
}
export function createIspRedactor(secrets: readonly string[]): (text: string) => string {
  const variants = [...new Set(secrets.filter(Boolean).flatMap((secret) => [
    secret, envQuote(secret), JSON.stringify(secret).slice(1, -1),
    secret.replaceAll('\\', '\\\\').replaceAll('"', '\\"'),
  ]))];
  return (text) => redact(stripVTControlCharacters(text), variants)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** Compare IP address values rather than IPv6 spelling. */
export function sameIspIp(left: string, right: string): boolean {
  if (isIpv4(left) && isIpv4(right)) return left === right;
  if (!isIpv6Strict(left) || !isIpv6Strict(right)) return false;
  const expand = (ip: string) => {
    const [head, tail] = ip.toLowerCase().split('::');
    const before = head ? head.split(':') : [];
    const after = tail ? tail.split(':') : [];
    const groups = tail === undefined ? before :
      [...before, ...Array<string>(8 - before.length - after.length).fill('0'), ...after];
    return groups.map((group) => parseInt(group, 16)).join(':');
  };
  return expand(left) === expand(right);
}

export interface IspServiceIO {
  projectDir: string;
  env?: NodeJS.ProcessEnv;
  sleep?(ms: number): Promise<void>;
  stdout(text: string): void;
  stderr(text: string): void;
  signal?: AbortSignal;
  /** Applied to complete command streams, so secrets split across chunks stay hidden. */
  sanitizeOutput?(text: string): string;
  commandTimeoutMs?: number;
  killGraceMs?: number;
  run?: CommandRunner;
}

export type DockerInfo = 'ok' | 'permission-denied' | 'down';
export type ListenerStatus = boolean | 'unknown';
type Result = { code: number | null; stdout: string; stderr: string; missing: boolean };
const container = 'sing-box';
const containerConfig = '/etc/sing-box/config.json';

/** External commands use this run's environment, including its PATH. */
export class IspService {
  constructor(private readonly io: IspServiceIO) {}

  private write(text: string, stderr = false): void {
    const clean = this.io.sanitizeOutput?.(text) ?? text;
    if (stderr) this.io.stderr(clean); else this.io.stdout(clean);
  }

  private warn(message: string): void {
    this.write(`Warning: ${message}\n`, true);
  }

  private async command(
    file: string,
    args: string[],
    output: 'capture' | 'forward' | 'stderr' = 'capture',
    input?: string,
    timeout = file === 'curl' ? 20_000 : 120_000,
  ): Promise<Result> {
    const timeoutMs = this.io.commandTimeoutMs ?? timeout;
    let result: CommandResult;
    try {
      result = await (this.io.run ?? runCommand)(file, args, {
        cwd: this.io.projectDir, env: this.io.env, signal: this.io.signal,
        timeout: timeoutMs, killGraceMs: this.io.killGraceMs ?? 2000, input, processGroup: true,
      });
    } catch (error) {
      if (!(error instanceof CommandTimeoutError)) throw error;
      this.warn(`${file} timed out after ${timeoutMs}ms.`);
      return { code: 124, stdout: '', stderr: '', missing: false };
    }
    if (output !== 'capture') {
      if (result.stdout) this.write(result.stdout, output === 'stderr');
      if (result.stderr) this.write(result.stderr, true);
    }
    this.io.signal?.throwIfAborted();
    return { ...result, missing: result.missing ?? false };
  }

  private compose(args: string[], output: 'capture' | 'forward' | 'stderr' = 'forward') {
    return this.command('docker', ['compose', '--project-directory', this.io.projectDir, ...args], output,
      undefined, args[0] === 'up' ? IMAGE_PULL_TIMEOUT_MS : undefined);
  }

  private pause(): Promise<void> {
    return pause(1000, this.io.signal, this.io.sleep);
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
    return (await this.compose(['up', '-d', '--force-recreate', '--no-deps', container])).code === 0;
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
    ], 'forward', undefined, IMAGE_PULL_TIMEOUT_MS)).code === 0;
  }

  async portListening(proto: 'tcp' | 'udp', port: number): Promise<ListenerStatus> {
    const result = await this.command('ss', ['-H', proto === 'tcp' ? '-ltn' : '-lun']);
    if (!result.missing) return new RegExp(`[:.]${port}\\s`).test(result.stdout);
    if (proto === 'udp') return 'unknown';
    return tcpOpen(port, this.io.signal, 5000);
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
        `proxy-user = "${quote(isp.user)}:${quote(isp.pass)}"\nnoproxy = ""\n` +
        `url = "${url}"\nsilent\nshow-error\nfail\nmax-time = 15\n`);
      const ip = result.stdout.trim();
      if (result.code === 0 && (isIpv4(ip) || isIpv6Strict(ip))) return ip;
    }
    return undefined;
  }
}
