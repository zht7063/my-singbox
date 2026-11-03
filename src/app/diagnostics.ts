import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { checkNode, checkPlatform, checkArch } from '../doctor/checks.js';
import { realSystem } from '../doctor/system.js';
import type { System } from '../doctor/system.js';
import { runCommand, safeText, type CommandRunner } from './system.js';

export interface Diagnostic {
  id: string;
  status: 'OK' | 'WARN' | 'FAIL' | 'SKIP';
  summary: string;
  detail: string;
  checkedAt: string;
  blocks: boolean;
  remediation?: string;
}
export interface DiagnosticOptions {
  projectDir: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  system?: System;
  run?: CommandRunner;
  osRelease?: string;
  isp?: boolean;
  onCheck?(check: Diagnostic): void;
}

export async function diagnose(options: DiagnosticOptions): Promise<Diagnostic[]> {
  const s = options.system ?? realSystem();
  const checks: Diagnostic[] = [];
  const add = (id: string, status: Diagnostic['status'], summary: string, detail: string, remediation?: string, blocks = status === 'FAIL') => {
    const check: Diagnostic = { id, status, summary, detail, remediation, blocks, checkedAt: new Date().toISOString() };
    checks.push(check); options.onCheck?.(check); return check;
  };
  for (const [id, check] of [['node', checkNode(s)], ['platform', checkPlatform(s)], ['arch', checkArch(s)]] as const)
    add(id, check.status, check.name, check.message);
  let release = options.osRelease;
  if (release === undefined) {
    try { release = readFileSync('/etc/os-release', 'utf8'); } catch { release = ''; }
  }
  const distro = /^ID=["']?([^\s"']+)/m.exec(release)?.[1] ?? 'unknown';
  add('distro', ['debian', 'ubuntu'].includes(distro) ? 'OK' : 'FAIL', '发行版', distro,
    '部署仅支持 Debian / Ubuntu VPS；其他系统可以查看诊断。');
  try {
    if (!statSync(options.projectDir).isDirectory()) throw new Error();
    accessSync(options.projectDir, constants.R_OK | constants.W_OK | constants.X_OK);
    add('directory', 'OK', '部署目录', '目录可读写。');
  } catch { add('directory', 'FAIL', '部署目录', '目录不存在或不可读写。', '请在现有的可写部署目录运行 my-singbox tui。'); }
  const run = options.run ?? runCommand;
  const exec = (file: string, args: string[]) => run(file, args, { cwd: options.projectDir, env: options.env, signal: options.signal, timeout: 10000, processGroup: true });
  const probe = async (file: string, args: string[]) => {
    options.signal?.throwIfAborted();
    try { return await exec(file, args); }
    catch (error) { options.signal?.throwIfAborted(); return { code: 1, stdout: '', stderr: safeText((error as Error).message) }; }
  };
  const docker = await probe('docker', ['--version']);
  add('docker', docker.code === 0 ? 'OK' : 'FAIL', 'Docker CLI', docker.code === 0 ? docker.stdout.trim() : 'Docker 未安装或不可执行。', '按 Docker 官方 Debian / Ubuntu 安装说明安装 Docker。');
  if (docker.code === 0) {
    const context = await probe('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
    const endpoint = options.env?.DOCKER_CONTEXT ? context.stdout.trim() : options.env?.DOCKER_HOST || context.stdout.trim();
    add('context', context.code === 0 && endpoint.startsWith('unix://') ? 'OK' : 'FAIL', 'Docker 目标',
      endpoint.startsWith('unix://') ? '本地 Unix socket。' : '远程或无法确认的 Docker context。',
      '本项目使用 host 网络和本地配置挂载；请使用本机 Docker Unix socket。');
    const compose = await probe('docker', ['compose', 'version']);
    add('compose', compose.code === 0 ? 'OK' : 'FAIL', 'Docker Compose v2', compose.code === 0 ? compose.stdout.trim() : '缺少 docker compose v2 插件。', '安装 Compose v2 插件；旧 docker-compose v1 不能用于此流程。');
    const daemon = await probe('docker', ['info', '--format', '{{.ServerVersion}}']);
    add('daemon', daemon.code === 0 ? 'OK' : 'FAIL', 'Docker daemon', daemon.code === 0 ? `可访问，版本 ${daemon.stdout.trim()}` : '无法访问 Docker daemon。', '检查 daemon 是否启动、当前 context 和用户权限；修改用户组后重新登录。');
  } else {
    for (const [id, summary] of [['context', 'Docker 目标'], ['compose', 'Docker Compose v2'], ['daemon', 'Docker daemon']])
      add(id, 'SKIP', summary, 'Docker CLI 不可用，未执行。', undefined, true);
  }
  const ss = await probe('ss', ['-V']);
  add('ss', ss.code === 0 ? 'OK' : 'WARN', 'ss / iproute2', ss.code === 0 ? '可以检查 TCP / UDP 监听。' : '缺少 ss，端口检查降级，服务 UDP 检查可能跳过。', '可自行安装：sudo apt-get install -y iproute2');
  if (options.isp) {
    const curl = await probe('curl', ['--version']);
    add('curl', curl.code === 0 ? 'OK' : 'FAIL', 'ISP 测试：curl', curl.code === 0 ? '可执行 SOCKS5 / HTTPS 出口检测。' : '未安装 curl，无法校验 ISP。', '可自行安装：sudo apt-get install -y curl');
  }
  return checks;
}
