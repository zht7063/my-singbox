import { it, expect } from 'vitest';
import {
  loadSingboxTemplate,
  renderSingbox,
  serializeSingbox,
} from '../../src/core/render-config.js';
import { readTemplate } from '../../src/core/templates.js';
import { fixtureModel, creds } from './helpers/fixtures.js';
it('renders ISP-off shell output and leaves template unchanged', () => {
  const template = loadSingboxTemplate();
  const before = structuredClone(template);
  const result = renderSingbox(fixtureModel(), template);
  const expected = readTemplate('config.json.template')
    .replaceAll('${SS_PASSWORD}', creds.ssPassword)
    .replaceAll('${VLESS_UUID}', creds.vlessUuid)
    .replaceAll('${REALITY_PRIVATE_KEY}', creds.realityPrivateKey)
    .replaceAll('${REALITY_SHORT_ID}', creds.realityShortId);
  expect(result).toEqual(JSON.parse(expected));
  expect(template).toEqual(before);
  expect(serializeSingbox(result)).toBe(JSON.stringify(result, null, 2) + '\n');
});

it('appends ISP nodes, outbound, and rule in shell order', () => {
  const t = loadSingboxTemplate() as Record<string, unknown>;
  t.route = { rules: [{ action: 'sniff' }] };
  const out = renderSingbox(fixtureModel(true), t);
  expect(out.inbounds.map((i) => i.tag)).toEqual([
    'ss-in',
    'vless-reality-in',
    'ss-isp-in',
    'vless-reality-isp-in',
  ]);
  expect(out.inbounds[2]).toEqual({
    ...out.inbounds[0],
    tag: 'ss-isp-in',
    listen_port: 13839,
  });
  expect(Object.keys(out.outbounds!.at(-1)!)).toEqual([
    'type',
    'tag',
    'server',
    'server_port',
    'version',
    'username',
    'password',
  ]);
  expect(out.outbounds!.at(-1)?.version).toBe('5');
  expect(out.route?.rules).toEqual([
    { action: 'sniff' },
    { inbound: ['ss-isp-in', 'vless-reality-isp-in'], outbound: 'isp-socks' },
  ]);
});

it('rejects unresolved placeholders, bad prototypes and missing credential placement', () => {
  const t = loadSingboxTemplate() as {
    inbounds: Record<string, unknown>[];
    other?: string;
  };
  t.other = '${UNKNOWN}';
  expect(() => renderSingbox(fixtureModel(), t)).toThrow(
    'Unresolved placeholder',
  );
  delete t.other;
  t.inbounds[0].tag = 'bad';
  expect(() => renderSingbox(fixtureModel(), t)).toThrow('prototype');
  t.inbounds[0].tag = 'ss-in';
  t.inbounds[0].password = 'removed';
  expect(() => renderSingbox(fixtureModel(), t)).toThrow('Failed to place');
});
