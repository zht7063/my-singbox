import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { userInfo } from 'node:os';

export interface System {
  nodeVersion: string;
  platform: string;
  arch: string;
  glibcVersionRuntime?: string;
  exec(file: string, args: string[]): Promise<string>;
  socketAccessible(): boolean;
  username(): string;
}

export function realSystem(): System {
  const header = (process.report.getReport() as { header: { glibcVersionRuntime?: string } })
    .header;
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    glibcVersionRuntime: header.glibcVersionRuntime,
    exec: (file, args) => {
      return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: 10000, maxBuffer: 65536 }, (error, stdout) => {
          if (error) {
            reject(error);
          } else {
            resolve(stdout);
          }
        });
      });
    },
    socketAccessible() {
      try {
        accessSync('/var/run/docker.sock', constants.R_OK | constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    username: () => userInfo().username,
  };
}
