// AC3: init without SING_BOX_VERSION must use the compose tag, so main.ts must not inject image-bound deps.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('main.ts does not bind key deps to SING_BOX_VERSION at startup', () => {
  const main = readFileSync('src/cli/main.ts', 'utf8');
  expect(main).not.toContain('realCliDeps');
  expect(main).not.toMatch(/deps:/);
});
