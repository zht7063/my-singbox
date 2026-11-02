import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const whitelist = [
  'dist/',
  'templates/config.json.template',
  'templates/clash.yaml.template',
  'compose.yaml',
  'install.sh',
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
  'README.md',
  'README_CN.md',
];
export function checkPack(data) {
  const files = data[0]?.files;
  if (!Array.isArray(files) || !files.length) {
    throw new Error('Empty or invalid npm pack result');
  }
  for (const { path } of files) {
    if (
      path !== 'package.json' &&
      !whitelist.some((x) => (x.endsWith('/') ? path.startsWith(x) : path === x))
    ) {
      throw new Error(`Forbidden packed file: ${path}`);
    }
  }
  for (const required of [
    'dist/cli.js',
    'dist/index.js',
    'dist/index.d.ts',
    ...whitelist.filter((x) => !x.endsWith('/')),
  ]) {
    if (!files.some((x) => x.path === required)) {
      throw new Error(`Missing packed file: ${required}`);
    }
  }
  return files.length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
  });
  const count = checkPack(JSON.parse(output));
  console.log(`Pack whitelist OK: ${count} files`);
}
