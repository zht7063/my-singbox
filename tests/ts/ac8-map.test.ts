import { expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { batsCases } from '../../tools/ac8-map.mjs';

const root = resolve(import.meta.dirname, '../..');
const cases = batsCases(root);
const statuses = ['covered', 'deviation', 'n/a', 'pending-P4'];
const decodeCell = (text: string) => text.trim()
  .replaceAll('&#96;', '`').replaceAll('&#124;', '|')
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const rows = readFileSync(resolve(root, 'docs/ts/ac8-bats-map.md'), 'utf8')
  .split('\n').filter((line) => line.startsWith('|')).slice(2)
  .map((line) => line.split('|').slice(1, -1).map(decodeCell));
const key = (file: string, name: string) => `${file}\0${name}`;

// Grep declared title text, not mapping comments or occurrences in test bodies.
// Keep template placeholders / it.each format specifiers as written in the source.
function testTitles(file: string): string[] {
  if (!existsSync(file)) return [];
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const declaration = /^\s*it(?:\.each\([\s\S]*?\))?\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gm;
  return [...source.matchAll(declaration)].map((match) =>
    match[1].slice(1, -1).replace(/\\(['"`\\])/g, '$1'));
}
const titlesByFile = new Map<string, string[]>();

it('AC8 inventories all nine bats files and exactly 163 distinct mapping rows', () => {
  expect(new Set(cases.map((test) => test.file)).size).toBe(9);
  expect(cases).toHaveLength(163);
  expect(rows).toHaveLength(163);
  expect(rows.every((row) => row.length === 6)).toBe(true);
  expect(new Set(rows.map(([file, name]) => key(file, name))).size).toBe(163);
  expect(rows.map(([file, name]) => key(file, name)).sort())
    .toEqual(cases.map(({ file, name }) => key(file, name)).sort());
});

for (const { file, name } of cases) {
  it(`AC8 map: ${file} — ${name}`, () => {
    const matches = rows.filter((row) => row[0] === file && row[1] === name);
    expect(matches, 'each bats case must appear exactly once').toHaveLength(1);
    const [, , tsFile, title, status, reason] = matches[0];
    expect(statuses).toContain(status);
    if (status !== 'covered') expect(reason, 'non-covered rows need a reason / owner').not.toBe('');
    if (status === 'pending-P4') {
      expect(['tests/init.bats', 'tests/start.bats']).toContain(file);
      expect(tsFile).toMatch(/^tests\/ts\/(init|start)\.test\.ts$/);
      expect(reason).toContain('ts-p4-start');
    }
    if (status !== 'covered' && status !== 'deviation') return;
    expect(tsFile).toMatch(/^tests\/ts\/(?:[\w-]+\/)*[\w-]+\.test\.ts$/);
    expect(title, 'covered and deviation rows need a title citation').not.toBe('');
    const path = resolve(root, tsFile);
    expect(existsSync(path), `missing TS file: ${tsFile}`).toBe(true);
    if (!titlesByFile.has(path)) titlesByFile.set(path, testTitles(path));
    const titles = titlesByFile.get(path)!;
    if (title.startsWith('AC8[')) {
      const prefix = `AC8[${name}]`;
      expect(title.startsWith(prefix), 'AC8 title must contain the exact bats name').toBe(true);
      expect(titles.some((candidate) => candidate.startsWith(title)), `missing title prefix: ${title} in ${tsFile}`).toBe(true);
    } else {
      expect(titles, `missing declared it/it.each title in ${tsFile}`).toContain(title);
    }
  });
}
