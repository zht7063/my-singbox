import React from 'react';
import { render } from 'ink';
import { resolve } from 'node:path';
import { App } from './app.js';
import type { TuiOptions } from './types.js';

/** Called only after dispatch has validated an interactive terminal. */
export async function launchTui(options: TuiOptions = {}): Promise<number> {
  const projectDir = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const controller = new AbortController();
  const wasRaw = !!process.stdin.isRaw;
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((name, index) => {
    const handler = () => controller.abort([130, 143, 129][index]);
    process.on(name, handler);
    return { name, handler };
  });
  let instance: ReturnType<typeof render> | undefined;
  let complete!: (code: number) => void;
  const result = new Promise<number>((resolve) => { complete = resolve; });
  const finish = (code: number) => {
    instance?.unmount();
    complete(code);
  };
  process.stdout.write('\x1b[?1049h');
  try {
    instance = render(
      <App projectDir={projectDir} env={env} finish={finish} signal={controller.signal} />,
      { exitOnCtrlC: false, patchConsole: false },
    );
    void instance.waitUntilExit().then(() => complete(1), () => complete(1));
    return await result;
  } finally {
    instance?.unmount();
    for (const { name, handler } of handlers) process.removeListener(name, handler);
    if (process.stdin.isTTY && !!process.stdin.isRaw !== wasRaw) process.stdin.setRawMode(wasRaw);
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  }
}
