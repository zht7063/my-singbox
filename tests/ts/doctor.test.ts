import { describe, it, expect, vi } from 'vitest';
import { run } from '../../src/cli/commands.js';
import { checkNode, checkPlatform, checkArch, checkCompose } from '../../src/doctor/checks.js';
import type { System } from '../../src/index.js';

function system(patch: Partial<System> = {}): System {
  return {
    nodeVersion: '22.1.0',
    platform: 'linux',
    arch: 'x64',
    glibcVersionRuntime: '2.31',
    exec: vi.fn(async () => ''),
    socketAccessible: () => true,
    username: () => "test'user",
    ...patch,
  };
}
async function invoke(args: string[], s = system()) {
  let stdout = '';
  let stderr = '';
  const code = await run(args, {
    system: s,
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
  });
  return { code, stdout, stderr };
}
describe('doctor', () => {
  it('summarizes OK, WARN, and FAIL separately', async () => {
    const r = await invoke(
      ['doctor'],
      system({
        nodeVersion: '20.1.0',
        exec: async (file) => {
          if (file === 'docker') {
            throw Error();
          }
          return '';
        },
      }),
    );
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('Summary: 3 OK, 1 WARN, 1 FAIL');
  });

  it('all OK and socket access exits zero', async () => {
    const r = await invoke(['doctor']);
    expect(r.code).toBe(0);
    expect(r.stdout.match(/\[ OK \]/g)).toHaveLength(5);
    expect(r.stdout).toContain('Summary: 5 OK, 0 WARN, 0 FAIL');
  });

  it('Node 20 fails', () => {
    return expect(checkNode(system({ nodeVersion: '20.1.0' })).status).toBe('FAIL');
  });

  it.each([undefined, '2.17'])(
    'unsupported libc %s points to shell version',
    (glibcVersionRuntime) => {
      const r = checkPlatform(system({ glibcVersionRuntime }));
      expect(r.status).toBe('FAIL');
      expect(r.message).toContain('v1.1.0');
    },
  );
  it.each(['2.28', '2.31'])('glibc %s works', (glibcVersionRuntime) => {
    return expect(checkPlatform(system({ glibcVersionRuntime })).status).toBe('OK');
  });

  it.each(['ia32', 'riscv64'])('arch %s fails', (arch) => {
    expect(checkArch(system({ arch })).status).toBe('FAIL');
    expect(checkArch(system({ arch })).message).toContain('v1.1.0');
  });

  it('arm64 works', () => {
    return expect(checkArch(system({ arch: 'arm64' })).status).toBe('OK');
  });

  it('non-linux fails', () => {
    return expect(checkPlatform(system({ platform: 'darwin' })).message).toContain('only Linux');
  });

  it('v2 works', async () => {
    return expect((await checkCompose(system())).status).toBe('OK');
  });

  it('legacy warns', async () => {
    return expect(
      (
        await checkCompose(
          system({
            exec: async (f) => {
              if (f === 'docker') {
                throw Error();
              }
              return '';
            },
          }),
        )
      ).status,
    ).toBe('WARN');
  });

  it('neither compose fails', async () => {
    return expect(
      (
        await checkCompose(
          system({
            exec: async () => {
              throw Error();
            },
          }),
        )
      ).status,
    ).toBe('FAIL');
  });

  it.each(['EACCES', 'ENOENT'])('socket %s prints safe guidance', async () => {
    const exec = vi.fn(async (_file: string, _args: string[]) => 'users');
    const r = await invoke(['doctor'], system({ socketAccessible: () => false, exec }));
    expect(r.code).toBe(1);
    for (const value of [
      '8388/tcp',
      '8388/udp',
      '8443/tcp',
      '13839/tcp',
      '13839/udp',
      '18444/tcp',
      'curl -fsSL https://get.docker.com | sudo sh',
      'sudo usermod -aG docker',
      'equivalent to root',
      'never uses sudo',
      "'test'\\''user'",
    ]) {
      expect(r.stdout).toContain(value);
    }
    expect(exec.mock.calls.every(([f]) => !['sudo', 'usermod', 'curl'].includes(f))).toBe(true);
    expect(r.stdout).not.toContain('SECRET');
  });

  it('existing docker member gets daemon advice', async () => {
    const r = await invoke(
      ['doctor'],
      system({ socketAccessible: () => false, exec: async () => 'users docker' }),
    );
    expect(r.stdout).toContain('daemon may not be running');
    expect(r.stdout).not.toContain('usermod');
    expect(r.stdout).toContain('8388/tcp');
  });

  it('runs all five checks despite early failure', async () => {
    const r = await invoke(
      ['doctor'],
      system({ nodeVersion: '20', platform: 'darwin', arch: 'ia32' }),
    );
    expect(r.stdout).toContain('Docker socket');
    expect(r.code).toBe(1);
  });
});
describe('CLI', () => {
  it.each(['init', 'start'])(
    '%s stub and help',
    async (cmd) => {
      expect((await invoke([cmd])).code).toBe(2);
      expect((await invoke([cmd])).stderr).toContain('not implemented yet');
      expect((await invoke([cmd, '-h'])).code).toBe(0);
    },
  );
  it('isp-outbound help', async () => {
    expect((await invoke(['isp-outbound', '-h'])).code).toBe(0);
  });

  it('isp unknown', async () => {
    const r = await invoke(['isp-outbound', '--bogus']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown argument: --bogus');
  });

  it('unknown command', async () => {
    return expect((await invoke(['bogus'])).code).toBe(1);
  });

  it('default help and doctor help', async () => {
    expect((await invoke([])).code).toBe(0);
    expect((await invoke(['doctor', '--help'])).code).toBe(0);
  });
});
