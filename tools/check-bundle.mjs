import { builtinModules } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const builtins = new Set(builtinModules.flatMap((x) => [x, `node:${x}`]));
function checkBundleText(text) {
  const imports = [
    ...text.matchAll(
      /(?:\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?|\b(?:require|import)\s*\()\s*["']([^"']+)["']/g,
    ),
  ];
  return imports.map((m) => m[1]).filter((x) => !builtins.has(x));
}

export function checkBundles() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  if (Object.keys(pkg.dependencies ?? {}).length) {
    throw new Error('Runtime dependencies are forbidden');
  }
  if (existsSync('dist')) {
    for (const file of readdirSync('dist').filter((x) => x.endsWith('.js'))) {
      const invalid = checkBundleText(readFileSync(`dist/${file}`, 'utf8'));
      if (invalid.length) {
        throw new Error(`${file}: non-builtin imports: ${invalid.join(', ')}`);
      }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkBundles();
  console.log('Bundles contain only builtin imports; 0 runtime dependencies.');
}
