import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { whitelist } from '../../tools/check-pack.mjs';

it('pins compose and CI versions', () => {
  const compose = readFileSync('compose.yaml', 'utf8');
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  expect(compose.match(/image: (.+)/)?.[1]).toBe('ghcr.io/sagernet/sing-box:v1.14.4');
  expect(ci).toContain('SING_BOX_VERSION: v1.14.4');
  expect(ci).toContain('MIHOMO_VERSION: v1.19.33');
});

it('package metadata and whitelist', () => {
  const p = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(p.name).toBe('my-singbox');
  expect(p.engines.node).toBe('>=22');
  expect(p.bin).toEqual({ 'my-singbox': 'dist/cli.js' });
  expect(Object.keys(p.dependencies ?? {})).toHaveLength(0);
  expect(p.type).toBe('module');
  expect(p.files).toEqual(whitelist);
});
