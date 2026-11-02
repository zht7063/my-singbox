import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateKeys } from '../core/keys.js';
import { renderGeneratedEnv, writeFileAtomic } from '../core/env.js';
import { isPublicIp } from '../core/validate.js';
import { CliError, realCliDeps } from './deps.js';
import type { IO } from './commands.js';

export async function genKeys(io: IO): Promise<number> {
  const version = (io.env ?? process.env).SING_BOX_VERSION;
  if (!version) throw new CliError('Please set SING_BOX_VERSION');
  const path = resolve(io.cwd ?? process.cwd(), '.env');
  if (existsSync(path))
    throw new CliError('.env already exists. Refusing to overwrite.');
  const deps = { ...realCliDeps(version), ...io.deps };
  if (!(await deps.dockerAvailable()))
    throw new CliError('docker is not installed.');
  if (!(await deps.dockerDaemonUp()))
    throw new CliError('Docker daemon is not running.');
  io.stdout('Detecting public IP address...\n');
  let serverAddress = await deps.detectPublicIp();
  if (serverAddress) io.stdout(`Detected public IP address: ${serverAddress}\n`);
  else {
    io.stderr('Could not detect a public IP address.\n');
    for (;;) {
      const line = await io.readLine?.('Public IP address of this machine: ');
      if (line == null)
        throw new CliError('Failed to read the public IP address.');
      serverAddress = line.trim();
      if (isPublicIp(serverAddress)) break;
      io.stderr('Error: Enter a public IP address.\n');
    }
  }
  io.stdout('Generating credentials...\n');
  const keys = await generateKeys(deps);
  writeFileAtomic(
    path,
    renderGeneratedEnv({ ...keys, singBoxVersion: version, serverAddress }),
    { exclusive: true },
  );
  io.stdout(`Credentials generated successfully.\nSaved to: ${path}\n`);
  return 0;
}
