import { expect } from 'vitest';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { envQuote } from '../../../src/core/env.js';
import type { SingboxConfig } from '../../../src/core/render-config.js';
import { invoke, project, root, shellEnv } from './cli.js';
import { creds, fixtureText } from './fixtures.js';

// Obviously fake credentials, shared by the shell behavior reference.
export const address = '198.51.100.7:1080';
export const username = 'isp-user';
export const password = 'S3cret-pass';
export const cleanListeners = 'tcp 8388\nudp 8388\ntcp 8443\n';
export const freshLines = (addr = address, user = username, pass = password, egress = '') =>
  [addr, user, pass, pass, egress];
export type Result = { code: number; stdout: string; stderr: string };
export type Switch = 'fail_check' | 'break_isp' | 'break_clean' | 'fail_up_isp' |
  'fail_exec_check' | 'docker_down' | 'no_container' | 'fail_curl' | 'term_on_up' |
  'docker_denied';

const docker = String.raw`
echo "docker $*" >> "$STUB_LOG"
S="$STUB_STATE"
case "$1" in
  info)
    if [[ -e "$S/docker_denied" ]]; then echo 'permission denied: Docker daemon socket' >&2; exit 1; fi
    [[ -e "$S/docker_down" ]] && exit 1
    exit 0 ;;
  inspect)
    case "$*" in
      *Config.Image*) [[ -e "$S/no_container" ]] && exit 1; echo ghcr.io/sagernet/sing-box:stub ;;
      *State.Status*) cat "$S/status" ;;
    esac
    exit 0 ;;
  run)
    if [[ -e "$S/fail_check" ]]; then echo 'FATAL[0000] stub: config check failed' >&2; exit 1; fi
    for a in "$@"; do
      if [[ "$a" == *:/etc/sing-box/config.json:ro ]]; then
        cp "${'${'}a%:/etc/sing-box/config.json:ro}" "$S/last-check-config"
        "$REAL_JQ" -e '.inbounds | length >= 2' "$S/last-check-config" >/dev/null || exit 1
      fi
    done
    exit 0 ;;
  compose)
    shift
    if [[ "$1" == --project-directory ]]; then proj=$2; shift 2; fi
    case "$1" in
      version) echo 'Docker Compose version v2.0.0-stub'; exit 0 ;;
      logs) echo 'stub container logs'; exit 0 ;;
      exec) [[ -e "$S/fail_exec_check" ]] && exit 1; [[ "$(cat "$S/status")" == running ]]; exit $? ;;
      up)
        if "$REAL_JQ" -e '.outbounds[] | select(.tag == "isp-socks")' "$proj/config.json" >/dev/null; then
          [[ -e "$S/fail_up_isp" ]] && exit 1
          if [[ -e "$S/term_on_up" ]]; then kill -TERM "$PPID"; exit 0; fi
          if [[ -e "$S/break_isp" ]]; then echo exited > "$S/status"; : > "$S/listeners"; exit 0; fi
          printf 'tcp 8388\nudp 8388\ntcp 8443\ntcp 13839\nudp 13839\ntcp 18444\n' > "$S/listeners"
        else
          if [[ -e "$S/break_clean" ]]; then echo exited > "$S/status"; : > "$S/listeners"; exit 0; fi
          printf 'tcp 8388\nudp 8388\ntcp 8443\n' > "$S/listeners"
        fi
        echo running > "$S/status"
        exit 0 ;;
    esac ;;
esac
exit 0
`;
const curl = String.raw`
echo "curl $*" >> "$STUB_LOG"
# Private inspection artifact, deliberately never appended to a diagnostic log.
cat > "$STUB_STATE/last-curl-config"
chmod 600 "$STUB_STATE/last-curl-config"
[[ -e "$STUB_STATE/fail_curl" ]] && exit 7
cat "$STUB_STATE/egress_ip"
`;
const ss = String.raw`
echo "ss $*" >> "$STUB_LOG"
case "$*" in
  *-ltn*) proto=tcp; state=LISTEN ;;
  *-lun*) proto=udp; state=UNCONN ;;
  *) exit 0 ;;
esac
while read -r p port; do
  [[ "$p" == "$proto" ]] && echo "$state 0 4096 0.0.0.0:$port 0.0.0.0:*"
done < "$STUB_STATE/listeners"
exit 0
`;

export async function setupIsp() {
  const dir = project(fixtureText());
  for (const command of ['gen-config', 'conf-clash'])
    expect((await invoke(command, dir)).code).toBe(0);
  const bin = join(dir, 'stubs'), state = join(dir, 'state');
  mkdirSync(bin);
  mkdirSync(state);
  const logFile = join(state, 'calls.log'), tripwireFile = join(state, 'tripwires.log');
  writeFileSync(logFile, '');
  writeFileSync(tripwireFile, '');
  const env = {
    ...shellEnv, PATH: `${bin}:/usr/bin:/bin`, STUB_STATE: state,
    STUB_LOG: logFile, TRIPWIRE_LOG: tripwireFile, REAL_JQ: '/usr/bin/jq',
  };
  function stub(name: string, body: string) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  stub('docker', docker);
  stub('curl', curl);
  stub('ss', ss);
  stub('sleep', 'exit 0');
  for (const name of ['apt-get', 'sudo', 'ufw', 'firewall-cmd', 'iptables', 'ip6tables', 'netfilter-persistent', 'debconf-set-selections', 'id'])
    stub(name, `echo "${name} $*" >> "$TRIPWIRE_LOG"\nexit 1`);
  function set(name: string, value: string) { writeFileSync(join(state, name), value); }
  set('listeners', cleanListeners);
  set('status', 'running\n');
  set('egress_ip', '198.51.100.7\n');
  const read = (name: string) => readFileSync(join(dir, name), 'utf8');
  const write = (name: string, text: string) => writeFileSync(join(dir, name), text);
  const log = () => readFileSync(logFile, 'utf8');
  const secrets = new Set([
    username, password, creds.ssPassword, creds.vlessUuid,
    creds.realityPrivateKey, creds.realityPublicKey,
  ]);
  function track(...values: string[]) { for (const value of values) if (value) secrets.add(value); }
  function observe(args: string[], lines: string[]) {
    const offset = args.includes('--add') ? 0 : lines[0] === '1' ? 1 : -1;
    if (offset >= 0) {
      track(lines[offset + 1] ?? '', lines[offset + 2] ?? '');
      if (lines[offset + 2]) track(lines[offset + 3] ?? '');
    }
  }
  function audit(result: Result) {
    const diagnostics = result.stdout + result.stderr + log() + readFileSync(tripwireFile, 'utf8');
    for (const value of secrets) {
      expect(diagnostics.includes(value), 'raw ISP credential leaked into diagnostics').toBe(false);
      expect(diagnostics.includes(envQuote(value)), 'quoted ISP credential leaked into diagnostics').toBe(false);
    }
    expect(readFileSync(tripwireFile, 'utf8'), 'system command or uid check was called').toBe('');
    expect(readdirSync(dir).filter((name) => name.startsWith('.isp-tmp.'))).toEqual([]);
    return result;
  }
  async function ispRun(args: string[] = [], stdinLines: string[] = []) {
    // Only ispSpawn may run the signal-sending stub: PPID must never be this worker.
    if (existsSync(join(state, 'term_on_up'))) throw new Error('Use ispSpawn for signal tests.');
    observe(args, stdinLines);
    const lines = [...stdinLines];
    return audit(await invoke('isp-outbound', dir, {
      env, sleep: async () => {},
      readLine: async () => lines.shift() ?? null,
      readSecret: async () => lines.shift() ?? null,
    }, args));
  }
  function ispSpawn(args: string[], stdinLines: string[] = [], shell = false) {
    observe(args, stdinLines);
    const input = join(state, 'stdin');
    writeFileSync(input, stdinLines.length ? stdinLines.join('\n') + '\n' : '', { mode: 0o600 });
    const fd = openSync(input, 'r');
    const stdout = openSync(join(state, 'stdout.log'), 'w');
    const stderr = openSync(join(state, 'stderr.log'), 'w');
    try {
      const result = spawnSync(shell ? '/bin/bash' : process.execPath,
        shell ? [join(dir, 'scripts/isp-outbound.sh'), ...args] : [join(root, 'dist/cli.js'), 'isp-outbound', ...args],
        { cwd: dir, env, encoding: 'utf8', stdio: [fd, stdout, stderr], timeout: 10000 });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      return audit({ code: result.status!, stdout: read('state/stdout.log'), stderr: read('state/stderr.log') });
    } finally { closeSync(fd); closeSync(stdout); closeSync(stderr); }
  }
  function snapshot() {
    return ['config.json', 'clash.yaml', '.env'].map((name) => `${name} ` +
      (existsSync(join(dir, name)) ? createHash('sha256').update(readFileSync(join(dir, name))).digest('hex') : 'absent'))
      .join('\n') + '\n' + readFileSync(join(state, 'listeners'), 'utf8');
  }
  function backups() {
    const base = join(dir, '.isp-backup');
    return existsSync(base) ? readdirSync(base).sort().map((name) => join(base, name)) : [];
  }
  // Remove jq from PATH without breaking the stubs: they inspect via REAL_JQ.
  function withoutJq() {
    for (const name of ['cat', 'cp', 'chmod', 'grep']) symlinkSync(`/usr/bin/${name}`, join(bin, name));
    env.PATH = bin;
  }
  return {
    dir, bin, state, env, read, write, log, set, stub, track, snapshot, backups, withoutJq,
    config: () => JSON.parse(read('config.json')) as SingboxConfig,
    switch: (name: Switch, enabled = true) => enabled ? set(name, '') : rmSync(join(state, name), { force: true }),
    clearLog: () => writeFileSync(logFile, ''),
    upCount: () => log().split('\n').filter((line) => /^docker compose .* up /.test(line)).length,
    ispRun, ispSpawn,
    add: (addr = address, user = username, pass = password, egress = '') =>
      ispRun(['--add', '--yes'], freshLines(addr, user, pass, egress)),
    keep: () => ispRun(['--add', '--yes'], ['', '', '', '']),
    remove: () => ispRun(['--remove', '--yes']),
  };
}
export type IspHarness = Awaited<ReturnType<typeof setupIsp>>;
