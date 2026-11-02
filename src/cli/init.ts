import { constants, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runDoctor } from '../doctor/checks.js';
import { composeImageTag, firewallPorts } from '../core/start.js';
import { findPackageFile } from '../core/templates.js';
import { genKeys } from './gen-keys.js';
import { genConfig } from './gen-config.js';
import { confClash } from './conf-clash.js';
import { start } from './start.js';
import type { IO } from './commands.js';

export async function init(io: IO): Promise<number> {
  if (await runDoctor(io.system, io.stdout)) return 1;
  try {
    await io.system.exec('ss', ['-V']);
  } catch {
    io.stdout('Note: ss (iproute2) not found; start will skip the UDP check. Install it as root: sudo apt-get install -y iproute2\n');
  }
  const project = resolve(io.cwd ?? process.cwd());
  const compose = resolve(project, 'compose.yaml');
  const source = existsSync(compose) ? compose : findPackageFile('compose.yaml');
  const env = io.env ?? process.env;
  const version = env.SING_BOX_VERSION || composeImageTag(readFileSync(source, 'utf8'));
  if (!existsSync(compose)) {
    copyFileSync(source, compose, constants.COPYFILE_EXCL);
    io.stdout('Wrote compose.yaml\n');
  }
  const generatedIO = { ...io, env: { ...env, SING_BOX_VERSION: version } };
  for (const [file, command] of [
    ['.env', genKeys], ['config.json', genConfig], ['clash.yaml', confClash],
  ] as const) {
    if (existsSync(resolve(project, file))) {
      io.stdout(`${file} already exists, keeping it.\n`);
      continue;
    }
    const code = await command(generatedIO);
    if (code) return code;
  }
  const code = await start(io);
  if (code) return code;
  const ports = firewallPorts(readFileSync(resolve(project, 'config.json'), 'utf8'));
  io.stdout(`Open these ports in the server firewall and the cloud security group (this tool never changes them):\n${ports.map((p) => `  ${p}\n`).join('')}`);
  io.stdout(`Import clash.yaml into your Mihomo client: ${resolve(project, 'clash.yaml')}\n`);
  return 0;
}
