import { accessSync, constants, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { IO } from './commands.js';
import type { IspSocks } from '../model.js';
import { OUT_TAG } from '../model.js';
import { loadSingboxTemplate, type SingboxConfig } from '../core/render-config.js';
import {
  IspError, MANAGED_FILES, checkIspConfig,
  envGet, addIspToConfig, removeIspFromConfig,
  makeTmpPath, installFile, makeBackup, restoreBackup,
  sweepStaleTmp, withLock,
} from '../core/isp.js';
import { envUnquote, envWithIsp, envWithoutIsp } from '../core/env.js';
import { isIspRule, isLegacyIspRule } from '../core/routing.js';
import { isIpv4, isIpv6Strict, parseIspAddr, validCred } from '../core/validate.js';
import { IspService } from '../core/isp-service.js';

class Interrupted extends Error {
  constructor(readonly code: number) { super('Interrupted.'); }
}

export async function ispOutbound(
  io: IO,
  opts: { action?: 'add' | 'remove'; yes: boolean },
): Promise<number> {
  const projectDir = resolve(io.cwd ?? process.cwd());
  const controller = new AbortController();
  const serviceIO = {
    projectDir, env: io.env, sleep: io.sleep,
    stdout: (text: string) => io.stdout(text),
    stderr: (text: string) => io.stderr(text),
  };
  const service = new IspService({ ...serviceIO, signal: controller.signal });
  const warn = (message: string) => io.stderr(`Warning: ${message}\n`);
  const info = (message: string) => io.stdout(message + '\n');
  const path = (name: string) => join(projectDir, name);
  const isFile = (file: string) => existsSync(file) && statSync(file).isFile();
  const tempFiles: string[] = [];
  let backupDir: string;
  let rollbackArmed = false, rollbackNeedsRestart = false;
  let action = opts.action;
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal, i) => {
    const handler = () => {
      if (controller.signal.aborted) return;
      warn(`Interrupted by ${signal.slice(3)}.`);
      controller.abort(new Interrupted([130, 143, 129][i]));
    };
    process.on(signal, handler);
    return { signal, handler };
  });

  const ask = async (prompt: string, secret = false): Promise<string> => {
    controller.signal.throwIfAborted();
    io.stderr(prompt);
    let abort: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    let value: string | null;
    try {
      const reader = secret ? io.readSecret ?? io.readLine : io.readLine;
      value = await Promise.race([reader ? reader.call(io, '') : Promise.resolve(null), interrupted]);
    } finally {
      controller.signal.removeEventListener('abort', abort!);
      if (secret) io.stderr('\n');
    }
    controller.signal.throwIfAborted();
    if (value === null) throw new IspError('Input ended unexpectedly.');
    return value.replace(/\r$/, '');
  };
  const confirmRestart = async () => {
    if (opts.yes) return;
    info('This restarts sing-box. Connections on its configured ports drop for a few seconds.');
    if (!['y', 'Y'].includes(await ask('Continue? [y/N] ')))
      throw new IspError('Aborted. Nothing was changed.');
  };
  const candidate = (data: string | Uint8Array): string => {
    const file = makeTmpPath(projectDir);
    tempFiles.push(file);
    writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
    return file;
  };
  const validateCandidate = async (image: string, file: string) => {
    info(`Validating the candidate config with ${image} ...`);
    if (!await service.checkCandidate(image, file))
      throw new IspError('sing-box rejected the candidate config. Nothing was changed.');
  };
  const preflightConfig = (): { text: string; config: SingboxConfig } => {
    if (!isFile(path('config.json')))
      throw new IspError('config.json does not exist. Run my-singbox gen-config first.');
    const text = readFileSync(path('config.json'), 'utf8');
    let config: unknown;
    try { config = JSON.parse(text); }
    catch { throw new IspError('config.json is not valid JSON.'); }
    checkIspConfig(config);
    return { text, config };
  };
  const rollback = async () => {
    rollbackArmed = false;
    warn('Rolling back to the previous configuration...');
    restoreBackup(projectDir, backupDir, MANAGED_FILES);
    if (rollbackNeedsRestart) {
      // Rollback must still run after the run's signal has been aborted.
      const previous = new IspService(serviceIO);
      if (!await previous.recreate()) {
        await previous.showLogs();
        throw new IspError(`Rollback failed to restart sing-box. Previous files are restored from ${backupDir}; run: docker compose up -d --force-recreate`);
      }
      if (!await previous.verifyService()) {
        await previous.showLogs();
        throw new IspError('Rollback restored the files, but sing-box is not healthy. Check: docker compose logs sing-box');
      }
    }
    io.stderr('Rollback complete. Previous server files are restored.\n');
  };

  const apply = async (
    image: string, original: { text: string; config: SingboxConfig },
    config: SingboxConfig, envText: string, envCandidate: string,
  ): Promise<boolean> => {
    const changed = !isDeepStrictEqual(config, original.config);
    const envChanged = envCandidate !== envText;
    const configText = changed ? JSON.stringify(config, null, 2) + '\n' : original.text;
    if (changed) {
      await validateCandidate(image, candidate(configText));
      await confirmRestart();
    }
    if (!changed && !envChanged) return false;
    backupDir = makeBackup(projectDir, MANAGED_FILES);
    info(`Backup saved in ${backupDir}`);
    rollbackArmed = true;
    controller.signal.throwIfAborted();
    if (changed) {
      rollbackNeedsRestart = true;
      installFile(path('config.json'), configText, projectDir);
    }
    if (envChanged) installFile(path('.env'), envCandidate, projectDir);
    controller.signal.throwIfAborted();
    if ((changed && !await service.recreate()) || !await service.verifyService()) {
      await service.showLogs();
      throw new IspError('sing-box did not come up after the ISP change.');
    }
    controller.signal.throwIfAborted();
    rollbackArmed = false;
    const remainingTags = new Set(config.inbounds.map((inbound) => inbound.tag));
    const retiredPorts = original.config.inbounds
      .filter((inbound) => !remainingTags.has(inbound.tag))
      .map((inbound) => inbound.listen_port);
    if (retiredPorts.length)
      info(`Regenerate the client clash.yaml; legacy ISP ports ${retiredPorts.join('/')} can now be closed.`);
    return true;
  };

  const add = async (image: string) => {
    const original = preflightConfig();
    if (!isFile(path('.env')))
      throw new IspError('.env does not exist. Run my-singbox gen-keys first.');
    const envText = readFileSync(path('.env'), 'utf8');
    const isp = await collectInputs(envText, ask);
    info('Checking the SOCKS5 proxy (TCP) and its egress IP...');
    const got = await service.socksEgressIp(isp);
    if (!got)
      throw new IspError("Could not reach an IP echo service through the SOCKS5 proxy. Check the address, username and password, and that this server's IP is allowed by the ISP. Nothing was changed.");
    const expected = isp.egressIp || isp.host;
    if (got.toLowerCase() !== expected.toLowerCase())
      throw new IspError(`Egress IP through the proxy is ${got}, expected ${expected}. If the ISP's egress differs from its entry IP, enter the egress IP when asked. Nothing was changed.`);
    info(`Egress IP through the SOCKS5 proxy: ${got} (matches).`);
    const hasIspPolicy = original.config.route?.final === OUT_TAG ||
      original.config.route?.rules?.some((rule) => isIspRule(rule) && !isLegacyIspRule(rule));
    const routeDefaults = hasIspPolicy ? undefined : loadSingboxTemplate(projectDir).route;
    const config = addIspToConfig(original.config, isp, routeDefaults);
    const changed = await apply(image, original, config, envText,
      envWithIsp(envText, { ...isp, egressIp: isp.egressIp ?? '' }));
    if (!changed) {
      info('config.json already has this ISP outbound.');
      if (!await service.verifyService()) {
        warn('sing-box is not healthy. Restarting it once...');
        await confirmRestart();
        if (!await service.recreate() || !await service.verifyService()) {
          await service.showLogs();
          throw new IspError('sing-box is still not healthy after a restart. Server files were not changed.');
        }
      }
    }
    info('\nISP outbound is configured. config.json route rules decide which traffic uses isp-socks.');
    info(`Server route.final: ${config.route?.final ?? 'direct'}. Existing rule order is preserved; check for earlier matching rules when customizing routing.`);
    info('Only TCP through the SOCKS5 proxy was tested; actual domain routing and UDP require separate verification.');
  };

  const remove = async (image: string) => {
    const original = preflightConfig();
    const envText = isFile(path('.env')) ? readFileSync(path('.env'), 'utf8') : '';
    const config = removeIspFromConfig(original.config);
    const changed = await apply(image, original, config, envText, envWithoutIsp(envText));
    info(changed ? `\nISP outbound and its targeted rules removed. Other server settings are preserved; route.final: ${config.route?.final ?? 'direct'}.`
      : '\nNo ISP outbound was configured. Nothing to remove.');
  };

  try {
    if (!await service.composeAvailable()) throw new IspError('docker compose is not available.');
    const docker = await service.dockerInfo();
    if (docker === 'permission-denied')
      throw new IspError('permission denied while talking to the Docker daemon (the Docker socket is not accessible to this user). Nothing was changed.\n' +
        'Do one of these, then re-run:\n' +
        `  - run it with sudo:  sudo my-singbox isp-outbound ${action ? `--${action}` : ''}\n` +
        '  - or add your user to the docker group and log in again:  sudo usermod -aG docker "$USER"   (then log out and back in)');
    if (docker === 'down')
      throw new IspError('Docker daemon is not running (or not reachable). Start it and re-run. Nothing was changed.');
    const image = await service.containerImage();
    if (!image) throw new IspError('Container sing-box not found. Run my-singbox start first.');
    const sudoHint = `sudo my-singbox isp-outbound ${action ? `--${action}` : ''}`;
    try { accessSync(projectDir, constants.W_OK); }
    catch {
      throw new IspError(`No permission to write in ${projectDir}. Run with sudo (${sudoHint}) or fix the directory's permissions. Nothing was changed.`);
    }
    for (const name of MANAGED_FILES) {
      const file = path(name);
      if (!existsSync(file)) continue;
      try { accessSync(file, constants.R_OK | constants.W_OK); }
      catch {
        throw new IspError(`No permission to read and write ${file}. Run with sudo (${sudoHint}) or fix the file's permissions. Nothing was changed.`);
      }
    }
    if (!action) {
      info('1) Add ISP outbound\n2) Remove ISP outbound\nq) Quit');
      const choice = await ask('Choose: ');
      if (choice === 'q' || choice === 'Q') return 0;
      if (choice === '1') action = 'add';
      else if (choice === '2') action = 'remove';
      else throw new IspError('Invalid choice.');
    }
    return await withLock(projectDir, async () => {
      try {
        controller.signal.throwIfAborted();
        sweepStaleTmp(projectDir);
        if (action === 'add') await add(image);
        else await remove(image);
        return 0;
      } catch (error) {
        if (rollbackArmed) {
          if (error instanceof Interrupted) {
            try { await rollback(); }
            catch (rollbackError) { io.stderr(`Error: ${(rollbackError as Error).message}\n`); }
          } else await rollback();
        }
        throw error;
      } finally {
        for (const file of tempFiles) rmSync(file, { force: true, recursive: true });
      }
    });
  } catch (error) {
    if (controller.signal.aborted) return (controller.signal.reason as Interrupted).code;
    throw error;
  } finally {
    for (const { signal, handler } of handlers) process.removeListener(signal, handler);
  }
}

async function collectInputs(
  text: string,
  ask: (prompt: string, secret?: boolean) => Promise<string>,
): Promise<IspSocks> {
  const currentAddr = envGet(text, 'ISP_SOCKS_ADDR') ?? '';
  const currentUser = envUnquote(envGet(text, 'ISP_SOCKS_USER') ?? '') ?? '';
  const currentPass = envUnquote(envGet(text, 'ISP_SOCKS_PASS') ?? '') ?? '';
  const currentEgress = envGet(text, 'ISP_SOCKS_EGRESS_IP') ?? '';
  const raw = (await ask(currentAddr
    ? `ISP SOCKS5 entry address host:port [${currentAddr}]: `
    : 'ISP SOCKS5 entry address (IPv4:port or [IPv6]:port): ')).trim() || currentAddr;
  const address = parseIspAddr(raw);
  if (!address) throw new IspError('Invalid address. Use IPv4:port or [IPv6]:port with a numeric port 1-65535.');
  const user = await ask(currentUser ? 'SOCKS5 username [keep current]: ' : 'SOCKS5 username: ') || currentUser;
  if (!validCred(user)) throw new IspError('Invalid username: it must be 1-255 bytes with no control characters, and valid UTF-8.');
  if (user.includes(':')) throw new IspError("Invalid username: it must not contain ':'.");
  let pass = await ask(currentPass
    ? 'SOCKS5 password (leave blank to keep the current one): ' : 'SOCKS5 password: ', true);
  if (!pass && currentPass) pass = currentPass;
  else if (pass !== await ask('Repeat the password: ', true))
    throw new IspError('The passwords do not match.');
  if (!validCred(pass)) throw new IspError('Invalid password: it must be 1-255 bytes with no control characters, and valid UTF-8.');
  let egressIp = (await ask(currentEgress
    ? `Expected egress IP, if it differs from the entry IP [${currentEgress}; '-' resets to ${address.host}]: `
    : `Expected egress IP, if it differs from the entry IP (Enter = the entry IP ${address.host}): `)).trim();
  if (currentEgress) egressIp = egressIp === '-' ? '' : egressIp || currentEgress;
  if (egressIp && !isIpv4(egressIp) && !isIpv6Strict(egressIp)) throw new IspError('Invalid expected egress IP.');
  return { ...address, user, pass, egressIp };
}
