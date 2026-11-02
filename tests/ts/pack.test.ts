import { execFileSync } from 'node:child_process';
import { it, expect, beforeAll } from 'vitest';
import { checkPack } from '../../tools/check-pack.mjs';
import { checkBundleText, checkBundles } from '../../tools/check-bundle.mjs';

beforeAll(() => {
  execFileSync('node', ['tools/build.mjs']);
}, 30000);

it('actual npm pack respects whitelist', () => {
  expect(
    checkPack(
      JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' })),
    ),
  ).toBeGreaterThan(5);
  checkBundles();
});

it.each(['.env', 'tests/a', 'src/a', 'scripts/a', '.github/a'])('rejects %s', (path) => {
  return expect(() => checkPack([{ files: [{ path }] }])).toThrow();
});

it('detects nonbuiltin imports', () => {
  expect(checkBundleText('import x from "evil"; require("bad"); import("other")')).toEqual([
    'evil',
    'bad',
    'other',
  ]);
  expect(checkBundleText('import fs from "node:fs"; require("os")')).toEqual([]);
});

it('requires built entry points', () => {
  return expect(() => checkPack([{ files: [{ path: 'package.json' }] }])).toThrow(
    'Missing packed file',
  );
});
