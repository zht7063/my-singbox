import {
  chmodSync, chownSync, closeSync, copyFileSync, existsSync, fchmodSync,
  mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  type IspSocks, SS_TAG, VLESS_TAG, SS_ISP_TAG, VLESS_ISP_TAG, OUT_TAG,
  SS_ISP_PORT, VLESS_ISP_PORT,
} from '../model.js';
import type { SingboxConfig } from './render-config.js';
import { ENV_HEADER, ENV_HEADER_NOEOL } from './env.js';
import { ensureRoute, isLegacyIspRule, isRecord, omitIsp, upsertIspOutbound, type RoutePolicy } from './routing.js';

export const ISP_BACKUP_DIR = '.isp-backup', ISP_LOCK_FILE = '.isp.lock',
  ISP_TMP_PREFIX = '.isp-tmp.';
export const MANAGED_FILES = ['config.json', '.env'] as const;
export type ManagedFile = typeof MANAGED_FILES[number];
export class IspError extends Error {
  override name = 'IspError';
}

export function envGet(text: string, key: string): string | undefined {
  return text.split('\n').find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1).replace(/\r$/, '');
}

export function envHasIsp(text: string): boolean {
  return text.split('\n').some((raw) => {
    const line = raw.replace(/\r$/, '');
    return /^ISP_SOCKS_[^=]*=/.test(line) ||
      line === ENV_HEADER || line === ENV_HEADER_NOEOL;
  });
}

export function checkIspConfig(config: unknown): asserts config is SingboxConfig {
  if (!isRecord(config)) throw new IspError('config.json is not valid JSON.');
  const inbounds = config.inbounds;
  if (!Array.isArray(inbounds) || !inbounds.every(isRecord) ||
      ![SS_TAG, VLESS_TAG].every((tag) => inbounds.some((i) => i.tag === tag)))
    throw new IspError('config.json has no inbounds tagged ss-in and vless-reality-in.');
  if (config.outbounds !== undefined && (!Array.isArray(config.outbounds) ||
      !config.outbounds.every(isRecord))) throw new IspError('config.json has invalid outbounds.');
  if (config.route !== undefined && (!isRecord(config.route) ||
      (config.route.rules !== undefined && !Array.isArray(config.route.rules))))
    throw new IspError('config.json has invalid route rules.');
}

export function configHasIsp(config: SingboxConfig): boolean {
  return [...(config.inbounds ?? []), ...(config.outbounds ?? [])].some(
    (i) => isRecord(i) && [SS_ISP_TAG, VLESS_ISP_TAG, OUT_TAG].includes(i.tag as string),
  ) || (config.route?.rules ?? []).some((r) => isRecord(r) && r.outbound === OUT_TAG);
}

/** Remove only the known old listener scheme; ambiguous references need manual migration. */
function withoutLegacyListeners(config: SingboxConfig): SingboxConfig {
  const next = structuredClone(config);
  const tags = new Set([SS_ISP_TAG, VLESS_ISP_TAG]);
  next.inbounds = next.inbounds.filter((inbound) => {
    if (!tags.has(inbound.tag as string)) return true;
    const ss = inbound.tag === SS_ISP_TAG;
    if (inbound.type !== (ss ? 'shadowsocks' : 'vless') ||
        inbound.listen_port !== (ss ? SS_ISP_PORT : VLESS_ISP_PORT))
      throw new IspError('Legacy ISP inbound was customized. Migrate its tag and references manually first.');
    return false;
  });
  if (next.route?.rules) next.route.rules = next.route.rules.flatMap((rule) => {
    if (!isRecord(rule)) return [rule];
    const inbound = typeof rule.inbound === 'string' ? [rule.inbound] : rule.inbound;
    if (!Array.isArray(inbound) || !inbound.some((tag) => tags.has(tag))) return [rule];
    const remaining = inbound.filter((tag) => !tags.has(tag));
    if (remaining.length) return [{ ...rule, inbound: remaining }];
    if (isLegacyIspRule(rule)) return [];
    throw new IspError('A custom route depends on legacy ISP inbounds. Migrate it manually first.');
  });
  const check = (value: unknown, key = ''): void => {
    if (typeof value === 'string' && tags.has(value) && ['inbound', 'detour'].includes(key))
      throw new IspError('A custom reference depends on legacy ISP inbounds. Migrate it manually first.');
    if (Array.isArray(value)) value.forEach((item) => check(item, key));
    else if (isRecord(value)) Object.entries(value).forEach(([name, item]) => check(item, name));
  };
  check(next);
  return next;
}

export function addIspToConfig(
  config: SingboxConfig, isp: IspSocks, routeDefaults?: RoutePolicy,
): SingboxConfig {
  checkIspConfig(config);
  const next = withoutLegacyListeners(config);
  upsertIspOutbound(next, isp);
  ensureRoute(next, routeDefaults);
  return next;
}

export function removeIspFromConfig(config: SingboxConfig): SingboxConfig {
  checkIspConfig(config);
  const next = withoutLegacyListeners(config);
  omitIsp(next);
  return next;
}

export function makeTmpPath(projectDir: string): string {
  return join(projectDir, ISP_TMP_PREFIX + randomBytes(16).toString('hex'));
}

export function installFile(dest: string, data: string | Uint8Array, projectDir: string): void {
  const tmp = makeTmpPath(projectDir);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, data);
      fchmodSync(fd, 0o600);
    } finally { closeSync(fd); }
    if (process.getuid?.() === 0 && existsSync(dest)) {
      const { uid, gid } = statSync(dest);
      chownSync(tmp, uid, gid);
    }
    renameSync(tmp, dest);
  } finally { rmSync(tmp, { force: true }); }
}

function copyPreserved(src: string, dest: string): void {
  const info = statSync(src);
  copyFileSync(src, dest);
  if (process.getuid?.() === 0) chownSync(dest, info.uid, info.gid);
  chmodSync(dest, info.mode & 0o7777);
  utimesSync(dest, info.atimeMs / 1000, info.mtimeMs / 1000);
}

function backupDirs(projectDir: string): string[] {
  const root = join(projectDir, ISP_BACKUP_DIR);
  return existsSync(root) ? readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name)).sort() : [];
}

let lastStamp = 0n;
export function makeBackup(projectDir: string, files: readonly ManagedFile[] = MANAGED_FILES): string {
  const now = BigInt(Date.now()) * 1_000_000n;
  lastStamp = now > lastStamp ? now : lastStamp + 1n;
  const d = new Date(Number(lastStamp / 1_000_000n));
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-` +
    `${(lastStamp % 1_000_000_000n).toString().padStart(9, '0')}-${process.pid}`;
  const root = join(projectDir, ISP_BACKUP_DIR), dir = join(root, stamp);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  mkdirSync(dir, { mode: 0o700 });
  for (const file of files) {
    const src = join(projectDir, file);
    if (existsSync(src) && statSync(src).isFile()) copyPreserved(src, join(dir, file));
  }
  const all = backupDirs(projectDir);
  for (const old of all.slice(1, Math.max(1, all.length - 4))) rmSync(old, { recursive: true });
  return dir;
}

export function restoreBackup(
  projectDir: string, backupDir: string, files: readonly ManagedFile[] = MANAGED_FILES,
): void {
  for (const file of files) {
    const src = join(backupDir, file), dest = join(projectDir, file);
    if (existsSync(src) && statSync(src).isFile()) copyPreserved(src, dest);
  }
}

export function sweepStaleTmp(projectDir: string): void {
  for (const entry of readdirSync(projectDir, { withFileTypes: true }))
    if (entry.name.startsWith(ISP_TMP_PREFIX) && entry.isFile())
      rmSync(join(projectDir, entry.name));
}

function lockState(path: string): 'absent' | 'alive' | 'dead' {
  let pid: number;
  try { pid = Number(readFileSync(path, 'utf8').trim()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
  // An empty lock may belong to a process still writing its PID.
  if (!Number.isInteger(pid) || pid <= 0) return 'alive';
  try { process.kill(pid, 0); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code !== 'EPERM') throw error;
  }
  return 'alive';
}

function claimLock(path: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, String(process.pid)); }
      finally { closeSync(fd); }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt > 0 || lockState(path) !== 'dead')
        throw new IspError('Another isp-outbound run is in progress.');
      rmSync(path, { force: true });
    }
  }
}

export async function withLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  const path = join(projectDir, ISP_LOCK_FILE);
  claimLock(path);
  try {
    sweepStaleTmp(projectDir);
    return await fn();
  } finally { rmSync(path, { force: true }); }
}
