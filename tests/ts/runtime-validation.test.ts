import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderGeneratedEnv } from '../../src/core/env.js';

const singbox = process.env.SINGBOX_BIN;
const mihomo = process.env.MIHOMO_BIN;
const enabled = Boolean(singbox && mihomo);
const cli = resolve('dist/cli.js');

beforeAll(() => {
  if (enabled) execFileSync('npm', ['run', 'build'], { stdio: 'pipe' });
}, 30000);

it.skipIf(!enabled).each(['off', 'on'])('validates generated configs with ISP %s', (isp) => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-validation-'));
  try {
    const keys = execFileSync(singbox!, ['generate', 'reality-keypair'], { encoding: 'utf8' });
    const privateKey = keys.match(/^PrivateKey:\s*(\S+)/m)![1];
    const publicKey = keys.match(/^PublicKey:\s*(\S+)/m)![1];
    let env = renderGeneratedEnv({
      singBoxVersion: 'v1.14.4',
      vlessUuid: '11111111-2222-4333-8444-555555555555',
      realityPrivateKey: privateKey,
      realityPublicKey: publicKey,
      realityShortId: '0123456789abcdef',
      ssPassword: 'AAAAAAAAAAAAAAAAAAAAAA==',
      serverAddress: '8.8.8.8',
    });
    if (isp === 'on') env += 'ISP_SOCKS_ADDR=198.51.100.7:1080\nISP_SOCKS_USER="fixture-user"\nISP_SOCKS_PASS="fixture-pass"\nISP_SOCKS_EGRESS_IP=198.51.100.7\n';
    writeFileSync(join(dir, '.env'), env, { mode: 0o600 });
    for (const command of ['gen-config', 'conf-clash'])
      execFileSync(process.execPath, [cli, command], { cwd: dir, stdio: 'pipe' });
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    const clash = parse(readFileSync(join(dir, 'clash.yaml'), 'utf8'));
    const tags = config.inbounds.map((item: { tag: string }) => item.tag);
    const outbounds = config.outbounds.map((item: { tag: string }) => item.tag);
    const rules = (config.route?.rules ?? []).filter((rule: { outbound: string }) => rule.outbound === 'isp-socks');
    const names = clash.proxies.map((proxy: { name: string }) => proxy.name);
    const group = clash['proxy-groups'].find((item: { name: string }) => item.name === 'Proxy').proxies;
    for (const tag of ['ss-isp-in', 'vless-reality-isp-in']) expect(tags.includes(tag)).toBe(isp === 'on');
    expect(outbounds.includes('isp-socks')).toBe(isp === 'on');
    expect(rules).toHaveLength(isp === 'on' ? 1 : 0);
    if (isp === 'on') expect(rules[0].inbound).toEqual(['ss-isp-in', 'vless-reality-isp-in']);
    for (const name of ['shadowsocks-isp', 'vless-reality-isp']) {
      expect(names.includes(name)).toBe(isp === 'on');
      expect(group.includes(name)).toBe(isp === 'on');
    }
    execFileSync(singbox!, ['check', '-c', join(dir, 'config.json')], { stdio: 'pipe' });
    execFileSync(mihomo!, ['-t', '-f', join(dir, 'clash.yaml'), '-d', join(dir, 'data')], { stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
