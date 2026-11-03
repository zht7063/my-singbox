import { afterEach, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directories: string[] = [];
const parents: ChildProcess[] = [];
const dockerPids: number[] = [];
const cli = resolve('dist/cli.js');
afterEach(() => {
  for (const child of parents.splice(0)) {
    if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
  for (const pid of dockerPids.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, description: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
function running(pid: number) {
  try {
    // An orphan may briefly be a zombie until the host init reaps it.
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().startsWith('Z');
  } catch { return false; }
}

it.skipIf(process.platform === 'win32' || !existsSync(cli)).each(['gen-keys', 'init'])(
  '%s keeps Docker in the foreground process group so Ctrl+C stops both processes', async (command) => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-signal-'));
    directories.push(dir);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const pidFile = join(dir, 'docker.pid');
    writeFileSync(join(bin, 'docker'), `#!${process.execPath}\nif(process.argv[2]==='run'){require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);}else console.log('available');\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'ss'), `#!${process.execPath}\nconsole.log('available');\n`, { mode: 0o755 });
    const preload = join(dir, 'host.mjs');
    writeFileSync(preload, `
import fs from 'node:fs';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', {value:'linux'});
process.report.getReport=()=>({header:{glibcVersionRuntime:'2.36'}});
const access=fs.accessSync;
fs.accessSync=(path,...args)=>{if(path!=='/var/run/docker.sock')access(path,...args);};
https.get=(_url,_options,callback)=>{
  const request=new EventEmitter();
  process.nextTick(()=>{
    const response=Readable.from(['8.8.8.8\\n']);response.statusCode=200;
    response.on('end',()=>request.emit('close'));callback(response);
  });
  return request;
};
syncBuiltinESMExports();
`);
    const child = spawn(process.execPath, ['--import', preload, cli, command], {
      cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SING_BOX_VERSION: 'v1.14.4' },
    });
    parents.push(child);
    let output = '';
    child.stdout!.on('data', (data) => { output += data; });
    child.stderr!.on('data', (data) => { output += data; });
    const closed = new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (_code, signal) => resolve(signal));
    });
    await waitFor(() => existsSync(pidFile), `Docker credential generation: ${output}`);
    const docker = Number(readFileSync(pidFile, 'utf8'));
    dockerPids.push(docker);
    expect(running(docker)).toBe(true);
    process.kill(-child.pid!, 'SIGINT');
    // Check before awaiting close: a surviving child would keep the pipes open.
    await waitFor(() => !running(docker), 'Docker to exit after foreground SIGINT');
    expect(await closed).toBe('SIGINT');
    expect(existsSync(join(dir, '.env'))).toBe(false);
  }, 10000,
);
