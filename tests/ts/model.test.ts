import { it, expect } from 'vitest';
import { buildModel, ModelError, SS_PORT, VLESS_PORT } from '../../src/model.js';
import { parseEnv } from '../../src/core/env.js';
import {
  fixtureEnv,
  fixtureText,
  fixtureModel,
  creds,
} from './helpers/fixtures.js';
it('builds exactly two protocol nodes independently of ISP credentials', () => {
  const off = fixtureModel(), on = fixtureModel(true);
  expect(off.nodes.map((n) => [n.name, n.inbound.tag, n.inbound.port])).toEqual([
    ['shadowsocks', 'ss-in', 8388],
    ['vless-reality', 'vless-reality-in', 8443],
  ]);
  expect(off.isp).toBeUndefined();
  expect(on.nodes).toEqual(off.nodes);
  expect(on.isp?.addr).toBe('[2001:db8::1]:1080');
  for (const node of on.nodes) expect(node).not.toHaveProperty('egress');
});

it.each(['ISP_SOCKS_USER=only-user', 'ISP_SOCKS_ADDR=invalid', 'ISP_SOCKS_EGRESS_IP=invalid'])('client model ignores incomplete or invalid ISP settings: %s', (line) => {
  const model = buildModel(parseEnv(fixtureText() + line + '\n'), { target: 'client' });
  expect(model.nodes).toEqual(buildModel(fixtureEnv(), { target: 'client' }).nodes);
  expect(model.isp).toBeUndefined();
});

it('accepts absent or empty optional ISP settings', () => {
  expect(
    buildModel(parseEnv(fixtureText() + 'ISP_SOCKS_USER=\nISP_SOCKS_PASS=\n'))
      .isp,
  ).toBeUndefined();
});

it('requires only fields relevant to target', () => {
  const server = fixtureEnv();
  delete server.values.SERVER_ADDRESS;
  delete server.values.REALITY_PUBLIC_KEY;
  server.keys.delete('SERVER_ADDRESS');
  server.keys.delete('REALITY_PUBLIC_KEY');
  expect(buildModel(server, { target: 'server' }).server).toBe('');
  expect(() => buildModel(server)).toThrow('Set SERVER_ADDRESS');
  const client = fixtureEnv();
  delete client.values.REALITY_PRIVATE_KEY;
  client.keys.delete('REALITY_PRIVATE_KEY');
  expect(buildModel(client, { target: 'client' }).nodes).toHaveLength(2);
  expect(() => buildModel(client, { target: 'server' })).toThrow(
    'Missing .env key: REALITY_PRIVATE_KEY',
  );
});

it('uses target-specific missing and invalid errors', () => {
  for (const key of [
    'VLESS_UUID',
    'REALITY_PUBLIC_KEY',
    'REALITY_SHORT_ID',
    'SS_PASSWORD',
  ] as const) {
    const env = fixtureEnv();
    env.keys.delete(key);
    delete env.values[key];
    expect(() => buildModel(env, { target: 'client' })).toThrow(
      `Invalid ${key}.`,
    );
  }
  const env = fixtureEnv();
  env.values.VLESS_UUID = 'SECRET';
  expect(() => buildModel(env, { target: 'server' })).toThrow(
    'Invalid credentials in .env.',
  );
  env.values.SERVER_ADDRESS = 'bad address';
  expect(() => buildModel(env, { target: 'client' })).toThrow(
    'Invalid SERVER_ADDRESS. Set it',
  );
});

it.each([
  ['ISP_SOCKS_ADDR', 'SECRET'],
  ['ISP_SOCKS_USER', '"$"'],
  ['ISP_SOCKS_USER', 'a:b'],
  ['ISP_SOCKS_PASS', ''],
  ['ISP_SOCKS_PASS', '"\\n"'],
  ['ISP_SOCKS_EGRESS_IP', 'SECRET'],
])('rejects invalid ISP key %s without values', (key, value) => {
  const env = fixtureEnv(true);
  env.values[key as keyof typeof env.values] = value;
  expect(() => buildModel(env)).toThrow(new ModelError(`Invalid ${key}.`));
});

it.each(['all', 'server', 'client'] as const)('uses validated custom ports for target %s', (target) => {
  const model = buildModel(parseEnv(fixtureText() + 'SS_PORT=18388\nVLESS_PORT=18443\n'), { target });
  expect(model.nodes.map((node) => node.inbound.port)).toEqual([18388, 18443]);
  expect([SS_PORT, VLESS_PORT]).toEqual([8388, 8443]);
});

it.each([
  ['SS_PORT=1\n', [1, 8443]],
  ['VLESS_PORT=65535\n', [8388, 65535]],
  ['SS_PORT=008388\n', [8388, 8443]],
])('defaults each omitted port independently: %s', (text, expected) => {
  expect(buildModel(parseEnv(fixtureText() + text)).nodes.map((node) => node.inbound.port)).toEqual(expected);
});

it.each(['SS_PORT', 'VLESS_PORT'] as const)('rejects empty and invalid %s for every target', (key) => {
  for (const value of ['', ' ', '0', '-1', '65536', '1.5', '1e3', '0x2000', '+8388', '8388 ', ' 8388', '"8388"', 'NaN', 'Infinity', '8388\rbroken']) {
    for (const target of ['all', 'server', 'client'] as const) {
      const env = parseEnv(fixtureText() + `${key}=${value}\n`);
      expect(() => buildModel(env, { target })).toThrow(new ModelError(`Invalid ${key}. Expected an integer from 1 to 65535.`));
    }
  }
});

it.each(['SS_PORT=8443\n', 'VLESS_PORT=8388\n', 'SS_PORT=18000\nVLESS_PORT=018000\n'])('rejects duplicate TCP ports: %s', (text) => {
  for (const target of ['all', 'server', 'client'] as const)
    expect(() => buildModel(parseEnv(fixtureText() + text), { target })).toThrow(new ModelError('SS_PORT and VLESS_PORT must be different.'));
});

it('rejects partial ISP blocks', () => {
  expect(() =>
    buildModel(parseEnv(fixtureText() + 'ISP_SOCKS_EGRESS_IP=1.2.3.4\n')),
  ).toThrow('ISP_SOCKS_ADDR');
  expect(fixtureModel().server).toBe(creds.serverAddress);
});
