import { createServer } from 'node:http';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
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
const nonBashSh = spawnSync('/bin/sh', ['-c', '[ -z "${BASH_VERSION+x}" ]']).status === 0;
async function scenario(
  options: {
    shell?: 'bash' | 'sh';
    tampered?: boolean;
    missing?: boolean;
    unreachable?: boolean;
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
  const requestedVersion = options.version ?? 'v22.99.0';
  const tree = join(root, 'tree', `node-${requestedVersion}-linux-${nodeArch}`);
  mkdirSync(join(tree, 'bin'), { recursive: true });
  writeFileSync(join(tree, 'bin/node'), `#!/bin/bash\necho ${requestedVersion}\n`, { mode: 0o755 });
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
    const name = `node-${requestedVersion}-linux-${nodeArch}.tar.${ext}`;
    const path = join(root, name);
    execFileSync('tar', [
      ext === 'gz' ? '-czf' : '-cJf',
      path,
      '-C',
      join(root, 'tree'),
      `node-${requestedVersion}-linux-${nodeArch}`,
    ]);
    // Hash the genuine archive first. The mirror can then serve a valid but altered
    // archive, so checksum verification is the only barrier to executing its node.
    const bytes = readFileSync(path);
    sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
    if (options.tampered) {
      writeFileSync(
        join(tree, 'bin/node'),
        `#!/bin/bash\necho ${requestedVersion}\ntouch "$HOME/PWNED"\n`,
        { mode: 0o755 },
      );
      execFileSync('tar', [
        ext === 'gz' ? '-czf' : '-cJf',
        path,
        '-C',
        join(root, 'tree'),
        `node-${requestedVersion}-linux-${nodeArch}`,
      ]);
      buffers[name] = readFileSync(path);
      // Restore genuine contents before hashing the next archive format.
      writeFileSync(join(tree, 'bin/node'), `#!/bin/bash\necho ${requestedVersion}\n`, {
        mode: 0o755,
      });
    } else {
      buffers[name] = bytes;
    }
  }
  const fakeSums = Object.entries(buffers).map(
    ([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}`,
  );
  let requests = 0;
  let officialChecksumRequests = 0;
  const official = createServer((req, res) => {
    requests++;
    if (req.url!.endsWith('/SHASUMS256.txt')) {
      officialChecksumRequests++;
      res.end(options.missing ? '' : sums.join('\n'));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => official.listen(0, '127.0.0.1', r));
  const officialAddress = official.address() as { port: number };
  if (options.unreachable) {
    await new Promise<void>((r) => official.close(() => r()));
  }
  let checksumRequests = 0;
  const server = createServer((req, res) => {
    requests++;
    const name = req.url!.split('/').pop()!;
    if (name === 'SHASUMS256.txt') {
      checksumRequests++;
      res.end(fakeSums.join('\n'));
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
      ({ stdout, stderr } = await execute(options.shell ?? 'bash', ['install.sh'], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${fake}:${process.env.PATH}`,
          MY_SINGBOX_NODE_DIR: join(home, '.local/node'),
          MY_SINGBOX_NODE_VERSION: options.version ?? 'v22.99.0',
          MY_SINGBOX_NODE_MIRROR: `http://127.0.0.1:${address.port}`,
          MY_SINGBOX_NODE_SHASUMS_BASE: `http://127.0.0.1:${officialAddress.port}`,
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
      const counters = `SHASUMS requests: mirror=${checksumRequests}, ` +
        `official=${officialChecksumRequests}\n`;
      const evidence = `${stdout}${stderr}${counters}exit code: ${code}\n`;
      console.log(`Tampered tarball evidence:\n${evidence}`);
      if (process.env.TS_TEST_LOG_DIR) {
        mkdirSync(process.env.TS_TEST_LOG_DIR, { recursive: true });
        const name = requestedVersion === 'v22.23.4'
          ? 'tampered-tarball.log'
          : 'tampered-tarball-fake-mirror-shasums.log';
        writeFileSync(join(process.env.TS_TEST_LOG_DIR, name), evidence);
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
      officialChecksumRequests,
      installed,
      version,
      markerExists: existsSync(join(home, 'PWNED')),
    };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    if (official.listening) await new Promise<void>((r) => official.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
}
it.skipIf(!nonBashSh)('sh without bash prints the legacy hint and creates nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'my-singbox-no-bash-'));
  const home = join(root, 'home');
  const path = join(root, 'path');
  mkdirSync(home);
  mkdirSync(path);
  try {
    const r = spawnSync('/bin/sh', ['install.sh'], {
      env: { PATH: path, HOME: home },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ERROR: bash not found');
    expect(r.stderr).toContain('musl/Alpine');
    expect(r.stderr).toContain(
      'use shell v1.1.0: https://github.com/zht7063/my-singbox/releases/tag/v1.1.0',
    );
    expect(r.stdout).toBe('');
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(['home', 'path']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('sh re-executes bash and installs normally', async () => {
  const r = await scenario({ shell: 'sh' });
  expect(r.code).toBe(0);
  expect(r.version).toBe('v22.99.0');
});
it.skipIf(!available || !nonBashSh)('sh reading the installer from stdin asks for a saved file', () => {
  const r = spawnSync('sh', [], {
    input: readFileSync('install.sh'),
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('ERROR: run this installer from a saved file: sh install.sh');
});
test('valid mirror tarball installs using official checksums', async () => {
  const r = await scenario();
  expect(r.code).toBe(0);
  expect(r.version).toBe('v22.99.0');
  expect(r.checksumRequests).toBe(0);
  expect(r.officialChecksumRequests).toBe(1);
  expect(r.stdout).toContain('127.0.0.1');
});
test('fake mirror checksums cannot authorize a tampered non-default tarball', async () => {
  const r = await scenario({ tampered: true });
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain('checksum mismatch');
  expect(r.installed).toBe(false);
  expect(r.markerExists).toBe(false);
  expect(r.checksumRequests).toBe(0);
  expect(r.officialChecksumRequests).toBe(1);
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

test('default pin rejects tampering without fetching any checksums', async () => {
  const r = await scenario({ version: 'v22.23.4', tampered: true });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('ERROR: checksum mismatch');
  expect(r.installed).toBe(false);
  expect(r.markerExists).toBe(false);
  expect(r.checksumRequests).toBe(0);
  expect(r.officialChecksumRequests).toBe(0);
  expect(r.stdout).toContain('checksum: built-in pin for v22.23.4');
});

test('unreachable official checksums fail before downloading a tarball', async () => {
  const r = await scenario({ unreachable: true });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('cannot fetch the official SHASUMS256.txt');
  expect(r.stderr).toContain('refusing to use mirror checksums');
  expect(r.installed).toBe(false);
  expect(r.markerExists).toBe(false);
  expect(r.requests).toBe(0);
  expect(r.checksumRequests).toBe(0);
});

it('default tarball pins match the verified table', () => {
  const source = readFileSync('install.sh', 'utf8');
  const pins = Object.fromEntries(
    [...source.matchAll(/(node-v22\.23\.4-linux-\w+\.tar\.\w+)\)\s+expected=([a-f0-9]{64})/g)]
      .map((match) => [match[1], match[2]]),
  );
  expect(pins).toEqual({
    'node-v22.23.4-linux-arm64.tar.gz':
      'f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9',
    'node-v22.23.4-linux-arm64.tar.xz':
      '6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b',
    'node-v22.23.4-linux-x64.tar.gz':
      'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406',
    'node-v22.23.4-linux-x64.tar.xz':
      '1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce',
  });
});
