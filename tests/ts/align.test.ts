import { beforeAll, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { envQuote, envUnquote, envWithIsp, renderGeneratedEnv } from '../../src/core/env.js';
import { creds } from './helpers/fixtures.js';
import { project as createProject, invoke, read, bash, root, shellEnv, stubKeyCommands } from './helpers/cli.js';

beforeAll(() => {
  for (const tool of ['bash', 'jq']) {
    const result = spawnSync(tool, ['--version'], { env: shellEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(result.status, `${tool} must be available for alignment; this suite must not skip`).toBe(0);
  }
});

// Source the real functions only, without executing the script's main loop.
// Slice in JS so BSD/GNU sed differences cannot silently source an empty script.
const ispScript = readFileSync(join(root, 'scripts/isp-outbound.sh'), 'utf8');
const mainLoop = ispScript.indexOf('\nwhile (($# > 0)); do\n');
if (mainLoop < 0) throw new Error('Cannot locate legacy ISP argument loop.');
const functions = ispScript.slice(0, mainLoop);
function project(text?: string | null) {
  const dir = createProject(text);
  writeFileSync(join(dir, 'scripts/isp-functions.sh'), functions, { mode: 0o600 });
  return dir;
}
const sourceIsp = `source scripts/isp-functions.sh
PROJECT_DIR=$PWD
CONFIG_FILE=$PWD/config.json
CLASH_FILE=$PWD/clash.yaml
ENV_FILE=$PWD/.env
`;
// Execute the actual do_add env writer, rather than a reimplementation.
const envWriter = ispScript.match(/    \{\n        env_without_isp "\$ENV_FILE"[\s\S]*?    \} > "\$env_cand"/)![0];
const defaultIsp = { addr: '198.51.100.7:1080', user: 'fixture-user', pass: 'fixture-pass', egressIp: '198.51.100.7' };
const fixtures = [
  { id: 'base-ipv4', server: '203.0.113.10', isp: defaultIsp },
  { id: 'base-hostname', server: 'vpn.example.com', isp: defaultIsp },
  { id: 'base-ipv6', server: '2001:db8::1', isp: defaultIsp },
  { id: 'isp-ipv4', server: '203.0.113.10', isp: defaultIsp },
  { id: 'isp-ipv6-special-creds', server: '2001:db8::1', isp: {
    addr: '[2001:db8::1]:1080', user: 'user"\\$# space 雪', pass: 'pass"\\$# space 密碼', egressIp: '2001:db8::1',
  } },
  { id: 'isp-ipv4-egress-differs', server: '203.0.113.10', isp: { ...defaultIsp, egressIp: '198.51.100.99' } },
];

function sortedJson(dir: string, file: string): string {
  return execFileSync('jq', ['-S', '.', join(dir, file)], { env: shellEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

it.each(fixtures)('AC1/AC6 $id', async ({ id, server, isp }) => {
  const base = renderGeneratedEnv({ ...creds, serverAddress: server });
  const s = project(base), t = project(base);
  bash(s, ['scripts/gen-config.sh']);
  bash(s, ['scripts/conf-clash.sh']);
  expect((await invoke('gen-config', t)).code).toBe(0);
  expect((await invoke('conf-clash', t)).code).toBe(0);
  const shellBase = JSON.parse(sortedJson(s, 'config.json'));
  const tsBase = JSON.parse(sortedJson(t, 'config.json'));
  expect(tsBase).toEqual(shellBase);
  expect(JSON.stringify(shellBase)).not.toContain('isp-socks');
  expect(tsBase.route).toEqual({ rules: [{ action: 'sniff' }], final: 'direct' });
  expect(parse(read(t, 'clash.yaml'))).toEqual(parse(read(s, 'clash.yaml')));

  bash(s, ['-c', sourceIsp + `
parse_addr "$HARNESS_ADDR"
ISP_USER=$HARNESS_USER
ISP_PASS=$HARNESS_PASS
ISP_EGRESS_IP=$HARNESS_EGRESS
render_config_add "$PWD/config.cand.json"
clash_render_add "$PWD/clash.cand.yaml"
env_cand=$PWD/env_cand
${envWriter}
`], {
    HARNESS_ADDR: isp.addr, HARNESS_USER: isp.user, HARNESS_PASS: isp.pass, HARNESS_EGRESS: isp.egressIp,
  });
  const withIsp = envWithIsp(base, isp);
  expect(withIsp).toBe(read(s, 'env_cand'));
  const on = project(withIsp);
  expect((await invoke('gen-config', on)).code).toBe(0);
  expect((await invoke('conf-clash', on)).code).toBe(0);
  const legacy = JSON.parse(sortedJson(s, 'config.cand.json'));
  const independent = JSON.parse(sortedJson(on, 'config.json'));
  expect(legacy.inbounds.map((i: { tag: string }) => i.tag)).toEqual(['ss-in', 'vless-reality-in', 'ss-isp-in', 'vless-reality-isp-in']);
  expect(independent.inbounds).toEqual(tsBase.inbounds);
  expect(independent.outbounds).toEqual(legacy.outbounds);
  const legacyIspRules = legacy.route.rules.filter((rule: { outbound?: string }) => rule.outbound === 'isp-socks');
  expect(legacyIspRules).toEqual([{ inbound: ['ss-isp-in', 'vless-reality-isp-in'], outbound: 'isp-socks' }]);
  const template = JSON.parse(read(on, 'templates/config.json.template'));
  expect(independent.route.rules).toEqual(template.route.rules);
  expect(independent.route.rules.some((rule: { inbound?: unknown }) => rule.inbound !== undefined)).toBe(false);
  expect(independent.route.final).toBe('direct');
  const shellClash = parse(read(s, 'clash.cand.yaml'));
  const tsClash = parse(read(on, 'clash.yaml'));
  expect(shellClash.proxies.map((p: { name: string }) => p.name)).toEqual(['shadowsocks', 'vless-reality', 'shadowsocks-isp', 'vless-reality-isp']);
  expect(shellClash['proxy-groups'].find((g: { name: string }) => g.name === 'Proxy').proxies).toEqual(['shadowsocks', 'vless-reality', 'DIRECT', 'shadowsocks-isp', 'vless-reality-isp']);
  expect(tsClash).toEqual(parse(read(t, 'clash.yaml')));
  expect(tsClash.proxies.map((p: { name: string }) => p.name)).toEqual(['shadowsocks', 'vless-reality']);
  for (const key of ['rules', 'rule-providers', 'dns']) expect(tsClash[key]).toEqual(shellClash[key]);
  console.log(`${id}: base protocol/client semantics and .env bytes aligned; legacy four-node ISP and independent TS routing checked separately`);
});

const tricky = ['', 'plain', '"', '\\', '$', '$$', '# space', 'quotes" slash\\ dollar$ # 雪😀', ' trailing ', '\\"$'];
it.each(tricky.map((value, i) => ({ id: `quote-${i}`, value })))('AC6 $id', ({ value }) => {
  const dir = project();
  const quoted = bash(dir, ['-c', sourceIsp + 'env_quote "$HARNESS_VALUE"'], { HARNESS_VALUE: value });
  expect(envQuote(value)).toBe(quoted);
  const unquoted = bash(dir, ['-c', sourceIsp + 'env_unquote "$HARNESS_VALUE"'], { HARNESS_VALUE: quoted });
  expect(envUnquote(quoted)).toBe(unquoted);
  expect(unquoted).toBe(value);
});

it.each(['raw # $', '"$"', '"\\n"', '"a"b"', '"a\\"'])('AC6 unquote raw/malformed case %#', (raw) => {
  const dir = project();
  const result = spawnSync('bash', ['-c', sourceIsp + 'env_unquote "$HARNESS_VALUE"'], { cwd: dir, env: { ...shellEnv, HARNESS_VALUE: raw }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  expect(envUnquote(raw)).toBe(result.status === 0 ? result.stdout : null);
});

it.each(['with newline', 'without newline', 'existing ISP block'])('AC6 envWithIsp bytes: %s', (kind) => {
  const base = renderGeneratedEnv(creds);
  const text = kind === 'without newline' ? base.trimEnd() : kind === 'existing ISP block' ? envWithIsp(base, defaultIsp) : base;
  const dir = project(text);
  bash(dir, ['-c', sourceIsp + `
parse_addr "$HARNESS_ADDR"
ISP_USER=$HARNESS_USER
ISP_PASS=$HARNESS_PASS
ISP_EGRESS_IP=$HARNESS_EGRESS
env_cand=$PWD/env_cand
${envWriter}
`], { HARNESS_ADDR: defaultIsp.addr, HARNESS_USER: defaultIsp.user, HARNESS_PASS: defaultIsp.pass, HARNESS_EGRESS: defaultIsp.egressIp });
  expect(envWithIsp(text, defaultIsp)).toBe(read(dir, 'env_cand'));
});

it('AC6 generated .env bytes and stat modes match real gen-keys.sh', async () => {
  const s = project(null), t = project(null);
  bash(s, ['scripts/gen-keys.sh'], stubKeyCommands(s));
  expect((await invoke('gen-keys', t)).code).toBe(0);
  expect(read(t, '.env')).toBe(read(s, '.env'));
  expect(read(t, '.env')).toBe(renderGeneratedEnv({ ...creds, serverAddress: '8.8.8.8' }));
  expect(statSync(join(s, '.env')).mode & 0o777).toBe(0o600);
  expect(statSync(join(t, '.env')).mode & 0o777).toBe(0o600);
});
