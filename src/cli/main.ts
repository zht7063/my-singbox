import { run } from './commands.js';
import { realSystem } from '../doctor/system.js';
import { createInterface } from 'node:readline';
import { realCliDeps } from './deps.js';

let readline: ReturnType<typeof createInterface> | undefined;
let lines: AsyncIterableIterator<string> | undefined;
try {
  process.exitCode = await run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    system: realSystem(),
    cwd: process.cwd(),
    env: process.env,
    deps: realCliDeps(process.env.SING_BOX_VERSION ?? ''),
    readLine: async (prompt) => {
      if (process.stdin.isTTY) process.stderr.write(prompt);
      if (!readline) {
        readline = createInterface({ input: process.stdin, terminal: false });
        lines = readline[Symbol.asyncIterator]();
      }
      const line = await lines!.next();
      return line.done ? null : line.value;
    },
  });
} finally {
  readline?.close();
}
