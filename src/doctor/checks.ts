import type { System } from './system.js';

export type Status = 'OK' | 'WARN' | 'FAIL';
export interface Check {
  name: string;
  status: Status;
  message: string;
}

export const legacyHint =
  'Use shell version v1.1.0: https://github.com/zht7063/my-singbox/releases/tag/v1.1.0';
const result = (name: string, ok: boolean, message: string): Check => ({
  name,
  status: ok ? 'OK' : 'FAIL',
  message,
});
export function checkNode(s: System): Check {
  return result(
    'Node',
    Number(s.nodeVersion.split('.')[0]) >= 22,
    `Node ${s.nodeVersion}; requires >=22`,
  );
}

export function checkPlatform(s: System): Check {
  if (s.platform !== 'linux') {
    return result('Platform/libc', false, 'only Linux servers are supported');
  }
  // Official Node builds require glibc; an absent runtime version on Linux means musl.
  const [major, minor] = (s.glibcVersionRuntime ?? '').split('.').map(Number);
  const ok = major > 2 || (major === 2 && minor >= 28);
  const unsupportedLibc = s.glibcVersionRuntime
    ? `glibc ${s.glibcVersionRuntime} (<2.28)`
    : 'musl/Alpine';
  return result(
    'Platform/libc',
    ok,
    ok
      ? `Linux glibc ${s.glibcVersionRuntime}`
      : `Official Node/this tool is unsupported on ${unsupportedLibc}. ${legacyHint}`,
  );
}

export function checkArch(s: System): Check {
  return result(
    'Architecture',
    ['x64', 'arm64'].includes(s.arch),
    `${s.arch}${['x64', 'arm64'].includes(s.arch) ? '' : `. Unsupported. ${legacyHint}`}`,
  );
}

export async function checkCompose(s: System): Promise<Check> {
  try {
    await s.exec('docker', ['compose', 'version']);
    return result('Docker Compose', true, 'docker compose v2 plugin found');
  } catch {
    /* try legacy */
  }
  try {
    await s.exec('docker-compose', ['version']);
    return {
      name: 'Docker Compose',
      status: 'WARN',
      message: 'legacy docker-compose v1 found; docker compose v2 plugin recommended',
    };
  } catch {
    return result(
      'Docker Compose',
      false,
      'Docker Compose not found. Install Docker: curl -fsSL https://get.docker.com | sudo sh',
    );
  }
}

export function checkSocket(s: System): Check {
  return result('Docker socket', s.socketAccessible(), 'access to /var/run/docker.sock');
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export async function dockerAccessGuidance(s: System): Promise<string> {
  let groups = '';
  try {
    groups = await s.exec('id', ['-Gn']);
  } catch {
    /* unknown groups */
  }
  const already = groups.trim().split(/\s+/).includes('docker');
  return [
    'This tool never uses sudo and never escalates privileges itself.',
    'Open firewall / cloud security group ports: 8388/tcp, 8388/udp, 8443/tcp; ' +
      'only for optional ISP outbound: 13839/tcp, 13839/udp, 18444/tcp.',
    ...(already
      ? [
          'The Docker daemon may not be running, or your session predates the group change. ' +
            'Log out and back in (or run `newgrp docker`).',
        ]
      : [
          'Commands to run as root (printed only):',
          'curl -fsSL https://get.docker.com | sudo sh',
          `sudo usermod -aG docker ${quote(s.username())}`,
          'log out and back in (or run `newgrp docker`) for the group change to take effect.',
        ]),
    'Membership of the docker group is equivalent to root access on this machine; ' +
      'only add users you trust with root.',
  ].join('\n');
}

export async function runDoctor(s: System, write: (text: string) => void): Promise<number> {
  const checks = [
    checkNode(s),
    checkPlatform(s),
    checkArch(s),
    await checkCompose(s),
    checkSocket(s),
  ];
  for (const c of checks) {
    write(`[${c.status === 'OK' ? ' OK ' : c.status}] ${c.name}: ${c.message}\n`);
  }
  if (checks[4].status === 'FAIL') {
    write(`${await dockerAccessGuidance(s)}\n`);
  }
  const failures = checks.filter((c) => c.status === 'FAIL').length;
  const successes = checks.filter((c) => c.status === 'OK').length;
  const warnings = checks.filter((c) => c.status === 'WARN').length;
  write(`Summary: ${successes} OK, ${warnings} WARN, ${failures} FAIL\n`);
  return failures ? 1 : 0;
}
