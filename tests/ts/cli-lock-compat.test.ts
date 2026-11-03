import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { invoke, project } from './helpers/cli.js';

for (const locked of [false, true]) {
  it.each(['gen-keys', 'gen-config', 'conf-clash', 'init', 'start'])(
    `%s leaves ISP temporary files alone (existing lock: ${locked})`, async (command) => {
      const dir = project(null);
      const lock = join(dir, '.isp.lock');
      const temp = join(dir, '.isp-tmp.stale');
      if (locked) writeFileSync(lock, String(process.pid));
      writeFileSync(temp, 'belongs to ISP');
      const result = await invoke(command, dir, {
        start: {
          run: async () => ({ code: 1, stdout: '', stderr: '' }),
          tcpOpen: async () => false,
          sleep: async () => {},
        },
      });
      expect(result.stderr).not.toContain('isp-outbound run');
      if (locked) expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
      else expect(existsSync(lock)).toBe(false);
      expect(readFileSync(temp, 'utf8')).toBe('belongs to ISP');
    },
  );
}

it('start reports its normal missing-compose error in a read-only directory', async () => {
  const dir = project(null);
  rmSync(join(dir, 'compose.yaml'));
  chmodSync(dir, 0o555);
  try {
    const result = await invoke('start', dir);
    expect(result).toEqual({ code: 1, stdout: '', stderr: 'Error: compose.yaml does not exist.\n' });
    expect(existsSync(join(dir, '.isp.lock'))).toBe(false);
  } finally {
    chmodSync(dir, 0o755);
  }
});

it('start can run an existing deployment in a read-only directory', async () => {
  const dir = project();
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ inbounds: [{ type: 'vless', listen_port: 8443 }] }));
  const run = vi.fn(async (_file: string, args: string[]) => ({
    code: 0, stdout: args[0] === 'inspect' ? 'running\n' : '', stderr: '',
  }));
  chmodSync(dir, 0o555);
  try {
    const result = await invoke('start', dir, { start: { run, tcpOpen: async () => true, sleep: async () => {} } });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Self-check passed. Ports: 8443');
    expect(existsSync(join(dir, '.isp.lock'))).toBe(false);
    expect(run).toHaveBeenCalledWith('docker', ['compose', '--project-directory', dir, 'up', '-d']);
  } finally {
    chmodSync(dir, 0o755);
  }
});
