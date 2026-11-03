import {
  accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { OUT_TAG, type IspSocks } from '../model.js';
import {
  addIspToConfig, checkIspConfig, envGet, envHasIsp, installFile, IspError,
  makeBackup, makeTmpPath, MANAGED_FILES, removeIspFromConfig, restoreBackup, withLock,
  type ManagedFile,
} from '../core/isp.js';
import { envUnquote, envWithIsp, envWithoutIsp } from '../core/env.js';
import { IspService, sameIspIp, createIspRedactor as sanitizer, ispConfigSecrets as configSecrets } from '../core/isp-service.js';
import { loadSingboxTemplate, type SingboxConfig } from '../core/render-config.js';
import { isIspRule, isLegacyIspRule } from '../core/routing.js';
import { findTemplate } from '../core/templates.js';
import { secretValues } from '../core/start.js';
import { isIpv4, isIpv6Strict, parseIspAddr, validCred } from '../core/validate.js';

export interface IspDraft {
  host: string;
  port: number;
  user: string;
  pass: string;
  egressIp?: string;
  addr?: string;
}
export type IspPhase = 'preflight' | 'baseline' | 'proxy-test' | 'candidate' |
  'backup' | 'install' | 'restart' | 'verify' | 'restore-files' | 'restore-service' | 'complete';
export interface IspEvent {
  operation: 'isp';
  phase: IspPhase;
  status: 'running' | 'done' | 'failed' | 'skipped';
  message?: string;
}
export interface IspIO {
  projectDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?(text: string): void;
  stderr?(text: string): void;
  sleep?(ms: number): Promise<void>;
  signal?: AbortSignal;
  onEvent?(event: IspEvent): void;
}
export interface IspSummary {
  host: string;
  port: number;
  expectedIp: string;
  usernamePresent: boolean;
  passwordPresent: boolean;
}
export interface IspState {
  projectDir: string;
  env: { exists: boolean; configured: boolean; isp?: IspSummary; issues: string[] };
  config: { exists: boolean; configured: boolean; isp?: IspSummary; issues: string[] };
  differences: { field: 'presence' | 'address' | 'user' | 'pass'; message: string }[];
  /** Explicitly contains credentials from .env; non-enumerable to keep serialized views safe. */
  readonly draft?: IspSocks;
  /** A running record from a previous process requires inspection, never automatic backup restore. */
  operation?: IspOperationRecord;
  operationIssue?: string;
}
export interface IspTestResult {
  ok: boolean;
  cancelled: boolean;
  checkedAt: string;
  draftRevision?: string;
  expectedIp?: string;
  actualIp?: string;
  /** Curl proves a SOCKS5 + HTTPS request, but does not report the server's chosen auth method. */
  checks: { tcp: 'passed' | 'unknown'; authentication: 'passed' | 'unknown'; egress: 'passed' | 'failed' | 'cancelled' };
  error?: string;
}
export interface IspPlan {
  readonly id: string;
  readonly action: 'add' | 'remove';
  readonly projectDir: string;
  readonly baseRevision: string;
  readonly files: readonly { path: ManagedFile; action: 'create' | 'update'; sensitive: true }[];
  readonly configChanged: boolean;
  readonly envChanged: boolean;
  readonly restart: 'required' | 'if-unhealthy' | 'none';
  readonly verify: boolean;
  readonly summary: {
    readonly before?: IspSummary;
    readonly after?: IspSummary;
    readonly credentials: 'remove' | 'keep' | 'replace';
    readonly routeFinal: string;
    readonly routeRules: readonly unknown[];
    readonly retiredPorts: readonly number[];
    readonly requiresClientReimport: boolean;
    readonly backupRoot?: string;
  };
}
export interface IspApplyResult {
  ok: boolean;
  cancelled: boolean;
  failedStage?: IspPhase;
  error?: string;
  files: 'unchanged' | 'installed' | 'restored' | 'recovery-failed';
  service: 'not-checked' | 'verified' | 'failed' | 'restored' | 'recovery-failed';
  restarted: boolean;
  backupDir?: string;
  warnings: string[];
  recovery: {
    files: 'not-needed' | 'restored' | 'failed';
    service: 'not-needed' | 'restored' | 'failed' | 'not-attempted';
    errors: string[];
  };
}
export const ISP_OPERATION_FILE = '.tui-isp-operation.json';
export interface IspOperationRecord {
  version: 1;
  id: string;
  action: 'add' | 'remove';
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  phase: IspPhase;
  failedStage?: IspPhase;
  startedAt: string;
  updatedAt: string;
  configChanged: boolean;
  envChanged: boolean;
  backupDir?: string;
  files: IspApplyResult['files'];
  service: IspApplyResult['service'];
  recovery: IspApplyResult['recovery'];
  error?: string;
}
function readOperation(dir: string): IspOperationRecord | undefined {
  const file = source(join(dir, ISP_OPERATION_FILE));
  if (!file.exists) return undefined;
  let value: IspOperationRecord;
  try { value = JSON.parse(file.text) as IspOperationRecord; }
  catch { throw new IspError('Cannot parse the ISP operation record. Inspect it before making another change.'); }
  if (!value || value.version !== 1 || typeof value.id !== 'string' ||
      !['add', 'remove'].includes(value.action) || !['running', 'succeeded', 'failed', 'cancelled'].includes(value.status) ||
      typeof value.phase !== 'string' || typeof value.startedAt !== 'string' || typeof value.updatedAt !== 'string' ||
      typeof value.configChanged !== 'boolean' || typeof value.envChanged !== 'boolean' ||
      !value.recovery || !Array.isArray(value.recovery.errors) ||
      !value.recovery.errors.every((message) => typeof message === 'string'))
    throw new IspError('Invalid ISP operation record. Inspect it before making another change.');
  return { version: 1, id: value.id, action: value.action, status: value.status,
    phase: value.phase, failedStage: value.failedStage, startedAt: value.startedAt, updatedAt: value.updatedAt,
    configChanged: value.configChanged, envChanged: value.envChanged,
    files: value.files, service: value.service,
    recovery: { files: value.recovery.files, service: value.recovery.service, errors: [...value.recovery.errors] },
    ...(typeof value.backupDir === 'string' ? { backupDir: value.backupDir } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}
interface Source {
  text: string;
  exists: boolean;
  mode?: number;
}
interface Context {
  configText: string;
  envText: string;
  sources: Map<string, Source>;
  isp?: IspSocks;
  secrets: string[];
  used: boolean;
}
const plans = new WeakMap<IspPlan, Context>();
// Keyed fingerprints cannot be used to guess a low-entropy password from a preview DTO.
const revisionKey = randomBytes(32);
const fingerprint = (value: unknown) => createHmac('sha256', revisionKey).update(JSON.stringify(value)).digest('hex');
const project = (io: string | Pick<IspIO, 'projectDir' | 'cwd'>) =>
  resolve(typeof io === 'string' ? io : io.projectDir ?? io.cwd ?? process.cwd());

function source(file: string): Source {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile()) throw new IspError(`Expected a regular file: ${file}`);
    return { text: readFileSync(file, 'utf8'), exists: true, mode: stat.mode & 0o7777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', exists: false };
    throw error;
  }
}
function revision(dir: string, sources: Map<string, Source>): string {
  return fingerprint([realpathSync(dir), [...sources]]);
}
function configFrom(text: string): SingboxConfig {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new IspError('config.json is not valid JSON.'); }
  checkIspConfig(value);
  return value;
}
/** Validates a complete draft; empty credentials never mean "keep current". */
export function validateIspDraft(draft: IspDraft): IspSocks {
  const addr = `${draft.host.includes(':') ? `[${draft.host}]` : draft.host}:${draft.port}`;
  const address = parseIspAddr(addr);
  if (!Number.isInteger(draft.port) || !address)
    throw new IspError('Invalid address. Use an IPv4 or IPv6 address and a port from 1 to 65535.');
  if (draft.addr !== undefined && draft.addr !== address.addr)
    throw new IspError('ISP address disagrees with its host and port.');
  if (!validCred(draft.user) || draft.user.includes(':'))
    throw new IspError('Invalid username: use 1-255 UTF-8 bytes, without control characters or a colon.');
  if (!validCred(draft.pass))
    throw new IspError('Invalid password: use 1-255 UTF-8 bytes, without control characters.');
  if (draft.egressIp && !isIpv4(draft.egressIp) && !isIpv6Strict(draft.egressIp))
    throw new IspError('Invalid expected egress IP.');
  return { ...address, user: draft.user, pass: draft.pass, egressIp: draft.egressIp ?? '' };
}
function envDraft(text: string): IspSocks | undefined {
  if (!envHasIsp(text)) return undefined;
  const address = parseIspAddr(envGet(text, 'ISP_SOCKS_ADDR') ?? '');
  if (!address) throw new IspError('Invalid ISP address in .env.');
  return validateIspDraft({ ...address,
    user: envUnquote(envGet(text, 'ISP_SOCKS_USER') ?? '') ?? '',
    pass: envUnquote(envGet(text, 'ISP_SOCKS_PASS') ?? '') ?? '',
    egressIp: envGet(text, 'ISP_SOCKS_EGRESS_IP') ?? '',
  });
}
function configDraft(config: SingboxConfig): IspSocks | undefined {
  const outbounds = config.outbounds?.filter((o) => o.tag === OUT_TAG) ?? [];
  if (!outbounds.length) return undefined;
  if (outbounds.length !== 1 || outbounds[0].type !== 'socks')
    throw new IspError('config.json has an ambiguous ISP outbound.');
  const o = outbounds[0];
  if (typeof o.server !== 'string' || typeof o.server_port !== 'number' ||
      typeof o.username !== 'string' || typeof o.password !== 'string')
    throw new IspError('config.json has an invalid ISP outbound.');
  return validateIspDraft({ host: o.server, port: o.server_port, user: o.username, pass: o.password });
}
const summary = (isp?: IspDraft): IspSummary | undefined => isp ? {
  host: isp.host, port: isp.port, expectedIp: isp.egressIp || isp.host,
  usernamePresent: !!isp.user, passwordPresent: !!isp.pass,
} : undefined;

/** Read-only facts. .env is the editing source, not a claim about running service state. */
export function readIspState(input: string | Pick<IspIO, 'projectDir' | 'cwd'>): IspState {
  const dir = project(input);
  const state: IspState = { projectDir: dir,
    env: { exists: false, configured: false, issues: [] },
    config: { exists: false, configured: false, issues: [] }, differences: [],
  };
  let fromEnv: IspSocks | undefined, fromConfig: IspSocks | undefined;
  try {
    const file = source(join(dir, '.env'));
    state.env.exists = file.exists;
    state.env.configured = envHasIsp(file.text);
    fromEnv = envDraft(file.text);
    state.env.isp = summary(fromEnv);
  } catch { state.env.issues.push('Cannot read valid ISP values from .env.'); }
  try {
    const file = source(join(dir, 'config.json'));
    state.config.exists = file.exists;
    if (file.exists) {
      const config = configFrom(file.text);
      state.config.configured = !!config.outbounds?.some((o) => o.tag === OUT_TAG);
      fromConfig = configDraft(config);
      state.config.isp = summary(fromConfig);
    } else state.config.issues.push('config.json does not exist.');
  } catch { state.config.issues.push('Cannot read a valid ISP outbound from config.json.'); }
  if (state.env.configured !== state.config.configured)
    state.differences.push({ field: 'presence', message: '.env and config.json disagree about whether ISP is configured.' });
  if (fromEnv && fromConfig) {
    if (!sameIspIp(fromEnv.host, fromConfig.host) || fromEnv.port !== fromConfig.port)
      state.differences.push({ field: 'address', message: 'ISP host or port differs between .env and config.json.' });
    for (const field of ['user', 'pass'] as const)
      if (fromEnv[field] !== fromConfig[field]) state.differences.push({ field, message: `ISP ${field === 'user' ? 'username' : 'password'} differs between .env and config.json.` });
  }
  if (fromEnv) Object.defineProperty(state, 'draft', { value: Object.freeze(fromEnv), enumerable: false });
  try {
    const operation = readOperation(dir);
    if (operation) state.operation = safeValue(operation, sanitizer(diskSecrets(dir))) as IspOperationRecord;
  } catch { state.operationIssue = 'Cannot read the ISP operation record. Inspect it before making another ISP change.'; }
  return state;
}

function safeValue(value: unknown, clean: (text: string) => string): unknown {
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map((item) => safeValue(item, clean));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key), safeValue(item, clean)]));
  return value;
}
function adapter(io: IspIO, dir: string, secrets: readonly string[], signal?: AbortSignal) {
  const clean = sanitizer(secrets);
  return new IspService({ projectDir: dir, env: io.env, sleep: io.sleep, signal,
    stdout: (text) => io.stdout?.(clean(text)), stderr: (text) => io.stderr?.(clean(text)),
    sanitizeOutput: clean,
  });
}
function event(io: IspIO, phase: IspPhase, status: IspEvent['status'], message?: string): void {
  // UI observers must not prevent installation or, especially, recovery.
  try { io.onEvent?.({ operation: 'isp', phase, status, ...(message ? { message } : {}) }); } catch { /* observer only */ }
}
function diskSecrets(dir: string): string[] {
  const values: string[] = [];
  try { values.push(...secretValues(readFileSync(join(dir, '.env'), 'utf8'))); } catch { /* optional */ }
  try { values.push(...configSecrets(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')))); } catch { /* optional */ }
  return values;
}

export async function testIsp(io: IspIO, draft: IspDraft, signal = io.signal): Promise<IspTestResult> {
  const dir = project(io);
  const clean = sanitizer([...diskSecrets(dir), draft.user, draft.pass]);
  const result: IspTestResult = { ok: false, cancelled: false, checkedAt: new Date().toISOString(),
    checks: { tcp: 'unknown', authentication: 'unknown', egress: 'failed' },
  };
  event(io, 'proxy-test', 'running');
  try {
    signal?.throwIfAborted();
    const isp = validateIspDraft(draft);
    result.draftRevision = fingerprint(isp);
    result.expectedIp = isp.egressIp || isp.host;
    const actual = await adapter(io, dir, [isp.user, isp.pass], signal).socksEgressIp(isp);
    signal?.throwIfAborted();
    if (!actual) throw new IspError('Could not reach an IP echo service through the SOCKS5 proxy. Check its address, credentials and ISP allowlist.');
    result.actualIp = actual;
    result.checks.tcp = 'passed';
    if (!sameIspIp(actual, result.expectedIp))
      throw new IspError(`Egress IP through the proxy is ${actual}, expected ${result.expectedIp}.`);
    result.ok = true;
    result.checks.egress = 'passed';
    event(io, 'proxy-test', 'done');
  } catch (error) {
    result.cancelled = signal?.aborted ?? false;
    result.checks.egress = result.cancelled ? 'cancelled' : 'failed';
    result.error = clean(result.cancelled ? 'ISP test cancelled.' : (error as Error).message);
    event(io, 'proxy-test', 'failed', result.error);
  }
  return result;
}

/** No files or service actions occur during planning. Keep the returned object in memory. */
export function planIspChange(io: IspIO, change: { action: 'add' | 'remove'; isp?: IspDraft }): IspPlan {
  const dir = project(io);
  const secrets = [...diskSecrets(dir), change.isp?.user ?? '', change.isp?.pass ?? ''];
  const clean = sanitizer(secrets);
  try {
    io.signal?.throwIfAborted();
    const sources = new Map<string, Source>();
    for (const name of [...MANAGED_FILES, 'compose.yaml']) sources.set(join(dir, name), source(join(dir, name)));
    const originalSource = sources.get(join(dir, 'config.json'))!;
    if (!originalSource.exists) throw new IspError('config.json does not exist. Run my-singbox gen-config first.');
    const original = configFrom(originalSource.text);
    const envSource = sources.get(join(dir, '.env'))!;
    let isp: IspSocks | undefined;
    let config: SingboxConfig;
    if (change.action === 'add') {
      if (!envSource.exists) throw new IspError('.env does not exist. Run my-singbox gen-keys first.');
      if (!change.isp) throw new IspError('ISP values are required when adding or updating.');
      isp = validateIspDraft(change.isp);
      const hasPolicy = original.route?.final === OUT_TAG ||
        original.route?.rules?.some((rule) => isIspRule(rule) && !isLegacyIspRule(rule));
      let defaults;
      if (!hasPolicy) {
        // Also bind absence of a local override: creating it invalidates this preview.
        for (const file of new Set([join(dir, 'templates/config.json.template'), findTemplate('config.json.template', dir)]))
          sources.set(file, source(file));
        defaults = loadSingboxTemplate(dir).route;
      }
      config = addIspToConfig(original, isp, defaults);
    } else if (change.action === 'remove') config = removeIspFromConfig(original);
    else throw new IspError('Invalid ISP action.');
    const envText = isp ? envWithIsp(envSource.text, { ...isp, egressIp: isp.egressIp ?? '' }) : envWithoutIsp(envSource.text);
    const configChanged = !isDeepStrictEqual(config, original);
    const envChanged = envText !== envSource.text;
    const configText = configChanged ? JSON.stringify(config, null, 2) + '\n' : originalSource.text;
    const remainingTags = new Set(config.inbounds.map((inbound) => inbound.tag));
    const retiredPorts = original.inbounds.filter((inbound) => !remainingTags.has(inbound.tag))
      .map((inbound) => inbound.listen_port).filter((port): port is number => typeof port === 'number');
    let before: IspSocks | undefined;
    try { before = envDraft(envSource.text); } catch { /* a valid replacement may repair malformed ISP values */ }
    const plan: IspPlan = {
      id: randomUUID(), action: change.action, projectDir: dir, baseRevision: revision(dir, sources),
      files: MANAGED_FILES.filter((name) => name === 'config.json' ? configChanged : envChanged)
        .map((name) => ({ path: name, action: sources.get(join(dir, name))!.exists ? 'update' : 'create', sensitive: true })),
      configChanged, envChanged,
      restart: configChanged ? 'required' : change.action === 'add' && !envChanged ? 'if-unhealthy' : 'none',
      verify: configChanged || envChanged || change.action === 'add',
      summary: { before: summary(before), after: summary(isp),
        credentials: !isp ? 'remove' : before?.user === isp.user && before.pass === isp.pass ? 'keep' : 'replace',
        routeFinal: clean(String(config.route?.final ?? 'direct')),
        routeRules: safeValue(config.route?.rules ?? [], clean) as unknown[],
        retiredPorts, requiresClientReimport: !!retiredPorts.length,
        ...(configChanged || envChanged ? { backupRoot: join(dir, '.isp-backup') } : {}),
      },
    };
    // All public plan data is immutable, safe to serialize, and independent of the draft object.
    const freeze = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    };
    freeze(plan);
    plans.set(plan, { configText, envText, sources, isp, secrets, used: false });
    return plan;
  } catch (error) {
    throw new IspError(clean(io.signal?.aborted ? 'ISP planning cancelled.' : (error as Error).message));
  }
}

/** Revalidates the preview under the same lock as CLI and always tests add/update before writing. */
export async function applyIspPlan(io: IspIO, plan: IspPlan, signal = io.signal): Promise<IspApplyResult> {
  const result: IspApplyResult = { ok: false, cancelled: false, files: 'unchanged', service: 'not-checked', restarted: false,
    warnings: [], recovery: { files: 'not-needed', service: 'not-needed', errors: [] },
  };
  const context = plans.get(plan);
  const clean = sanitizer(context?.secrets ?? []);
  let phase: IspPhase = 'baseline';
  let record: IspOperationRecord | undefined;
  const persist = (required = false) => {
    if (!record) return;
    record.updatedAt = new Date().toISOString();
    record.files = result.files;
    record.service = result.service;
    record.backupDir = result.backupDir;
    record.recovery = structuredClone(result.recovery);
    record.error = result.error;
    record.failedStage = result.failedStage;
    try { installFile(join(plan.projectDir, ISP_OPERATION_FILE), JSON.stringify(record, null, 2) + '\n', plan.projectDir); }
    catch {
      const warning = 'Could not update the ISP operation record; inspect the deployment before the next ISP change.';
      if (!result.warnings.includes(warning)) result.warnings.push(warning);
      if (required) throw new IspError(warning);
    }
  };
  const emit = (name: IspPhase, status: IspEvent['status'], message?: string) => {
    if (record) { record.phase = name; persist(); }
    event(io, name, status, message);
  };
  const stage = async <T>(name: IspPhase, fn: () => Promise<T> | T): Promise<T> => {
    phase = name;
    emit(name, 'running');
    const value = await fn();
    emit(name, 'done');
    return value;
  };
  try {
    if (!context || context.used) throw new IspError('ISP plan is unknown or already used. Refresh the preview.');
    const dir = project(io);
    if (dir !== plan.projectDir) throw new IspError('ISP plan belongs to a different deployment directory.');
    signal?.throwIfAborted();
    context.used = true;
    await withLock(dir, async () => {
      let armed = false;
      let candidate: string | undefined;
      const service = adapter(io, dir, context.secrets, signal);
      const assertBaseline = () => {
        signal?.throwIfAborted();
        const current = new Map([...context.sources.keys()].map((file) => [file, source(file)]));
        if (revision(dir, current) !== plan.baseRevision)
          throw new IspError('Deployment files or templates changed after preview. Refresh the ISP plan.');
      };
      try {
        await stage('baseline', assertBaseline);
        const previousOperation = readOperation(dir);
        if (previousOperation?.status === 'running')
          throw new IspError('An unfinished ISP operation was detected. Inspect its recorded files, backup and service state before removing the operation record and trying again.');
        record = { version: 1, id: plan.id, action: plan.action, status: 'running', phase: 'baseline',
          startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          configChanged: plan.configChanged, envChanged: plan.envChanged,
          files: result.files, service: result.service, recovery: structuredClone(result.recovery),
        };
        persist(true);
        const image = await stage('preflight', async () => {
          accessSync(dir, constants.W_OK);
          for (const name of MANAGED_FILES) {
            const file = join(dir, name);
            if (existsSync(file)) accessSync(file, constants.R_OK | constants.W_OK);
          }
          if (!await service.composeAvailable()) throw new IspError('docker compose is not available.');
          const docker = await service.dockerInfo();
          if (docker !== 'ok') throw new IspError(docker === 'permission-denied'
            ? 'Permission denied while talking to the Docker daemon.' : 'Docker daemon is not running or reachable.');
          const image = await service.containerImage();
          if (!image) throw new IspError('Container sing-box not found. Run my-singbox start first.');
          return image;
        });
        if (context.isp) {
          phase = 'proxy-test';
          record.phase = phase;
          persist();
          const test = await testIsp(io, context.isp, signal);
          if (!test.ok) throw new IspError(test.error ?? 'ISP test failed.');
        }
        if (plan.configChanged) await stage('candidate', async () => {
          candidate = makeTmpPath(dir);
          writeFileSync(candidate, context.configText, { flag: 'wx', mode: 0o600 });
          if (!await service.checkCandidate(image, candidate))
            throw new IspError('sing-box rejected the candidate config. Nothing was changed.');
        });
        // Test/validation can take time; also detect edits made by tools that ignore our lock.
        await stage('baseline', assertBaseline);
        if (plan.files.length) {
          result.backupDir = await stage('backup', () => makeBackup(dir, MANAGED_FILES));
          signal?.throwIfAborted();
          armed = true;
          await stage('install', () => {
            signal?.throwIfAborted();
            if (plan.configChanged) installFile(join(dir, 'config.json'), context.configText, dir);
            if (plan.envChanged) installFile(join(dir, '.env'), context.envText, dir);
            result.files = 'installed';
          });
          signal?.throwIfAborted();
          if (plan.configChanged) await stage('restart', async () => {
            result.restarted = true;
            result.service = 'failed';
            if (!await service.recreate()) throw new IspError('sing-box failed to restart after the ISP change.');
          });
          await stage('verify', async () => {
            result.service = 'failed';
            if (!await service.verifyService()) throw new IspError('sing-box did not come up after the ISP change.');
            result.service = 'verified';
          });
        } else if (plan.verify) {
          await stage('verify', async () => {
            result.service = 'failed';
            if (await service.verifyService()) { result.service = 'verified'; return; }
            await stage('restart', async () => {
              result.restarted = true;
              if (!await service.recreate() || !await service.verifyService())
                throw new IspError('sing-box is still not healthy after a restart. Server files were not changed.');
              result.service = 'verified';
            });
          });
        } else event(io, 'verify', 'skipped', 'No ISP change; service health was not checked.');
        signal?.throwIfAborted();
        armed = false;
        result.ok = true;
      } catch (error) {
        result.failedStage = phase;
        result.cancelled = signal?.aborted ?? false;
        result.error = clean(result.cancelled ? 'ISP operation cancelled.' : (error as Error).message);
        event(io, phase, 'failed', result.error);
        if (armed && result.backupDir) {
          // Recovery deliberately has no cancelled signal; restore every file even if another fails.
          emit('restore-files', 'running');
          for (const name of MANAGED_FILES) {
            try {
              const dest = join(dir, name), original = context.sources.get(dest)!;
              // A concurrently replaced symlink must not redirect restoration outside this deployment.
              source(dest);
              if (original.exists) restoreBackup(dir, result.backupDir, [name]);
              else rmSync(dest, { force: true });
              if (!isDeepStrictEqual(source(dest), original))
                throw new IspError(`Could not confirm restoration of ${name}. Inspect the saved backup.`);
            } catch (restoreError) { result.recovery.errors.push(clean((restoreError as Error).message)); }
          }
          result.recovery.files = result.recovery.errors.length ? 'failed' : 'restored';
          result.files = result.recovery.files === 'restored' ? 'restored' : 'recovery-failed';
          emit('restore-files', result.recovery.files === 'restored' ? 'done' : 'failed');
          if (plan.configChanged && result.recovery.files === 'restored') {
            emit('restore-service', 'running');
            try {
              const previous = adapter(io, dir, context.secrets);
              if (!await previous.recreate() || !await previous.verifyService())
                throw new IspError('Previous files were restored, but sing-box service recovery failed.');
              result.recovery.service = 'restored';
              result.service = 'restored';
            } catch (restoreError) {
              result.recovery.service = 'failed';
              result.service = 'recovery-failed';
              result.recovery.errors.push(clean((restoreError as Error).message));
            }
            emit('restore-service', result.recovery.service === 'restored' ? 'done' : 'failed');
          } else if (plan.configChanged) {
            result.recovery.service = 'not-attempted';
            result.service = 'recovery-failed';
            emit('restore-service', 'skipped', 'Files could not be fully restored; service recovery was not attempted.');
          }
        }
      } finally {
        if (candidate) {
          try { rmSync(candidate, { force: true }); }
          catch { result.warnings.push('Could not remove the private candidate file. Inspect .isp-tmp files.'); }
        }
        if (record) {
          record.status = result.ok ? 'succeeded' : result.cancelled ? 'cancelled' : 'failed';
          record.phase = 'complete';
          persist();
        }
      }
    });
  } catch (error) {
    result.failedStage ??= phase;
    result.cancelled = signal?.aborted ?? false;
    result.error ??= clean(result.cancelled ? 'ISP operation cancelled.' : (error as Error).message);
    event(io, phase, 'failed', result.error);
  }
  if (context?.used) plans.delete(plan);
  event(io, 'complete', result.ok ? 'done' : 'failed', result.error);
  return result;
}
