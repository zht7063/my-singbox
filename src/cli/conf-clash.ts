import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile, parseEnv, writeFileAtomic } from '../core/env.js';
import { findTemplate } from '../core/templates.js';
import { renderClash } from '../core/render-clash.js';
import { buildModel } from '../model.js';
import { CliError } from './deps.js';
import type { IO } from './commands.js';

export async function confClash(io: IO): Promise<number> {
  const project = resolve(io.cwd ?? process.cwd());
  const envPath = resolve(project, '.env');
  if (!existsSync(envPath))
    throw new CliError('.env does not exist. Run scripts/gen-keys.sh first.');
  const template = findTemplate('clash.yaml.template', project);
  const path = resolve(project, 'clash.yaml');
  if (existsSync(path))
    throw new CliError('clash.yaml already exists. Refusing to overwrite.');
  const defaultsPath = resolve(project, 'templates/.env.template');
  const defaults = parseEnv(
    existsSync(defaultsPath) ? readFileSync(defaultsPath, 'utf8') : '',
    'templates/.env.template',
  );
  const env = loadEnvFile(envPath);
  const model = buildModel(
    {
      values: { ...defaults.values, ...env.values },
      keys: new Set([...defaults.keys, ...env.keys]),
    },
    { target: 'client' },
  );
  writeFileAtomic(path, renderClash(model, readFileSync(template, 'utf8')), {
    exclusive: true,
  });
  io.stdout(`Clash config generated successfully.\nSaved to: ${path}\n`);
  return 0;
}
