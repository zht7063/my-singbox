#!/usr/bin/env node
// Print only the deterministic inventory. Mapping columns are maintained in Markdown.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function batsCases(root) {
  return readdirSync(join(root, 'tests')).filter((file) => file.endsWith('.bats')).sort()
    .flatMap((file) => [...readFileSync(join(root, 'tests', file), 'utf8')
      .matchAll(/^\s*@test "([^"\n]*)"\s*\{/gm)]
      .map((match) => ({ file: `tests/${file}`, name: match[1] })));
}

export function markdownCell(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;').replaceAll('`', '&#96;');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  console.log('| Bats file | Exact bats name | TS test file | TS title / prefix | Status | Reason / parameters |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const { file, name } of batsCases(root))
    console.log(`| ${markdownCell(file)} | ${markdownCell(name)} | | | | |`);
}
