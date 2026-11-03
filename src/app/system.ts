import { spawn } from 'node:child_process';
import { createIspRedactor } from '../core/isp-service.js';

export interface CommandResult { code: number; stdout: string; stderr: string }
export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeout?: number;
  input?: string;
}
export type CommandRunner = (file: string, args: string[], options: CommandOptions) => Promise<CommandResult>;

/** Capture before forwarding: secrets split across process chunks must never escape. */
export const runCommand: CommandRunner = (file, args, options) => new Promise((resolve, reject) => {
  options.signal?.throwIfAborted();
  const grouped = process.platform !== 'win32';
  const child = spawn(file, args, { cwd: options.cwd, env: options.env, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', spawnError = false, timedOut = false, tooLarge = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
  };
  const stop = () => {
    kill('SIGTERM');
    killTimer ??= setTimeout(() => kill('SIGKILL'), 1500);
    killTimer.unref();
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeout ?? 120000);
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
  child.on('error', () => { spawnError = true; });
  child.stdin.on('error', () => { /* A process may exit before reading stdin. */ });
  child.once('close', (code) => {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', abort);
    if (options.signal?.aborted) { reject(options.signal.reason ?? new Error('操作已取消。')); return; }
    if (timedOut || tooLarge) { reject(new Error(`${file} ${timedOut ? '执行超时' : '输出超过限制'}。`)); return; }
    resolve({ code: spawnError ? 127 : code ?? 1, stdout, stderr });
  });
  child.stdin.end(options.input);
});

/** Strip terminal escapes and control characters after redacting the full message. */
export function safeText(text: string, secrets: readonly string[] = []): string {
  return createIspRedactor(secrets)(text).replace(/[\x80-\x9f]/g, '');
}

export interface OperationEvent {
  stage: string;
  status: 'running' | 'done' | 'skipped' | 'failed';
  message: string;
}
export interface ApplicationIO {
  projectDir: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  run?: CommandRunner;
  onEvent?(event: OperationEvent): void;
  onLog?(text: string): void;
}
