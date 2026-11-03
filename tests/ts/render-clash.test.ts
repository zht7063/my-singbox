import { it, expect } from 'vitest';
import { parse } from 'yaml';
import { renderClash } from '../../src/core/render-clash.js';
import { readTemplate } from '../../src/core/templates.js';
import { fixtureModel, fixtureText, creds } from './helpers/fixtures.js';
import { parseEnv } from '../../src/core/env.js';
import { buildModel } from '../../src/model.js';
import { loadSingboxTemplate, renderSingbox } from '../../src/core/render-config.js';
it.each([false, true])(
  'preserves comments and unchanged sections (ISP=%s)',
  (withIsp) => {
    const template = readTemplate('clash.yaml.template'),
      out = renderClash(fixtureModel(withIsp), template);
    for (const line of template.split('\n').filter((l) => /^\s*#/.test(l)))
      expect(out.split('\n')).toContain(line);
    const a = parse(template),
      b = parse(out);
    for (const key of ['rules', 'rule-providers', 'dns'])
      expect(b[key]).toEqual(a[key]);
    expect(out).not.toContain(creds.realityPrivateKey);
    expect(out).not.toContain('${');
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
    expect(b['proxy-groups'][0].proxies).toEqual(['shadowsocks', 'vless-reality', 'DIRECT']);
    expect(b.proxies.map((p: { port: number }) => p.port)).toEqual([8388, 8443]);
    expect(out).not.toContain('isp-socks');
    expect(out).toBe(renderClash(fixtureModel(), template));
    expect(b.proxies[1]['reality-opts']['public-key']).toBe(
      creds.realityPublicKey,
    );
  },
);
it.each([false, true])('keeps custom client ports aligned with server inbounds, ISP=%s', (enabled) => {
  const model = buildModel(parseEnv(fixtureText(enabled) + 'SS_PORT=18388\nVLESS_PORT=18443\n'));
  const template = readTemplate('clash.yaml.template');
  const clash = parse(renderClash(model, template));
  const server = renderSingbox(model, loadSingboxTemplate());
  expect(clash.proxies.map((proxy: { port: number }) => proxy.port)).toEqual([18388, 18443]);
  expect(clash.proxies.map((proxy: { port: number }) => proxy.port)).toEqual(server.inbounds.map((inbound) => inbound.listen_port));
  expect(clash['proxy-groups'][0].proxies).toEqual(['shadowsocks', 'vless-reality', 'DIRECT']);
  for (const key of ['rules', 'rule-providers', 'dns']) expect(clash[key]).toEqual(parse(template)[key]);
});

it('keeps quoted scalar style', () => {
  expect(
    renderClash(fixtureModel(), readTemplate('clash.yaml.template')),
  ).toContain(`server: "${creds.serverAddress}"`);
});

it('rejects malformed YAML, unresolved placeholders, credential leaks safely', () => {
  const t = readTemplate('clash.yaml.template');
  expect(() => renderClash(fixtureModel(), 'a: [')).toThrow(
    'Invalid Clash template.',
  );
  expect(() =>
    renderClash(fixtureModel(), t + '\nextra: ${UNKNOWN}\n'),
  ).toThrow('Unresolved placeholder');
  expect(() =>
    renderClash(fixtureModel(), t + '\n# ' + creds.realityPrivateKey),
  ).toThrow('Refusing to write');
});
