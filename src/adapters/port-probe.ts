import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { runCommand, type ApplicationIO } from '../app/system.js';

export interface Listener { port: number; protocol: 'tcp' | 'udp' }
export interface PortProbe extends Listener {
  state: 'free' | 'occupied' | 'unknown';
  source: 'ss' | 'bind';
  detail: string;
  checkedAt: string;
}

export function listeningInTable(text: string, port: number): boolean {
  return text.split('\n').some((line) => {
    const fields = line.trim().split(/\s+/);
    // ss without process details: the final two fields are local and peer address.
    return new RegExp(`:${port}$`).test(fields.at(-2) ?? '');
  });
}

async function bindProbe(listener: Listener, family: 4 | 6, signal?: AbortSignal): Promise<'free' | 'occupied' | 'unknown' | 'unsupported'> {
  signal?.throwIfAborted();
  return new Promise((resolve) => {
    const host = family === 4 ? '0.0.0.0' : '::';
    const socket = listener.protocol === 'tcp' ? createServer() : createSocket({ type: family === 4 ? 'udp4' : 'udp6', reuseAddr: false });
    let finished = false;
    const finish = (state: 'free' | 'occupied' | 'unknown' | 'unsupported') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try { socket.close(() => resolve(state)); } catch { resolve(state); }
    };
    const abort = () => finish('unknown');
    const timer = setTimeout(() => finish('unknown'), 1500);
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('error', (error: NodeJS.ErrnoException) => finish(
      error.code === 'EADDRINUSE' ? 'occupied' : ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code ?? '') ? 'unsupported' : 'unknown',
    ));
    if (listener.protocol === 'tcp') {
      (socket as ReturnType<typeof createServer>).listen({ host, port: listener.port, exclusive: true, ipv6Only: family === 6 }, () => finish('free'));
    } else {
      (socket as ReturnType<typeof createSocket>).bind({ address: host, port: listener.port, exclusive: true }, () => finish('free'));
    }
  });
}

/** Check local listeners only. A successful probe never guarantees future or public reachability. */
export async function probePorts(listeners: Listener[], io: ApplicationIO): Promise<PortProbe[]> {
  const run = io.run ?? runCommand;
  const tables = new Map<string, string | undefined>();
  for (const protocol of new Set(listeners.map((listener) => listener.protocol))) {
    io.signal?.throwIfAborted();
    try {
      const result = await run('ss', ['-H', protocol === 'tcp' ? '-ltn' : '-lun'], { cwd: io.projectDir, env: io.env, signal: io.signal, timeout: 5000 });
      tables.set(protocol, result.code === 0 ? result.stdout : undefined);
    } catch { io.signal?.throwIfAborted(); tables.set(protocol, undefined); }
  }
  const results: PortProbe[] = [];
  for (const listener of listeners) {
    const table = tables.get(listener.protocol);
    if (table !== undefined) {
      const occupied = listeningInTable(table, listener.port);
      results.push({ ...listener, state: occupied ? 'occupied' : 'free', source: 'ss', detail: occupied ? '已发现本机监听，未判断进程归属。' : '本机监听表未发现占用；提交前仍需重查。', checkedAt: new Date().toISOString() });
    } else {
      const v4 = await bindProbe(listener, 4, io.signal), v6 = await bindProbe(listener, 6, io.signal);
      io.signal?.throwIfAborted();
      const state = [v4, v6].includes('occupied') ? 'occupied' : [v4, v6].includes('unknown') || v4 === 'unsupported' ? 'unknown' : 'free';
      results.push({ ...listener, state, source: 'bind', detail: `临时独占绑定，IPv4=${v4} / IPv6=${v6}；不保证外网可达。`, checkedAt: new Date().toISOString() });
    }
  }
  return results;
}

export function deploymentListeners(ports: { ss: number; vless: number }): Listener[] {
  return [{ port: ports.ss, protocol: 'tcp' }, { port: ports.ss, protocol: 'udp' }, { port: ports.vless, protocol: 'tcp' }];
}
