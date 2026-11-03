import { createIspRedactor } from '../core/isp-service.js';
export { runCommand, type CommandOptions, type CommandResult, type CommandRunner } from '../core/isp-service.js';
import type { CommandRunner } from '../core/isp-service.js';

/** Strip terminal escapes and control characters after redacting the full message. */
export function safeText(text: string, secrets: readonly string[] = []): string {
  return createIspRedactor(secrets)(text).replace(/[\x80-\x9f]/g, '');
}

export interface OperationEvent {
  stage: string;
  status: 'running' | 'done' | 'skipped' | 'failed';
  message: string;
}
export interface ApplicationIO {
  projectDir: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  run?: CommandRunner;
  onEvent?(event: OperationEvent): void;
  onLog?(text: string): void;
}
