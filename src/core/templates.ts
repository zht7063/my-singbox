import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function findTemplate(name: string, projectDir?: string): string {
  if (projectDir) {
    const p = join(projectDir, 'templates', name);
    if (existsSync(p)) return p;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const p = join(dir, 'templates', name);
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Template does not exist: templates/${name}`);
}

export function readTemplate(name: string, projectDir?: string): string {
  return readFileSync(findTemplate(name, projectDir), 'utf8');
}
