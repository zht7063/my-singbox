import { type Env, type EnvKey, envUnquote } from './core/env.js';
import { parsePorts, PortError } from './core/ports.js';
import {
  UUID_RE,
  PRIVATE_KEY_RE,
  PUBLIC_KEY_RE,
  SHORT_ID_RE,
  SS_PASSWORD_RE,
  isValidServerAddress,
  parseIspAddr,
  validCred,
  isIpv4,
  isIpv6Strict,
} from './core/validate.js';

export type Protocol = 'shadowsocks' | 'vless-reality';

export interface SsCreds {
  password: string;
}

export interface RealityCreds {
  uuid: string;
  privateKey: string;
  publicKey: string;
  shortId: string;
}

export interface Node {
  name: string;
  protocol: Protocol;
  inbound: { tag: string; port: number };
  creds: SsCreds | RealityCreds;
}

export interface IspSocks {
  host: string;
  port: number;
  addr: string;
  user: string;
  pass: string;
  egressIp?: string;
}

export interface Model {
  server: string;
  nodes: Node[];
  isp?: IspSocks;
}

export const SS_PORT = 8388, VLESS_PORT = 8443;
/** @deprecated Legacy listener ports, retained for migration only. */
export const SS_ISP_PORT = 13839, VLESS_ISP_PORT = 18444;

export const SS_TAG = 'ss-in',
  VLESS_TAG = 'vless-reality-in',
  SS_ISP_TAG = 'ss-isp-in',
  VLESS_ISP_TAG = 'vless-reality-isp-in',
  OUT_TAG = 'isp-socks';

export const NODE_SS = 'shadowsocks',
  NODE_VLESS = 'vless-reality',
  NODE_SS_ISP = 'shadowsocks-isp',
  NODE_VLESS_ISP = 'vless-reality-isp';

export class ModelError extends Error {
  override name = 'ModelError';
}
const checks: {
  key: EnvKey;
  side: 'server' | 'client' | 'both';
  valid: (s: string) => boolean;
}[] = [
  { key: 'SERVER_ADDRESS', side: 'client', valid: isValidServerAddress },
  { key: 'VLESS_UUID', side: 'both', valid: (s) => UUID_RE.test(s) },
  {
    key: 'REALITY_PRIVATE_KEY',
    side: 'server',
    valid: (s) => PRIVATE_KEY_RE.test(s),
  },
  {
    key: 'REALITY_PUBLIC_KEY',
    side: 'client',
    valid: (s) => PUBLIC_KEY_RE.test(s),
  },
  { key: 'REALITY_SHORT_ID', side: 'both', valid: (s) => SHORT_ID_RE.test(s) },
  { key: 'SS_PASSWORD', side: 'both', valid: (s) => SS_PASSWORD_RE.test(s) },
];

export function buildModel(
  env: Env,
  opts: { target?: 'all' | 'server' | 'client' } = {},
): Model {
  const target = opts.target ?? 'all',
    v = env.values;
  const active = checks.filter(
    (c) => target === 'all' || c.side === target || c.side === 'both',
  );
  if (target !== 'client')
    for (const c of active.filter((c) => c.side !== 'client'))
      if (!env.keys.has(c.key))
        throw new ModelError(`Missing .env key: ${c.key}`);
  for (const c of active) {
    const value = v[c.key] ?? '';
    if (c.valid(value)) continue;
    if (c.key === 'SERVER_ADDRESS')
      throw new ModelError(
        !env.keys.has(c.key) || value === '<server-address>'
          ? 'Set SERVER_ADDRESS in templates/.env.template or .env.'
          : 'Invalid SERVER_ADDRESS. Set it in templates/.env.template or .env.',
      );
    throw new ModelError(
      target === 'client' || c.side === 'client'
        ? `Invalid ${c.key}.`
        : 'Invalid credentials in .env.',
    );
  }
  const {
    SERVER_ADDRESS: server = '',
    REALITY_PRIVATE_KEY: privateKey = '',
    REALITY_PUBLIC_KEY: publicKey = '',
  } = v;
  const ss: SsCreds = { password: v.SS_PASSWORD! };
  const reality: RealityCreds = {
    uuid: v.VLESS_UUID!,
    privateKey,
    publicKey,
    shortId: v.REALITY_SHORT_ID!,
  };
  const node = (
    name: string,
    protocol: Protocol,
    tag: string,
    port: number,
  ): Node => ({
    name,
    protocol,
    inbound: { tag, port },
    creds: protocol === 'shadowsocks' ? ss : reality,
  });
  let ports;
  try {
    ports = parsePorts({
      ss: env.keys.has('SS_PORT') ? v.SS_PORT ?? '' : SS_PORT,
      vless: env.keys.has('VLESS_PORT') ? v.VLESS_PORT ?? '' : VLESS_PORT,
    });
  } catch (error) {
    if (error instanceof PortError) throw new ModelError(error.message);
    throw error;
  }
  const model: Model = {
    server,
    nodes: [
      node(NODE_SS, 'shadowsocks', SS_TAG, ports.ss),
      node(NODE_VLESS, 'vless-reality', VLESS_TAG, ports.vless),
    ],
  };
  if (target === 'client') return model;
  const {
    ISP_SOCKS_ADDR: rawAddr = '',
    ISP_SOCKS_USER: rawUser = '',
    ISP_SOCKS_PASS: rawPass = '',
    ISP_SOCKS_EGRESS_IP: ip = '',
  } = v;
  if (!rawAddr && !rawUser && !rawPass && !ip) return model;
  const addr = parseIspAddr(rawAddr);
  if (!addr) throw new ModelError('Invalid ISP_SOCKS_ADDR.');
  const user = envUnquote(rawUser),
    pass = envUnquote(rawPass);
  if (user === null || !validCred(user) || user.includes(':'))
    throw new ModelError('Invalid ISP_SOCKS_USER.');
  if (pass === null || !validCred(pass))
    throw new ModelError('Invalid ISP_SOCKS_PASS.');
  if (ip && !isIpv4(ip) && !isIpv6Strict(ip))
    throw new ModelError('Invalid ISP_SOCKS_EGRESS_IP.');
  model.isp = {
    ...addr,
    user,
    pass,
    ...(ip ? { egressIp: ip } : {}),
  };
  return model;
}
