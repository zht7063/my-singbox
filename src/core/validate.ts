export const UUID_RE = /^[0-9a-fA-F-]{36}$/;

export const PRIVATE_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export const PUBLIC_KEY_RE = PRIVATE_KEY_RE;

export const SHORT_ID_RE = /^[0-9a-f]{16}$/;

export const SS_PASSWORD_RE = /^[A-Za-z0-9+/]{22}==$/;

export function isIpv4(s: string): boolean {
  return (
    /^(\d{1,3}\.){3}\d{1,3}$/.test(s) &&
    s
      .split('.')
      .every((x) => Number(x) <= 255 && (x.length === 1 || x[0] !== '0'))
  );
}

export function isIpv6(s: string): boolean {
  const n = s.split(':').length - 1;
  return (
    /^[\da-f:]+$/i.test(s) &&
    !s.includes(':::') &&
    s.indexOf('::') === s.lastIndexOf('::') &&
    n >= 2 &&
    n <= 7
  );
}

export function isIpv6Strict(s: string): boolean {
  if (!/^[\da-f:]+$/i.test(s) || s.includes(':::')) return false;
  const group = /^[\da-f]{1,4}(:[\da-f]{1,4})*$/i;
  if (!s.includes('::')) return group.test(s) && s.split(':').length === 8;
  if (s.indexOf('::') !== s.lastIndexOf('::')) return false;
  const sides = s.split('::');
  return (
    sides.every((x) => !x || group.test(x)) &&
    sides.reduce((n, x) => n + (x ? x.split(':').length : 0), 0) <= 7
  );
}

export function isHostname(s: string): boolean {
  return (
    s.length <= 253 &&
    /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(
      s,
    )
  );
}

export function isValidServerAddress(s: string): boolean {
  return /^[0-9.]+$/.test(s)
    ? isIpv4(s)
    : s.includes(':')
      ? isIpv6(s)
      : isHostname(s);
}

export function isPublicIp(s: string): boolean {
  if (s.includes(':')) {
    const first = s.split(':')[0];
    const n = parseInt(first, 16);
    return (
      isIpv6(s) &&
      /^[\da-f]{1,4}$/i.test(first) &&
      n >= 0x2000 &&
      n <= 0x3fff &&
      !/^2001:0*db8(:|$)/i.test(s)
    );
  }
  if (!isIpv4(s)) return false;
  const [a, b, c] = s.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

export function parseIspAddr(
  value: string,
): { host: string; port: number; addr: string } | null {
  const v6 = /^\[([\da-f:]+)\]:([0-9]{1,5})$/i.exec(value);
  const m = v6 ?? /^([0-9.]+):([0-9]{1,5})$/.exec(value);
  if (!m || !(v6 ? isIpv6Strict(m[1]) : isIpv4(m[1]))) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1], port, addr: `${v6 ? `[${m[1]}]` : m[1]}:${port}` };
}

export function validCred(value: string): boolean {
  return (
    Buffer.byteLength(value, 'utf8') >= 1 &&
    Buffer.byteLength(value, 'utf8') <= 255 &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    !value.includes('\uFFFD')
  );
}
