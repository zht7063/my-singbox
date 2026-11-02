import { runDoctor } from '../doctor/checks.js';
import type { System } from '../doctor/system.js';
import { genKeys } from './gen-keys.js';
import { genConfig } from './gen-config.js';
import { confClash } from './conf-clash.js';
import type { CliDeps } from './deps.js';
export type { CliDeps } from './deps.js';

export interface IO {
  stdout(text: string): void;
  stderr(text: string): void;
  system: System;
  cwd?: string;
  env?: Record<string, string | undefined>;
  readLine?(prompt: string): Promise<string | null>;
  deps?: Partial<CliDeps>;
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

  --add      add or update the ISP outbound (ports 13839 and 18444)
  --remove   remove the ISP outbound and everything this script added
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
    for (const arg of args) {
      if (['--help', '-h'].includes(arg)) {
        io.stdout(ispUsage);
        return 0;
      }
      if (!['--add', '--remove', '--yes', '-y'].includes(arg)) {
        io.stderr(`${ispUsage}Error: Unknown argument: ${arg}\n`);
        return 1;
      }
    }
  } else if (args.some((a) => ['--help', '-h'].includes(a))) {
    const help =
      cmd === 'doctor'
        ? '\nCheck server prerequisites without changing the system.'
        : ` [args]\nEquivalent shell script: scripts/${cmd}.sh`;
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
  io.stderr(
    `${cmd}: not implemented yet (planned for phase P2/P4; ` +
      `use the shell script scripts/${cmd}.sh from v1.1.0 meanwhile)\n`,
  );
  return 2;
}
