import { resolve } from 'node:path';
import { dockerAvailable, dockerDaemonUp } from '../core/keys.js';
import { realStartDeps, startNode } from '../core/start.js';
import type { IO } from './commands.js';

export async function start(io: IO): Promise<number> {
  await startNode({
    project: resolve(io.cwd ?? process.cwd()),
    deps: { ...realStartDeps(), ...io.start },
    dockerAvailable: io.deps?.dockerAvailable ?? dockerAvailable,
    dockerDaemonUp: io.deps?.dockerDaemonUp ?? dockerDaemonUp,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  return 0;
}
