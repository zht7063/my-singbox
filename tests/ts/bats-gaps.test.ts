import { expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { project, invoke, read } from './helpers/cli.js';
import { fixtureText, creds } from './helpers/fixtures.js';
import { envWithIsp } from '../../src/core/env.js';

const emptyIsp = 'ISP_SOCKS_ADDR=\nISP_SOCKS_USER=\nISP_SOCKS_PASS=\nISP_SOCKS_EGRESS_IP=\n';
const populatedIsp = { addr: '198.51.100.7:1080', user: 'user.name', pass: 'p@ss', egressIp: '198.51.100.99' };

async function rejected(cmd: string, text: string, error: string) {
  const dir = project(text);
  const result = await invoke(cmd, dir);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(error);
  expect(existsSync(join(dir, cmd === 'gen-config' ? 'config.json' : 'clash.yaml'))).toBe(false);
}

it("AC8[gen-config: output is byte-identical with empty ISP keys]", async () => {
  const baseline = project(), withEmpty = project(fixtureText() + emptyIsp);
  expect((await invoke('gen-config', baseline)).code).toBe(0);
  expect((await invoke('gen-config', withEmpty)).code).toBe(0);
  expect(read(withEmpty, 'config.json')).toBe(read(baseline, 'config.json'));
});

it("AC8[gen-config: ISP keys placed before the other keys are accepted]", async () => {
  const text = envWithIsp('', populatedIsp) + fixtureText();
  const dir = project(text);
  expect((await invoke('gen-config', dir)).code).toBe(0);
  const config = JSON.parse(read(dir, 'config.json'));
  expect(config.inbounds).toHaveLength(4);
  expect(config.outbounds.at(-1).username).toBe(populatedIsp.user);
});

it("AC8[gen-config: ISP keys never satisfy a required key]", async () => {
  await rejected('gen-config', envWithIsp(fixtureText().replace(/^SS_PASSWORD=.*\n/m, ''), populatedIsp), 'Missing .env key: SS_PASSWORD');
});

it("AC8[gen-config: a duplicated ISP key still dies]", async () => {
  await rejected('gen-config', fixtureText() + "ISP_SOCKS_USER=\"a\"\nISP_SOCKS_USER=\"b\"\n", 'Duplicate key in .env: ISP_SOCKS_USER');
});

it("AC8[gen-config: a duplicated empty ISP key still dies]", async () => {
  await rejected('gen-config', fixtureText() + "ISP_SOCKS_ADDR=\nISP_SOCKS_ADDR=\n", 'Duplicate key in .env: ISP_SOCKS_ADDR');
});

it("AC8[gen-config: a duplicated ISP_SOCKS_EGRESS_IP still dies]", async () => {
  await rejected('gen-config', fixtureText() + "ISP_SOCKS_EGRESS_IP=198.51.100.1\nISP_SOCKS_EGRESS_IP=\n", 'Duplicate key in .env: ISP_SOCKS_EGRESS_IP');
});

it("AC8[gen-config: only the four ISP keys are whitelisted]", async () => {
  for (const key of ['ISP_SOCKS', 'ISP_SOCKS_PASSWORD', 'ISP_SOCKS_ADDRESS', 'ISP_SOCKS_EGRESS', 'ISP_SOCKS_EGRESS_IPV4', 'ISP_EXPECTED_EGRESS_IP', 'isp_socks_egress_ip', 'FOO_BAR'])
    await rejected('gen-config', fixtureText() + key + '=x\n', 'Unknown key in .env: ' + key);
});

it("AC8[conf-clash: output is byte-identical with empty ISP keys]", async () => {
  const baseline = project(), withEmpty = project(fixtureText() + emptyIsp);
  expect((await invoke('conf-clash', baseline)).code).toBe(0);
  expect((await invoke('conf-clash', withEmpty)).code).toBe(0);
  expect(read(withEmpty, 'clash.yaml')).toBe(read(baseline, 'clash.yaml'));
});

it("AC8[conf-clash: ISP keys never satisfy a required key]", async () => {
  await rejected('conf-clash', envWithIsp(fixtureText().replace(/^SERVER_ADDRESS=.*\n/m, ''), populatedIsp), 'Set SERVER_ADDRESS');
});

it("AC8[conf-clash: a duplicated ISP key still dies]", async () => {
  await rejected('conf-clash', fixtureText() + "ISP_SOCKS_PASS=\"a\"\nISP_SOCKS_PASS=\"b\"\n", 'Duplicate key in .env: ISP_SOCKS_PASS');
});

it("AC8[conf-clash: a duplicated empty ISP key still dies]", async () => {
  await rejected('conf-clash', fixtureText() + "ISP_SOCKS_ADDR=\nISP_SOCKS_ADDR=\n", 'Duplicate key in .env: ISP_SOCKS_ADDR');
});

it("AC8[conf-clash: ISP keys are accepted when uncommented in templates/.env.template too]", async () => {
  const dir = project();
  writeFileSync(join(dir, 'templates/.env.template'), read(dir, 'templates/.env.template') + emptyIsp);
  expect((await invoke('conf-clash', dir)).code).toBe(0);
  expect(parse(read(dir, 'clash.yaml')).proxies).toHaveLength(2);
});

it("AC8[conf-clash: a duplicated ISP_SOCKS_EGRESS_IP still dies]", async () => {
  await rejected('conf-clash', fixtureText() + "ISP_SOCKS_EGRESS_IP=198.51.100.1\nISP_SOCKS_EGRESS_IP=\n", 'Duplicate key in .env: ISP_SOCKS_EGRESS_IP');
});

it("AC8[conf-clash: only the four ISP keys are whitelisted]", async () => {
  for (const key of ['ISP_SOCKS', 'ISP_SOCKS_PASSWORD', 'ISP_SOCKS_ADDRESS', 'ISP_SOCKS_EGRESS', 'ISP_SOCKS_EGRESS_IPV4', 'ISP_EXPECTED_EGRESS_IP', 'isp_socks_egress_ip', 'FOO_BAR'])
    await rejected('conf-clash', fixtureText() + key + '=x\n', 'Unknown key in .env: ' + key);
});

it("AC8[gen-config: dies on invalid credential formats]", async () => {
  await rejected('gen-config', fixtureText().replace(creds.vlessUuid, 'not-a-uuid'), "Invalid credentials in .env.");
});


