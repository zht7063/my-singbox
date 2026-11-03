import { it, expect } from 'vitest';
import {
  loadSingboxTemplate,
  renderSingbox,
  serializeSingbox,
} from '../../src/core/render-config.js';
import { readTemplate } from '../../src/core/templates.js';
import { parseEnv } from '../../src/core/env.js';
import { buildModel } from '../../src/model.js';
import { fixtureModel, fixtureText, creds } from './helpers/fixtures.js';

it('renders ISP-off template with only optional ISP rules filtered and leaves template unchanged', () => {
  const template = loadSingboxTemplate(), before = structuredClone(template);
  const result = renderSingbox(fixtureModel(), template);
  const expected = JSON.parse(readTemplate('config.json.template')
    .replaceAll('${SS_PASSWORD}', creds.ssPassword)
    .replaceAll('${VLESS_UUID}', creds.vlessUuid)
    .replaceAll('${REALITY_PRIVATE_KEY}', creds.realityPrivateKey)
    .replaceAll('${REALITY_SHORT_ID}', creds.realityShortId));
  expected.route.rules = expected.route.rules.filter((r: { outbound?: string }) => r.outbound !== 'isp-socks');
  expect(result).toEqual(expected);
  expect(result.route).toEqual({ rules: [{ action: 'sniff' }], final: 'direct' });
  expect(template).toEqual(before);
  expect(serializeSingbox(result)).toBe(JSON.stringify(result, null, 2) + '\n');
});

it('uses the native template as the sole source of the six default ISP domains', () => {
  const template = loadSingboxTemplate(), before = structuredClone(template);
  const out = renderSingbox(fixtureModel(true), template);
  expect(out.inbounds.map((i) => [i.tag, i.listen_port])).toEqual([
    ['ss-in', 8388], ['vless-reality-in', 8443],
  ]);
  expect(out.route).toEqual(template.route);
  expect(out.route?.rules?.[0]).toEqual({ action: 'sniff' });
  const rules = out.route!.rules!.filter((r) => (r as { outbound?: string }).outbound === 'isp-socks');
  expect(rules.flatMap((r) => (r as { domain_suffix: string[] }).domain_suffix)).toEqual([
    'anthropic.com', 'claude.ai', 'claude.com', 'claudeusercontent.com',
    'http-intake.logs.us5.datadoghq.com', 'browser-intake-us5-datadoghq.com',
  ]);
  expect(out.route!.final).toBe('direct');
  expect(out.outbounds!.filter((o) => o.tag === 'isp-socks')).toHaveLength(1);
  expect(out.outbounds!.at(-1)).toMatchObject({
    type: 'socks', tag: 'isp-socks', server: '2001:db8::1', server_port: 1080, version: '5',
  });
  expect(template).toEqual(before);
});

it.each([false, true])('preserves custom route fields and order with ISP=%s', (enabled) => {
  const template = loadSingboxTemplate();
  const custom = { domain_suffix: ['custom.test'], network: 'tcp', outbound: 'isp-socks', custom: true };
  template.route = { rules: [{ action: 'sniff' }, { ip_is_private: true, outbound: 'direct' }, custom], final: 'direct', auto_detect_interface: true };
  const out = renderSingbox(fixtureModel(enabled), template);
  expect(out.route).toEqual({ ...template.route, rules: enabled ? template.route.rules : template.route.rules!.slice(0, 2) });
  expect(out.route!.rules).not.toContainEqual(expect.objectContaining({ inbound: expect.anything() }));
});

it.each([false, true])('rejects non-array template route.rules with ISP=%s', (enabled) => {
  for (const rules of [null, {}, { outbound: 'direct' }, 'invalid', '', 42, false]) {
    const template = loadSingboxTemplate();
    const malformed = { ...template, route: { ...template.route, rules } };
    expect(() => renderSingbox(fixtureModel(enabled), malformed))
      .toThrow('Invalid config.json template: route.rules must be an array.');
  }
});

it.each([false, true])('initializes omitted template route.rules with ISP=%s', (enabled) => {
  const template = loadSingboxTemplate();
  delete template.route!.rules;
  expect(renderSingbox(fixtureModel(enabled), template).route)
    .toEqual({ rules: [{ action: 'sniff' }], final: 'direct' });
});

it.each(['final', 'detour', 'nested route'])('rejects unsupported ISP dependencies without ISP: %s', (kind) => {
  const template = loadSingboxTemplate();
  if (kind === 'final') template.route!.final = 'isp-socks';
  if (kind === 'detour') template.outbounds!.push({ type: 'direct', tag: 'custom', detour: 'isp-socks' });
  if (kind === 'nested route') template.route!.rules!.push({ type: 'logical', mode: 'or', rules: [{ domain: ['example.test'], outbound: 'isp-socks' }] });
  expect(() => renderSingbox(fixtureModel(), template)).toThrow(/ISP.*reference|isp-socks/);
});

it.each([false, true])('applies custom model ports after validating default prototypes, ISP=%s', (enabled) => {
  const template = loadSingboxTemplate(), before = structuredClone(template);
  const model = buildModel(parseEnv(fixtureText(enabled) + 'SS_PORT=18388\nVLESS_PORT=18443\n'));
  const result = renderSingbox(model, template);
  expect(result.inbounds.map((inbound) => [inbound.type, inbound.tag, inbound.listen_port])).toEqual([
    ['shadowsocks', 'ss-in', 18388], ['vless', 'vless-reality-in', 18443],
  ]);
  expect(result.inbounds.map((inbound) => ({ ...inbound, listen_port: 0 })))
    .toEqual(renderSingbox(fixtureModel(enabled), template).inbounds.map((inbound) => ({ ...inbound, listen_port: 0 })));
  expect(template).toEqual(before);
});

it.each([
  [0, 'tag', 'bad'], [1, 'tag', 'bad'],
  [0, 'type', 'vless'], [1, 'type', 'shadowsocks'],
  [0, 'listen_port', 18388], [1, 'listen_port', 18443],
])('rejects altered default prototype %s.%s even when using custom ports', (index, key, value) => {
  const template = loadSingboxTemplate();
  template.inbounds[index as number][key as string] = value;
  const model = buildModel(parseEnv(fixtureText() + 'SS_PORT=18388\nVLESS_PORT=18443\n'));
  expect(() => renderSingbox(model, template)).toThrow('Invalid inbound prototype tag or port.');
});

it('rejects unresolved placeholders and bad prototype tags or ports', () => {
  const t = loadSingboxTemplate() as { inbounds: Record<string, unknown>[]; other?: string };
  t.other = '${UNKNOWN}';
  expect(() => renderSingbox(fixtureModel(), t)).toThrow('Unresolved placeholder');
  delete t.other;
  t.inbounds[0].tag = 'bad';
  expect(() => renderSingbox(fixtureModel(), t)).toThrow('prototype');
  t.inbounds[0].tag = 'ss-in'; t.inbounds[0].listen_port = 1;
  expect(() => renderSingbox(fixtureModel(), t)).toThrow('prototype');
});
