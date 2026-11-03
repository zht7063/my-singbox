import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnose } from '../../src/app/diagnostics.js';
import { listeningInTable, probePorts } from '../../src/adapters/port-probe.js';
import { safeText, type CommandRunner } from '../../src/app/system.js';
import { run } from '../../src/cli/commands.js';
import type { System } from '../../src/doctor/system.js';

const system: System = { nodeVersion: '22.1.0', platform: 'linux', arch: 'arm64', glibcVersionRuntime: '2.36', exec: async () => '', socketAccessible: () => false, username: () => 'test' };
const options = { projectDir: tmpdir(), osRelease: 'ID=debian\n', system };
const runner = (patch: Record<string, { code: number; stdout: string; stderr: string }> = {}): CommandRunner => async (file, args) => patch[[file, ...args].join(' ')] ?? { code: 0, stdout: args[0] === 'context' ? 'unix:///run/user/1000/docker.sock\n' : 'available\n', stderr: '' };

describe('TUI diagnostics', () => {
  it('uses actual daemon access rather than requiring /var/run/docker.sock', async () => {
    const checks = await diagnose({ ...options, run: runner(), isp: true });
    expect(checks.every((check) => !check.blocks)).toBe(true);
    expect(checks.find((check) => check.id === 'curl')?.status).toBe('OK');
  });
  it('blocks deployment with missing Compose v2 and remote Docker endpoints', async () => {
    const checks = await diagnose({ ...options, env: { DOCKER_HOST: 'ssh://example.test' }, run: runner({ 'docker compose version': { code: 1, stdout: '', stderr: '' } }) });
    expect(checks.filter((check) => check.blocks).map((check) => check.id)).toEqual(['context', 'compose']);
  });
  it('skips dependent Docker probes without treating them as successful', async () => {
    const run = vi.fn(runner({ 'docker --version': { code: 127, stdout: '', stderr: '' } }));
    const checks = await diagnose({ ...options, run });
    expect(checks.find((check) => check.id === 'daemon')).toMatchObject({ status: 'SKIP', blocks: true });
    expect(run.mock.calls.some(([, args]) => args[0] === 'info')).toBe(false);
  });
  it('supports only Debian / Ubuntu and treats missing ss as optional', async () => {
    const checks = await diagnose({ ...options, osRelease: 'ID=fedora', run: runner({ 'ss -V': { code: 127, stdout: '', stderr: '' } }) });
    expect(checks.find((check) => check.id === 'distro')?.blocks).toBe(true);
    expect(checks.find((check) => check.id === 'ss')).toMatchObject({ status: 'WARN', blocks: false });
  });
});

describe('port probes', () => {
  it('matches the local endpoint only and keeps TCP / UDP separate', async () => {
    expect(listeningInTable('LISTEN 0 128 [::]:18388 [::]:*\n', 18388)).toBe(true);
    expect(listeningInTable('LISTEN 0 128 0.0.0.0:118388 0.0.0.0:*\n', 18388)).toBe(false);
    const probes = await probePorts([{ port: 18388, protocol: 'tcp' }, { port: 18388, protocol: 'udp' }], { projectDir: tmpdir(), run: async (_file, args) => ({ code: 0, stdout: args.includes('-lun') ? 'UNCONN 0 0 0.0.0.0:18388 0.0.0.0:*\n' : '', stderr: '' }) });
    expect(probes.map((probe) => probe.state)).toEqual(['free', 'occupied']);
  });
});

describe('terminal boundary', () => {
  it('redacts complete secrets and strips hostile escape sequences', () => {
    expect(safeText('\x1b[2Jsecret-value\x1b]0;title\x07\x00', ['secret-value'])).toBe('***');
  });
  it('rejects non-TTY without writing files or starting deployment', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tui-nontty-'));
    try {
      let output = '';
      const code = await run(['tui'], { cwd, system, stdout: () => {}, stderr: (text) => { output += text; } });
      expect(code).toBe(2); expect(output).toContain('interactive terminal');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('shows TUI help without requiring a terminal', async () => {
    let output = '';
    expect(await run(['tui', '--help'], { system, stdout: (text) => { output += text; }, stderr: () => {} })).toBe(0);
    expect(output).toContain('my-singbox tui');
  });
});
