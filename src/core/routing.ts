import { OUT_TAG, SS_ISP_TAG, VLESS_ISP_TAG, type IspSocks } from '../model.js';
import type { SingboxConfig } from './render-config.js';

export type RoutePolicy = NonNullable<SingboxConfig['route']>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isIspRule(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.outbound === OUT_TAG;
}

/** The old generated rule selected only the dedicated ISP listener tags. */
export function isLegacyIspRule(value: unknown): boolean {
  if (!isIspRule(value)) return false;
  const inbound = typeof value.inbound === 'string' ? [value.inbound] : value.inbound;
  return Array.isArray(inbound) && inbound.length > 0 &&
    inbound.every((tag) => tag === SS_ISP_TAG || tag === VLESS_ISP_TAG) &&
    (value.action === undefined || value.action === 'route') &&
    Object.keys(value).every((key) => ['inbound', 'outbound', 'action'].includes(key));
}

/** Fail rather than silently changing references outside optional top-level rules. */
export function checkNoIspReferences(config: SingboxConfig): void {
  const referenceKeys = new Set(['outbound', 'outbounds', 'detour', 'final', 'default']);
  const walk = (value: unknown, path: string, key = ''): void => {
    if (value === OUT_TAG && referenceKeys.has(key))
      throw new Error(`Unsupported ISP reference at ${path}. Remove this reference before disabling ISP.`);
    if (Array.isArray(value))
      value.forEach((item, i) => walk(item, `${path}[${i}]`, key));
    else if (isRecord(value))
      for (const [name, item] of Object.entries(value)) walk(item, `${path}.${name}`, name);
  };
  walk(config, 'config');
}

export function upsertIspOutbound(config: SingboxConfig, isp: IspSocks): void {
  const outbounds = config.outbounds ??= [];
  const matches = outbounds.filter((o) => o.tag === OUT_TAG);
  if (matches.length > 1) throw new Error(`Duplicate outbound tag: ${OUT_TAG}.`);
  const fields = {
    type: 'socks', tag: OUT_TAG, server: isp.host, server_port: isp.port,
    version: '5', username: isp.user, password: isp.pass,
  };
  if (matches[0]) {
    if (matches[0].type !== 'socks')
      throw new Error(`Outbound ${OUT_TAG} must have type socks.`);
    Object.assign(matches[0], fields);
  } else outbounds.push(fields);
}

/** Mutates only the optional outbound and top-level rules targeting it. */
export function omitIsp(config: SingboxConfig): void {
  if (config.outbounds) config.outbounds = config.outbounds.filter((o) => o.tag !== OUT_TAG);
  if (config.route?.rules) config.route.rules = config.route.rules.filter((r) => !isIspRule(r));
  checkNoIspReferences(config);
}

export function ensureRoute(config: SingboxConfig, defaults?: RoutePolicy): void {
  const route = config.route ??= {};
  const rules = route.rules ??= [];
  if (!rules.some((r) => isRecord(r) && r.action === 'sniff'))
    rules.unshift({ action: 'sniff' });
  if (!rules.some(isIspRule) && defaults?.rules)
    rules.push(...structuredClone(defaults.rules.filter(isIspRule)));
  route.final ??= 'direct';
}
