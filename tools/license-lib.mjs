export const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  'CC-BY-4.0',
  'WTFPL',
  'Zlib',
]);
// MPL is not allowlisted. These exact dev-only CSS tool packages are used by
// Vitest/Vite, never imported by src or bundled/distributed (checkBundles enforces
// builtin-only output). No MPL source is modified or redistributed by this package.
// Re-review these exceptions when versions or the shipped artifact change.
export const EXCEPTIONS = {
  'lightningcss@1.33.0': 'MPL-2.0; dev-only Vite CSS tooling, excluded from shipped artifact.',
  'lightningcss-linux-x64-gnu@1.33.0':
    'MPL-2.0; dev-only platform binding, excluded from shipped artifact.',
};
export function normalizeLicense(value) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value) && value.length) {
    return value.map(normalizeLicense).join(' OR ');
  }
  if (value && typeof value === 'object') {
    return normalizeLicense(value.type);
  }
  return 'UNKNOWN';
}

export function evaluateLicenseExpression(value) {
  const expression = normalizeLicense(value);
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let index = 0;
  // Recursive descent gives AND precedence over OR; parentheses recurse into OR.
  function atom() {
    const token = tokens[index++];
    if (token === '(') {
      const result = or();
      if (tokens[index++] !== ')') {
        throw new Error('Unbalanced');
      }
      return result;
    }
    if (!token || ['AND', 'OR', ')'].includes(token)) {
      throw new Error('Invalid');
    }
    return ALLOWED.has(token);
  }
  function and() {
    let result = atom();
    while (tokens[index] === 'AND') {
      index++; // Consume every operand even if the accumulated result is already false.
      const next = atom();
      result = result && next;
    }
    return result;
  }
  function or() {
    let result = and();
    while (tokens[index] === 'OR') {
      index++; // Consume every alternative even if a previous alternative already passed.
      const next = and();
      result = result || next;
    }
    return result;
  }
  try {
    const allowed = or();
    return allowed && index === tokens.length;
  } catch {
    return false;
  }
}

export function inferLicense(text) {
  if (
    /Permission is hereby granted, free of charge/i.test(text) &&
    /THE SOFTWARE IS PROVIDED "AS IS"/i.test(text)
  ) {
    return 'MIT';
  }
  if (/ISC License/i.test(text)) {
    return 'ISC';
  }
  if (/Apache License[\s\S]*Version 2\.0/i.test(text)) {
    return 'Apache-2.0';
  }
  return 'UNKNOWN';
}
