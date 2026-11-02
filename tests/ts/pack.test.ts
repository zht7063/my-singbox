// AC9
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { checkPackFiles } from '../../tools/check-pack.mjs';

it('identifies secrets and test files in a package', () => {
  const offenders = ['.env', 'config/.env.local', 'tests/x.bats', 'tests/ts/a.test.ts', 'dist/a.spec.js'];
  const fine = ['dist/cli.js', 'templates/config.json.template', 'compose.yaml', 'dist/index.d.ts'];
  expect(checkPackFiles([...offenders, ...fine])).toEqual(offenders);
});

it.skipIf(!existsSync('dist/cli.js'))('packs no secrets or tests', () => {
  const result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
  expect(checkPackFiles(result[0].files.map((file: { path: string }) => file.path))).toEqual([]);
});
