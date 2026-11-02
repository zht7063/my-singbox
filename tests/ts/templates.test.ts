import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findTemplate, readTemplate } from '../../src/core/templates.js';
it('finds repository templates by walking up and falls back from an absent override', () => {
  expect(findTemplate('config.json.template')).toMatch(
    /templates\/config.json.template$/,
  );
  expect(readTemplate('config.json.template', '/nonexistent')).toContain(
    '${SS_PASSWORD}',
  );
  expect(() => findTemplate('missing')).toThrow(
    'Template does not exist: templates/missing',
  );
});

it('prefers project templates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2-template-'));
  try {
    mkdirSync(join(dir, 'templates'));
    writeFileSync(join(dir, 'templates', 'custom'), 'custom');
    expect(readTemplate('custom', dir)).toBe('custom');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
