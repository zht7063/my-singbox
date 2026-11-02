import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { project, invoke, read, bash, stubKeyCommands, shellEnv } from './helpers/cli.js';

const commands = [
  { name: 'gen-keys', file: '.env', success: 'Credentials generated successfully.' },
  { name: 'gen-config', file: 'config.json', success: 'Config generated successfully.' },
  { name: 'conf-clash', file: 'clash.yaml', success: 'Clash config generated successfully.' },
];

for (const { name, file, success } of commands) {
  it.each(['--help', '-h'])('AC14 ' + name + ' %s retains usage and exit 0', async (arg) => {
    const dir = project(null);
    const result = await invoke(name, dir, { env: {} }, [arg]);
    expect(result).toEqual({ code: 0, stdout: `Usage: my-singbox ${name} [args]\n`, stderr: '' });
  });
  it.each([
    { id: 'no args', args: [] },
    { id: 'extra ignored args', args: ['--unknown', 'ignored', '--also-ignored'] },
  ])('AC14 ' + name + ' accepts $id', async ({ args }) => {
    const s = project(name === 'gen-keys' ? null : undefined);
    const t = project(name === 'gen-keys' ? null : undefined);
    const shellOutput = bash(s, [`scripts/${name}.sh`, ...args], name === 'gen-keys' ? stubKeyCommands(s) : {});
    const result = await invoke(name, t, {}, args);
    expect(result.code).toBe(0);
    expect(shellOutput).toContain(success);
    expect(result.stdout).toContain(success);
    expect(result.stderr).toBe('');
    expect(read(t, file).length).toBeGreaterThan(0);
  });
  it('AC14 ' + name + ' refusal has the shell exit code and error text', async () => {
    const dir = project();
    writeFileSync(join(dir, file), 'sentinel');
    const shell = spawnSync('bash', [`scripts/${name}.sh`, '--ignored'], { cwd: dir, env: { ...shellEnv, SING_BOX_VERSION: '1.12.0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const ts = await invoke(name, dir, {}, ['--ignored']);
    expect(shell.error).toBeUndefined();
    expect(shell.status).toBe(1);
    expect(ts.code).toBe(shell.status);
    const error = `Error: ${file} already exists. Refusing to overwrite.`;
    expect(shell.stderr).toContain(error);
    expect(ts.stderr).toContain(error);
    expect(read(dir, file)).toBe('sentinel');
  });
  if (name !== 'gen-keys') {
    it('AC14 ' + name + ' missing .env has the shell exit code and error text', async () => {
      const dir = project(null);
      const shell = spawnSync('bash', [`scripts/${name}.sh`], { cwd: dir, env: shellEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const ts = await invoke(name, dir);
      expect(shell.error).toBeUndefined();
      expect(shell.status).toBe(1);
      expect(ts.code).toBe(shell.status);
      // Only wording difference from v1.1.0: npx installs ship no scripts/, so point at the CLI.
      expect(shell.stderr).toContain('Error: .env does not exist. Run scripts/gen-keys.sh first.');
      expect(ts.stderr).toContain('Error: .env does not exist. Run my-singbox gen-keys first.');
    });
  }
}

it('AC14 gen-keys missing version retains shell failure exit code', async () => {
  const dir = project(null);
  const shell = spawnSync('bash', ['scripts/gen-keys.sh'], { cwd: dir, env: shellEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const ts = await invoke('gen-keys', dir, { env: {} });
  expect(shell.error).toBeUndefined();
  expect(shell.status).toBe(1);
  expect(ts.code).toBe(shell.status);
  expect(shell.stderr).toContain('Please set SING_BOX_VERSION');
  expect(ts.stderr).toBe('Error: Please set SING_BOX_VERSION\n');
});
