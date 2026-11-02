#!/usr/bin/env node
import { run } from './commands.js';
import { realSystem } from '../doctor/system.js';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';

let readline: ReturnType<typeof createInterface> | undefined;
let lines: AsyncIterableIterator<string> | undefined;
async function readLine(prompt: string): Promise<string | null> {
  if (process.stdin.isTTY) process.stderr.write(prompt);
  if (!readline) {
    readline = createInterface({ input: process.stdin, terminal: false });
    lines = readline[Symbol.asyncIterator]();
  }
  const line = await lines!.next();
  return line.done ? null : line.value;
}
try {
  process.exitCode = await run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    system: realSystem(),
    cwd: process.cwd(),
    env: process.env,
    readLine,
    readSecret: async (prompt) => {
      if (!process.stdin.isTTY) return readLine(prompt);
      const state = spawnSync('stty', ['-g'], {
        env: process.env, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8',
      });
      if (state.error) throw state.error;
      if (state.status !== 0) throw new Error('Could not read terminal settings.');
      const restore = () => {
        spawnSync('stty', [state.stdout.trim()], { env: process.env, stdio: 'inherit' });
      };
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
      for (const signal of signals) process.on(signal, restore);
      try {
        const hidden = spawnSync('stty', ['-echo'], { env: process.env, stdio: 'inherit' });
        if (hidden.error) throw hidden.error;
        if (hidden.status !== 0) throw new Error('Could not disable terminal echo.');
        return await readLine(prompt);
      } finally {
        restore();
        for (const signal of signals) process.removeListener(signal, restore);
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
} finally {
  readline?.close();
}
