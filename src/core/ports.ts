export interface Ports {
  ss: number;
  vless: number;
}

export class PortError extends Error {
  override name = 'PortError';
}

export function parsePorts(ports: {
  ss: string | number;
  vless: string | number;
}): Ports {
  const parse = (value: string | number, key: string): number => {
    const port = Number(value);
    if (
      (typeof value === 'string' && (value.length === 0 || /[^0-9]/.test(value))) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new PortError(`Invalid ${key}. Expected an integer from 1 to 65535.`);
    return port;
  };
  const ss = parse(ports.ss, 'SS_PORT');
  const vless = parse(ports.vless, 'VLESS_PORT');
  if (ss === vless)
    throw new PortError('SS_PORT and VLESS_PORT must be different.');
  return { ss, vless };
}
