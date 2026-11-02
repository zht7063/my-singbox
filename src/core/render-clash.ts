import { parseDocument, visit, isScalar, isSeq, isMap, type YAMLMap } from 'yaml';
import type { Model, RealityCreds, SsCreds } from '../model.js';

export function renderClash(model: Model, templateText: string): string {
  const doc = parseDocument(templateText);
  if (doc.errors.length) throw new Error('Invalid Clash template.');
  const ss = model.nodes.find((n) => n.protocol === 'shadowsocks')!
    .creds as SsCreds;
  const r = model.nodes.find((n) => n.protocol === 'vless-reality')!
    .creds as RealityCreds;
  const values: Record<string, string> = {
    SERVER_ADDRESS: model.server,
    VLESS_UUID: r.uuid,
    REALITY_PUBLIC_KEY: r.publicKey,
    REALITY_SHORT_ID: r.shortId,
    SS_PASSWORD: ss.password,
  };
  visit(doc, {
    Scalar(_key, scalar) {
      if (typeof scalar.value === 'string')
        scalar.value = scalar.value.replace(
          /\$\{([^}]+)\}/g,
          (p, k: string) => values[k] ?? p,
        );
    },
  });
  const proxies = doc.get('proxies', true),
    groups = doc.get('proxy-groups', true);
  if (!isSeq(proxies) || !isSeq(groups))
    throw new Error('Missing Clash proxies or groups.');
  const prototypes = new Map<string, YAMLMap>();
  for (const protocol of ['shadowsocks', 'vless-reality']) {
    const proto = proxies.items.find(
      (p) =>
        isMap(p) &&
        p.get('name') === protocol &&
        p.get('type') === (protocol === 'shadowsocks' ? 'ss' : 'vless'),
    );
    if (!isMap(proto)) throw new Error('Missing Clash proxy prototype.');
    prototypes.set(protocol, proto);
  }
  proxies.items = model.nodes.map((n) => {
    const proto = prototypes.get(n.protocol)!;
    proto.set('name', n.name);
    proto.set('port', n.inbound.port);
    return proto;
  });
  const group = groups.items.find((g) => isMap(g) && g.get('name') === 'Proxy');
  const list = isMap(group) ? group.get('proxies', true) : null;
  if (!isSeq(list)) throw new Error('Missing Proxy group.');
  for (const n of model.nodes)
    if (!list.items.some((x) => (isScalar(x) ? x.value : x) === n.name))
      list.add(n.name);
  const text = doc.toString({ lineWidth: 0 }).replace(/\n*$/, '\n');
  if (text.includes('${'))
    throw new Error('Unresolved placeholder left in clash.yaml.');
  if (r.privateKey && text.includes(r.privateKey))
    throw new Error('Refusing to write REALITY_PRIVATE_KEY into clash.yaml.');
  return text;
}
