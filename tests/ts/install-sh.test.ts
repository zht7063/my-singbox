import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { it, expect } from 'vitest';

const execute = promisify(execFile);
const available = ['bash', 'tar', 'curl'].every((tool) => {
  try {
    execFileSync('which', [tool]);
    return true;
  } catch {
    return false;
  }
});
const test = it.skipIf(!available); // Requires bash, tar, curl; skip only when unavailable.
async function scenario(
  options: {
    tampered?: boolean;
    missing?: boolean;
    os?: string;
    arch?: string;
    libc?: string;
    node?: string;
    force?: boolean;
    version?: string;
    localNode?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'my-singbox-installer-'));
  const home = join(root, 'home');
  const fake = join(root, 'fake');
  mkdirSync(home);
  mkdirSync(fake);
  const executable = (name: string, body: string) =>
    writeFileSync(join(fake, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  const hostArch = execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim();
  const selectedArch = options.arch ?? hostArch;
  const nodeArch = ['aarch64', 'arm64'].includes(selectedArch) ? 'arm64' : 'x64';
  executable(
    'uname',
    `if [[ $1 == -s ]]; then echo '${options.os ?? 'Linux'}'; else echo '${selectedArch}'; fi`,
  );
  executable('ldd', `echo '${options.libc ?? 'ldd (GNU libc) 2.31'}'`);
  if (options.localNode) {
    const bin = join(home, '.local/node/bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'node'), `#!/bin/bash\necho '${options.localNode}'\n`, { mode: 0o755 });
  }
  if (options.node) {
    executable('node', `echo '${options.node}'`);
  }
  const tree = join(root, 'tree', `node-v22.99.0-linux-${nodeArch}`);
  mkdirSync(join(tree, 'bin'), { recursive: true });
  writeFileSync(join(tree, 'bin/node'), '#!/bin/bash\necho v22.99.0\n', { mode: 0o755 });
  const buffers: Record<string, Buffer> = {};
  const sums: string[] = [];
  let extensions = ['gz'];
  try {
    execFileSync('which', ['xz']);
    extensions.push('xz');
  } catch {
    /* gzip fallback */
  }
  for (const ext of extensions) {
    const name = `node-v22.99.0-linux-${nodeArch}.tar.${ext}`;
    const path = join(root, name);
    execFileSync('tar', [
      ext === 'gz' ? '-czf' : '-cJf',
      path,
      '-C',
      join(root, 'tree'),
      `node-v22.99.0-linux-${nodeArch}`,
    ]);
    // Hash the genuine archive first. The mirror can then serve a valid but altered
    // archive, so checksum verification is the only barrier to executing its node.
    const bytes = readFileSync(path);
    sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
    if (options.tampered) {
      writeFileSync(join(tree, 'bin/node'), '#!/bin/bash\necho v22.99.0\ntouch "$HOME/PWNED"\n', {
        mode: 0o755,
      });
      execFileSync('tar', [
        ext === 'gz' ? '-czf' : '-cJf',
        path,
        '-C',
        join(root, 'tree'),
        `node-v22.99.0-linux-${nodeArch}`,
      ]);
      buffers[name] = readFileSync(path);
      // Restore genuine contents before hashing the next archive format.
      writeFileSync(join(tree, 'bin/node'), '#!/bin/bash\necho v22.99.0\n', { mode: 0o755 });
    } else {
      buffers[name] = bytes;
    }
  }
  let requests = 0;
  let checksumRequests = 0;
  const server = createServer((req, res) => {
    requests++;
    const name = req.url!.split('/').pop()!;
    if (name === 'SHASUMS256.txt') {
      checksumRequests++;
      res.end(options.missing ? '' : sums.join('\n'));
    } else if (buffers[name]) {
      res.end(buffers[name]);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  try {
    let stdout = '';
    let stderr = '';
    let code = 0;
    try {
      ({ stdout, stderr } = await execute('bash', ['install.sh'], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${fake}:${process.env.PATH}`,
          MY_SINGBOX_NODE_DIR: join(home, '.local/node'),
          MY_SINGBOX_NODE_VERSION: options.version ?? 'v22.99.0',
          MY_SINGBOX_NODE_MIRROR: `http://127.0.0.1:${address.port}`,
          MY_SINGBOX_FORCE_NODE_INSTALL: options.force === false ? '0' : '1',
        },
      }));
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string };
      code = e.code;
      stdout = e.stdout;
      stderr = e.stderr;
    }
    if (options.tampered) {
      console.log(`Tampered tarball evidence:\n${stdout}${stderr}exit code: ${code}\n`);
      if (process.env.TS_TEST_LOG_DIR) {
        mkdirSync(process.env.TS_TEST_LOG_DIR, { recursive: true });
        writeFileSync(
          join(process.env.TS_TEST_LOG_DIR, 'tampered-tarball.log'),
          `${stdout}${stderr}exit code: ${code}\n`,
        );
      }
    }
    const target = join(home, '.local/node');
    const installed = existsSync(target);
    const version = installed
      ? execFileSync(join(target, 'bin/node'), ['--version'], { encoding: 'utf8' }).trim()
      : '';
    return {
      stdout,
      stderr,
      code,
      requests,
      checksumRequests,
      installed,
      version,
      markerExists: existsSync(join(home, 'PWNED')),
    };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
}
test('valid mirror tarball installs and fetches mirror checksums', async () => {
  const r = await scenario();
  expect(r.code).toBe(0);
  expect(r.version).toBe('v22.99.0');
  expect(r.checksumRequests).toBe(1);
  expect(r.stdout).toContain('127.0.0.1');
});
test('tampered tarball never extracts or creates target', async () => {
  const r = await scenario({ tampered: true });
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain('checksum mismatch');
  expect(r.installed).toBe(false);
  expect(r.markerExists).toBe(false);
});
test('missing checksum aborts', async () => {
  const r = await scenario({ missing: true });
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain('checksum entry');
  expect(r.installed).toBe(false);
});
test.each([
  { libc: 'musl libc (x86_64)' },
  { libc: 'ldd (GNU libc) 2.17' },
  { arch: 'i686' },
  { arch: 'riscv64' },
  { os: 'Darwin' },
  { libc: 'unknown' },
])('unsupported environment %j downloads nothing', async (options) => {
  const r = await scenario(options);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('v1.1.0');
  expect(r.requests).toBe(0);
});
test('existing Node >=22 reused', async () => {
  const r = await scenario({ node: 'v22.1.0', force: false });
  expect(r.code).toBe(0);
  expect(r.requests).toBe(0);
});
test('old Node downloads replacement', async () => {
  const r = await scenario({ node: 'v20.1.0', force: false });
  expect(r.code).toBe(0);
  expect(r.requests).toBe(2);
});

test('arm64 with supported glibc installs', async () => {
  const r = await scenario({ arch: 'aarch64' });
  expect(r.code).toBe(0);
  expect(r.version).toBe('v22.99.0');
});

test('PATH reuse never prepends stale local Node', async () => {
  const r = await scenario({ node: 'v22.1.0', localNode: 'v20.1.0', force: false });
  expect(r.code).toBe(0);
  expect(r.stdout).not.toContain('export PATH');
  expect(r.requests).toBe(0);
});
test('reuses supported local Node when PATH Node is too old', async () => {
  const r = await scenario({ node: 'v20.1.0', localNode: 'v22.1.0', force: false });
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('Using Node at');
  expect(r.requests).toBe(0);
});
test('rejects requested Node below 22 without download', async () => {
  const r = await scenario({ version: 'v20.1.0' });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('Node >=22');
  expect(r.requests).toBe(0);
});
