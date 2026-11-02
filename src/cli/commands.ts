import { runDoctor } from '../doctor/checks.js';
import type { System } from '../doctor/system.js';
import { genKeys } from './gen-keys.js';
import { genConfig } from './gen-config.js';
import { confClash } from './conf-clash.js';
import { ispOutbound } from './isp-outbound.js';
import { init } from './init.js';
import { start } from './start.js';
import type { StartDeps } from '../core/start.js';
import type { CliDeps } from './deps.js';
export type { CliDeps } from './deps.js';

export interface IO {
  stdout(text: string): void;
  stderr(text: string): void;
  system: System;
  cwd?: string;
  env?: Record<string, string | undefined>;
  readLine?(prompt: string): Promise<string | null>;
  readSecret?(prompt: string): Promise<string | null>;
  sleep?(ms: number): Promise<void>;
  deps?: Partial<CliDeps>;
  start?: Partial<StartDeps>;
}
const commands = [
  'init',
  'gen-keys',
  'gen-config',
  'conf-clash',
  'start',
  'isp-outbound',
  'doctor',
];
const usage = `Usage: my-singbox <cmd>

Commands: ${commands.join(', ')}
Options: --help, -h
`;
const ispUsage = `Usage: my-singbox isp-outbound [--add | --remove] [--yes]

  --add      add or update the server ISP outbound and route policy
  --remove   remove the ISP outbound and its targeted server rules
  --yes, -y  do not ask before restarting sing-box
  --help     show this help

Without --add or --remove, a menu is shown.
`;

export async function run(argv: string[], io: IO): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    io.stderr(`Error: ${(error as Error).message}\n`);
    return 1;
  }
}

async function dispatch(argv: string[], io: IO): Promise<number> {
  const [cmd, ...args] = argv;
  if (!cmd || ['--help', '-h'].includes(cmd)) {
    io.stdout(usage);
    return 0;
  }
  if (!commands.includes(cmd)) {
    io.stderr(usage);
    return 1;
  }
  if (cmd === 'isp-outbound') {
    let action: 'add' | 'remove' | undefined;
    let yes = false;
    for (const arg of args) {
      if (['--help', '-h'].includes(arg)) {
        io.stdout(ispUsage);
        return 0;
      }
      if (!['--add', '--remove', '--yes', '-y'].includes(arg)) {
        io.stderr(`${ispUsage}Error: Unknown argument: ${arg}\n`);
        return 1;
      }
      if (arg === '--add') action = 'add';
      if (arg === '--remove') action = 'remove';
      if (arg === '--yes' || arg === '-y') yes = true;
    }
    return ispOutbound(io, { action, yes });
  } else if (args.some((a) => ['--help', '-h'].includes(a))) {
    const help =
      cmd === 'doctor'
        ? '\nCheck server prerequisites without changing the system.'
        : ' [args]';
    io.stdout(`Usage: my-singbox ${cmd}${help}\n`);
    return 0;
  }
  if (cmd === 'doctor') {
    if (args.length) {
      io.stderr(`Error: Unknown argument: ${args[0]}\n`);
      return 1;
    }
    return runDoctor(io.system, io.stdout);
  }
  if (cmd === 'gen-keys') return genKeys(io);
  if (cmd === 'gen-config') return genConfig(io);
  if (cmd === 'conf-clash') return confClash(io);
  if (cmd === 'init') return init(io);
  return start(io);
}
