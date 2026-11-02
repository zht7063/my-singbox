import { afterEach, vi } from 'vitest';
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { run, type IO, type CliDeps } from '../../../src/cli/commands.js';
import { creds, fixtureText } from './fixtures.js';

export const root = resolve(import.meta.dirname, '../../..');
export const shellEnv = { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' };
const projects: string[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

export function project(text: string | null = fixtureText()): string {
  const dir = mkdtempSync(join(tmpdir(), 'p2-cli-'));
  projects.push(dir);
  for (const name of ['scripts', 'templates', 'compose.yaml'])
    cpSync(join(root, name), join(dir, name), { recursive: true });
  if (text !== null) writeFileSync(join(dir, '.env'), text, { mode: 0o600 });
  return dir;
}

export function keyDeps(): CliDeps {
  return {
    dockerAvailable: vi.fn(async () => true),
    dockerDaemonUp: vi.fn(async () => true),
    detectPublicIp: vi.fn(async () => '8.8.8.8'),
    randomUuid: vi.fn(() => creds.vlessUuid),
    randomShortId: vi.fn(() => creds.realityShortId),
    runSingbox: vi.fn(async (args: string[]) => args[1] === 'reality-keypair'
      ? `PrivateKey: ${creds.realityPrivateKey}\nPublicKey: ${creds.realityPublicKey}\n`
      : `${creds.ssPassword}\n`),
  };
}

export async function invoke(cmd: string, cwd: string, patch: Partial<IO> = {}, args: string[] = []) {
  let stdout = '', stderr = '';
  const code = await run([cmd, ...args], {
    cwd,
    env: { SING_BOX_VERSION: creds.singBoxVersion },
    deps: keyDeps(),
    system: {
      nodeVersion: '22.0.0', platform: 'linux', arch: 'x64', glibcVersionRuntime: '2.36',
      exec: async () => '', socketAccessible: () => true, username: () => 'fixture',
    },
    stdout: (s) => { stdout += s; },
    stderr: (s) => { stderr += s; },
    ...patch,
  });
  return { code, stdout, stderr };
}

export function read(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

export function bash(dir: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('bash', args, { cwd: dir, env: { ...shellEnv, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function stubKeyCommands(dir: string): Record<string, string> {
  const bin = join(dir, 'stubs');
  mkdirSync(bin);
  const stubs = {
    docker: `case "$*" in
      *'generate uuid'*) printf '%s\\n' "$FIX_UUID" ;;
      *'generate reality-keypair'*) printf 'PrivateKey: %s\\nPublicKey: %s\\n' "$FIX_PRIVATE" "$FIX_PUBLIC" ;;
      *'generate rand --base64 16'*) printf '%s\\n' "$FIX_SS" ;;
    esac`,
    curl: 'printf "8.8.8.8\\n"',
    openssl: 'printf "%s\\n" "$FIX_SHORT"',
  };
  for (const [name, body] of Object.entries(stubs))
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return {
    PATH: `${bin}:${shellEnv.PATH}`, SING_BOX_VERSION: creds.singBoxVersion,
    FIX_UUID: creds.vlessUuid, FIX_PRIVATE: creds.realityPrivateKey,
    FIX_PUBLIC: creds.realityPublicKey, FIX_SS: creds.ssPassword, FIX_SHORT: creds.realityShortId,
  };
}
