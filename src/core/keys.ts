import { IMAGE_PULL_TIMEOUT_MS, runCommand } from './isp-service.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { get } from 'node:https';
import {
  UUID_RE,
  PRIVATE_KEY_RE,
  PUBLIC_KEY_RE,
  SHORT_ID_RE,
  SS_PASSWORD_RE,
  isPublicIp,
} from './validate.js';

export interface KeyDeps {
  runSingbox(args: string[]): Promise<string>;
  randomUuid(): string;
  randomShortId(): string;
}

export async function generateKeys(deps: KeyDeps) {
  const vlessUuid = deps.randomUuid(),
    realityShortId = deps.randomShortId();
  const output = await deps.runSingbox(['generate', 'reality-keypair']);
  const field = (name: string) =>
    output
      .split('\n')
      .filter((l) => new RegExp(`^\\s*${name}:`).test(l))
      .map((l) => l.split(/: */)[1])
      .join('\n');
  const realityPrivateKey = field('PrivateKey'),
    realityPublicKey = field('PublicKey');
  const ssPassword = (
    await deps.runSingbox(['generate', 'rand', '--base64', '16'])
  ).replace(/\n+$/, '');
  if (
    !UUID_RE.test(vlessUuid) ||
    !PRIVATE_KEY_RE.test(realityPrivateKey) ||
    !PUBLIC_KEY_RE.test(realityPublicKey) ||
    !SHORT_ID_RE.test(realityShortId) ||
    !SS_PASSWORD_RE.test(ssPassword)
  )
    throw new Error('Invalid generated credentials.');
  return {
    vlessUuid,
    realityPrivateKey,
    realityPublicKey,
    realityShortId,
    ssPassword,
  };
}

export type DockerRun = (file: string, args: string[]) => Promise<string>;
const execute: DockerRun = async (file, args) => {
  const result = await runCommand(file, args, {
    cwd: process.cwd(),
    timeout: args[0] === 'run' ? IMAGE_PULL_TIMEOUT_MS : 120_000,
  }).catch(() => null);
  if (!result || result.code) throw new Error('Docker command failed.');
  return result.stdout;
};

export function defaultKeyDeps(image: string): KeyDeps {
  return {
    runSingbox: (args) => execute('docker', ['run', '--rm', image, ...args]),
    randomUuid: randomUUID,
    randomShortId: () => randomBytes(8).toString('hex'),
  };
}

async function dockerProbe(run: DockerRun, args: string[]): Promise<boolean> {
  return run('docker', args).then(
    () => true,
    () => false,
  );
}

export function dockerAvailable(run: DockerRun = execute): Promise<boolean> {
  return dockerProbe(run, ['--version']);
}

export function dockerDaemonUp(run: DockerRun = execute): Promise<boolean> {
  return dockerProbe(run, ['info']);
}

export interface PublicIpDeps {
  httpGet(url: string, family: 4 | 6, signal?: AbortSignal): Promise<string>;
}
const httpGet: PublicIpDeps['httpGet'] = (url, family, signal) =>
  new Promise((resolve, reject) => {
    const req = get(
      url,
      { family, headers: { 'User-Agent': 'my-singbox' }, signal },
      (res) => {
        if (res.statusCode! < 200 || res.statusCode! >= 300) {
          res.resume();
          reject(new Error('HTTP request failed.'));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve(body));
        res.on('error', () => reject(new Error('HTTP request failed.')));
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error('HTTP request timed out.')),
      8000,
    );
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => reject(new Error('HTTP request failed.')));
  });

export async function detectPublicIp(
  deps: PublicIpDeps = { httpGet },
  signal?: AbortSignal,
): Promise<string | null> {
  for (const family of [4, 6] as const) {
    const urls =
      family === 4
        ? [
            'https://ipinfo.io/ip',
            'https://api.ipify.org',
            'https://ipv4.icanhazip.com',
            'https://ifconfig.me/ip',
            'https://api.ip.sb/ip',
          ]
        : ['https://api6.ipify.org', 'https://ipv6.icanhazip.com'];
    for (const url of [...urls, 'https://1.1.1.1/cdn-cgi/trace']) {
      try {
        signal?.throwIfAborted();
        const body = await deps.httpGet(url, family, signal);
        const ip = (
          url.endsWith('/trace')
            ? (body
                .split('\n')
                .find((l) => l.startsWith('ip='))
                ?.split('=')[1] ?? '')
            : body
        ).trim();
        if (isPublicIp(ip)) return ip;
      } catch { signal?.throwIfAborted(); }
    }
  }
  return null;
}
