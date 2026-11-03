import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { buildModel, type IspSocks } from '../model.js';
import { loadEnvFile, parseEnv, renderGeneratedEnv, envWithIsp, writeFileAtomic } from '../core/env.js';
import { parsePorts } from '../core/ports.js';
import { generateKeys } from '../core/keys.js';
import { composeImageTag, firewallPorts, secretValues, startNode } from '../core/start.js';
import { findPackageFile, findTemplate } from '../core/templates.js';
import { renderSingbox, serializeSingbox } from '../core/render-config.js';
import { renderClash } from '../core/render-clash.js';
import { withLock } from '../core/isp.js';
import { ispConfigSecrets } from '../core/isp-service.js';
import { diagnose } from './diagnostics.js';
import { deploymentListeners, probePorts } from '../adapters/port-probe.js';
import { runCommand, safeText, type ApplicationIO, type OperationEvent } from './system.js';
import { readIspState, testIsp } from './isp.js';
import { isValidServerAddress } from '../core/validate.js';

const files = ['compose.yaml', '.env', 'config.json', 'clash.yaml'] as const;
const recordName = '.tui-operation.json';
export interface DeploymentDraft { serverAddress: string; ports: { ss: number; vless: number }; isp?: IspSocks }
export interface DeploymentState {
  kind: 'empty' | 'ready' | 'incomplete' | 'inconsistent';
  files: { name: string; exists: boolean }[];
  listeners: string[];
  serverAddress?: string;
  isp: boolean;
  problems: string[];
  operation?: { state: string; stage: string; updatedAt: string };
  ispOperation?: { status: string; phase: string };
  operationIssue?: string;
}

export function readDeployment(projectDir: string): DeploymentState {
  const status = files.map((name) => ({ name, exists: existsSync(join(projectDir, name)) }));
  const state: DeploymentState = { kind: status.every((f) => !f.exists) ? 'empty' : status.every((f) => f.exists) ? 'ready' : 'incomplete', files: status, listeners: [], isp: false, problems: [] };
  if (state.kind === 'incomplete') state.problems.push(`缺少：${status.filter((f) => !f.exists).map((f) => f.name).join('、')}`);
  try {
    const operation = JSON.parse(readFileSync(join(projectDir, recordName), 'utf8'));
    if (operation.owner === 'my-singbox-tui' && typeof operation.state === 'string') state.operation = operation;
    else state.problems.push('操作记录格式未知，请手动核对。');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') state.problems.push('无法读取之前的操作记录。'); }
  if (existsSync(join(projectDir, '.tui-isp-operation.json'))) {
    try { const isp = readIspState(projectDir); state.ispOperation = isp.operation; state.operationIssue = isp.operationIssue; }
    catch { state.operationIssue = '无法读取上次 ISP 操作记录，请手动核对。'; }
  }
  if (state.kind === 'empty') return state;
  try {
    const env = existsSync(join(projectDir, '.env')) ? loadEnvFile(join(projectDir, '.env')) : undefined;
    state.serverAddress = env?.values.SERVER_ADDRESS;
    if (existsSync(join(projectDir, 'config.json'))) {
      const config = JSON.parse(readFileSync(join(projectDir, 'config.json'), 'utf8'));
      state.listeners = firewallPorts(JSON.stringify(config));
      state.isp = !!config.outbounds?.some((outbound: { tag?: string }) => outbound.tag === 'isp-socks');
      const ss = config.inbounds.find((inbound: { tag?: string }) => inbound.tag === 'ss-in');
      const vless = config.inbounds.find((inbound: { tag?: string }) => inbound.tag === 'vless-reality-in');
      if (!ss || !vless || config.inbounds.length !== 2) state.problems.push('存在旧版或自定义入站，请先手动核对；TUI 不静默迁移。');
      if (existsSync(join(projectDir, 'clash.yaml'))) {
        const client = parseYaml(readFileSync(join(projectDir, 'clash.yaml'), 'utf8'));
        for (const [name, inbound] of [['shadowsocks', ss], ['vless-reality', vless]] as const) {
          const node = client?.proxies?.find((proxy: { name?: string }) => proxy.name === name);
          if (!node || node.port !== inbound?.listen_port) state.problems.push(`${name} 的服务端与客户端端口不一致。`);
        }
      }
    }
  } catch { state.problems.push('部署文件解析失败，请检查 .env、config.json 和 clash.yaml。'); }
  if (state.problems.length && state.kind === 'ready') state.kind = 'inconsistent';
  return state;
}

export function deploymentRevision(projectDir: string): string {
  const paths = [...files.map((name) => join(projectDir, name)), findPackageFile('compose.yaml'), findTemplate('config.json.template', projectDir), findTemplate('clash.yaml.template', projectDir)];
  const hash = createHash('sha256');
  for (const path of paths) { hash.update(path); hash.update(existsSync(path) ? readFileSync(path) : '<absent>'); }
  return hash.digest('hex');
}

export interface DeploymentPlan {
  id: string;
  kind: 'initial-deploy';
  baseRevision: string;
  files: readonly string[];
  serverAddress: string;
  listeners: string[];
  isp: boolean;
  version: string;
  allowUnknownPorts: boolean;
}
const drafts = new WeakMap<DeploymentPlan, { projectDir: string; draft: DeploymentDraft }>();

export function planDeployment(projectDir: string, input: DeploymentDraft, allowUnknownPorts = false): DeploymentPlan {
  const project = resolve(projectDir);
  const draft = structuredClone(input);
  draft.serverAddress = draft.serverAddress.trim();
  if (!isValidServerAddress(draft.serverAddress)) throw new Error('请输入合法的服务器 IPv4、IPv6 或域名，不要包含协议或端口。');
  draft.ports = parsePorts(draft.ports);
  if (readDeployment(project).kind !== 'empty') throw new Error('已有部署文件；首次部署不会覆盖它们。请先查看诊断。');
  const version = composeImageTag(readFileSync(findPackageFile('compose.yaml'), 'utf8'));
  const plan: DeploymentPlan = { id: randomUUID(), kind: 'initial-deploy', baseRevision: deploymentRevision(project), files: Object.freeze([...files]), serverAddress: draft.serverAddress, listeners: deploymentListeners(draft.ports).map((listener) => `${listener.port}/${listener.protocol}`), isp: !!draft.isp, version, allowUnknownPorts };
  drafts.set(plan, { projectDir: project, draft });
  return Object.freeze(plan);
}

export interface DeploymentResult { ok: boolean; cancelled: boolean; message: string; created: string[]; warnings: string[] }

function saveOperation(projectDir: string, value: { id: string; state: string; stage: string; created: string[] }): void {
  const path = join(projectDir, recordName);
  if (existsSync(path)) {
    const previous = JSON.parse(readFileSync(path, 'utf8'));
    if (previous.owner !== 'my-singbox-tui') throw new Error('已有未知操作记录，拒绝覆盖。');
  }
  writeFileAtomic(path, JSON.stringify({ owner: 'my-singbox-tui', ...value, updatedAt: new Date().toISOString() }, null, 2) + '\n');
}

export async function applyDeployment(io: ApplicationIO, plan: DeploymentPlan): Promise<DeploymentResult> {
  const context = drafts.get(plan);
  if (!context || context.projectDir !== resolve(io.projectDir)) throw new Error('部署计划已失效，请重新预览。');
  const { draft } = context;
  const secrets: string[] = draft.isp ? [draft.isp.user, draft.isp.pass] : [];
  const created: string[] = [], warnings: string[] = [];
  let stage = 'preflight', staging: string | undefined, recorded = false;
  const event = (status: OperationEvent['status'], message: string) => io.onEvent?.({ stage, status, message });
  const run = io.run ?? runCommand;
  const exec = async (file: string, args: string[]) => {
    const result = await run(file, args, { cwd: io.projectDir, env: io.env, signal: io.signal });
    const text = safeText(result.stdout + result.stderr, secrets);
    if (text.trim()) io.onLog?.(text);
    return { ...result, stdout: safeText(result.stdout, secrets), stderr: safeText(result.stderr, secrets) };
  };
  const record = (state = 'running') => { saveOperation(io.projectDir, { id: plan.id, state, stage, created }); recorded = true; };
  try {
    return await withLock(io.projectDir, async () => {
      try {
        io.signal?.throwIfAborted();
        if (deploymentRevision(io.projectDir) !== plan.baseRevision) throw new Error('文件或模板已发生变化，请重新预览。');
        event('running', '重新检查运行条件与端口');
        const checks = await diagnose({ ...io, isp: !!draft.isp });
        if (checks.some((check) => check.blocks)) throw new Error('运行条件不满足，请返回运行条件页面处理。');
        const ports = await probePorts(deploymentListeners(draft.ports), io);
        if (ports.some((port) => port.state === 'occupied')) throw new Error('监听端口已被占用，请返回修改端口。');
        if (!plan.allowUnknownPorts && ports.some((port) => port.state === 'unknown')) throw new Error('部分端口检查未知，需在预览中明确确认后继续。');
        event('done', '运行条件与端口检查完成');
        record();
        if (draft.isp) {
          stage = 'isp-test'; record(); event('running', '校验代理与期望出口 IP');
          const tested = await testIsp({ projectDir: io.projectDir, env: io.env, signal: io.signal, stdout: (text: string) => io.onLog?.(safeText(text, secrets)), stderr: (text: string) => io.onLog?.(safeText(text, secrets)) }, draft.isp);
          if (!tested.ok) throw new Error(tested.error ?? 'ISP 出口校验失败。');
          event('done', 'ISP 出口校验通过；应用域名路由仍需单独验证');
        }
        staging = mkdtempSync(join(io.projectDir, '.tui-stage-'));
        stage = 'keys'; record(); event('running', '生成凭据；必要时拉取固定镜像');
        const credentials = await generateKeys({
          runSingbox: async (args) => {
            // Key generation output itself contains secrets: never forward it.
            const result = await run('docker', ['run', '--rm', `ghcr.io/sagernet/sing-box:${plan.version}`, ...args], { cwd: io.projectDir, env: io.env, signal: io.signal });
            if (result.code) throw new Error('Docker 凭据生成失败。');
            return result.stdout;
          },
          randomUuid: randomUUID,
          randomShortId: () => createHash('sha256').update(randomUUID()).digest('hex').slice(0, 16),
        });
        secrets.push(credentials.vlessUuid, credentials.realityPrivateKey, credentials.realityPublicKey, credentials.ssPassword, credentials.realityShortId);
        event('done', '凭据已生成，尚未发布到部署文件');
        let envText = renderGeneratedEnv({ ...credentials, singBoxVersion: plan.version, serverAddress: draft.serverAddress, ports: draft.ports });
        if (draft.isp) envText = envWithIsp(envText, { ...draft.isp, egressIp: draft.isp.egressIp ?? '' });
        const model = buildModel(parseEnv(envText));
        const config = serializeSingbox(renderSingbox(model, JSON.parse(readFileSync(findTemplate('config.json.template', io.projectDir), 'utf8'))));
        const clash = renderClash(model, readFileSync(findTemplate('clash.yaml.template', io.projectDir), 'utf8'));
        const candidate = join(staging, 'config.json');
        writeFileAtomic(candidate, config, { exclusive: true });
        stage = 'validate'; record(); event('running', '校验候选 sing-box 配置');
        if ((await exec('docker', ['run', '--rm', '-v', `${candidate}:/etc/sing-box/config.json:ro`, `ghcr.io/sagernet/sing-box:${plan.version}`, 'check', '-c', '/etc/sing-box/config.json'])).code)
          throw new Error('sing-box 拒绝候选配置；尚未发布部署文件。');
        event('done', '候选配置校验通过');
        io.signal?.throwIfAborted();
        if (deploymentRevision(io.projectDir) !== plan.baseRevision) throw new Error('校验期间文件或模板被外部修改，请重新预览。');
        stage = 'files'; record(); event('running', '创建部署文件');
        const values = { 'compose.yaml': readFileSync(findPackageFile('compose.yaml'), 'utf8'), '.env': envText, 'config.json': config, 'clash.yaml': clash };
        for (const name of files) { writeFileAtomic(join(io.projectDir, name), values[name], { exclusive: true }); created.push(name); record(); }
        event('done', '部署文件已创建，凭据文件权限为 0600');
        stage = 'start'; record(); event('running', '启动 sing-box 并检查本地监听');
        await startNode({ project: io.projectDir,
          deps: { run: exec, tcpOpen: (port) => tcpOpen(port, io.signal), sleep: (ms) => pause(ms, io.signal) },
          dockerAvailable: async () => (await exec('docker', ['--version'])).code === 0,
          dockerDaemonUp: async () => (await exec('docker', ['info'])).code === 0,
          stdout: (text) => io.onLog?.(safeText(text, secrets)),
          stderr: (text) => { const clean = safeText(text, secrets); if (/Skipping|Warning:/i.test(clean)) warnings.push(clean.trim()); io.onLog?.(clean); },
        });
        event('done', '容器和本地检查完成；外网可达性尚未验证');
        stage = 'complete'; record('complete');
        drafts.delete(plan);
        return { ok: true, cancelled: false, message: warnings.length ? '服务已启动，存在跳过或警告项；外网尚未验证。' : '服务已启动，本地检查通过；外网尚未验证。', created, warnings };
      } catch (error) {
        const message = safeText((error as Error).message ?? '操作失败。', secrets);
        event('failed', message);
        if (recorded) { try { record(io.signal?.aborted ? 'interrupted' : 'failed'); } catch { warnings.push('无法更新操作记录，请核对文件和服务状态。'); } }
        return { ok: false, cancelled: !!io.signal?.aborted, message: message + (created.length ? ' 已创建的配置已保留；重试不会重新生成凭据。' : ''), created, warnings };
      } finally { if (staging) rmSync(staging, { recursive: true, force: true }); }
    });
  } catch (error) {
    return { ok: false, cancelled: !!io.signal?.aborted, message: safeText((error as Error).message, secrets), created, warnings };
  }
}

async function tcpOpen(port: number, signal?: AbortSignal): Promise<boolean> {
  const { createConnection } = await import('node:net');
  signal?.throwIfAborted();
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (value: boolean) => { signal?.removeEventListener('abort', abort); socket.destroy(); resolve(value); };
    const abort = () => finish(false);
    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(500, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('操作已取消。')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function deploymentSecrets(projectDir: string): string[] {
  const secrets: string[] = [];
  try { secrets.push(...secretValues(readFileSync(join(projectDir, '.env'), 'utf8'))); } catch { /* Optional or invalid file. */ }
  try { secrets.push(...ispConfigSecrets(JSON.parse(readFileSync(join(projectDir, 'config.json'), 'utf8')))); } catch { /* Diagnosed separately. */ }
  return secrets;
}

export async function startDeployment(io: ApplicationIO, baseRevision?: string): Promise<DeploymentResult> {
  const secrets = deploymentSecrets(io.projectDir);
  const warnings: string[] = [];
  try {
    await withLock(io.projectDir, async () => {
      if (baseRevision && deploymentRevision(io.projectDir) !== baseRevision) throw new Error('文件或模板已变化，请重新预览启动操作。');
      const checks = await diagnose(io);
      if (checks.some((check) => check.blocks)) throw new Error('运行条件不满足，请先查看诊断。');
      const run = io.run ?? runCommand;
      const exec = (file: string, args: string[]) => run(file, args, { cwd: io.projectDir, env: io.env, signal: io.signal });
      if (baseRevision && deploymentRevision(io.projectDir) !== baseRevision) throw new Error('检查期间文件已变化，请重新预览启动操作。');
      io.onEvent?.({ stage: 'start', status: 'running', message: '启动并检查当前配置' });
      await startNode({ project: io.projectDir, deps: { run: exec, tcpOpen: (port) => tcpOpen(port, io.signal), sleep: (ms) => pause(ms, io.signal) },
        dockerAvailable: async () => (await exec('docker', ['--version'])).code === 0,
        dockerDaemonUp: async () => (await exec('docker', ['info'])).code === 0,
        stdout: (text) => io.onLog?.(safeText(text, secrets)), stderr: (text) => { const clean = safeText(text, secrets); warnings.push(clean.trim()); io.onLog?.(clean); },
      });
      io.onEvent?.({ stage: 'start', status: 'done', message: '当前配置启动检查完成' });
      const record = readDeployment(io.projectDir).operation;
      if (record && record.state !== 'complete') saveOperation(io.projectDir, { id: randomUUID(), state: 'complete', stage: 'start', created: [] });
    });
    return { ok: true, cancelled: false, message: '服务已启动，本地检查完成；外网尚未验证。', created: [], warnings };
  } catch (error) { return { ok: false, cancelled: !!io.signal?.aborted, message: safeText((error as Error).message, secrets), created: [], warnings }; }
}
