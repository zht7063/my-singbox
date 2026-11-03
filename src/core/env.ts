import {
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  fchmodSync,
  closeSync,
  linkSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parsePorts, type Ports } from './ports.js';

export const ENV_KEYS = [
  'SING_BOX_VERSION',
  'VLESS_UUID',
  'REALITY_PRIVATE_KEY',
  'REALITY_PUBLIC_KEY',
  'REALITY_SHORT_ID',
  'SS_PASSWORD',
  'SERVER_ADDRESS',
  'SS_PORT',
  'VLESS_PORT',
  'ISP_SOCKS_ADDR',
  'ISP_SOCKS_USER',
  'ISP_SOCKS_PASS',
  'ISP_SOCKS_EGRESS_IP',
] as const;

export type EnvKey = (typeof ENV_KEYS)[number];

export interface Env {
  values: Partial<Record<EnvKey, string>>;
  keys: Set<EnvKey>;
}

export class EnvError extends Error {
  override name = 'EnvError';
}

export class FileExistsError extends Error {
  override name = 'FileExistsError';
  constructor() {
    super('File already exists. Refusing to overwrite.');
  }
}

export function envQuote(v: string): string {
  return (
    '"' +
    v
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('$', () => '$$') +
    '"'
  );
}

export function envUnquote(raw: string): string | null {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\') {
      const next = inner[++i];
      if (next !== '\\' && next !== '"') return null;
      out += next;
    } else if (c === '"') return null;
    else if (c === '$') {
      if (inner[++i] !== '$') return null;
      out += '$';
    } else out += c;
  }
  return out;
}

export function parseEnv(text: string, label = '.env'): Env {
  const env: Env = { values: {}, keys: new Set() };
  text.split('\n').forEach((line, i) => {
    line = line.replace(/\r$/, '');
    if (/^\s*(#|$)/.test(line)) return;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=([^\n]*)$/.exec(line);
    if (!m) throw new EnvError(`Invalid line ${i + 1} in ${label}`);
    const key = m[1] as EnvKey;
    if (!ENV_KEYS.includes(key))
      throw new EnvError(`Unknown key in ${label}: ${key}`);
    if (env.keys.has(key))
      throw new EnvError(`Duplicate key in ${label}: ${key}`);
    env.keys.add(key);
    env.values[key] = m[2];
  });
  return env;
}

export function loadEnvFile(path: string): Env {
  return parseEnv(readFileSync(path, 'utf8'));
}

export const ENV_HEADER = '# ISP outbound (managed by scripts/isp-outbound.sh)';

export const ENV_HEADER_NOEOL =
  ENV_HEADER + ' [original file had no trailing newline]';
function stripIsp(text: string): { text: string; noeol: boolean } {
  let noeol = !!text && !text.endsWith('\n');
  const kept: string[] = [];
  const lines = text.split('\n');
  if (text.endsWith('\n') || !text) lines.pop();
  for (const line of lines) {
    if (line === ENV_HEADER || line === ENV_HEADER_NOEOL) {
      if (line === ENV_HEADER_NOEOL) noeol = true;
      if (kept.at(-1) === '') kept.pop();
    } else if (!/^ISP_SOCKS_(ADDR|USER|PASS|EGRESS_IP)=/.test(line))
      kept.push(line);
  }
  return {
    text: kept.length ? kept.join('\n') + (noeol ? '' : '\n') : '',
    noeol,
  };
}

export function envWithoutIsp(text: string): string {
  return stripIsp(text).text;
}

export function envWithIsp(
  text: string,
  isp: { addr: string; user: string; pass: string; egressIp: string },
): string {
  const base = stripIsp(text);
  return (
    base.text +
    (base.noeol ? '\n' : '') +
    '\n' +
    (base.noeol ? ENV_HEADER_NOEOL : ENV_HEADER) +
    '\n' +
    `ISP_SOCKS_ADDR=${isp.addr}\nISP_SOCKS_USER=${envQuote(isp.user)}\nISP_SOCKS_PASS=${envQuote(isp.pass)}\nISP_SOCKS_EGRESS_IP=${isp.egressIp}\n`
  );
}

export function renderGeneratedEnv(v: {
  singBoxVersion: string;
  vlessUuid: string;
  realityPrivateKey: string;
  realityPublicKey: string;
  realityShortId: string;
  ssPassword: string;
  serverAddress: string;
  ports?: Ports;
}): string {
  const ports = v.ports === undefined ? undefined : parsePorts(v.ports);
  return `SING_BOX_VERSION=${v.singBoxVersion}\n\n# VLESS\nVLESS_UUID=${v.vlessUuid}\n\n# REALITY\nREALITY_PRIVATE_KEY=${v.realityPrivateKey}\nREALITY_PUBLIC_KEY=${v.realityPublicKey}\nREALITY_SHORT_ID=${v.realityShortId}\n\n# Shadowsocks 2022\nSS_PASSWORD=${v.ssPassword}\n\n# Client\nSERVER_ADDRESS=${v.serverAddress}\n` +
    (ports ? `\n# Listening ports\nSS_PORT=${ports.ss}\nVLESS_PORT=${ports.vless}\n` : '');
}

export function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: { exclusive?: boolean } = {},
): void {
  const tempBase = basename(path) === '.env' ? '.env' : `.${basename(path)}`;
  const tmp = join(
    dirname(path),
    `${tempBase}.tmp.${randomBytes(12).toString('hex')}`,
  );
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
    if (options.exclusive) {
      try {
        linkSync(tmp, path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST')
          throw new FileExistsError();
        throw e;
      }
    } else renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function writeEnvFile(path: string, text: string): void {
  writeFileAtomic(path, text, { exclusive: true });
}
