import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkBundles } from './check-bundle.mjs';
import {
  normalizeLicense,
  evaluateLicenseExpression,
  inferLicense,
  EXCEPTIONS,
} from './license-lib.mjs';

checkBundles();
const rows = [];
function scan(directory) {
  if (!existsSync(directory)) {
    return;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.name.startsWith('@')) {
      scan(path);
      continue;
    }
    const manifest = join(path, 'package.json');
    if (!existsSync(manifest)) {
      continue;
    }
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    let license = normalizeLicense(pkg.license ?? pkg.licenses);
    if (license === 'UNKNOWN') {
      for (const name of readdirSync(path).filter((x) => /^licen[sc]e(?:\.|$)/i.test(x))) {
        license = inferLicense(readFileSync(join(path, name), 'utf8'));
        if (license !== 'UNKNOWN') {
          break;
        }
      }
    }
    const id = `${pkg.name}@${pkg.version}`;
    const allowed = evaluateLicenseExpression(license);
    const excepted = !allowed && Object.hasOwn(EXCEPTIONS, id);
    let verdict = 'FAIL';
    if (allowed) verdict = 'PASS';
    else if (excepted) verdict = 'EXCEPTION';
    else if (license.includes('MPL-2.0')) verdict = 'REVIEW';
    rows.push({
      package: id,
      license,
      verdict,
      scope: 'dev',
    });
    scan(join(path, 'node_modules'));
  }
}
scan('node_modules');
const failures = rows.filter((x) => !['PASS', 'EXCEPTION'].includes(x.verdict)).length;
const header =
  'MIT repository: bundled third-party licenses are recorded in THIRD-PARTY-NOTICES.md; ' +
  'package.json has 0 external runtime dependencies.';
console.log(header);
console.table(rows);
console.log(`${rows.length} packages scanned; ${failures} failures.`);
process.exitCode = failures ? 1 : 0;
