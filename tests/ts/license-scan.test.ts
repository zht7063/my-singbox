import { it, expect } from 'vitest';
import {
  evaluateLicenseExpression as evaluate,
  normalizeLicense,
  inferLicense,
} from '../../tools/license-lib.mjs';

it.each([
  'MIT',
  'ISC',
  'Apache-2.0',
  '(GPL-3.0 OR MIT) AND ISC',
  'MIT OR (GPL-3.0 AND ISC)',
  { type: 'MIT' },
  [{ type: 'MIT' }, { type: 'ISC' }],
])('allowed %j', (value) => {
  return expect(evaluate(value)).toBe(true);
});

it.each([
  'GPL-3.0',
  'MIT AND GPL-3.0',
  'UNLICENSED',
  undefined,
  'MPL-2.0',
  'MIT WITH invalid',
  '(MIT',
  'MIT OR',
  'CC-BY-NC-4.0',
])('rejected %j', (value) => {
  return expect(evaluate(value)).toBe(false);
});

it('missing license is unknown', () => {
  expect(normalizeLicense(undefined)).toBe('UNKNOWN');
  expect(inferLicense('nothing')).toBe('UNKNOWN');
});
