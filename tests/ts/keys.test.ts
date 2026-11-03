import { IMAGE_PULL_TIMEOUT_MS, runCommand } from '../../src/core/isp-service.js';
import { it, expect, vi } from 'vitest';
import {
  generateKeys,
  defaultKeyDeps,
  dockerAvailable,
  dockerDaemonUp,
  detectPublicIp,
} from '../../src/core/keys.js';
import { creds } from './helpers/fixtures.js';
const deps = () => ({
  randomUuid: () => creds.vlessUuid,
  randomShortId: () => creds.realityShortId,
  runSingbox: vi.fn(async (args: string[]) =>
    args[1] === 'reality-keypair'
      ? `  PrivateKey: ${creds.realityPrivateKey}\n\tPublicKey: ${creds.realityPublicKey}\n`
      : creds.ssPassword + '\n',
  ),
});

it('generates and validates credentials through injected commands', async () => {
  const d = deps();
  expect(await generateKeys(d)).toEqual({
    vlessUuid: creds.vlessUuid,
    realityPrivateKey: creds.realityPrivateKey,
    realityPublicKey: creds.realityPublicKey,
    realityShortId: creds.realityShortId,
    ssPassword: creds.ssPassword,
  });
  expect(d.runSingbox.mock.calls).toEqual([
    [['generate', 'reality-keypair']],
    [['generate', 'rand', '--base64', '16']],
  ]);
});

it('rejects malformed credentials without including their values', async () => {
  for (const patch of [
    { randomUuid: () => 'SECRET' },
    { randomShortId: () => 'SECRET' },
    { runSingbox: async () => 'SECRET' },
  ])
    await expect(generateKeys({ ...deps(), ...patch })).rejects.toThrow(
      /^Invalid generated credentials\.$/,
    );
});

it('propagates dependency errors unchanged', async () => {
  const error = new Error('Docker command failed.');
  await expect(
    generateKeys({
      ...deps(),
      runSingbox: async () => {
        throw error;
      },
    }),
  ).rejects.toBe(error);
});

it('provides crypto defaults and injectable Docker probes', async () => {
  const d = defaultKeyDeps('image');
  expect(d.randomUuid()).toMatch(/^[\da-f-]{36}$/);
  expect(d.randomShortId()).toMatch(/^[\da-f]{16}$/);
  expect(typeof d.runSingbox).toBe('function');
  const run = vi.fn(async () => 'ok');
  expect(await dockerAvailable(run)).toBe(true);
  expect(await dockerDaemonUp(run)).toBe(true);
  expect(run.mock.calls).toEqual([
    ['docker', ['--version']],
    ['docker', ['info']],
  ]);
  const fail = async () => {
    throw Error('SECRET');
  };
  expect(await dockerAvailable(fail)).toBe(false);
  expect(await dockerDaemonUp(fail)).toBe(false);
});

it('uses IPv4 first and trims response', async () => {
  const httpGet = vi.fn(async () => ' 8.8.8.8\n');
  expect(await detectPublicIp({ httpGet })).toBe('8.8.8.8');
  expect(httpGet.mock.calls).toEqual([['https://ipinfo.io/ip', 4, undefined]]);
});

it('tries trace within each family then IPv6', async () => {
  const calls: [string, number][] = [];
  expect(
    await detectPublicIp({
      httpGet: async (url, family) => {
        calls.push([url, family]);
        return family === 6 ? '2606:4700::1111' : '10.0.0.1';
      },
    }),
  ).toBe('2606:4700::1111');
  expect(calls[5]).toEqual(['https://1.1.1.1/cdn-cgi/trace', 4]);
  expect(calls[6]).toEqual(['https://api6.ipify.org', 6]);
});

it('uses trace ip field and rejects reserved or failed results', async () => {
  expect(
    await detectPublicIp({
      httpGet: async (url) =>
        url.endsWith('trace') ? 'x=y\nip=8.8.4.4\n' : '203.0.113.1',
    }),
  ).toBe('8.8.4.4');
  expect(
    await detectPublicIp({
      httpGet: async () => {
        throw Error();
      },
    }),
  ).toBeNull();
  expect(
    await detectPublicIp({ httpGet: async () => '2001:db8::1' }),
  ).toBeNull();
});

vi.mock('../../src/core/isp-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/isp-service.js')>();
  return { ...actual, runCommand: vi.fn() };
});
it('runs Docker with an args array, time to pull the image, and generic errors', async () => {
  vi.mocked(runCommand).mockResolvedValueOnce({ code: 0, stdout: 'output', stderr: '' });
  const image = 'ghcr.io/sagernet/sing-box:1.12.0';
  expect(await defaultKeyDeps(image).runSingbox(['generate', 'reality-keypair'])).toBe('output');
  expect(runCommand).toHaveBeenLastCalledWith(
    'docker', ['run', '--rm', image, 'generate', 'reality-keypair'],
    expect.objectContaining({ timeout: IMAGE_PULL_TIMEOUT_MS }),
  );
  vi.mocked(runCommand).mockRejectedValueOnce(new Error('SECRET stdout/stderr'));
  await expect(defaultKeyDeps(image).runSingbox([])).rejects.toThrow(/^Docker command failed\.$/);
  vi.mocked(runCommand).mockResolvedValueOnce({ code: 1, stdout: 'SECRET', stderr: 'SECRET' });
  await expect(defaultKeyDeps(image).runSingbox([])).rejects.toThrow(/^Docker command failed\.$/);
});

it('forwards cancellation to public IP requests and stops retrying after abort', async () => {
  const controller = new AbortController(), reason = new Error('stop IP detection');
  const httpGet = vi.fn(async (_url: string, _family: 4 | 6, signal?: AbortSignal) => {
    expect(signal).toBe(controller.signal);
    controller.abort(reason);
    throw reason;
  });
  await expect(detectPublicIp({ httpGet }, controller.signal)).rejects.toBe(reason);
  expect(httpGet).toHaveBeenCalledTimes(1);
});
