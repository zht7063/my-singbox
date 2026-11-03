import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// npm yoga-layout@3.2.1 omits LICENSE. Verbatim release license:
// https://raw.githubusercontent.com/facebook/yoga/v3.2.1/LICENSE
const fallbackLicenses = {
  'yoga-layout@3.2.1': 'tools/licenses/yoga-layout-3.2.1/LICENSE',
  // This npm release also omits its license text. Upstream LICENSE blob:
  // https://api.github.com/repos/AlCalzone/ansi-tokenize/git/blobs/f7947e693e81ef580880a5c83f934e8a0a9ff4f6
  '@alcalzone/ansi-tokenize@0.1.3': 'tools/licenses/ansi-tokenize-0.1.3/LICENSE',
};

/** Include the actual package copyright/license texts for all modules in shipped bundles. */
export function writeThirdPartyNotices(metafile) {
  const packages = new Map();
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, contribution] of Object.entries(output.inputs)) {
      if (!contribution.bytesInOutput || !input.includes('node_modules/')) continue;
      const normalized = input.replaceAll('\\', '/');
      const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/.exec(normalized);
      if (!match) continue;
      const directory = match[1];
      const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      const id = `${pkg.name}@${pkg.version}`;
      const licenseFiles = readdirSync(directory).filter((name) => /^(?:licen[sc]e|copying|notice)(?:[-_.]|$)/i.test(name)).map((name) => join(directory, name));
      if (!licenseFiles.length && fallbackLicenses[id]) licenseFiles.push(fallbackLicenses[id]);
      if (!licenseFiles.length) throw new Error(`Missing license text for bundled package ${pkg.name}`);
      packages.set(id, { pkg, licenseFiles });
    }
  }
  const parts = ['# Third-party notices', '', 'The CLI and library bundle the following packages. No external npm runtime dependencies are required.', ''];
  for (const [id, { pkg, licenseFiles }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(`## ${id}`, '', `License: ${pkg.license ?? 'see license text below'}`, '');
    for (const name of licenseFiles.sort()) {
      parts.push(`### ${name.split('/').at(-1)}`, '', '```text', readFileSync(name, 'utf8').trimEnd(), '```', '');
    }
  }
  writeFileSync(resolve('THIRD-PARTY-NOTICES.md'), parts.join('\n'));
}
