import type { Model, RealityCreds, SsCreds } from '../model.js';
import { OUT_TAG } from '../model.js';
import { readTemplate } from './templates.js';

export interface SingboxConfig {
  inbounds: Record<string, unknown>[];
  outbounds?: Record<string, unknown>[];
  route?: { rules?: unknown[]; [key: string]: unknown };
  [key: string]: unknown;
}

export function renderSingbox(model: Model, template: unknown): SingboxConfig {
  const ss = model.nodes.find((n) => n.protocol === 'shadowsocks')!
    .creds as SsCreds;
  const r = model.nodes.find((n) => n.protocol === 'vless-reality')!
    .creds as RealityCreds;
  const replacements: Record<string, string> = {
    SS_PASSWORD: ss.password,
    VLESS_UUID: r.uuid,
    REALITY_PRIVATE_KEY: r.privateKey,
    REALITY_SHORT_ID: r.shortId,
  };
  const substitute = (v: unknown): unknown =>
    typeof v === 'string'
      ? v.replace(/\$\{([^}]+)\}/g, (p, k: string) => replacements[k] ?? p)
      : Array.isArray(v)
        ? v.map(substitute)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) => [k, substitute(x)]),
            )
          : v;
  const config = substitute(template) as SingboxConfig;
  const prototypes = new Map<string, Record<string, unknown>>();
  for (const protocol of ['shadowsocks', 'vless-reality'] as const) {
    const base = model.nodes.find(
      (n) => n.protocol === protocol && n.egress === 'direct',
    )!;
    const proto = config.inbounds.find(
      (i) => i.type === (protocol === 'shadowsocks' ? 'shadowsocks' : 'vless'),
    );
    if (
      !proto ||
      proto.tag !== base.inbound.tag ||
      proto.listen_port !== base.inbound.port
    )
      throw new Error('Invalid inbound prototype tag or port.');
    prototypes.set(protocol, proto);
  }
  config.inbounds = model.nodes.map((n) => ({
    ...structuredClone(prototypes.get(n.protocol)!),
    tag: n.inbound.tag,
    listen_port: n.inbound.port,
  }));
  const ispNodes = model.nodes.filter((n) => n.egress === 'isp-socks');
  if (ispNodes.length) {
    const isp = model.isp!;
    config.outbounds = [
      ...(config.outbounds ?? []),
      {
        type: 'socks',
        tag: OUT_TAG,
        server: isp.host,
        server_port: isp.port,
        version: '5',
        username: isp.user,
        password: isp.pass,
      },
    ];
    config.route ??= {};
    config.route.rules = [
      ...(config.route.rules ?? []),
      { inbound: ispNodes.map((n) => n.inbound.tag), outbound: OUT_TAG },
    ];
  }
  if (JSON.stringify(config).includes('${'))
    throw new Error('Unresolved placeholder left in config.json.');
  return config;
}

export function serializeSingbox(config: SingboxConfig): string {
  return JSON.stringify(config, null, 2) + '\n';
}

export function loadSingboxTemplate(projectDir?: string): unknown {
  return JSON.parse(readTemplate('config.json.template', projectDir));
}
