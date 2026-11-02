import { it, expect } from 'vitest';
import { parse } from 'yaml';
import { renderClash } from '../../src/core/render-clash.js';
import { readTemplate } from '../../src/core/templates.js';
import { fixtureModel, creds } from './helpers/fixtures.js';
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
    expect(b['proxy-groups'][0].proxies).toEqual(
      withIsp
        ? [
            'shadowsocks',
            'vless-reality',
            'DIRECT',
            'shadowsocks-isp',
            'vless-reality-isp',
          ]
        : ['shadowsocks', 'vless-reality', 'DIRECT'],
    );
    expect(b.proxies.map((p: { port: number }) => p.port)).toEqual(
      withIsp ? [8388, 8443, 13839, 18444] : [8388, 8443],
    );
    expect(b.proxies[1]['reality-opts']['public-key']).toBe(
      creds.realityPublicKey,
    );
  },
);
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
