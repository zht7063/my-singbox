import {
  defaultKeyDeps,
  dockerAvailable,
  dockerDaemonUp,
  detectPublicIp,
  type KeyDeps,
} from '../core/keys.js';

export interface CliDeps extends KeyDeps {
  dockerAvailable(): Promise<boolean>;
  dockerDaemonUp(): Promise<boolean>;
  detectPublicIp(): Promise<string | null>;
}

export function realCliDeps(version: string): CliDeps {
  return {
    ...defaultKeyDeps(`ghcr.io/sagernet/sing-box:${version}`),
    dockerAvailable,
    dockerDaemonUp,
    detectPublicIp,
  };
}

export class CliError extends Error {
  override name = 'CliError';
}
