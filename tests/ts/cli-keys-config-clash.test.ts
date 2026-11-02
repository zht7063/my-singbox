/* Bats -> Vitest (same names unless an explicit arrow is shown):
gen-keys: requires SING_BOX_VERSION -> gen-keys: requires SING_BOX_VERSION
gen-keys: refuses to overwrite an existing .env -> gen-keys: refuses to overwrite an existing .env
gen-keys: fails before generating anything when the Docker daemon is down -> gen-keys: fails before generating anything when the Docker daemon is down
gen-keys: writes a complete mode-600 .env that gen-config and conf-clash accept -> gen-keys: writes a complete mode-600 .env that gen-config and conf-clash accept
gen-keys: prompts for the address when detection fails -> gen-keys: prompts for the address when detection fails
gen-config: renders config.json from .env -> gen-config: renders config.json from .env
gen-config: output is mode 600 and has no leftover placeholders -> gen-config: output is mode 600 and has no leftover placeholders
gen-config: credentials land beside the right fields -> gen-config: credentials land beside the right fields
gen-config: client-only public key and server address are not written -> gen-config: client-only public key and server address are not written
gen-config: keeps the original two inbounds and the direct outbound -> gen-config: keeps the original two inbounds and the direct outbound
gen-config: refuses to overwrite an existing config.json -> gen-config: refuses to overwrite an existing config.json
gen-config: dies on an unknown .env key -> gen-config: dies on an unknown .env key
gen-config: dies on a duplicate .env key -> gen-config: dies on a duplicate .env key
gen-config: dies on a missing required key -> gen-config: dies on a missing required key
gen-config: dies on a malformed .env line -> gen-config: dies on a malformed .env line
gen-config: dies on invalid credential formats -> gen-config: dies on invalid credential formats
gen-config: dies when .env is missing -> gen-config: dies when .env is missing
gen-config: tolerates CRLF line endings and comments in .env -> gen-config: tolerates CRLF line endings and comments in .env
gen-config: does not depend on the current directory -> gen-config: uses the injected project directory (CLI cwd intentionally replaces script location)
conf-clash: renders clash.yaml from .env -> conf-clash: renders clash.yaml from .env
conf-clash: output is mode 600 and has no leftover placeholders -> conf-clash: output is mode 600 and has no leftover placeholders
conf-clash: client credentials are filled in -> conf-clash: client credentials are filled in
conf-clash: never writes the Reality private key -> conf-clash: never writes the Reality private key
conf-clash: has the two proxies and the Proxy group -> conf-clash: has the two proxies and the Proxy group
conf-clash: refuses to overwrite an existing clash.yaml -> conf-clash: refuses to overwrite an existing clash.yaml
conf-clash: dies on an unknown .env key -> conf-clash: dies on an unknown .env key
conf-clash: dies on a duplicate .env key -> conf-clash: dies on a duplicate .env key
conf-clash: a key missing from .env falls back to the template placeholder and is rejected -> conf-clash: a key missing from .env falls back to the template placeholder and is rejected
conf-clash: dies while SERVER_ADDRESS is still the template placeholder -> conf-clash: dies while SERVER_ADDRESS is still the template placeholder
conf-clash: rejects an invalid SERVER_ADDRESS -> conf-clash: rejects an invalid SERVER_ADDRESS
conf-clash: accepts a hostname and an IPv6 SERVER_ADDRESS -> conf-clash: accepts a hostname and an IPv6 SERVER_ADDRESS
conf-clash: rejects invalid credential formats -> conf-clash: rejects invalid credential formats
conf-clash: dies when .env is missing -> conf-clash: dies when .env is missing
*/
import { it, expect, vi } from 'vitest';
import { existsSync, writeFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { project, invoke, read, keyDeps } from './helpers/cli.js';
import { creds, fixtureText } from './helpers/fixtures.js';
import { envWithIsp } from '../../src/core/env.js';
import * as templates from '../../src/core/templates.js';

it('gen-keys: requires SING_BOX_VERSION', async () => {
  for (const env of [{}, { SING_BOX_VERSION: '' }]) {
    const dir = project(null);
    const deps = keyDeps();
    expect(await invoke('gen-keys', dir, { env, deps })).toEqual({ code: 1, stdout: '', stderr: 'Error: Please set SING_BOX_VERSION\n' });
    expect(deps.dockerAvailable).not.toHaveBeenCalled();
    expect(existsSync(join(dir, '.env'))).toBe(false);
  }
});

it('gen-keys: refuses to overwrite an existing .env', async () => {
  const dir = project('sentinel');
  const deps = keyDeps();
  expect((await invoke('gen-keys', dir, { deps })).stderr).toBe('Error: .env already exists. Refusing to overwrite.\n');
  expect(deps.dockerAvailable).not.toHaveBeenCalled();
  expect(read(dir, '.env')).toBe('sentinel');
});

it.each([
  ['docker CLI is missing', 'dockerAvailable', 'docker is not installed.'],
  ['fails before generating anything when the Docker daemon is down', 'dockerDaemonUp', 'Docker daemon is not running.'],
] as const)('gen-keys: %s', async (_name, probe, message) => {
  const dir = project(null), deps = keyDeps();
  deps[probe] = vi.fn(async () => false);
  const result = await invoke('gen-keys', dir, { deps });
  expect(result).toEqual({ code: 1, stdout: '', stderr: `Error: ${message}\n` });
  expect(deps.detectPublicIp).not.toHaveBeenCalled();
  expect(deps.runSingbox).not.toHaveBeenCalled();
  expect(existsSync(join(dir, '.env'))).toBe(false);
});

it('gen-keys: writes a complete mode-600 .env that gen-config and conf-clash accept', async () => {
  const dir = project(null);
  const result = await invoke('gen-keys', dir);
  expect(result).toEqual({ code: 0, stderr: '', stdout: `Detecting public IP address...\nDetected public IP address: 8.8.8.8\nGenerating credentials...\nCredentials generated successfully.\nSaved to: ${dir}/.env\n` });
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
  expect(read(dir, '.env')).toBe(fixtureText().replace(creds.serverAddress, '8.8.8.8'));
  expect((await invoke('gen-config', dir)).code).toBe(0);
  expect((await invoke('conf-clash', dir)).code).toBe(0);
});

it('gen-keys: prompts for the address when detection fails', async () => {
  const dir = project(null), deps = keyDeps();
  deps.detectPublicIp = async () => null;
  const readLine = vi.fn().mockResolvedValueOnce('10.0.0.1').mockResolvedValueOnce(' 8.8.4.4 ');
  const result = await invoke('gen-keys', dir, { deps, readLine });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('Could not detect a public IP address.\nError: Enter a public IP address.\n');
  expect(readLine.mock.calls).toEqual([['Public IP address of this machine: '], ['Public IP address of this machine: ']]);
  expect(read(dir, '.env')).toContain('SERVER_ADDRESS=8.8.4.4\n');
});

it.each(['EOF', 'invalid keys', 'docker generation failure'])('gen-keys: writes nothing on %s', async (failure) => {
  const dir = project(null), deps = keyDeps();
  if (failure === 'EOF') deps.detectPublicIp = async () => null;
  if (failure === 'invalid keys') deps.randomUuid = () => 'invalid';
  if (failure === 'docker generation failure') deps.runSingbox = async () => { throw Error('Docker command failed.'); };
  const result = await invoke('gen-keys', dir, { deps, readLine: async () => null });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(failure === 'EOF' ? 'Error: Failed to read the public IP address.' : failure === 'invalid keys' ? 'Error: Invalid generated credentials.' : 'Error: Docker command failed.');
  expect(readdirSync(dir).filter((n) => n.startsWith('.env'))).toEqual([]);
});

for (const [cmd, file, message] of [
  ['gen-config', 'config.json', 'Config generated successfully.'],
  ['conf-clash', 'clash.yaml', 'Clash config generated successfully.'],
] as const) {
  it(`${cmd}: renders ${file} from .env`, async () => {
    const dir = project();
    expect(await invoke(cmd, dir)).toEqual({ code: 0, stderr: '', stdout: `${message}\nSaved to: ${dir}/${file}\n` });
    expect(existsSync(join(dir, file))).toBe(true);
  });
  it(`${cmd}: output is mode 600 and has no leftover placeholders`, async () => {
    const dir = project();
    expect((await invoke(cmd, dir)).code).toBe(0);
    expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    expect(read(dir, file)).not.toContain('${');
  });
  it(`${cmd}: refuses to overwrite an existing ${file}`, async () => {
    const dir = project('malformed env must not be parsed');
    writeFileSync(join(dir, file), 'sentinel');
    expect(await invoke(cmd, dir)).toEqual({ code: 1, stdout: '', stderr: `Error: ${file} already exists. Refusing to overwrite.\n` });
    expect(read(dir, file)).toBe('sentinel');
  });
  for (const [name, text, error] of [
    ['dies on an unknown .env key', fixtureText() + 'FOO_BAR=1\n', 'Unknown key in .env: FOO_BAR'],
    ['dies on a duplicate .env key', fixtureText() + `VLESS_UUID=${creds.vlessUuid}\n`, 'Duplicate key in .env: VLESS_UUID'],
    ['dies on a malformed .env line', fixtureText() + 'not a key value line\n', 'Invalid line'],
    [cmd === 'gen-config' ? 'dies on invalid credential formats' : 'rejects invalid credential formats', fixtureText().replace(creds.ssPassword, 'short'), cmd === 'gen-config' ? 'Invalid credentials in .env.' : 'Invalid SS_PASSWORD.'],
  ]) {
    it(`${cmd}: ${name}`, async () => {
      const dir = project(text);
      const result = await invoke(cmd, dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(error);
      expect(existsSync(join(dir, file))).toBe(false);
    });
  }
  it(`${cmd}: dies when .env is missing`, async () => {
    const dir = project(null);
    expect(await invoke(cmd, dir)).toEqual({ code: 1, stdout: '', stderr: 'Error: .env does not exist. Run my-singbox gen-keys first.\n' });
  });
  it.each([false, true])(`${cmd}: ISP enabled=%s`, async (enabled) => {
    const dir = project(fixtureText(enabled));
    expect((await invoke(cmd, dir)).code).toBe(0);
    const config = cmd === 'gen-config' ? JSON.parse(read(dir, file)) : parse(read(dir, file));
    expect(cmd === 'gen-config' ? config.inbounds.length : config.proxies.length).toBe(enabled ? 4 : 2);
  });
}

it('gen-config: credentials land beside the right fields', async () => {
  const dir = project();
  await invoke('gen-config', dir);
  const [ss, reality] = JSON.parse(read(dir, 'config.json')).inbounds;
  expect(ss.password).toBe(creds.ssPassword);
  expect(reality.users[0].uuid).toBe(creds.vlessUuid);
  expect(reality.tls.reality.private_key).toBe(creds.realityPrivateKey);
  expect(reality.tls.reality.short_id).toEqual([creds.realityShortId]);
});
it('gen-config: client-only public key and server address are not written', async () => {
  const dir = project();
  await invoke('gen-config', dir);
  expect(read(dir, 'config.json')).not.toContain(creds.realityPublicKey);
  expect(read(dir, 'config.json')).not.toContain(creds.serverAddress);
});
it('gen-config: keeps the original two inbounds and the direct outbound', async () => {
  const dir = project();
  await invoke('gen-config', dir);
  const config = JSON.parse(read(dir, 'config.json'));
  expect(config.inbounds.map((n: { listen_port: number }) => n.listen_port)).toEqual([8388, 8443]);
  expect(config.outbounds.map((n: { tag: string }) => n.tag)).toEqual(['direct']);
});
it('gen-config: dies on a missing required key', async () => {
  const dir = project(fixtureText().replace(/^SS_PASSWORD=.*\n/m, ''));
  expect((await invoke('gen-config', dir)).stderr).toBe('Error: Missing .env key: SS_PASSWORD\n');
  expect(existsSync(join(dir, 'config.json'))).toBe(false);
});
it('gen-config: tolerates CRLF line endings and comments in .env', async () => {
  const dir = project(fixtureText().replaceAll('\n', '\r\n') + '# comment\r\n\r\n');
  expect((await invoke('gen-config', dir)).code).toBe(0);
});
it('gen-config: uses the injected project directory', async () => {
  const dir = project();
  expect(dir).not.toBe(process.cwd());
  expect((await invoke('gen-config', dir)).code).toBe(0);
  expect(existsSync(join(dir, 'config.json'))).toBe(true);
});
it('conf-clash: client credentials are filled in', async () => {
  const dir = project();
  await invoke('conf-clash', dir);
  const [ss, reality] = parse(read(dir, 'clash.yaml')).proxies;
  expect(ss.server).toBe(creds.serverAddress);
  expect(reality.server).toBe(creds.serverAddress);
  expect(ss.password).toBe(creds.ssPassword);
  expect(reality.uuid).toBe(creds.vlessUuid);
  expect(reality['reality-opts']).toEqual({ 'public-key': creds.realityPublicKey, 'short-id': creds.realityShortId });
});
it('conf-clash: never writes the Reality private key', async () => {
  const dir = project();
  await invoke('conf-clash', dir);
  expect(read(dir, 'clash.yaml')).not.toContain(creds.realityPrivateKey);
});
it('conf-clash: has the two proxies and the Proxy group', async () => {
  const dir = project();
  await invoke('conf-clash', dir);
  const config = parse(read(dir, 'clash.yaml'));
  expect(config.proxies.map((n: { name: string }) => n.name)).toEqual(['shadowsocks', 'vless-reality']);
  expect(config['proxy-groups'].find((g: { name: string }) => g.name === 'Proxy').proxies).toEqual(['shadowsocks', 'vless-reality', 'DIRECT']);
});
it('conf-clash: a key missing from .env falls back to the template placeholder and is rejected', async () => {
  const dir = project(fixtureText().replace(/^REALITY_PUBLIC_KEY=.*\n/m, ''));
  expect((await invoke('conf-clash', dir)).stderr).toBe('Error: Invalid REALITY_PUBLIC_KEY.\n');
  expect(existsSync(join(dir, 'clash.yaml'))).toBe(false);
});
it('conf-clash: dies while SERVER_ADDRESS is still the template placeholder', async () => {
  const dir = project(fixtureText().replace(creds.serverAddress, '<server-address>'));
  expect((await invoke('conf-clash', dir)).stderr).toContain('Error: Set SERVER_ADDRESS');
});
it('conf-clash: rejects an invalid SERVER_ADDRESS', async () => {
  const dir = project(fixtureText().replace(creds.serverAddress, '999.1.1.1'));
  expect((await invoke('conf-clash', dir)).stderr).toContain('Error: Invalid SERVER_ADDRESS');
});
it('conf-clash: accepts a hostname and an IPv6 SERVER_ADDRESS', async () => {
  for (const server of ['vpn.example.com', '2001:db8::1']) {
    const dir = project(fixtureText().replace(creds.serverAddress, server));
    expect((await invoke('conf-clash', dir)).code).toBe(0);
    expect(parse(read(dir, 'clash.yaml')).proxies[0].server).toBe(server);
  }
});
it('conf-clash: loads defaults first, unions keys, and lets .env override', async () => {
  const dir = project(fixtureText().replace(/^REALITY_PUBLIC_KEY=.*\n/m, ''));
  writeFileSync(join(dir, 'templates/.env.template'), envWithIsp(fixtureText().replace(creds.serverAddress, 'default.example.com'), { addr: '198.51.100.7:1080', user: 'fixture', pass: 'fixture', egressIp: '' }));
  expect((await invoke('conf-clash', dir)).code).toBe(0);
  const config = parse(read(dir, 'clash.yaml'));
  expect(config.proxies).toHaveLength(4);
  expect(config.proxies[0].server).toBe(creds.serverAddress);
});
it('conf-clash: rejects invalid defaults before reading .env with the template label', async () => {
  const dir = project('also malformed');
  writeFileSync(join(dir, 'templates/.env.template'), 'BROKEN=fixture');
  expect((await invoke('conf-clash', dir)).stderr).toBe('Error: Unknown key in templates/.env.template: BROKEN\n');
});
it.each(['gen-config', 'conf-clash'])('%s: uses package templates without local templates', async (cmd) => {
  const dir = project();
  rmSync(join(dir, 'templates'), { recursive: true });
  expect((await invoke(cmd, dir)).code).toBe(0);
});

it.each([
  ['gen-config', 'config.json'],
  ['conf-clash', 'clash.yaml'],
])('%s: checks missing .env, missing template, then existing output', async (cmd, file) => {
  const dir = project(null);
  writeFileSync(join(dir, file), 'sentinel');
  const message = `Template does not exist: ${dir}/templates/${file}.template`;
  const lookup = vi.spyOn(templates, 'findTemplate').mockImplementation(() => { throw Error(message); });
  try {
    expect((await invoke(cmd, dir)).stderr).toBe('Error: .env does not exist. Run my-singbox gen-keys first.\n');
    expect(lookup).not.toHaveBeenCalled();
    writeFileSync(join(dir, '.env'), 'malformed env must not be parsed');
    expect((await invoke(cmd, dir)).stderr).toBe(`Error: ${message}\n`);
    expect(read(dir, file)).toBe('sentinel');
  } finally {
    lookup.mockRestore();
  }
});
