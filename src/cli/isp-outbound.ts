import {
  accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { IO } from './commands.js';
import type { IspSocks } from '../model.js';
import type { SingboxConfig } from '../core/render-config.js';
import {
  SS_PORT, VLESS_PORT, SS_ISP_PORT, VLESS_ISP_PORT, SS_ISP_TAG, VLESS_ISP_TAG,
  NODE_SS_ISP, NODE_VLESS_ISP,
} from '../model.js';
import {
  IspError, MANAGED_FILES, GROUP_MAIN, checkIspConfig, configHasIsp,
  envGet, envHasIsp, clashHasIsp, addIspToConfig, addIspToClash,
  makeTmpPath, installFile, makeBackup, findCleanBackup, restoreBackup,
  sweepStaleTmp, withLock,
} from '../core/isp.js';
import { envUnquote, envWithIsp } from '../core/env.js';
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
  let rollbackArmed = false;
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
    info('This restarts sing-box. Connections on 8388 and 8443 drop for a few seconds.');
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
  const saveBackup = () => {
    backupDir = makeBackup(projectDir);
    info(`Backup saved in ${backupDir}`);
  };
  const rollback = async () => {
    rollbackArmed = false;
    warn('Rolling back to the previous configuration...');
    restoreBackup(projectDir, backupDir);
    // Rollback must still run after the run's signal has been aborted.
    const previous = new IspService(serviceIO);
    if (!await previous.recreate()) {
      await previous.showLogs();
      throw new IspError(`Rollback failed to restart sing-box. Previous files are restored from ${backupDir}; run: docker compose up -d --force-recreate`);
    }
    if (!await previous.verifyService(false)) {
      await previous.showLogs();
      throw new IspError('Rollback restored the files, but sing-box is not healthy. Check: docker compose logs sing-box');
    }
    io.stderr('Rollback complete. sing-box is running the previous configuration.\n');
  };

  const add = async (image: string) => {
    const original = preflightConfig();
    if (!isFile(path('.env')))
      throw new IspError('.env does not exist. Run my-singbox gen-keys first.');
    if (!configHasIsp(original.config)) await service.portsFree();
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

    const envCandidate = envWithIsp(envText, { ...isp, egressIp: isp.egressIp ?? '' });
    candidate(envCandidate);
    const config = addIspToConfig(original.config, isp);
    const configText = isDeepStrictEqual(config, original.config)
      ? original.text : JSON.stringify(config, null, 2) + '\n';
    const cfgCandidate = candidate(configText);
    await validateCandidate(image, cfgCandidate);
    let clashText: string | undefined, clashCandidate: string | undefined;
    let clashState: string;
    if (isFile(path('clash.yaml'))) {
      clashText = readFileSync(path('clash.yaml'), 'utf8');
      clashCandidate = addIspToClash(clashText, envGet(envText, 'REALITY_PRIVATE_KEY'));
      candidate(clashCandidate);
      clashState = `clash.yaml updated (nodes ${NODE_SS_ISP} and ${NODE_VLESS_ISP} added and listed in the ${GROUP_MAIN} group).`;
    } else {
      warn('clash.yaml does not exist, so only the server config is changed. After running my-singbox conf-clash, re-run my-singbox isp-outbound --add to add the client nodes.');
      clashState = 'clash.yaml not found (skipped).';
    }
    const changed = configText !== original.text;
    const envChanged = envCandidate !== envText;
    const clashChanged = clashCandidate !== clashText;
    if (changed) await confirmRestart();
    if (changed || envChanged || clashChanged) saveBackup();

    if (changed) {
      rollbackArmed = true;
      installFile(path('config.json'), configText, projectDir);
      if (!await service.recreate() || !await service.verifyService(true)) {
        await service.showLogs();
        await rollback();
        throw new IspError('The ISP outbound did not come up. The previous configuration was restored.');
      }
      rollbackArmed = false;
    } else {
      info('config.json already has this ISP outbound.');
      if (!await service.verifyService(true)) {
        warn('sing-box is not running the ISP configuration. Restarting it once...');
        await confirmRestart();
        if (!await service.recreate() || !await service.verifyService(true)) {
          await service.showLogs();
          throw new IspError('sing-box still does not run the ISP outbound after a restart. config.json, .env and clash.yaml were not changed. Check: docker compose logs sing-box');
        }
      }
    }
    if (envChanged) installFile(path('.env'), envCandidate, projectDir);
    if (clashChanged) installFile(path('clash.yaml'), clashCandidate!, projectDir);
    info(`
ISP outbound is active.
  shadowsocks-isp    port ${SS_ISP_PORT} (tcp+udp), tag ${SS_ISP_TAG}
  vless-reality-isp  port ${VLESS_ISP_PORT} (tcp),    tag ${VLESS_ISP_TAG}
  ${clashState}
  Ports ${SS_PORT} and ${VLESS_PORT} are unchanged and still go out directly.
Notes:
  - Only TCP was tested. UDP through the ISP (Shadowsocks UDP) works only if the proxy supports SOCKS5 UDP ASSOCIATE.
  - If the ISP proxy stops working, the ISP nodes fail. They never fall back to a direct connection.
  - Re-import clash.yaml in your clients to see the new ${NODE_SS_ISP} and ${NODE_VLESS_ISP} nodes in the ${GROUP_MAIN} group.`);
    portNotice(io, 'add');
  };

  const remove = async (image: string) => {
    const original = preflightConfig();
    const envText = isFile(path('.env')) ? readFileSync(path('.env'), 'utf8') : '';
    const clashText = isFile(path('clash.yaml')) ? readFileSync(path('clash.yaml'), 'utf8') : '';
    if (!configHasIsp(original.config) && !envHasIsp(envText) && !clashHasIsp(clashText)) {
      info('\nNo ISP outbound was configured. Nothing to remove.');
      portNotice(io, 'remove');
      return;
    }
    const cleanBackup = findCleanBackup(projectDir);
    if (!cleanBackup)
      throw new IspError('No backup from before the ISP outbound was added was found in .isp-backup. Nothing was changed.');
    // Stage the selected backup before rotation can prune it from .isp-backup.
    const staged = makeTmpPath(projectDir);
    tempFiles.push(staged);
    mkdirSync(staged, { mode: 0o700 });
    restoreBackup(staged, cleanBackup);
    const changed = (name: string) => isFile(join(staged, name)) &&
      (!isFile(path(name)) || !readFileSync(join(staged, name)).equals(readFileSync(path(name))));
    const cfgChanged = changed('config.json');
    const envChanged = changed('.env');
    const clashChanged = changed('clash.yaml');
    if (cfgChanged) {
      await validateCandidate(image, candidate(readFileSync(join(staged, 'config.json'))));
      await confirmRestart();
    }
    if (cfgChanged || envChanged || clashChanged) {
      saveBackup();
      rollbackArmed = true;
      restoreBackup(projectDir, staged);
      if (cfgChanged && (!await service.recreate() || !await service.verifyService(false))) {
        await service.showLogs();
        await rollback();
        throw new IspError('sing-box did not come up after removing the ISP outbound. The previous configuration was restored.');
      }
      rollbackArmed = false;
    }
    info('\nISP outbound removed.');
    info(`  Restored files from ${cleanBackup}`);
    if (cfgChanged) info('  config.json: ISP inbounds, outbound and route rule removed; sing-box restarted.');
    if (envChanged) info('  .env: ISP_SOCKS_* keys removed.');
    if (clashChanged) info(`  clash.yaml: ISP nodes removed from the nodes list and the ${GROUP_MAIN} group. Re-import it in your clients.`);
    portNotice(io, 'remove');
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
    if (controller.signal.aborted)
      return (controller.signal.reason as Interrupted).code;
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
  if (egressIp && !isIpv4(egressIp) && !isIpv6Strict(egressIp))
    throw new IspError('Invalid expected egress IP.');
  return { ...address, user, pass, egressIp };
}

function portNotice(io: IO, action: 'add' | 'remove'): void {
  io.stdout('\n' + (action === 'add' ? ADD_PORT_NOTICE : REMOVE_PORT_NOTICE));
}

const ADD_PORT_NOTICE = `ACTION REQUIRED: allow these ports yourself. This script does not open any port.
  ${SS_ISP_PORT}/tcp  (${SS_ISP_TAG}, Shadowsocks)
  ${SS_ISP_PORT}/udp  (${SS_ISP_TAG}, Shadowsocks)
  ${VLESS_ISP_PORT}/tcp  (${VLESS_ISP_TAG}, VLESS Reality)
Allow them in BOTH places, otherwise the new ports are not reachable from outside:
  1. the local firewall on this server, if you run one (ufw, firewalld or iptables);
  2. your cloud provider's security group (or network ACL) for this server.
Ports ${SS_PORT} and ${VLESS_PORT} are not affected.

Example commands for reference (run as root, use the one for your firewall):
  ufw (rules are persistent already):
    ufw allow ${SS_ISP_PORT}/tcp
    ufw allow ${SS_ISP_PORT}/udp
    ufw allow ${VLESS_ISP_PORT}/tcp
  firewalld (use --permanent, then --reload):
    firewall-cmd --permanent --add-port=${SS_ISP_PORT}/tcp
    firewall-cmd --permanent --add-port=${SS_ISP_PORT}/udp
    firewall-cmd --permanent --add-port=${VLESS_ISP_PORT}/tcp
    firewall-cmd --reload
  iptables (lost on reboot unless saved; repeat with ip6tables if you filter IPv6):
    iptables -I INPUT -p tcp --dport ${SS_ISP_PORT} -j ACCEPT
    iptables -I INPUT -p udp --dport ${SS_ISP_PORT} -j ACCEPT
    iptables -I INPUT -p tcp --dport ${VLESS_ISP_PORT} -j ACCEPT
    then save them: netfilter-persistent save
    or: iptables-save > /etc/iptables/rules.v4
    (install iptables-persistent first if it is missing: apt-get install -y iptables-persistent;
     both ways save the whole current iptables ruleset, not only these rules)
`;

const REMOVE_PORT_NOTICE = `NOTE: the ISP ports are no longer used, so you can now close them yourself. This script does not close any port.
  ${SS_ISP_PORT}/tcp
  ${SS_ISP_PORT}/udp
  ${VLESS_ISP_PORT}/tcp
Close them in BOTH places if you opened them:
  1. the local firewall on this server;
  2. your cloud provider's security group (or network ACL).
Closing a rule by port also removes a rule you added yourself for the same port, so check first.

Example commands for reference (run as root, use the one for your firewall):
  ufw:
    ufw delete allow ${SS_ISP_PORT}/tcp
    ufw delete allow ${SS_ISP_PORT}/udp
    ufw delete allow ${VLESS_ISP_PORT}/tcp
  firewalld (use --permanent, then --reload):
    firewall-cmd --permanent --remove-port=${SS_ISP_PORT}/tcp
    firewall-cmd --permanent --remove-port=${SS_ISP_PORT}/udp
    firewall-cmd --permanent --remove-port=${VLESS_ISP_PORT}/tcp
    firewall-cmd --reload
  iptables (then save the ruleset, as above):
    iptables -D INPUT -p tcp --dport ${SS_ISP_PORT} -j ACCEPT
    iptables -D INPUT -p udp --dport ${SS_ISP_PORT} -j ACCEPT
    iptables -D INPUT -p tcp --dport ${VLESS_ISP_PORT} -j ACCEPT
    then: netfilter-persistent save   (or: iptables-save > /etc/iptables/rules.v4)
`;
