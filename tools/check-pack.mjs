import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @param {string[]} paths */
export function checkPackFiles(paths) {
  return paths.filter((path) => {
    const name = posix.basename(path);
    return name === '.env' || name.startsWith('.env.') ||
      path.split('/').slice(0, -1).some((part) => part === 'tests' || part === 'test') ||
      /\.(test|spec)\./.test(name);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
  const paths = result[0].files.map((file) => file.path);
  console.log(paths.join('\n'));
  const offenders = checkPackFiles(paths);
  if (offenders.length) {
    console.error(`Forbidden package files:\n${offenders.join('\n')}`);
    process.exitCode = 1;
  }
  if (!paths.includes('dist/cli.js')) {
    console.error('Missing dist/cli.js; build before checking the package.');
    process.exitCode = 1;
  }
}
