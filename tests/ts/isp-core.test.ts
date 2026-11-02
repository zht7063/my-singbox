import { afterEach, expect, it, vi } from 'vitest';
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createConnection, Socket } from 'node:net';
import { parse } from 'yaml';
import {
  IspError, ISP_BACKUP_DIR, ISP_LOCK_FILE, ISP_TMP_PREFIX, MANAGED_FILES, GROUP_MAIN,
  envGet, envHasIsp, checkIspConfig, configHasIsp,
  addIspToConfig, removeIspFromConfig, makeTmpPath, installFile, makeBackup,
  restoreBackup, sweepStaleTmp, withLock, IspService,
} from '../../src/index.js';
import { ENV_HEADER, ENV_HEADER_NOEOL, envWithIsp, parseEnv } from '../../src/core/env.js';
import { buildModel, type IspSocks } from '../../src/model.js';
import { loadSingboxTemplate, renderSingbox, type SingboxConfig } from '../../src/core/render-config.js';
import { renderClash } from '../../src/core/render-clash.js';
import { fixtureModel, fixtureText, isp } from './helpers/fixtures.js';
import { project, read, root } from './helpers/cli.js';
import { setupIsp, address, username, password } from './helpers/isp.js';

// The ss fallback is tested without opening real sockets or depending on host ports.
vi.mock('node:net', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:net')>(), createConnection: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
const socks: IspSocks = { addr: address, host: '198.51.100.7', port: 1080, user: username, pass: password };
const baseConfig = () => renderSingbox(fixtureModel(), loadSingboxTemplate(root));
const baseClash = () => renderClash(fixtureModel(), read(root, 'templates/clash.yaml.template'));
const mode = (file: string) => statSync(file).mode & 0o777;
const writeConfig = (dir: string, config: SingboxConfig) => writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

it('AC2 package exports ISP constants and IspError', () => {
  expect([ISP_BACKUP_DIR, ISP_LOCK_FILE, ISP_TMP_PREFIX, GROUP_MAIN]).toEqual(['.isp-backup', '.isp.lock', '.isp-tmp.', 'Proxy']);
  expect(MANAGED_FILES).toEqual(['config.json', '.env']);
  const error = new IspError('fixture failure');
  expect(error).toBeInstanceOf(Error); expect(error.name).toBe('IspError');
});

it('AC2 envGet reads the first exact key leniently, strips CR and preserves raw quoted text', () => {
  const text = '# note\nnot dotenv\nX_OTHER=no\nX="raw $$ value"\r\nX=second\nEMPTY=\nLAST=end';
  expect(envGet(text, 'X')).toBe('"raw $$ value"');
  expect(envGet(text, 'EMPTY')).toBe(''); expect(envGet(text, 'LAST')).toBe('end');
  expect(envGet(text, 'MISSING')).toBeUndefined();
});

it('AC2 ISP detectors recognize partial state and legacy markers without false positives', () => {
  for (const text of ['ISP_SOCKS_USER=\r\n', 'ISP_SOCKS_CUSTOM=1', ENV_HEADER, ENV_HEADER_NOEOL]) expect(envHasIsp(text)).toBe(true);
  expect(envHasIsp('# ISP_SOCKS_PASS=ignored\nOTHER=ISP_SOCKS_USER=1')).toBe(false);
  expect(configHasIsp(baseConfig())).toBe(false);
  for (const tag of ['ss-isp-in', 'vless-reality-isp-in', 'isp-socks'])
    expect(configHasIsp({ inbounds: [{ tag }] })).toBe(true);
  expect(configHasIsp({ inbounds: [], outbounds: [{ tag: 'isp-socks' }] })).toBe(true);
});

it('AC2 checkIspConfig refuses invalid shapes and missing prototypes but permits unrelated legacy-port users', () => {
  for (const value of [null, [], 'invalid', 3]) expect(() => checkIspConfig(value)).toThrow('not valid JSON');
  for (const value of [{}, { inbounds: [] }, { inbounds: [{ tag: 'ss-in' }] }])
    expect(() => checkIspConfig(value)).toThrow('no inbounds tagged');
  for (const port of [13839, 18444]) {
    const config = baseConfig(); config.inbounds.push({ tag: 'custom', listen_port: port });
    expect(addIspToConfig(config, socks).inbounds).toEqual(config.inbounds);
  }
  expect(() => checkIspConfig(addIspToConfig(baseConfig(), socks))).not.toThrow();
});

it('AC2 AC17 addIspToConfig clones without mutating input and is deeply idempotent', () => {
  const old = baseConfig(), original = structuredClone(old);
  const next = addIspToConfig(old, socks);
  expect(old).toEqual(original); expect(next).not.toBe(old);
  expect(addIspToConfig(next, socks)).toEqual(next);
  const clonedUsers = next.inbounds[1].users as Record<string, unknown>[];
  clonedUsers[0].name = 'clone-only'; expect(old).toEqual(original);
});

it('AC2 AC17 addIspToConfig updates existing ISP entries in place and preserves user extensions', () => {
  const config = addIspToConfig(baseConfig(), socks);
  config.inbounds[0].custom = 'keep';
  config.outbounds![1].custom = { keep: true };
  config.route = { final: 'custom-final', rules: [
    { action: 'sniff' },
    { domain: ['example.test'], outbound: 'direct' },
    { domain_suffix: ['custom.test'], network: 'tcp', outbound: 'isp-socks', custom: true },
    { ip_cidr: ['192.0.2.0/24'], outbound: 'isp-socks' },
  ] };
  config.custom = ['keep'];
  const original = structuredClone(config);
  const next = addIspToConfig(config, { ...socks, host: '192.0.2.9', port: 2080, user: 'other-fake-user', pass: 'other-fake-pass' }, loadSingboxTemplate(root).route);
  expect(next.inbounds).toEqual(config.inbounds);
  expect(next.outbounds).toHaveLength(2);
  expect(next.outbounds![1]).toMatchObject({ server: '192.0.2.9', server_port: 2080, custom: { keep: true } });
  expect(next.route).toEqual(config.route);
  expect(next.custom).toEqual(['keep']); expect(config).toEqual(original);
});

it('AC2 addIspToConfig creates missing outbounds and route.rules containers', () => {
  for (const route of [undefined, {}, { final: 'direct' }]) {
    const config = { inbounds: baseConfig().inbounds, ...(route ? { route } : {}) };
    const next = addIspToConfig(config, socks);
    expect(next.outbounds).toHaveLength(1);
    expect(next.route).toEqual({ rules: [{ action: 'sniff' }], final: 'direct' });
    expect(next.inbounds).toEqual(config.inbounds);
  }
});

it.each(['duplicate', 'wrong type'])('AC2 outbound upsert rejects reserved tag conflicts without mutating input: %s', (kind) => {
  const config = addIspToConfig(baseConfig(), socks);
  if (kind === 'duplicate') config.outbounds!.push({ ...config.outbounds![1] });
  else config.outbounds![1].type = 'direct';
  const before = structuredClone(config);
  expect(() => addIspToConfig(config, socks)).toThrow(kind === 'duplicate' ? /Duplicate outbound/ : /type socks/);
  expect(config).toEqual(before);
});

it('AC2 route defaults append only ISP rules after existing rules and are deeply cloned', () => {
  const config = baseConfig();
  config.route = { final: 'custom', rules: [{ action: 'route', outbound: 'direct' }], custom: true };
  const defaults = { rules: [{ action: 'sniff' }, { domain_suffix: ['template.test'], outbound: 'isp-socks', custom: { keep: true } }, { domain: ['unrelated.test'], outbound: 'direct' }], final: 'ignored', custom: 'ignored' };
  const original = structuredClone(defaults);
  const next = addIspToConfig(config, socks, defaults);
  expect(next.route).toEqual({ ...config.route, rules: [{ action: 'sniff' }, ...config.route.rules!, defaults.rules[1]] });
  (next.route!.rules![2] as { custom: { keep: boolean } }).custom.keep = false;
  expect(defaults).toEqual(original);
  expect(addIspToConfig(config, socks).route!.rules).toEqual([{ action: 'sniff' }, ...config.route.rules!]);
});

it('AC1 AC2 AC4 fresh ISP rendering and incremental additions are semantically equal including array order', () => {
  const model = buildModel(parseEnv(envWithIsp(fixtureText(), isp)));
  const direct = fixtureModel(), template = loadSingboxTemplate(root), clashTemplate = read(root, 'templates/clash.yaml.template');
  expect(canonical(addIspToConfig(renderSingbox(direct, template), model.isp!, template.route)))
    .toBe(canonical(renderSingbox(model, template)));
  expect(parse(renderClash(direct, clashTemplate)))
    .toEqual(parse(renderClash(model, clashTemplate)));
});

it('AC2 AC7 makeBackup and restoreBackup preserve bytes modes and mtime for every present file', () => {
  const dir = project(); writeConfig(dir, baseConfig()); writeFileSync(join(dir, 'clash.yaml'), baseClash());
  const time = new Date('2020-01-02T03:04:05Z');
  const saved = MANAGED_FILES.map((name, i) => {
    const file = join(dir, name); chmodSync(file, 0o600 + i * 0o20); utimesSync(file, time, time);
    return { content: readFileSync(file), mode: mode(file), mtime: statSync(file).mtimeMs };
  });
  const backup = makeBackup(dir);
  expect(mode(join(dir, ISP_BACKUP_DIR))).toBe(0o700); expect(mode(backup)).toBe(0o700);
  for (const [i, name] of MANAGED_FILES.entries()) {
    expect(readFileSync(join(backup, name)).equals(saved[i].content)).toBe(true);
    writeFileSync(join(dir, name), 'changed'); chmodSync(join(dir, name), 0o644);
  }
  restoreBackup(dir, backup);
  for (const [i, name] of MANAGED_FILES.entries()) {
    const file = join(dir, name);
    expect(readFileSync(file).equals(saved[i].content)).toBe(true);
    expect(mode(file)).toBe(saved[i].mode); expect(statSync(file).mtimeMs).toBe(saved[i].mtime);
  }
});

it('AC2 AC7 backup stamps are sortable and unique within one millisecond; retention keeps oldest plus four newest', () => {
  const dir = project(); vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2100, 0, 1));
  const created = Array.from({ length: 9 }, () => makeBackup(dir));
  expect(new Set(created).size).toBe(9); expect([...created].sort()).toEqual(created);
  for (const path of created) expect(path.split('/').at(-1)).toMatch(/^\d{8}-\d{6}-\d{9}-\d+$/);
  expect(readdirSync(join(dir, ISP_BACKUP_DIR)).sort()).toEqual([created[0], ...created.slice(-4)].map((p) => p.split('/').at(-1)));
  expect(read(created[0], '.env') === fixtureText()).toBe(true);
});

it('AC2 AC7 makeBackup repairs permissions on an existing backup root before saving secrets', () => {
  const dir = project(); writeConfig(dir, baseConfig());
  const backupRoot = join(dir, ISP_BACKUP_DIR); mkdirSync(backupRoot, { mode: 0o755 });
  chmodSync(backupRoot, 0o755);
  const backup = makeBackup(dir);
  expect(mode(backupRoot)).toBe(0o700); expect(mode(backup)).toBe(0o700);
  for (const name of MANAGED_FILES) expect(read(backup, name)).toBe(read(dir, name));
});

it('AC2 AC7 restoreBackup copies available snapshots and leaves other current files untouched', () => {
  const dir = project(); writeConfig(dir, baseConfig());
  const backup = makeBackup(dir);
  rmSync(join(backup, 'config.json'));
  writeFileSync(join(dir, 'config.json'), 'keep-current-config');
  writeFileSync(join(dir, 'clash.yaml'), 'keep-current-clash');
  writeFileSync(join(backup, 'clash.yaml'), 'historical-client-bytes');
  writeFileSync(join(dir, '.env'), 'modified'); restoreBackup(dir, backup);
  expect(read(dir, '.env') === fixtureText()).toBe(true);
  expect(read(dir, 'config.json')).toBe('keep-current-config');
  expect(read(dir, 'clash.yaml')).toBe('keep-current-clash');
});

it('AC2 AC7 backups honor an explicit managed-file selection', () => {
  const dir = project(); writeConfig(dir, baseConfig());
  const before = read(dir, 'config.json'), backup = makeBackup(dir, ['config.json']);
  writeFileSync(join(dir, '.env'), 'keep new env'); writeFileSync(join(dir, 'config.json'), 'changed');
  restoreBackup(dir, backup, ['config.json']);
  expect(read(dir, 'config.json')).toBe(before); expect(read(dir, '.env')).toBe('keep new env');
});

it('AC2 makeTmpPath is unique and sweepStaleTmp removes only prefixed regular files', () => {
  const dir = project(), first = makeTmpPath(dir), second = makeTmpPath(dir);
  expect(first).not.toBe(second); expect(first).toMatch(new RegExp('/\\.isp-tmp\\.[a-f0-9]{32}$'));
  expect(existsSync(first)).toBe(false);
  writeFileSync(first, 'stale'); writeFileSync(second, 'stale');
  writeFileSync(join(dir, 'keep.txt'), 'keep'); mkdirSync(join(dir, '.isp-tmp.directory'));
  sweepStaleTmp(dir);
  expect(existsSync(first)).toBe(false); expect(existsSync(second)).toBe(false);
  expect(existsSync(join(dir, 'keep.txt'))).toBe(true); expect(existsSync(join(dir, '.isp-tmp.directory'))).toBe(true);
});

it('AC2 withLock refuses an alive PID without sweeping files or removing its lock', async () => {
  const dir = project(); writeFileSync(join(dir, ISP_LOCK_FILE), String(process.pid));
  writeFileSync(join(dir, '.isp-tmp.keep'), 'owned by lock holder'); const fn = vi.fn();
  await expect(withLock(dir, fn)).rejects.toThrow('Another isp-outbound run is in progress');
  expect(fn).not.toHaveBeenCalled(); expect(read(dir, ISP_LOCK_FILE)).toBe(String(process.pid)); expect(existsSync(join(dir, '.isp-tmp.keep'))).toBe(true);
});

it('AC2 withLock takes over a dead PID, sweeps stale files and releases after success or failure', async () => {
  const dir = project();
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('dead fixture PID'), { code: 'ESRCH' }); });
  writeFileSync(join(dir, ISP_LOCK_FILE), '2147483647'); writeFileSync(join(dir, '.isp-tmp.stale'), 'old');
  expect(await withLock(dir, async () => {
    expect(read(dir, ISP_LOCK_FILE)).toBe(String(process.pid)); expect(existsSync(join(dir, '.isp-tmp.stale'))).toBe(false); return 42;
  })).toBe(42);
  expect(kill).toHaveBeenCalledWith(2147483647, 0); expect(existsSync(join(dir, ISP_LOCK_FILE))).toBe(false);
  await expect(withLock(dir, async () => { throw new Error('fixture callback failed'); })).rejects.toThrow('fixture callback failed');
  expect(existsSync(join(dir, ISP_LOCK_FILE))).toBe(false);
});

it('AC2 withLock treats empty and permission-denied PID locks as alive', async () => {
  const dir = project();
  for (const pid of ['', 'invalid', '0', '-1']) {
    writeFileSync(join(dir, ISP_LOCK_FILE), pid);
    await expect(withLock(dir, async () => {})).rejects.toThrow('in progress');
  }
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('fixture denied'), { code: 'EPERM' }); });
  writeFileSync(join(dir, ISP_LOCK_FILE), '123');
  await expect(withLock(dir, async () => {})).rejects.toThrow('in progress');
});

it('AC2 installFile atomically replaces the inode with mode 600 and preserves ownership', () => {
  const dir = project(), file = join(dir, 'config.json'); writeFileSync(file, 'old'); chmodSync(file, 0o644);
  const before = statSync(file), fd = openSync(file, 'r');
  try {
    installFile(file, new Uint8Array(Buffer.from('complete new bytes')), dir);
    expect(readFileSync(fd, 'utf8')).toBe('old'); expect(read(dir, 'config.json')).toBe('complete new bytes');
    expect(statSync(file).ino).not.toBe(before.ino); expect(mode(file)).toBe(0o600);
    expect([statSync(file).uid, statSync(file).gid]).toEqual([before.uid, before.gid]);
  } finally { closeSync(fd); }
  installFile(join(dir, 'new-file'), 'new', dir); expect(mode(join(dir, 'new-file'))).toBe(0o600);
  expect(readdirSync(dir).filter((name) => name.startsWith(ISP_TMP_PREFIX))).toEqual([]);
});

it('AC2 installFile cleans its private temporary file when rename fails', () => {
  const dir = project(), dest = join(dir, 'directory'); mkdirSync(dest);
  expect(() => installFile(dest, 'candidate', dir)).toThrow();
  expect(statSync(dest).isDirectory()).toBe(true);
  expect(readdirSync(dir).filter((name) => name.startsWith(ISP_TMP_PREFIX))).toEqual([]);
});

async function serviceFixture() {
  const h = await setupIsp(), sleep = vi.fn(async () => {});
  let stdout = '', stderr = '';
  const controller = new AbortController();
  const service = new IspService({ projectDir: h.dir, env: h.env, sleep, signal: controller.signal,
    stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
  return { h, service, sleep, controller, output: () => ({ stdout, stderr }) };
}

it('AC2 IspService reports missing Docker and compose version failure', async () => {
  const { h, service } = await serviceFixture(); h.env.PATH = join(h.dir, 'empty');
  await expect(service.composeAvailable()).rejects.toThrow('docker is not installed');
  expect(await service.dockerInfo()).toBe('down');
  h.env.PATH = h.bin; h.stub('docker', 'exit 1');
  expect(await service.composeAvailable()).toBe(false); expect(await service.containerImage()).toBe('');
  expect(await service.containerStatus()).toBe('missing');
});

it('AC2 IspService listener fallback reports UDP unknown and probes TCP without real network', async () => {
  const { h, service, output } = await serviceFixture(); h.env.PATH = join(h.dir, 'empty');
  expect(await service.portListening('udp', 13839)).toBe('unknown');
  expect(await service.waitListening('udp', 13839)).toBe(true);
  expect(output().stderr).toContain('Skipping the UDP listener check');
  for (const event of ['connect', 'error']) {
    const socket = new Socket(); vi.spyOn(socket, 'destroy');
    vi.mocked(createConnection).mockImplementation(() => {
      queueMicrotask(() => socket.emit(event)); return socket;
    });
    expect(await service.portListening('tcp', 13839)).toBe(event === 'connect');
    expect(createConnection).toHaveBeenCalledWith({ host: '127.0.0.1', port: 13839 }); expect(socket.destroy).toHaveBeenCalled();
  }
});

it('AC2 IspService waits exactly fifteen injected sleeps for missing TCP or UDP listeners', async () => {
  const { h, service, sleep, output } = await serviceFixture();
  h.set('listeners', ''); expect(await service.waitListening('tcp', 8388)).toBe(false);
  expect(sleep).toHaveBeenCalledTimes(15); expect(sleep).toHaveBeenCalledWith(1000);
  sleep.mockClear(); expect(await service.verifyService()).toBe(false);
  expect(output().stderr).toContain('Port 8388/tcp is not listening');
  h.set('listeners', 'tcp 8388\ntcp 8443\n'); sleep.mockClear();
  expect(await service.verifyService()).toBe(false); expect(sleep).toHaveBeenCalledTimes(15);
  expect(output().stderr).toContain('Port 8388/udp is not listening');
  h.set('listeners', 'tcp 8388\nudp 8388\ntcp 8443\n'); sleep.mockClear();
  expect(await service.verifyService()).toBe(true);
  expect(sleep).not.toHaveBeenCalled();
});

it('AC2 remove targets ISP state and preserves unrelated content without mutating input', () => {
  const config = addIspToConfig(baseConfig(), socks, loadSingboxTemplate(root).route);
  config.outbounds!.push({ type: 'direct', tag: 'custom', custom: true });
  config.route!.rules!.push({ domain_suffix: ['later.test'], outbound: 'custom' });
  config.dns = { servers: [{ tag: 'dns', address: '1.1.1.1' }] };
  const original = structuredClone(config), next = removeIspFromConfig(config);
  expect(next).toEqual({ ...config, outbounds: config.outbounds!.filter((o) => o.tag !== 'isp-socks'), route: { ...config.route, rules: [{ action: 'sniff' }, { domain_suffix: ['later.test'], outbound: 'custom' }] } });
  expect(config).toEqual(original); expect(removeIspFromConfig(next)).toEqual(next);
});

it.each(['add', 'remove'])('AC2 %s migrates known legacy inbounds and dedicated rules safely', (action) => {
  const config = baseConfig();
  config.inbounds.push({ ...config.inbounds[0], tag: 'ss-isp-in', listen_port: 13839 }, { ...config.inbounds[1], tag: 'vless-reality-isp-in', listen_port: 18444 });
  config.route!.rules!.push({ inbound: ['ss-isp-in', 'vless-reality-isp-in'], outbound: 'isp-socks' }, { inbound: ['ss-isp-in', 'ss-in'], domain: ['custom.test'], outbound: 'direct' });
  const next = action === 'add' ? addIspToConfig(config, socks, loadSingboxTemplate(root).route) : removeIspFromConfig(config);
  expect(next.inbounds.map((i) => i.tag)).toEqual(['ss-in', 'vless-reality-in']);
  expect(next.route!.rules).toContainEqual({ inbound: ['ss-in'], domain: ['custom.test'], outbound: 'direct' });
  expect(JSON.stringify(next.route)).not.toContain('ss-isp-in');
});

it.each(['add', 'remove'])('AC2 %s refuses a legacy-only custom matcher instead of broadening it', (action) => {
  const config = baseConfig();
  config.route!.rules!.push({ inbound: ['ss-isp-in'], domain_suffix: ['custom.test'], outbound: 'direct' });
  const before = structuredClone(config);
  expect(() => action === 'add' ? addIspToConfig(config, socks) : removeIspFromConfig(config)).toThrow(/migrat/i);
  expect(config).toEqual(before);
});

it.each(['final', 'detour', 'nested', 'legacy reference'])('AC2 remove refuses unsupported ISP dependencies before mutation: %s', (kind) => {
  const config = addIspToConfig(baseConfig(), socks, loadSingboxTemplate(root).route);
  if (kind === 'final') config.route!.final = 'isp-socks';
  if (kind === 'detour') config.outbounds!.push({ type: 'direct', tag: 'custom', detour: 'isp-socks' });
  if (kind === 'nested') config.route!.rules!.push({ type: 'logical', mode: 'or', rules: [{ outbound: 'isp-socks' }] });
  if (kind === 'legacy reference') config.custom = { inbound: 'ss-isp-in' };
  const before = structuredClone(config);
  expect(() => removeIspFromConfig(config)).toThrow(/ISP.*reference|isp-socks|ss-isp-in|migrat/i);
  expect(config).toEqual(before);
});

it('AC2 IspService verifies actual configured ports including Shadowsocks UDP', async () => {
  const { h, service } = await serviceFixture();
  const config = h.config(); config.inbounds[0].listen_port = 9001; config.inbounds[1].listen_port = 9002;
  writeConfig(h.dir, config); h.set('listeners', 'tcp 9001\nudp 9001\ntcp 9002\n');
  expect(await service.verifyService()).toBe(true);
  h.set('listeners', 'tcp 9001\ntcp 9002\n');
  expect(await service.verifyService()).toBe(false);
});

it('AC2 IspService egress retries invalid responses and sends quoted credentials only over stdin', async () => {
  const { h, service, output } = await serviceFixture();
  h.set('egress_ip', 'not-an-IP'); expect(await service.socksEgressIp(socks)).toBeUndefined();
  expect(h.log().split('\n').filter((line) => line === 'curl -K -')).toHaveLength(4);
  h.set('egress_ip', '2001:db8::1\n'); expect(await service.socksEgressIp(socks)).toBe('2001:db8::1');
  for (const value of [username, password]) expect((h.log() + output().stdout + output().stderr).includes(value)).toBe(false);
});

it('AC2 IspService abort interrupts an injected polling sleep without waiting', async () => {
  const { h, controller, output } = await serviceFixture(); h.set('status', 'exited\n');
  const reason = new Error('fixture interruption');
  const service = new IspService({ projectDir: h.dir, env: h.env, signal: controller.signal,
    sleep: async () => { controller.abort(reason); }, stdout: () => {}, stderr: () => {} });
  await expect(service.verifyService()).rejects.toBe(reason);
  await expect(service.containerStatus()).rejects.toBe(reason); expect(output()).toEqual({ stdout: '', stderr: '' });
});
