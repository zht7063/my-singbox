export type Screen = 'home' | 'checks' | 'network' | 'isp' | 'review' | 'progress' | 'result' | 'info' | 'discard' | 'help';
export type Flow = 'setup' | 'isp-add' | 'isp-remove' | 'start';

export interface TuiOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AppProps {
  projectDir: string;
  env: NodeJS.ProcessEnv;
  finish(code: number): void;
  signal: AbortSignal;
}

export interface OperationResult {
  ok: boolean;
  message: string;
  lines: string[];
}
