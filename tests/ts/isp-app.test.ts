import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyIspPlan, ISP_OPERATION_FILE, planIspChange, readIspState, testIsp, validateIspDraft,
  type IspDraft, type IspEvent, type IspIO,
} from '../../src/app/isp.js';
import { installFile } from '../../src/core/isp.js';
import { IspService, sameIspIp } from '../../src/core/isp-service.js';
import { envQuote } from '../../src/core/env.js';
import { setupIsp, username, password, type IspHarness } from './helpers/isp.js';

vi.mock('../../src/core/isp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/isp.js')>();
  return { ...actual, installFile: vi.fn(actual.installFile) };
});
afterEach(() => vi.mocked(installFile).mockRestore());
let h: IspHarness, io: IspIO, output: string, events: IspEvent[];
const draft = (): IspDraft => ({ host: '198.51.100.7', port: 1080, user: username, pass: password });
beforeEach(async () => {
  h = await setupIsp();
  output = ''; events = [];
  io = { projectDir: h.dir, env: h.env, sleep: async () => {},
    stdout: (text) => { output += text; }, stderr: (text) => { output += text; },
    onEvent: (event) => { events.push(event); },
  };
});
const addPlan = () => planIspChange(io, { action: 'add', isp: draft() });
const removePlan = () => planIspChange(io, { action: 'remove' });
function cleanRuntime() {
  expect(existsSync(join(h.dir, '.isp.lock'))).toBe(false);
  expect(readdirSync(h.dir).filter((name) => name.startsWith('.isp-tmp.'))).toEqual([]);
}
function safe(value: unknown, ...secrets: string[]) {
  const text = JSON.stringify(value) + output + h.log();
  for (const secret of [username, password, ...secrets]) {
    expect(text.includes(secret), 'credential leaked into structured diagnostics').toBe(false);
    expect(text.includes(JSON.stringify(secret).slice(1, -1)), 'escaped credential leaked').toBe(false);
  }
}

it('plans without writes, freezes a detached safe preview, and rejects copied plans', async () => {
  const before = h.snapshot();
  const isp = draft();
  const plan = planIspChange(io, { action: 'add', isp });
  isp.pass = 'changed-after-preview';
  expect(plan.files.map((file) => file.path)).toEqual(['config.json', '.env']);
  expect(plan).toMatchObject({ configChanged: true, envChanged: true, restart: 'required', verify: true });
  expect(Object.isFrozen(plan.summary.routeRules)).toBe(true);
  expect(h.snapshot()).toBe(before);
  expect(h.log()).toBe('');
  expect(h.backups()).toEqual([]);
  safe(plan);
  expect((await applyIspPlan(io, { ...plan })).ok).toBe(false);
  const result = await applyIspPlan(io, plan);
  expect(result.ok, result.error).toBe(true);
  expect(h.config().outbounds!.at(-1)!.password).toBe(password);
  expect((await applyIspPlan(io, plan)).ok).toBe(false);
  cleanRuntime();
});

it('reads .env as an explicit credential draft and reports config differences without serializing secrets', async () => {
  expect(readIspState(h.dir)).toMatchObject({ env: { configured: false }, config: { configured: false }, differences: [] });
  expect((await h.add()).code).toBe(0);
  const config = h.config();
  Object.assign(config.outbounds!.find((o) => o.tag === 'isp-socks')!, {
    server: '192.0.2.9', username: 'old-saved-user', password: 'old-saved-password',
  });
  h.write('config.json', JSON.stringify(config));
  const state = readIspState({ cwd: h.dir });
  expect(state.draft?.pass).toBe(password);
  expect(state.differences.map((difference) => difference.field)).toEqual(['address', 'user', 'pass']);
  expect(state.config.isp?.host).toBe('192.0.2.9');
  safe(state, 'old-saved-user', 'old-saved-password');
});

it('reports malformed source values instead of claiming they are current runtime state', () => {
  h.write('.env', 'ISP_SOCKS_ADDR=not-an-address\n');
  h.write('config.json', '{invalid');
  const state = readIspState(h.dir);
  expect(state.draft).toBeUndefined();
  expect(state.env.issues).toHaveLength(1);
  expect(state.config.issues).toHaveLength(1);
});

it('validates complete drafts without treating empty or mask passwords as keep tokens', () => {
  expect(() => validateIspDraft({ ...draft(), pass: '' })).toThrow('password');
  expect(() => validateIspDraft({ ...draft(), user: 'bad:user' })).toThrow('username');
  expect(() => validateIspDraft({ ...draft(), addr: '192.0.2.9:1080' })).toThrow('disagrees');
  const pass = '  quote " $HOME \\ 日本語  ';
  expect(validateIspDraft({ ...draft(), pass }).pass).toBe(pass);
});

it('compares IPv6 by address value and preserves curl credentials on stdin', async () => {
  const isp = { ...draft(), host: '2001:0DB8:0:0:0:0:0:7' };
  h.set('egress_ip', '2001:db8::7\n');
  const result = await testIsp(io, isp);
  expect(result).toMatchObject({ ok: true, checks: { tcp: 'passed', authentication: 'unknown', egress: 'passed' } });
  expect(sameIspIp('2001:db8::7', '2001:0db8:0:0:0:0:0:7')).toBe(true);
  expect(sameIspIp('::7', '::8')).toBe(false);
  expect(h.log()).toContain('curl -K -');
  expect(h.read('state/last-curl-config')).toContain('proxy-user = ');
  expect(h.read('state/last-curl-config')).toContain('noproxy = ""');
  safe(result);
  expect(h.backups()).toEqual([]);
});

it('describes mismatch separately from unknown TCP/authentication failure', async () => {
  h.set('egress_ip', '203.0.113.50\n');
  const mismatch = await testIsp(io, draft());
  expect(mismatch).toMatchObject({ ok: false, actualIp: '203.0.113.50', expectedIp: draft().host,
    checks: { tcp: 'passed', authentication: 'unknown', egress: 'failed' } });
  h.switch('fail_curl');
  expect(await testIsp(io, draft())).toMatchObject({ ok: false, checks: { tcp: 'unknown', authentication: 'unknown' } });
  safe(mismatch);
});

it('does not accept a valid looking echo body from a failed curl request', async () => {
  h.stub('curl', 'cat > /dev/null\nprintf "198.51.100.7\\n"\nexit 7');
  expect((await testIsp(io, draft())).ok).toBe(false);
});

it('enforces an egress test at final apply and leaves files unchanged on failure', async () => {
  const before = h.snapshot(), plan = addPlan();
  h.switch('fail_curl');
  const result = await applyIspPlan(io, plan);
  expect(result).toMatchObject({ ok: false, failedStage: 'proxy-test', files: 'unchanged' });
  expect(h.snapshot()).toBe(before);
  expect(h.backups()).toEqual([]);
  expect(h.upCount()).toBe(0);
  cleanRuntime();
});

it('backs up and manages only .env/config.json, recreates only sing-box, and records progress without credentials', async () => {
  const client = h.read('clash.yaml');
  const result = await applyIspPlan(io, addPlan());
  expect(result).toMatchObject({ ok: true, files: 'installed', service: 'verified', restarted: true });
  expect(h.read('clash.yaml')).toBe(client);
  expect(readdirSync(result.backupDir!)).toEqual(expect.arrayContaining(['.env', 'config.json']));
  expect(existsSync(join(result.backupDir!, 'clash.yaml'))).toBe(false);
  expect(h.log()).toContain('up -d --force-recreate --no-deps sing-box');
  expect(statSync(join(h.dir, '.env')).mode & 0o777).toBe(0o600);
  const record = JSON.parse(h.read(ISP_OPERATION_FILE));
  expect(record).toMatchObject({ status: 'succeeded', files: 'installed', service: 'verified' });
  expect(statSync(join(h.dir, ISP_OPERATION_FILE)).mode & 0o777).toBe(0o600);
  safe([result, events, record]);
  cleanRuntime();
});

it.each(['.env', 'config.json', 'compose.yaml', 'templates/config.json.template'])(
  'rejects stale %s before testing, backing up, or installing', async (file) => {
    const plan = addPlan();
    h.write(file, h.read(file) + '\n');
    const before = h.snapshot();
    const result = await applyIspPlan(io, plan);
    expect(result).toMatchObject({ ok: false, failedStage: 'baseline', files: 'unchanged' });
    expect(result.error).toContain('changed after preview');
    expect(h.snapshot()).toBe(before);
    expect(h.log()).toBe('');
    expect(h.backups()).toEqual([]);
    cleanRuntime();
  },
);

it('revalidates the baseline after network validation as well as before it', async () => {
  const plan = addPlan();
  io.onEvent = (event) => {
    events.push(event);
    if (event.phase === 'proxy-test' && event.status === 'done') h.write('.env', h.read('.env') + '# concurrent edit\n');
  };
  const result = await applyIspPlan(io, plan);
  expect(result).toMatchObject({ ok: false, failedStage: 'baseline', files: 'unchanged' });
  expect(h.read('.env')).toContain('# concurrent edit');
  expect(h.backups()).toEqual([]);
  expect(h.upCount()).toBe(0);
});

it('shares the CLI exclusive lock and preserves an existing live owner', async () => {
  const plan = addPlan();
  h.write('.isp.lock', String(process.pid));
  const result = await applyIspPlan(io, plan);
  expect(result.error).toContain('in progress');
  expect(h.read('.isp.lock')).toBe(String(process.pid));
  expect(h.log()).toBe('');
});

it('only rewrites env text when config semantics already agree and still verifies health', async () => {
  expect((await h.add()).code).toBe(0);
  h.write('.env', h.read('.env').replace(/^ISP_SOCKS_USER=.*$/m, `ISP_SOCKS_USER=${username}`));
  h.clearLog();
  const config = h.read('config.json'), plan = addPlan();
  expect(plan).toMatchObject({ configChanged: false, envChanged: true, restart: 'none', verify: true });
  const result = await applyIspPlan(io, plan);
  expect(result).toMatchObject({ ok: true, files: 'installed', service: 'verified', restarted: false });
  expect(h.read('config.json')).toBe(config);
  expect(h.upCount()).toBe(0);
  expect(h.log()).toContain('exec -T sing-box sing-box check');
});

it('keeps no-op add repair and no-op remove health semantics distinct', async () => {
  expect((await h.add()).code).toBe(0);
  h.clearLog();
  const plan = addPlan();
  expect(plan).toMatchObject({ files: [], restart: 'if-unhealthy', verify: true });
  h.set('status', 'exited\n'); h.set('listeners', '');
  expect(await applyIspPlan(io, plan)).toMatchObject({ ok: true, files: 'unchanged', service: 'verified', restarted: true });
  expect(h.upCount()).toBe(1);
  expect((await applyIspPlan(io, removePlan())).ok).toBe(true);
  h.clearLog();
  const remove = removePlan();
  expect(remove).toMatchObject({ files: [], restart: 'none', verify: false });
  expect(await applyIspPlan(io, remove)).toMatchObject({ ok: true, service: 'not-checked', restarted: false });
  expect(h.log()).not.toContain('State.Status');
  expect(h.log()).not.toContain('exec -T');
});

it('rejects unsafe nested ISP removal references and preserves custom routing', async () => {
  expect((await h.add()).code).toBe(0);
  const config = h.config();
  config.route!.final = 'isp-socks';
  h.write('config.json', JSON.stringify(config));
  expect(() => removePlan()).toThrow('config.route.final');
  expect(h.backups()).toHaveLength(1);
});

it('does not install a rejected candidate', async () => {
  const before = h.snapshot();
  h.switch('fail_check');
  expect(await applyIspPlan(io, addPlan())).toMatchObject({ ok: false, failedStage: 'candidate', files: 'unchanged' });
  expect(h.snapshot()).toBe(before);
  expect(h.backups()).toEqual([]);
  cleanRuntime();
});

it('restores file and service outcomes separately when new and previous health checks both fail', async () => {
  const before = h.snapshot();
  h.switch('break_isp'); h.switch('fail_exec_check');
  const result = await applyIspPlan(io, addPlan());
  expect(result).toMatchObject({ ok: false, files: 'restored', service: 'recovery-failed',
    recovery: { files: 'restored', service: 'failed' } });
  expect(h.snapshot()).toBe(before);
  expect(h.upCount()).toBe(2);
  expect(JSON.parse(h.read(ISP_OPERATION_FILE))).toMatchObject({ status: 'failed', files: 'restored', service: 'recovery-failed' });
  cleanRuntime();
});

it('does not claim file restoration when a backup member disappeared', async () => {
  const oldConfig = h.read('config.json');
  h.switch('fail_up_isp');
  io.onEvent = (event) => {
    if (event.phase === 'restore-files' && event.status === 'running')
      rmSync(join(h.backups().at(-1)!, '.env'));
  };
  const result = await applyIspPlan(io, addPlan());
  expect(result).toMatchObject({ ok: false, files: 'recovery-failed', service: 'recovery-failed',
    recovery: { files: 'failed', service: 'not-attempted' } });
  expect(h.read('config.json')).toBe(oldConfig);
  expect(result.recovery.errors.join(' ')).toContain('restoration of .env');
  expect(h.upCount()).toBe(1);
  cleanRuntime();
});

it('CLI redacts draft, env, and config credentials across process output boundaries', async () => {
  expect((await h.add()).code).toBe(0);
  const configOnly = 'config-only-password';
  h.track(configOnly);
  const config = h.config();
  config.outbounds!.find((o) => o.tag === 'isp-socks')!.password = configOnly;
  h.write('config.json', JSON.stringify(config));
  const nextUser = 'next-cli-user', nextPass = 'next-cli-password';
  const originalDocker = h.read('stubs/docker');
  h.stub('docker', `if [[ "$1" == run ]]; then
    printf '\\033[31m${nextPass.slice(0, 5)}'; /bin/sleep 0.01; printf '${nextPass.slice(5)}\\033[0m\\n';
    printf '${password} ${configOnly}\\n' >&2;
  fi\n${originalDocker}`);
  const result = await h.add('198.51.100.7:1080', nextUser, nextPass);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout + result.stderr).not.toContain('\u001b');
});

it('cancels a committed change and completes uncancelled file and service recovery', async () => {
  const before = h.snapshot(), controller = new AbortController();
  io.onEvent = (event) => {
    events.push(event);
    if (event.phase === 'restart' && event.status === 'done') controller.abort(new Error('stop requested'));
  };
  const result = await applyIspPlan(io, addPlan(), controller.signal);
  expect(result).toMatchObject({ ok: false, cancelled: true, files: 'restored', service: 'restored',
    recovery: { files: 'restored', service: 'restored' } });
  expect(h.snapshot()).toBe(before);
  expect(h.upCount()).toBe(2);
  expect(JSON.parse(h.read(ISP_OPERATION_FILE)).status).toBe('cancelled');
  cleanRuntime();
});

it('rolls back partial installation and redacts new and old credentials even across process output chunks', async () => {
  expect((await h.add()).code).toBe(0);
  const before = h.snapshot(), nextUser = 'new-isp-username', nextPass = 'new-isp-password';
  const originalDocker = h.read('stubs/docker');
  h.stub('docker', `if [[ "$1" == run ]]; then
    printf '\\033[31m${nextPass.slice(0, 5)}'; /bin/sleep 0.01; printf '${nextPass.slice(5)}\\033[0m\\n';
    printf '${password}\\n' >&2;
  fi\n${originalDocker}`);
  const actual = await vi.importActual<typeof import('../../src/core/isp.js')>('../../src/core/isp.js');
  vi.mocked(installFile).mockImplementation((dest, data, dir) => {
    if (dest === join(h.dir, '.env')) throw new Error(`install failed for ${nextUser} ${nextPass} ${password}`);
    actual.installFile(dest, data, dir);
  });
  const plan = planIspChange(io, { action: 'add', isp: { ...draft(), user: nextUser, pass: nextPass } });
  const result = await applyIspPlan(io, plan);
  expect(result).toMatchObject({ ok: false, failedStage: 'install', files: 'restored', service: 'restored' });
  expect(h.snapshot()).toBe(before);
  expect(output).not.toContain('\u001b');
  safe([result, plan, events, JSON.parse(h.read(ISP_OPERATION_FILE))], nextUser, nextPass);
  cleanRuntime();
});

it('keeps recovery truth when writing the operation record fails after installation', async () => {
  const before = h.snapshot();
  const actual = await vi.importActual<typeof import('../../src/core/isp.js')>('../../src/core/isp.js');
  let installed = false;
  vi.mocked(installFile).mockImplementation((dest, data, dir) => {
    if (dest === join(h.dir, 'config.json')) installed = true;
    if (installed && dest === join(h.dir, ISP_OPERATION_FILE)) throw new Error('record disk failure');
    actual.installFile(dest, data, dir);
  });
  h.switch('fail_up_isp');
  const result = await applyIspPlan(io, addPlan());
  expect(result).toMatchObject({ ok: false, files: 'restored', service: 'restored' });
  expect(result.warnings).toHaveLength(1);
  expect(h.snapshot()).toBe(before);
  expect(readIspState(h.dir).operation?.status).toBe('running');
  const retry = await applyIspPlan(io, addPlan());
  expect(retry.error).toContain('unfinished ISP operation');
  cleanRuntime();
});

it('reports unfinished operation records and refuses to overwrite recovery evidence', async () => {
  expect((await applyIspPlan(io, addPlan())).ok).toBe(true);
  const record = JSON.parse(h.read(ISP_OPERATION_FILE));
  record.status = 'running'; record.phase = 'restart';
  h.write(ISP_OPERATION_FILE, JSON.stringify(record));
  expect(readIspState(h.dir).operation).toMatchObject({ status: 'running', phase: 'restart' });
  const before = h.snapshot(), saved = h.read(ISP_OPERATION_FILE);
  const result = await applyIspPlan(io, removePlan());
  expect(result.error).toContain('unfinished ISP operation');
  expect(h.snapshot()).toBe(before);
  expect(h.read(ISP_OPERATION_FILE)).toBe(saved);
});

it('allows cancellation before testing without commands, writes, or a success claim', async () => {
  const controller = new AbortController(); controller.abort();
  const before = h.snapshot();
  expect(await testIsp(io, draft(), controller.signal)).toMatchObject({ ok: false, cancelled: true });
  expect(await applyIspPlan(io, addPlan(), controller.signal)).toMatchObject({ ok: false, cancelled: true, files: 'unchanged' });
  expect(h.snapshot()).toBe(before);
  expect(h.log()).toBe('');
  expect(h.backups()).toEqual([]);
});

it('times out commands and escalates cancellation for subprocesses that ignore TERM', async () => {
  h.stub('docker', 'trap "" TERM\nwhile true; do /bin/sleep 1; done');
  const service = new IspService({ projectDir: h.dir, env: h.env, commandTimeoutMs: 30, killGraceMs: 30,
    stdout: () => {}, stderr: (text) => { output += text; } });
  expect(await service.composeAvailable()).toBe(false);
  expect(output).toContain('timed out');
  const controller = new AbortController();
  const cancellable = new IspService({ projectDir: h.dir, env: h.env, signal: controller.signal,
    commandTimeoutMs: 2000, killGraceMs: 30, stdout: () => {}, stderr: () => {} });
  const pending = cancellable.composeAvailable();
  setTimeout(() => controller.abort(new Error('cancelled command')), 30);
  await expect(pending).rejects.toThrow('cancelled command');
}, 3000);

it('redacts one-character quote/backslash credentials without corrupting safe route previews', () => {
  const plan = planIspChange(io, { action: 'add', isp: { ...draft(), user: '"', pass: '\\' } });
  expect(Array.isArray(plan.summary.routeRules)).toBe(true);
  expect(() => JSON.stringify(plan)).not.toThrow();
  expect(envQuote('\\')).toBe('"\\\\"');
});
