import { afterEach, expect, it, vi } from 'vitest';
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createConnection, Socket } from 'node:net';
import { parse, parseDocument, stringify } from 'yaml';
import {
  IspError, ISP_BACKUP_DIR, ISP_LOCK_FILE, ISP_TMP_PREFIX, MANAGED_FILES, GROUP_MAIN,
  envGet, envHasIsp, checkIspConfig, configHasIsp, clashHasIsp,
  addIspToConfig, addIspToClash, makeTmpPath, installFile, makeBackup,
  findCleanBackup, restoreBackup, sweepStaleTmp, withLock, IspService,
} from '../../src/index.js';
import { ENV_HEADER, ENV_HEADER_NOEOL, envWithIsp, parseEnv } from '../../src/core/env.js';
import { buildModel, type IspSocks } from '../../src/model.js';
import { loadSingboxTemplate, renderSingbox, type SingboxConfig } from '../../src/core/render-config.js';
import { renderClash } from '../../src/core/render-clash.js';
import { creds, fixtureModel, fixtureText, isp } from './helpers/fixtures.js';
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
  expect(MANAGED_FILES).toEqual(['config.json', 'clash.yaml', '.env']);
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
  expect(clashHasIsp(baseClash())).toBe(false);
  expect(clashHasIsp('proxies: []\n# BEGIN my-singbox-isp\n')).toBe(true);
  expect(clashHasIsp('proxies:\n  - name: shadowsocks-isp\n')).toBe(true);
  expect(clashHasIsp('proxies:\n  - name: vless-reality-isp\n')).toBe(true);
  expect(clashHasIsp('rules: [MATCH,DIRECT]\n')).toBe(false);
});

it('AC2 checkIspConfig refuses invalid shapes, missing prototypes and conflicting ports', () => {
  for (const value of [null, [], 'invalid', 3]) expect(() => checkIspConfig(value)).toThrow('not valid JSON');
  for (const value of [{}, { inbounds: [] }, { inbounds: [{ tag: 'ss-in' }] }])
    expect(() => checkIspConfig(value)).toThrow('no inbounds tagged');
  for (const port of [13839, 18444]) {
    const config = baseConfig(); config.inbounds.push({ tag: 'custom', listen_port: port });
    expect(() => addIspToConfig(config, socks)).toThrow('already uses port');
  }
  expect(() => checkIspConfig(addIspToConfig(baseConfig(), socks))).not.toThrow();
});

it('AC2 AC17 addIspToConfig clones without mutating input and is deeply idempotent', () => {
  const old = baseConfig(), original = structuredClone(old);
  const next = addIspToConfig(old, socks);
  expect(old).toEqual(original); expect(next).not.toBe(old);
  expect(addIspToConfig(next, socks)).toEqual(next);
  const clonedUsers = next.inbounds[3].users as Record<string, unknown>[];
  clonedUsers[0].name = 'clone-only'; expect(old).toEqual(original);
});

it('AC2 AC17 addIspToConfig updates existing ISP entries in place and preserves user extensions', () => {
  const config = addIspToConfig(baseConfig(), socks);
  config.inbounds[2].custom = 'keep'; config.inbounds[2].listen_port = 99;
  config.outbounds![1].custom = { keep: true };
  config.route!.rules![0] = { inbound: ['old'], outbound: 'isp-socks', custom: true };
  config.route!.rules!.unshift({ domain: ['example.test'], outbound: 'direct' });
  config.custom = ['keep'];
  const next = addIspToConfig(config, { ...socks, host: '192.0.2.9', port: 2080, user: 'other-fake-user', pass: 'other-fake-pass' });
  expect(next.inbounds).toHaveLength(4); expect(next.inbounds[2]).toMatchObject({ listen_port: 13839, custom: 'keep' });
  expect(next.outbounds).toHaveLength(2);
  expect(next.outbounds![1]).toMatchObject({ server: '192.0.2.9', server_port: 2080, custom: { keep: true } });
  expect(next.route!.rules).toEqual([
    { domain: ['example.test'], outbound: 'direct' },
    { inbound: ['ss-isp-in', 'vless-reality-isp-in'], outbound: 'isp-socks', custom: true },
  ]);
  expect(next.custom).toEqual(['keep']);
});

it('AC2 addIspToConfig creates missing outbounds and route.rules containers', () => {
  for (const route of [undefined, {}, { final: 'direct' }]) {
    const config = { inbounds: baseConfig().inbounds, ...(route ? { route } : {}) };
    const next = addIspToConfig(config, socks);
    expect(next.outbounds).toHaveLength(1); expect(next.route!.rules).toHaveLength(1);
    if (route && 'final' in route) expect(next.route!.final).toBe('direct');
  }
});

it('AC2 AC4 AC17 addIspToClash is byte-idempotent and appends nodes after user proxies', () => {
  const doc = parse(baseClash());
  doc.proxies.push({ name: 'custom', type: 'socks5', server: '192.0.2.9', port: 1000 });
  doc.rules.unshift('DOMAIN,custom.test,DIRECT');
  const text = '# custom header\n' + stringify(doc), next = addIspToClash(text);
  expect(addIspToClash(next)).toBe(next);
  expect(next).toContain('# custom header');
  expect(parse(next).proxies.map((p: { name: string }) => p.name)).toEqual(['shadowsocks', 'vless-reality', 'custom', 'shadowsocks-isp', 'vless-reality-isp']);
  expect(parse(next).rules).toEqual(doc.rules);
});

it('AC2 AC17 addIspToClash strips comment metadata recursively from clones only', () => {
  const text = baseClash()
    .replace('  - name: "shadowsocks"', '\n  # ss annotation\n  - name: "shadowsocks" # ss inline')
    .replace('  - name: vless-reality', '\n  # vless annotation\n  - name: vless-reality')
    .replace('    reality-opts:', '    # nested annotation\n    reality-opts:')
    .replace('      public-key:', '      # nested key annotation\n      public-key:');
  const next = addIspToClash(text);
  for (const comment of ['# ss annotation', '# ss inline', '# vless annotation', '# nested annotation', '# nested key annotation'])
    expect(next.split(comment)).toHaveLength(2);
  const doc = parseDocument(next);
  // A clone must not inherit a blank line before its source entry either.
  expect(doc.getIn(['proxies', 2], true)).not.toHaveProperty('spaceBefore', true);
  expect(doc.getIn(['proxies', 3], true)).not.toHaveProperty('spaceBefore', true);
  expect(addIspToClash(next)).toBe(next);
});

it('AC2 AC4 AC17 addIspToClash repairs existing ports and missing group names without replacing user properties', () => {
  const doc = parse(addIspToClash(baseClash()));
  doc.proxies[2].port = 9; doc.proxies[2].custom = 'keep'; doc.proxies[3].port = 10;
  doc['proxy-groups'][0].proxies = ['vless-reality-isp', 'DIRECT', 'shadowsocks'];
  const next = parse(addIspToClash(stringify(doc)));
  expect(next.proxies).toHaveLength(4);
  expect(next.proxies[2]).toMatchObject({ port: 13839, custom: 'keep' }); expect(next.proxies[3].port).toBe(18444);
  expect(next['proxy-groups'][0].proxies).toEqual(['vless-reality-isp', 'DIRECT', 'shadowsocks', 'shadowsocks-isp']);
});

it('AC2 AC9 addIspToClash refuses invalid YAML, bad prototypes, missing groups and private keys', () => {
  expect(() => addIspToClash('proxies: [')).toThrow('not valid YAML');
  const original = parse(baseClash());
  for (const kind of ['missing proxies', 'missing ss', 'missing vless', 'wrong port', 'missing groups', 'missing list']) {
    const doc = structuredClone(original);
    if (kind === 'missing proxies') delete doc.proxies;
    if (kind === 'missing ss') doc.proxies.shift();
    if (kind === 'missing vless') doc.proxies.pop();
    if (kind === 'wrong port') doc.proxies[0].port = 12;
    if (kind === 'missing groups') delete doc['proxy-groups'];
    if (kind === 'missing list') delete doc['proxy-groups'][0].proxies;
    expect(() => addIspToClash(stringify(doc)), kind).toThrow(IspError);
  }
  for (const key of ['REALITY_PRIVATE_KEY', creds.realityPrivateKey]) {
    expect(() => addIspToClash(baseClash() + `# ${key}\n`, creds.realityPrivateKey)).toThrow('Refusing to write REALITY_PRIVATE_KEY');
    expect(() => addIspToClash(addIspToClash(baseClash()) + `# ${key}\n`, creds.realityPrivateKey)).toThrow('Refusing to write REALITY_PRIVATE_KEY');
  }
});

it('AC1 AC2 AC4 fresh ISP rendering and incremental additions are semantically equal including array order', () => {
  const model = buildModel(parseEnv(envWithIsp(fixtureText(), isp)));
  const direct = fixtureModel(), template = loadSingboxTemplate(root), clashTemplate = read(root, 'templates/clash.yaml.template');
  expect(canonical(addIspToConfig(renderSingbox(direct, template), model.isp!)))
    .toBe(canonical(renderSingbox(model, template)));
  expect(parse(addIspToClash(renderClash(direct, clashTemplate))))
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

it('AC2 AC7 findCleanBackup chooses newest clean bytes, rejecting ISP in any file and invalid JSON', () => {
  const dir = project(); expect(findCleanBackup(dir)).toBeUndefined();
  writeConfig(dir, baseConfig()); writeFileSync(join(dir, 'clash.yaml'), baseClash());
  const first = makeBackup(dir);
  writeFileSync(join(dir, '.env'), fixtureText() + '# newest clean\n'); const newest = makeBackup(dir);
  const variants = [
    { file: '.env', text: 'ISP_SOCKS_USER=\n' },
    { file: 'clash.yaml', text: 'proxies: [{name: shadowsocks-isp}]\n' },
    { file: 'config.json', text: JSON.stringify(addIspToConfig(baseConfig(), socks)) },
    { file: 'config.json', text: '{invalid' },
  ];
  // Remove each dirty candidate after inspection so retention cannot remove newest.
  for (const { file, text } of variants) {
    writeFileSync(join(dir, file), text); const dirty = makeBackup(dir);
    expect(findCleanBackup(dir)).toBe(newest); rmSync(dirty, { recursive: true }); restoreBackup(dir, newest);
  }
  rmSync(newest, { recursive: true }); expect(findCleanBackup(dir)).toBe(first);
});

it('AC2 AC7 partial backups restore only files actually present', () => {
  const dir = project(), backup = makeBackup(dir);
  writeFileSync(join(dir, 'config.json'), 'keep-current-config');
  writeFileSync(join(dir, 'clash.yaml'), 'keep-current-clash');
  writeFileSync(join(dir, '.env'), 'modified'); restoreBackup(dir, backup);
  expect(read(dir, '.env') === fixtureText()).toBe(true);
  expect(read(dir, 'config.json')).toBe('keep-current-config'); expect(read(dir, 'clash.yaml')).toBe('keep-current-clash');
  expect(findCleanBackup(dir)).toBe(backup);
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
  await service.portsFree(); expect(output().stderr).toContain('Skipping the check that ports');
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
  sleep.mockClear(); expect(await service.verifyService(false)).toBe(false);
  expect(output().stderr).toContain('Port 8388/tcp is not accepting connections');
  h.set('listeners', 'tcp 8388\ntcp 8443\ntcp 13839\ntcp 18444\n'); sleep.mockClear();
  expect(await service.verifyService(true)).toBe(false); expect(sleep).toHaveBeenCalledTimes(15);
  expect(output().stderr).toContain('Port 13839/udp is not listening');
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
  await expect(service.verifyService(true)).rejects.toBe(reason);
  await expect(service.containerStatus()).rejects.toBe(reason); expect(output()).toEqual({ stdout: '', stderr: '' });
});
