import { createHash } from 'node:crypto';
import { project, invoke, read } from './helpers/cli.js';
import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findTemplate, readTemplate, findPackageFile } from '../../src/core/templates.js';
it('finds package files by walking up', () => {
  expect(findPackageFile('compose.yaml')).toBe(join(import.meta.dirname, '../../compose.yaml'));
  expect(() => findPackageFile('missing')).toThrow('Package file does not exist: missing');
});
it('finds repository templates by walking up and falls back from an absent override', () => {
  expect(findTemplate('config.json.template')).toMatch(
    /templates\/config.json.template$/,
  );
  expect(readTemplate('config.json.template', '/nonexistent')).toContain(
    '${SS_PASSWORD}',
  );
  expect(() => findTemplate('missing')).toThrow(
    'Template does not exist: templates/missing',
  );
});

it('prefers project templates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2-template-'));
  try {
    mkdirSync(join(dir, 'templates'));
    writeFileSync(join(dir, 'templates', 'custom'), 'custom');
    expect(readTemplate('custom', dir)).toBe('custom');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// AC8 guards for the shipped templates; these files remain unchanged.

it("AC8[clash template: reversing the three renames gives back the original template byte for byte]", async () => {
  const restored = readTemplate('clash.yaml.template').replaceAll('shadowsocks', 'My-sing-box').replaceAll('vless-reality', 'My-VLESS-Reality').replace(/\bProxy\b/g, 'PROXY');
  expect(createHash('sha256').update(restored).digest('hex')).toBe('169cc1356c9e0c79d7b692c511a69ca12619a781adb433de83903dc8e1fbb36d');
});

it("AC8[clash template: no old names are left]", async () => {
  expect(readTemplate('clash.yaml.template')).not.toMatch(/My-sing-box|My-VLESS-Reality|PROXY/);
});

it("AC8[clash template: the new names appear exactly where the old ones did]", async () => {
  const lines = readTemplate('clash.yaml.template').split('\n');
  expect(lines.filter((line) => line.includes('shadowsocks'))).toHaveLength(2);
  expect(lines.filter((line) => line.includes('vless-reality'))).toHaveLength(2);
  expect(lines.filter((line) => /^  - name: Proxy$/.test(line))).toHaveLength(1);
  expect(lines.filter((line) => /^  - [A-Z-]+,(.*,)?Proxy$/.test(line))).toHaveLength(10);
  expect(lines.filter((line) => /dns-query#Proxy"$/.test(line))).toHaveLength(2);
});

it("AC8[clash template: rules, rule-providers and dns settings are unchanged]", async () => {
  const text = readTemplate('clash.yaml.template');
  expect(text).toContain('  - RULE-SET,meta-proxy,Proxy');
  expect(text).toContain('  meta-proxy:');
  expect(text).toContain('path: ./ruleset/meta-proxy.mrs');
});

it("AC8[env.template: ISP keys are present, commented out and empty]", async () => {
  const text = readTemplate('.env.template');
  for (const key of ['ADDR', 'USER', 'PASS'])
    expect(text.split('\n')).toContain('# ISP_SOCKS_' + key + '=');
  expect(text).not.toMatch(/^\s*ISP_SOCKS_/m);
});

it("AC8[env.template: ISP_SOCKS_EGRESS_IP is the fourth key, commented out and empty]", async () => {
  const text = readTemplate('.env.template');
  expect(text.split('\n')).toContain('# ISP_SOCKS_EGRESS_IP=');
  expect(text).not.toMatch(/^\s*ISP_SOCKS_EGRESS_IP/m);
  expect(text.match(/^# ISP_SOCKS_.*$/gm)?.at(3)).toBe('# ISP_SOCKS_EGRESS_IP=');
});

it("AC8[env.template: carries the 'filled automatically' comment]", async () => {
  expect(readTemplate('.env.template')).toContain('# Optional; filled automatically by scripts/isp-outbound.sh, no need to edit manually.');
});

it("AC8[env.template: output is identical to a template that has no ISP block at all]", async () => {
  const withBlock = project(), withoutBlock = project();
  const stripped = read(withoutBlock, 'templates/.env.template').split('\n').filter((line) => !/isp/i.test(line)).join('\n');
  expect(stripped).not.toMatch(/isp/i);
  writeFileSync(join(withoutBlock, 'templates/.env.template'), stripped);
  expect((await invoke('conf-clash', withBlock)).code).toBe(0);
  expect((await invoke('conf-clash', withoutBlock)).code).toBe(0);
  expect(read(withBlock, 'clash.yaml')).toBe(read(withoutBlock, 'clash.yaml'));
});
