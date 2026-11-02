import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile, writeFileAtomic } from '../core/env.js';
import { findTemplate } from '../core/templates.js';
import { renderSingbox, serializeSingbox } from '../core/render-config.js';
import { buildModel } from '../model.js';
import { CliError } from './deps.js';
import type { IO } from './commands.js';

export async function genConfig(io: IO): Promise<number> {
  const project = resolve(io.cwd ?? process.cwd());
  const envPath = resolve(project, '.env');
  if (!existsSync(envPath))
    throw new CliError('.env does not exist. Run scripts/gen-keys.sh first.');
  const template = findTemplate('config.json.template', project);
  const path = resolve(project, 'config.json');
  if (existsSync(path))
    throw new CliError('config.json already exists. Refusing to overwrite.');
  // Plan v3 §7.1 includes ISP settings; v1.1.0 gen-config ignored them.
  const model = buildModel(loadEnvFile(envPath), { target: 'server' });
  const config = renderSingbox(model, JSON.parse(readFileSync(template, 'utf8')));
  writeFileAtomic(path, serializeSingbox(config), { exclusive: true });
  io.stdout(`Config generated successfully.\nSaved to: ${path}\n`);
  return 0;
}
