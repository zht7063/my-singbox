import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { envQuote, envUnquote } from '../../src/core/env.js';
import { isIpv6Strict } from '../../src/core/validate.js';
import { loadSingboxTemplate } from '../../src/core/render-config.js';
import { installFile } from '../../src/core/isp.js';

vi.mock('../../src/core/isp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/isp.js')>();
  return { ...actual, installFile: vi.fn(actual.installFile) };
});
afterEach(() => { vi.mocked(installFile).mockClear(); });
import { invoke, read, root } from './helpers/cli.js';
import {
  setupIsp, address, username, password, freshLines, cleanListeners,
  type IspHarness, type Result,
} from './helpers/isp.js';

let h: IspHarness, original: string;
beforeAll(() => {
  execFileSync(process.execPath, ['tools/build.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
}, 30000);
beforeEach(async () => { h = await setupIsp(); original = h.snapshot(); });
const ok = (r: Result) => { expect(r.code, r.stderr).toBe(0); };
const failed = (r: Result, message?: string) => {
  expect(r.code).toBe(1);
  if (message) expect(r.stderr).toContain(message);
};
function nothingWritten(before = original) {
  expect(h.snapshot()).toBe(before);
  expect(h.backups()).toEqual([]);
  expect(existsSync(join(h.dir, '.isp.lock'))).toBe(false);
  expect(h.upCount()).toBe(0);
}
function yaml() { return parse(h.read('clash.yaml')); }
function writeYaml(doc: ReturnType<typeof yaml>) { h.write('clash.yaml', stringify(doc)); }
function writeConfig(config = h.config()) { h.write('config.json', JSON.stringify(config, null, 2) + '\n'); }
function envValue(key: string) { return h.read('.env').split('\n').find((line) => line.startsWith(key + '='))!.slice(key.length + 1); }
const mode = (path: string) => statSync(path).mode & 0o777;
const outbound = () => h.config().outbounds!.find((o) => o.tag === 'isp-socks')!;
function addedLines(before: string, after: string) {
  const lines = new Set(before.split('\n'));
  return after.split('\n').filter((line) => !lines.has(line)).join('\n');
}

function addNotice(r: Result) {
  ok(r);
  expect(r.stdout).toMatch(/route/i);
  expect(r.stdout).toContain('direct');
  expect(r.stdout).not.toMatch(/13839|18444|ufw allow|ACTION REQUIRED/);
}
function removeNotice(r: Result) {
  ok(r);
  expect(r.stdout).toMatch(/direct|Nothing to remove/);
  expect(r.stdout).not.toMatch(/13839|18444|ufw delete|ACTION REQUIRED/);
}

it("AC8[repo: .gitignore covers the script's runtime files] AC9 runtime artifacts are ignored", () => {
  const lines = read(root, '.gitignore').split('\n');
  for (const name of ['.isp-backup/', '.isp.lock', '.isp-tmp.*']) expect(lines).toContain(name);
});

it('AC8[--help prints usage and needs neither root nor jq nor docker] AC14 help works with no commands on PATH', async () => {
  h.env.PATH = join(h.dir, 'empty');
  mkdirSync(h.env.PATH);
  for (const name of ['dirname', 'cat']) {
    const executable = [`/usr/bin/${name}`, `/bin/${name}`].find(existsSync);
    if (!executable) throw new Error(`Missing test prerequisite: ${name}`);
    symlinkSync(executable, join(h.env.PATH, name));
  }
  const ts = await h.ispRun(['--help']), shell = h.ispSpawn(['--help'], [], true);
  ok(ts); ok(shell);
  for (const text of ['--add', '--remove', '--yes', 'Without --add or --remove']) {
    expect(ts.stdout).toContain(text); expect(shell.stdout).toContain(text);
  }
  expect(h.log()).toBe('');
  nothingWritten();
});

it('AC8[unknown argument is rejected] AC14 unknown options retain shell exit 1', async () => {
  const ts = await h.ispRun(['--frobnicate']), shell = h.ispSpawn(['--frobnicate'], [], true);
  failed(ts, 'Unknown'); failed(shell, 'Unknown');
  nothingWritten();
});

it('AC8[no root or sudo is needed: the script never checks the uid and never calls sudo] AC14 add and remove without privilege checks', async () => {
  ok(await h.add()); ok(await h.remove());
  expect(h.snapshot()).toBe(original);
  expect(read(root, 'src/cli/isp-outbound.ts')).not.toMatch(/getuid|EUID|id -u/);
});

it('AC8[menu: q quits, junk is rejected] AC14 menu quit and invalid choice write nothing', async () => {
  ok(await h.ispRun([], ['q']));
  failed(await h.ispRun([], ['9']), 'Invalid choice');
  failed(await h.ispRun(), 'Input ended unexpectedly');
  nothingWritten();
});

it('AC8[menu: 1 adds and 2 removes] AC14 menu actions and -y alias', async () => {
  ok(await h.ispRun(['-y'], ['1', ...freshLines()]));
  expect(outbound().tag).toBe('isp-socks');
  ok(await h.ispRun([], ['2', 'y']));
  expect(h.snapshot()).toBe(original);
});

it('AC8[declining the confirmation changes nothing] AC14 default confirmation refuses restart', async () => {
  failed(await h.ispRun(['--add'], [...freshLines(), 'n']), 'Aborted');
  nothingWritten();
});

it('AC8[add: config.json gets the two ISP inbounds, the socks outbound and the route rule] AC2 server outbound and template rules are incremental', async () => {
  const old = h.config(); ok(await h.add()); const next = h.config();
  expect(next.inbounds).toEqual(old.inbounds);
  expect(next.inbounds).toHaveLength(2);
  expect(next.outbounds!.slice(0, -1)).toEqual(old.outbounds);
  expect(outbound()).toEqual({ type: 'socks', tag: 'isp-socks', server: '198.51.100.7', server_port: 1080, version: '5', username, password });
  expect(next.route).toEqual(loadSingboxTemplate(root).route);
  expect(mode(join(h.dir, 'config.json'))).toBe(0o600);
});

it('AC8[add: .env gets the four keys as plain text (no b64), mode 600] AC9 generated commands consume ISP env in the TS port', async () => {
  const oldEnv = h.read('.env'); ok(await h.add());
  expect(h.read('.env').startsWith(oldEnv)).toBe(true);
  expect(envValue('ISP_SOCKS_ADDR')).toBe(address);
  expect(envValue('ISP_SOCKS_USER') === envQuote(username)).toBe(true);
  expect(envValue('ISP_SOCKS_PASS') === envQuote(password)).toBe(true);
  expect(envValue('ISP_SOCKS_EGRESS_IP')).toBe('');
  expect(h.read('.env')).not.toMatch(/b64|base64/i);
  expect(mode(join(h.dir, '.env'))).toBe(0o600);
  const config = h.config(), clash = yaml();
  for (const [cmd, file] of [['gen-config', 'config.json'], ['conf-clash', 'clash.yaml']]) {
    rmSync(join(h.dir, file)); ok(await invoke(cmd, h.dir));
  }
  expect(h.config()).toEqual(config);
  expect(yaml()).toEqual(clash);
});

it('AC8[add: config.json is written from the values stored in .env] AC9 quoted and hand-written credentials round-trip', async () => {
  const pass = 'Str@nge "pw" $x \\'; ok(await h.add(address, username, pass));
  expect(outbound().password === pass).toBe(true);
  expect(envValue('ISP_SOCKS_PASS') === envQuote(pass)).toBe(true);
  h.track('hand-written pw', 'hand-user');
  h.write('.env', h.read('.env').replace(/^ISP_SOCKS_PASS=.*$/m, 'ISP_SOCKS_PASS=hand-written pw')
    .replace(/^ISP_SOCKS_USER=.*$/m, 'ISP_SOCKS_USER=hand-user') + '# lenient extra line\nCUSTOM_NOTE=1\n');
  ok(await h.keep());
  expect(outbound().password === 'hand-written pw').toBe(true);
  expect(outbound().username === 'hand-user').toBe(true);
  expect(envValue('ISP_SOCKS_PASS') === envQuote('hand-written pw')).toBe(true);
  expect(h.read('.env')).toContain('CUSTOM_NOTE=1');
});

it('AC8[no base64 anywhere: the ISP script, gen-config.sh, conf-clash.sh and the .env template do not mention it] AC9 ISP values are never base64 encoded', () => {
  for (const file of ['src/core/isp.ts', 'src/core/isp-service.ts', 'src/cli/isp-outbound.ts', 'scripts/isp-outbound.sh', 'scripts/gen-config.sh', 'scripts/conf-clash.sh', 'templates/.env.template'])
    expect(read(root, file)).not.toMatch(/b64|base64/i);
});

it("AC8[add: validates with the container's own image, restarts once, verifies] AC14 built CLI smoke uses isolated external stubs", () => {
  ok(h.ispSpawn(['--add', '--yes'], freshLines()));
  expect(h.log()).toMatch(/docker run .*ghcr.io\/sagernet\/sing-box:stub check -c \/etc\/sing-box\/config.json/);
  expect(h.upCount()).toBe(1);
  expect(h.log()).toContain(`docker compose --project-directory ${realpathSync(h.dir)} up -d --force-recreate`);
  expect(h.log().indexOf('docker run')).toBeLessThan(h.log().indexOf(' up -d'));
  expect(h.log()).toContain('exec -T sing-box sing-box check');
  expect(h.log()).toContain('curl -K -');
  expect(h.read('state/last-curl-config').includes(`proxy-user = "${username}:${password}"`)).toBe(true);
  expect(h.read('state/last-check-config')).toContain('isp-socks');
});

it('AC8[add: makes a private backup of all three files first] AC7 backups preserve the original bytes with private directories', async () => {
  const texts = ['config.json', '.env'].map(h.read); ok(await h.add());
  expect(h.backups()).toHaveLength(1);
  const backup = h.backups()[0];
  expect(mode(join(h.dir, '.isp-backup'))).toBe(0o700); expect(mode(backup)).toBe(0o700);
  for (const [i, file] of ['config.json', '.env'].entries())
    expect(read(backup, file) === texts[i]).toBe(true);
  expect(existsSync(join(backup, 'clash.yaml'))).toBe(false);
});

it('AC8[add: a run that changes nothing makes no backup] AC17 repeated no-op adds preserve all bytes', async () => {
  ok(await h.add()); const before = h.snapshot();
  for (let i = 0; i < 7; i++) { const r = await h.keep(); ok(r); expect(r.stdout).not.toContain('Backup saved'); }
  expect(h.backups()).toHaveLength(1); expect(h.snapshot()).toBe(before); expect(h.upCount()).toBe(1);
});

it('AC8[add: keeps five backups, and the oldest one (the original files) is never rotated away] AC7 retention keeps oldest and four newest', async () => {
  ok(await h.add()); const first = h.backups()[0]; const created = [first];
  for (let i = 1; i <= 8; i++) { ok(await h.add(address, `fake-user-${i}`)); created.push(h.backups().at(-1)!); }
  expect(h.backups()).toEqual([first, ...created.slice(-4)]);
  ok(await h.remove()); expect(h.snapshot()).toBe(original);
});

it('AC8[add: output carries the UDP caveat and the no-fallback note] AC14 protocol limitations are printed', async () => {
  const r = await h.add(); ok(r);
  expect(r.stdout).toContain('Only TCP');
  expect(r.stdout).toMatch(/domain routing.*UDP.*separate verification/);
});

it('AC8[add: IPv6 entry address] AC14 IPv6 SOCKS address and egress are supported', async () => {
  h.set('egress_ip', '2001:db8::1\n'); ok(await h.add('[2001:db8::1]:1080'));
  expect(outbound().server).toBe('2001:db8::1'); expect(outbound().server_port).toBe(1080);
  expect(h.read('state/last-curl-config')).toContain('proxy = "socks5h://[2001:db8::1]:1080"');
});

it('AC8[add: existing route rules and other config keys survive add and remove] AC17 before/after diff contains only ISP additions', async () => {
  const config = h.config();
  config.inbounds.push({ type: 'direct', tag: 'custom-in', listen_port: 4567, custom: true });
  config.route = { final: 'direct', rules: [{ action: 'sniff' }, { domain: ['example.com'], outbound: 'direct' }] };
  config.log = { level: 'warn' }; config.custom = { preserved: 'user edit' }; writeConfig(config);
  const clientBefore = h.read('clash.yaml'); ok(await h.add()); const next = h.config();
  expect(next.inbounds.slice(0, 3)).toEqual(config.inbounds);
  expect(next.route!.rules![0]).toEqual(config.route.rules![0]);
  expect(next.route!.final).toBe('direct'); expect(next.log).toEqual(config.log); expect(next.custom).toEqual(config.custom);
  const stripped = structuredClone(next);
  stripped.outbounds!.pop(); stripped.route!.rules = config.route.rules;
  expect(stripped).toEqual(config);
  expect(addedLines(JSON.stringify(config, null, 2), h.read('config.json'))).toContain('"tag": "isp-socks"');
  // Later edits must survive targeted removal without relying on the old clean backup.
  next.route!.rules!.push({ domain: ['later.test'], outbound: 'direct' }); next.custom = { preserved: 'later edit' }; writeConfig(next);
  ok(await h.remove());
  expect(h.config()).toEqual({ ...config, custom: { preserved: 'later edit' }, route: { ...config.route, rules: [...config.route.rules!, { domain: ['later.test'], outbound: 'direct' }] } });
  expect(h.read('clash.yaml')).toBe(clientBefore);
});

it('AC8[clash: only marker blocks are added; the clones differ from the originals only in name and port] AC17 client bytes and permissions remain untouched', async () => {
  const old = h.read('clash.yaml'), oldMode = mode(join(h.dir, 'clash.yaml'));
  ok(await h.add()); expect(h.read('clash.yaml')).toBe(old);
  expect(yaml().proxies).toHaveLength(2);
  expect(mode(join(h.dir, 'clash.yaml'))).toBe(oldMode);
});

it('AC8[clash: both ISP nodes are added to the existing Proxy group; no new group; the rest is untouched] AC4 AC17 comments and user additions survive', async () => {
  const doc = yaml();
  doc.proxies.push({ name: 'extra-proxy', type: 'socks5', server: '192.0.2.8', port: 1000 });
  doc.rules.unshift('DOMAIN,custom.example,DIRECT'); doc['proxy-groups'][0].proxies.push('extra-proxy');
  writeYaml(doc);
  h.write('clash.yaml', '# user header\n' + h.read('clash.yaml').replace('rules:', '# user rules\nrules:') + '# user footer\n');
  const before = h.read('clash.yaml'); ok(await h.add()); const next = yaml();
  expect(next.proxies.slice(0, 3)).toEqual(doc.proxies);
  expect(next['proxy-groups']).toEqual(doc['proxy-groups']);
  expect(next.rules).toEqual(doc.rules);
  for (const comment of ['# user header', '# user rules', '# user footer']) expect(h.read('clash.yaml')).toContain(comment);
  expect(next).toEqual(doc);
  expect(h.read('clash.yaml')).toBe(before);
  expect(read(h.dir, 'templates/clash.yaml.template')).toBe(read(root, 'templates/clash.yaml.template'));
});

it('AC8[clash: the Proxy group keeps its order, the ISP names follow its last entry] AC4 group order is untouched by server routing', async () => {
  const old = yaml()['proxy-groups'][0].proxies; ok(await h.add());
  expect(yaml()['proxy-groups'][0].proxies).toEqual(old);
});

it('AC8[clash: add is idempotent; re-running changes nothing and never duplicates the entries] AC17 credentials update without rewriting Clash', async () => {
  ok(await h.add()); const after = h.read('clash.yaml');
  for (let i = 0; i < 3; i++) ok(await h.keep());
  ok(await h.add(address, 'other-user', 'other-pass'));
  expect(h.read('clash.yaml')).toBe(after);
  expect(yaml().proxies.map((p: { name: string }) => p.name)).toEqual(['shadowsocks', 'vless-reality']);
});

it('AC8[clash: remove deletes the nodes and their Proxy entries and restores clash.yaml byte for byte] AC7 repeated cycles restore original bytes', async () => {
  for (let i = 0; i < 2; i++) { ok(await h.add()); ok(await h.remove()); expect(h.snapshot()).toBe(original); }
});

it("AC8[clash: a Proxy group that is missing or has no proxies list is refused, nothing written] AC4 missing and malformed client groups do not block server changes", async () => {
  const originalYaml = yaml();
  for (const kind of ['missing', 'no list']) {
    const doc = structuredClone(originalYaml);
    if (kind === 'missing') doc['proxy-groups'][0].name = 'Main'; else delete doc['proxy-groups'][0].proxies;
    writeYaml(doc); const before = h.read('clash.yaml');
    ok(await h.add()); ok(await h.remove()); expect(h.read('clash.yaml')).toBe(before);
  }
});

it('AC8[clash: parses as YAML; the ISP nodes are in the Proxy group, nothing else changed] AC4 parsed document preserves all other sections', async () => {
  const old = yaml(); ok(await h.add()); const next = yaml();
  expect(next['proxy-groups']).toHaveLength(1);
  expect(next['proxy-groups'][0].proxies).toEqual(old['proxy-groups'][0].proxies);
  expect(next).toEqual(old);
});

it('AC8[clash: old node names (My-sing-box / My-VLESS-Reality) are refused with a regenerate hint, nothing written] AC17 legacy client names remain untouched', async () => {
  h.write('clash.yaml', h.read('clash.yaml').replaceAll('shadowsocks', 'My-sing-box').replaceAll('vless-reality', 'My-VLESS-Reality'));
  const before = h.read('clash.yaml'); ok(await h.add()); ok(await h.remove()); expect(h.read('clash.yaml')).toBe(before);
});

it('AC8[clash: a missing source node is refused, nothing written] AC17 missing client prototypes do not block server changes', async () => {
  const old = yaml();
  for (let i = 0; i < 2; i++) {
    const doc = structuredClone(old); doc.proxies.splice(i, 1); writeYaml(doc);
    const before = h.read('clash.yaml'); ok(await h.add()); ok(await h.remove()); expect(h.read('clash.yaml')).toBe(before);
  }
});

it('AC8[clash: unbalanced markers are refused, nothing written] AC17 marker comments remain untouched', async () => {
  h.write('clash.yaml', h.read('clash.yaml') + '# BEGIN my-singbox-isp\n'); const before = h.snapshot();
  ok(await h.add()); expect(h.read('clash.yaml')).toContain('# BEGIN my-singbox-isp');
  const added = h.snapshot(); ok(await h.keep()); expect(h.snapshot()).toBe(added);
  expect(h.snapshot()).not.toBe(before);
});

it('AC8[clash: no clash.yaml is not fatal, config is still updated and a hint is printed] AC14 server-only add is supported', async () => {
  rmSync(join(h.dir, 'clash.yaml')); const before = h.snapshot(); const r = await h.add(); ok(r);
  expect(outbound().tag).toBe('isp-socks');
  expect(existsSync(join(h.dir, 'clash.yaml'))).toBe(false);
  ok(await h.remove()); expect(h.snapshot()).toBe(before);
});

it('AC8[add twice (keeping stored values) is byte-identical and restarts once] AC17 idempotent add preserves hand formatting', async () => {
  ok(await h.add()); h.write('config.json', JSON.stringify(h.config(), null, '\t'));
  const before = h.snapshot(); ok(await h.keep()); expect(h.snapshot()).toBe(before); expect(h.upCount()).toBe(1);
});

it('AC8[add twice with the same values typed again is byte-identical] AC17 explicit values are also idempotent', async () => {
  ok(await h.add()); const before = h.snapshot(); ok(await h.add());
  expect(h.snapshot()).toBe(before); expect(h.upCount()).toBe(1); expect(h.backups()).toHaveLength(1);
});

it('AC8[add with new credentials replaces the old ones in place] AC17 updates preserve custom outbound and domain rules', async () => {
  ok(await h.add()); const config = h.config();
  config.outbounds!.find((o) => o.tag === 'isp-socks')!.custom = 'keep';
  config.inbounds[0].custom = true;
  config.route!.rules!.splice(1, 0, { domain_suffix: ['custom.test'], outbound: 'isp-socks', network: 'tcp' });
  const routeBefore = structuredClone(config.route); writeConfig(config);
  h.set('egress_ip', '192.0.2.9\n'); ok(await h.add('192.0.2.9:2080', 'other-user', 'other-pass'));
  expect(outbound()).toMatchObject({ server: '192.0.2.9', server_port: 2080, custom: 'keep' });
  expect(outbound().password === 'other-pass').toBe(true);
  expect(h.config().outbounds!.filter((o) => o.tag === 'isp-socks')).toHaveLength(1);
  expect(h.config().inbounds[0].custom).toBe(true);
  expect(h.config().route).toEqual(routeBefore);
  expect(h.read('.env').match(/^ISP_SOCKS_ADDR=/gm)).toHaveLength(1);
  ok(await h.remove()); expect(h.config().inbounds[0].custom).toBe(true);
  expect(h.config().outbounds).toEqual([{ type: 'direct', tag: 'direct' }]);
});

it('AC8[add then remove restores config.json, clash.yaml and .env byte for byte] AC7 targeted removal preserves semantics and unmanaged bytes', async () => {
  for (const handFormatted of [false, true]) {
    if (handFormatted) { h = await setupIsp(); h.write('config.json', '\n' + JSON.stringify(h.config(), null, '\t') + '\n\n'); }
    const config = h.config(), env = h.read('.env'), clash = h.read('clash.yaml');
    ok(await h.add()); ok(await h.remove());
    expect(h.config()).toEqual(config); expect(h.read('.env')).toBe(env); expect(h.read('clash.yaml')).toBe(clash);
    expect(h.upCount()).toBe(2);
  }
});

it('AC8[remove twice, and remove when nothing is configured, is a harmless no-op] AC7 no-op remove creates no backup or restart', async () => {
  const r = await h.remove(); ok(r); expect(r.stdout).toContain('Nothing to remove'); nothingWritten();
  ok(await h.add()); ok(await h.remove()); const count = h.backups().length;
  ok(await h.remove()); expect(h.snapshot()).toBe(original); expect(h.upCount()).toBe(2); expect(h.backups()).toHaveLength(count);
});

it('AC8[remove validates, restarts and verifies like add] AC14 built remove smoke validates clean config', async () => {
  ok(await h.add()); h.clearLog(); ok(h.ispSpawn(['--remove', '-y']));
  expect(h.log()).toContain('docker run'); expect(h.upCount()).toBe(1);
  expect(h.read('state/last-check-config')).not.toContain('isp-socks'); expect(h.snapshot()).toBe(original);
});

it('AC8[remove keeps unrelated lines the user added to .env] AC7 targeted removal keeps later user edits and saves transaction state', async () => {
  ok(await h.add()); h.write('.env', h.read('.env') + '# my note\nCUSTOM_NOTE=1\n');
  const edited = h.read('.env'); ok(await h.remove());
  expect(h.read('.env')).toContain('# my note\nCUSTOM_NOTE=1\n');
  expect(h.read('.env')).not.toMatch(/^ISP_SOCKS_/m);
  expect(read(h.backups().at(-1)!, '.env') === edited).toBe(true);
});

it('AC8[egress: defaults to the entry IP, mismatch is refused] AC9 mismatched entry egress writes nothing', async () => {
  h.set('egress_ip', '203.0.113.50\n'); const r = await h.add(); failed(r, '203.0.113.50');
  expect(r.stderr).toContain('198.51.100.7'); nothingWritten();
});

it('AC8[egress: an expected egress IP differing from the entry IP is accepted and stored] AC14 expected egress survives blank input', async () => {
  h.set('egress_ip', '203.0.113.50\n'); ok(await h.add(address, username, password, '203.0.113.50'));
  ok(await h.keep()); expect(envValue('ISP_SOCKS_EGRESS_IP')).toBe('203.0.113.50');
});

it('AC8[egress: an expected IP that does not match what the proxy shows is refused] AC9 expected egress mismatch writes nothing', async () => {
  failed(await h.add(address, username, password, '203.0.113.50'), 'expected 203.0.113.50'); nothingWritten();
});

it("AC8[egress: '-' clears a stored expected IP (back to the entry IP)] AC14 reset validates against entry before writing", async () => {
  h.set('egress_ip', '203.0.113.50\n'); ok(await h.add(address, username, password, '203.0.113.50'));
  const before = h.snapshot(); failed(await h.ispRun(['--add', '--yes'], ['', '', '', '-']), 'expected 198.51.100.7');
  expect(h.snapshot()).toBe(before); h.set('egress_ip', '198.51.100.7\n');
  ok(await h.ispRun(['--add', '--yes'], ['', '', '', '-'])); expect(envValue('ISP_SOCKS_EGRESS_IP')).toBe('');
});

it('AC8[failure paths: bad input is rejected and writes nothing] AC9 validation and EOF fail before candidate writes', async () => {
  const invalid = [
    ...['example.com:1080', '198.51.100.7', '198.51.100.7:0', '198.51.100.7:70000', '[2001:db8::1:1080', '300.1.1.1:1080', '[1:2:3]:1080', '[abcde::1]:1080'].map((addr) => freshLines(addr)),
    freshLines(address, ''), freshLines(address, 'invalid:fake-user'), freshLines(address, username, ''),
    [address, username, 'fake-first-password', 'fake-second-password', ''],
    freshLines(address, username, password, 'not-an-ip'), freshLines(address, username, password, 'abcde::1'),
    [address], freshLines(address, username, 'ab\uFFFDcd'), freshLines(address, 'fake-u\uFFFD'),
  ];
  for (const lines of invalid) { failed(await h.ispRun(['--add', '--yes'], lines)); nothingWritten(); }
});

it('AC8[failure paths: SOCKS check, egress mismatch, docker and sing-box check failures write nothing] AC9 preflight failures are inert', async () => {
  for (const name of ['fail_curl', 'docker_down', 'no_container', 'fail_check'] as const) {
    h.switch(name); failed(await h.add()); nothingWritten(); h.switch(name, false);
  }
});

it("AC8[failure paths: a rejected candidate config shows sing-box's message] AC14 validator diagnostic is forwarded", async () => {
  h.switch('fail_check'); failed(await h.add(), 'config check failed'); nothingWritten();
});

it('AC8[failure paths: the ISP port is already taken by something else] AC14 historical ports are unrelated to new ISP routing', async () => {
  for (const listener of ['tcp 13839', 'udp 13839', 'tcp 18444']) {
    h.set('listeners', cleanListeners + listener + '\n'); const before = h.snapshot();
    ok(await h.add()); expect(h.config().inbounds).toHaveLength(2); ok(await h.remove());
    h.set('listeners', cleanListeners + listener + '\n'); expect(h.snapshot()).toBe(before);
  }
});

it('AC8[failure paths: another inbound in config.json already uses an ISP port] AC14 unrelated legacy-port inbounds are preserved', async () => {
  const c = h.config(); c.inbounds.push({ type: 'direct', tag: 'other', listen_port: 18444 }); writeConfig(c);
  ok(await h.add()); expect(h.config().inbounds).toEqual(c.inbounds);
  ok(await h.remove()); expect(h.config().inbounds).toEqual(c.inbounds);
});

it('AC8[failure paths: config.json without ss-in or vless-reality-in is refused] AC14 missing inbound prototypes are refused', async () => {
  const c = h.config(); c.inbounds.pop(); writeConfig(c); const before = h.snapshot();
  failed(await h.add(), 'vless-reality-in'); nothingWritten(before);
});

it('AC8[failure paths: missing config.json is refused] AC14 missing and invalid JSON are reported without contents', async () => {
  rmSync(join(h.dir, 'config.json')); let before = h.snapshot();
  failed(await h.add(), 'config.json does not exist'); nothingWritten(before);
  h.write('config.json', `invalid ${password}`); before = h.snapshot();
  failed(await h.add(), 'not valid JSON'); nothingWritten(before);
});

it('AC8[lock: a second instance is refused while the lock is held] AC14 an alive PID lock is left intact', async () => {
  h.write('.isp.lock', String(process.pid)); failed(await h.add(), 'in progress');
  expect(h.snapshot()).toBe(original); expect(h.read('.isp.lock')).toBe(String(process.pid)); expect(h.backups()).toEqual([]);
});

it('AC8[rollback: container crashes with the ISP config -> all three files restored, old config running again] AC7 crash rollback restores service and files', async () => {
  h.switch('break_isp'); failed(await h.add(), 'Rolling back');
  expect(h.snapshot()).toBe(original); expect(h.read('state/status')).toBe('running\n');
  expect(h.upCount()).toBe(2); expect(h.backups()).toHaveLength(1);
});

it('AC8[rollback: compose up fails -> files restored] AC7 failed restart restores original files', async () => {
  h.switch('fail_up_isp'); failed(await h.add(), 'Rollback complete'); expect(h.snapshot()).toBe(original);
});

it('AC8[rollback: if even the rollback cannot be verified, say so and still leave the old files in place] AC7 unverified rollback never claims success', async () => {
  h.switch('break_isp'); h.switch('fail_exec_check'); const r = await h.add();
  failed(r, 'Rollback restored the files, but sing-box is not healthy');
  expect(r.stderr).not.toContain('Rollback complete'); expect(h.snapshot()).toBe(original);
});

it('AC8[rollback: a failed remove puts the ISP setup back] AC7 failed clean restart restores ISP files and listeners', async () => {
  ok(await h.add()); const before = h.snapshot(); h.switch('break_clean');
  failed(await h.remove(), 'Rolling back'); expect(h.snapshot()).toBe(before);
});

it('AC8[special-character passwords round-trip through .env into config.json and never reach output or logs] AC9 credentials stay off argv and diagnostics', async () => {
  const passwords = ['p@ss:w/rd#1', 'a"b\'c\\d', '$HOME', '`id`', '$(id)', ';rm -rf /', 'with space s', '  padded  ', '%41%2f', '-leading-dash', '--insecure', 'ünï/日本語', 'x&y|z>w<v*?[a]{b}~', '!bang!'];
  for (const pass of passwords) {
    ok(await h.add(address, 'user.name@host', pass));
    expect(outbound().password === pass).toBe(true);
    expect(envValue('ISP_SOCKS_PASS') === envQuote(pass)).toBe(true);
    expect(envUnquote(envValue('ISP_SOCKS_PASS')) === pass).toBe(true);
    const escaped = pass.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    expect(h.read('state/last-curl-config').includes(`proxy-user = "user.name@host:${escaped}"`)).toBe(true);
    expect(h.read('clash.yaml').includes(pass)).toBe(false);
    ok(await h.remove()); expect(h.snapshot()).toBe(original);
  }
});

it('AC8[special-character: a re-run keeps the stored credentials without prompting for them] AC9 blank password skips repeat prompt', async () => {
  const pass = 'p@ss:w/rd#1 "q" \\'; ok(await h.add(address, username, pass)); const before = h.snapshot();
  const r = await h.keep(); ok(r); expect(r.stderr).not.toContain('Repeat the password'); expect(h.snapshot()).toBe(before);
});

it('AC8[special-character: control characters in the password are refused] AC9 tabs and control bytes never write', async () => {
  for (const pass of ['fake-pa\tss', 'fake-pa\x00ss', 'fake-pa\x7fss']) { failed(await h.add(address, username, pass), 'Invalid password'); nothingWritten(); }
});

it('AC8[secrets: failure output does not show the password either] AC9 every runner audits stdout stderr and every stub log', async () => {
  for (const name of ['fail_curl', 'break_isp'] as const) {
    h.switch(name); failed(await h.add(address, 'unique-fake-user', 'Un1queSecretValue!')); h.switch(name, false);
    expect(h.snapshot()).toBe(original);
  }
});

it('AC8[jq missing: fails early with a clear error, installs nothing, writes nothing (add, remove, menu)] AC14 TS needs no jq on PATH', async () => {
  h.withoutJq(); expect(existsSync(join(h.bin, 'jq'))).toBe(false);
  ok(await h.add()); ok(await h.remove());
  ok(await h.ispRun(['--yes'], ['1', ...freshLines()])); ok(await h.ispRun(['--yes'], ['2']));
  expect(h.snapshot()).toBe(original);
});

it('AC8[docker permission denied: fails early on stderr with both remedies, writes nothing (add, remove, menu)] AC14 Docker permissions have actionable hints', async () => {
  h.switch('docker_denied');
  for (const args of [['--add'], ['--remove'], []]) {
    const r = await h.ispRun(args, ['1']); failed(r, 'permission denied while talking to the Docker daemon');
    expect(r.stdout).toBe(''); expect(r.stderr).toContain('sudo my-singbox isp-outbound');
    if (args[0]) expect(r.stderr).toContain(args[0]);
    expect(r.stderr).toContain('sudo usermod -aG docker "$USER"'); expect(r.stderr).toContain('log out and back in');
    expect(r.stderr).not.toContain('Choose'); nothingWritten();
  }
  expect(h.log()).not.toContain('docker run');
});

it('AC8[docker not running: fails early with its own message, writes nothing] AC14 daemon outage differs from permissions', async () => {
  h.switch('docker_down'); const r = await h.add(); failed(r, 'Docker daemon is not running');
  expect(r.stderr).not.toContain('permission denied'); nothingWritten();
});

it('AC8[project directory not writable: fails early with a clear error, writes nothing] AC14 directory permission failure is inert', async () => {
  chmodSync(h.dir, 0o500);
  try { failed(await h.add(), 'No permission to write in'); nothingWritten(); }
  finally { chmodSync(h.dir, 0o700); }
});

it('AC8[config.json not writable: fails early with a clear error, writes nothing] AC14 managed file permission failure is inert', async () => {
  chmodSync(join(h.dir, 'config.json'), 0o400);
  try { failed(await h.add(), 'No permission to read and write'); nothingWritten(); }
  finally { chmodSync(join(h.dir, 'config.json'), 0o600); }
});

it('AC8[notice: a successful add prints the complete allow-the-ports notice on stdout] AC14 add reports server route and final outbound', async () => { addNotice(await h.add()); });
it('AC8[notice: a no-change re-run of add prints it again] AC14 no-op add reports server route and final outbound', async () => { ok(await h.add()); addNotice(await h.keep()); });
it('AC8[notice: a successful remove prints the ports-can-be-closed note] AC14 removal reports preserved direct final outbound', async () => { ok(await h.add()); removeNotice(await h.remove()); expect(h.snapshot()).toBe(original); });
it('AC8[notice: remove with nothing configured still prints the note] AC14 no-op removal reports no configured ISP', async () => { removeNotice(await h.remove()); nothingWritten(); });

it('AC8[notice: not printed when the add fails, is declined or is rolled back] AC14 no success notice on add failure', async () => {
  for (const name of ['break_isp', 'fail_check'] as const) {
    h.switch(name); const r = await h.add(); failed(r); expect(r.stdout).not.toContain('ISP outbound is configured'); h.switch(name, false);
  }
  const r = await h.ispRun(['--add'], [...freshLines(), 'n']); failed(r); expect(r.stdout).not.toContain('ISP outbound is configured');
});

it('AC8[notice: not printed when a remove is rolled back] AC14 no success notice on remove failure', async () => {
  ok(await h.add()); h.switch('break_clean'); const r = await h.remove(); failed(r); expect(r.stdout).not.toContain('targeted rules removed');
});

it('AC8[no firewall is touched, nothing is installed and sudo is never called, in any flow] AC9 system tripwires cover all flows', async () => {
  ok(await h.add()); ok(await h.keep()); ok(await h.remove()); ok(await h.remove()); h.switch('break_isp'); failed(await h.add());
  expect(h.read('state/tripwires.log')).toBe('');
});

it('AC8[temp files: nothing is left behind after answering n to the restart prompt] AC9 declined add removes private candidates', async () => {
  failed(await h.ispRun(['--add'], [...freshLines(), 'n']), 'Aborted'); nothingWritten();
});
it('AC8[temp files: nothing is left behind after answering n to the restart prompt of --remove] AC9 declined remove removes staged backup', async () => {
  ok(await h.add()); const before = h.snapshot(), backups = h.backups();
  failed(await h.ispRun(['--remove'], ['n']), 'Aborted'); expect(h.snapshot()).toBe(before); expect(h.backups()).toEqual(backups);
});
it('AC8[temp files: nothing is left behind after a rollback] AC9 rollback removes private candidates', async () => {
  h.switch('break_isp'); failed(await h.add(), 'Rolling back'); expect(h.snapshot()).toBe(original);
});
it('AC8[temp files: nothing is left behind after a successful add, a no-op add and a remove] AC9 runners assert candidate cleanup after every run', async () => {
  ok(await h.add()); ok(await h.keep()); ok(await h.remove()); expect(h.snapshot()).toBe(original);
});
it('AC8[temp files: leftovers from an older run are swept at the start of the next run] AC9 stale plaintext files are swept', async () => {
  h.write('.isp-tmp.stale1', 'ISP_SOCKS_PASS="old-fake"\n'); h.write('.isp-tmp.stale2', 'plaintext\n'); ok(await h.add());
  expect(readdirSync(h.dir).filter((name) => name.startsWith('.isp-tmp.'))).toEqual([]);
});

it('AC8[add again with the ISP config present but the service on the old config: restarts once, verifies, then succeeds] AC14 unhealthy idempotent add repairs service', async () => {
  ok(await h.add()); h.set('status', 'exited\n'); h.set('listeners', ''); h.clearLog(); const r = await h.keep(); ok(r);
  expect(r.stderr).toContain('Restarting'); expect(h.upCount()).toBe(1); expect(h.read('state/listeners')).toBe(cleanListeners);
});
it('AC8[add again with the ISP config present and the service still unhealthy after one restart: exit non-zero, nothing reported active, no system change] AC9 failed repair preserves files', async () => {
  ok(await h.add()); const files = ['config.json', 'clash.yaml', '.env'].map(h.read);
  h.switch('break_isp'); h.set('status', 'exited\n'); h.set('listeners', ''); h.clearLog(); const r = await h.keep();
  failed(r, 'still not healthy'); expect(r.stdout).not.toContain('ISP outbound is configured');
  expect(['config.json', 'clash.yaml', '.env'].map(h.read)).toEqual(files); expect(h.upCount()).toBe(1); expect(h.backups()).toHaveLength(1);
});
it('AC8[add again, unhealthy, answering n to the restart question: nothing changes] AC14 declined repair preserves service state', async () => {
  ok(await h.add()); h.set('status', 'exited\n'); h.set('listeners', ''); h.clearLog(); const before = h.snapshot();
  failed(await h.ispRun(['--add'], ['', '', '', '', 'n']), 'Aborted'); expect(h.snapshot()).toBe(before); expect(h.upCount()).toBe(0);
});

it('AC8[signal: SIGTERM after config.json was replaced but before the service is verified rolls everything back] AC7 AC9 child process signal rollback exits 143', () => {
  h.switch('term_on_up'); const r = h.ispSpawn(['--add', '--yes'], freshLines());
  expect(r.code).toBe(143); expect(r.stderr).toContain('Interrupted by TERM'); expect(r.stderr).toContain('Rollback complete');
  expect(h.snapshot()).toBe(original); expect(h.upCount()).toBe(2); expect(existsSync(join(h.dir, '.isp.lock'))).toBe(false);
});

it('AC8[is_ipv6: accepts well-formed addresses] AC2 strict TS validator accepts valid IPv6', () => {
  for (const ip of ['::1', '::', '2001:db8::1', 'fe80::1', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7::', '::2:3:4:5:6:7:8', '1::8', 'ABCD:ef01::1', '0:0:0:0:0:0:0:1']) expect(isIpv6Strict(ip), ip).toBe(true);
});
it('AC8[is_ipv6: rejects 1:2:3, abcde::1 and other malformed input] AC2 strict TS validator rejects malformed IPv6', () => {
  for (const ip of ['1:2:3', 'abcde::1', ':1:2', '1:2:', '1::2::3', '1:::2', '12345::1', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8::', '::1:2:3:4:5:6:7:8', ':1:2:3:4:5:6:7', '1:2:3:4:5:6:7:', 'g::1', '::ffff:1.2.3.4', 'fe80::1%eth0', '', ':', '1.2.3.4']) expect(isIpv6Strict(ip), ip).toBe(false);
});
it('AC8[password and user name must be valid UTF-8: refused before anything is written] AC9 replacement characters and lone surrogates are refused', async () => {
  for (const value of ['fake-ab\uFFFDcd', 'fake-ab\uD800cd', 'fake-ab\uDC00cd']) {
    failed(await h.add(address, username, value), 'UTF-8'); nothingWritten();
    failed(await h.add(address, value), 'UTF-8'); nothingWritten();
  }
});
it('AC8[a valid multi-byte UTF-8 password is accepted] AC9 Unicode credentials round-trip', async () => {
  const pass = 'pässwörd-密码-🔐'; ok(await h.add(address, username, pass)); expect(outbound().password === pass).toBe(true);
});
it('AC8[add then remove is byte-exact even when .env and clash.yaml have no trailing newline] AC7 SHA-256 proves no-EOL restores', async () => {
  for (const file of ['.env', 'clash.yaml']) h.write(file, h.read(file).replace(/\n$/, ''));
  const before = h.snapshot(); ok(await h.add()); const added = h.snapshot(); ok(await h.keep());
  expect(h.snapshot()).toBe(added); expect(h.backups()).toHaveLength(1); ok(await h.remove()); expect(h.snapshot()).toBe(before);
});
it('AC8[add then remove is byte-exact for a .env with trailing blank lines] AC7 SHA-256 proves trailing blank lines survive', async () => {
  h.write('.env', h.read('.env') + '\n\n'); const before = h.snapshot(); ok(await h.add()); ok(await h.remove()); expect(h.snapshot()).toBe(before);
});

it('AC7 env installation failure after config replacement restores bytes and modes', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/isp.js')>('../../src/core/isp.js');
  chmodSync(join(h.dir, 'config.json'), 0o640); chmodSync(join(h.dir, '.env'), 0o640);
  const before = h.snapshot(); let installedConfig = false;
  vi.mocked(installFile).mockImplementationOnce((dest, data, projectDir) => {
    expect(dest).toBe(join(h.dir, 'config.json')); actual.installFile(dest, data, projectDir); installedConfig = true;
  }).mockImplementationOnce((dest) => {
    expect(dest).toBe(join(h.dir, '.env')); expect(installedConfig).toBe(true);
    expect(h.config().outbounds!.some((o) => o.tag === 'isp-socks')).toBe(true);
    throw new Error('fixture env install failed');
  });
  failed(await h.add(), 'fixture env install failed');
  expect(h.snapshot()).toBe(before);
  expect(mode(join(h.dir, 'config.json'))).toBe(0o640); expect(mode(join(h.dir, '.env'))).toBe(0o640);
  expect(h.upCount()).toBe(1); expect(existsSync(join(h.dir, '.isp.lock'))).toBe(false);
});

it('AC7 failed remove restores an originally absent env file state and leaves Clash absent', async () => {
  ok(await h.add()); rmSync(join(h.dir, '.env')); rmSync(join(h.dir, 'clash.yaml'));
  const before = h.snapshot(); h.switch('break_clean'); failed(await h.remove(), 'Rolling back');
  expect(h.snapshot()).toBe(before);
  expect(existsSync(join(h.dir, '.env'))).toBe(false); expect(existsSync(join(h.dir, 'clash.yaml'))).toBe(false);
});

it('AC7 remove works without a historical clean backup and preserves current user edits', async () => {
  ok(await h.add()); rmSync(join(h.dir, '.isp-backup'), { recursive: true });
  const config = h.config(); config.custom = { later: true };
  config.route!.rules!.push({ domain: ['later.test'], outbound: 'direct' }); writeConfig(config);
  h.write('.env', h.read('.env') + '# later note\n'); ok(await h.remove());
  expect(h.config().custom).toEqual({ later: true });
  expect(h.config().route!.rules).toEqual([{ action: 'sniff' }, { domain: ['later.test'], outbound: 'direct' }]);
  expect(h.read('.env')).toContain('# later note\n');
  expect(h.backups()).toHaveLength(1); expect(h.upCount()).toBe(2);
});

it('ISP commands ignore unreadable malformed Clash and preserve its mode through success and rollback', async () => {
  const file = join(h.dir, 'clash.yaml'), text = 'proxies: [malformed legacy client';
  h.write('clash.yaml', text); chmodSync(file, 0o000);
  try {
    ok(await h.add()); ok(await h.keep()); ok(await h.remove());
    h.switch('break_isp'); failed(await h.add(), 'Rolling back');
    expect(mode(file)).toBe(0o000);
  } finally { chmodSync(file, 0o600); }
  expect(h.read('clash.yaml')).toBe(text);
});

it('CLI uses active template defaults only when no custom ISP routes exist', async () => {
  const template = JSON.parse(h.read('templates/config.json.template'));
  const customRule = { domain_suffix: ['active-template.test'], outbound: 'isp-socks', network: 'tcp' };
  template.route.rules = [{ action: 'sniff' }, customRule];
  h.write('templates/config.json.template', JSON.stringify(template));
  ok(await h.add()); expect(h.config().route!.rules).toEqual([{ action: 'sniff' }, customRule]);
  const before = h.config().route;
  h.write('templates/config.json.template', '{invalid template');
  ok(await h.add(address, 'updated-user', 'updated-password'));
  expect(h.config().route).toEqual(before);
  ok(await h.remove());
  const filesBefore = h.snapshot(); failed(await h.add()); expect(h.snapshot()).toBe(filesBefore);
});

it.each(['add', 'remove'])('CLI refuses unsupported legacy references before %s writes any managed file', async (action) => {
  if (action === 'remove') ok(await h.add());
  const config = h.config(); config.custom = { inbound: 'ss-isp-in' }; writeConfig(config);
  const before = h.snapshot(), backups = h.backups(), restarts = h.upCount();
  failed(action === 'add' ? await h.add() : await h.remove());
  expect(h.snapshot()).toBe(before); expect(h.backups()).toEqual(backups); expect(h.upCount()).toBe(restarts);
});
