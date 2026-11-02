import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function findTemplate(name: string, projectDir?: string): string {
  if (projectDir) {
    const p = join(projectDir, 'templates', name);
    if (existsSync(p)) return p;
  }
  return findUp(join('templates', name), `Template does not exist: templates/${name}`);
}

export function findPackageFile(name: string): string {
  return findUp(name, `Package file does not exist: ${name}`);
}

function findUp(name: string, message: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(message);
}

export function readTemplate(name: string, projectDir?: string): string {
  return readFileSync(findTemplate(name, projectDir), 'utf8');
}
