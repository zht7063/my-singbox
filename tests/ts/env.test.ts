import { it, expect, vi, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  linkSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as e from '../../src/core/env.js';
import { parsePorts, PortError } from '../../src/core/ports.js';
import { buildModel } from '../../src/model.js';
import { creds, isp } from './helpers/fixtures.js';
it.each(['', '"\\$# spaces 雪😀', '\\"$', '$$', 'a # b'])(
  'quotes/unquotes %s',
  (s) => {
    expect(e.envUnquote(e.envQuote(s))).toBe(s);
  },
);
it('uses exact escaping and leaves unwrapped text raw', () => {
  expect(e.envQuote('$')).toBe('"$$"');
  expect(e.envUnquote('raw # $')).toBe('raw # $');
  for (const s of ['"$"', '"\\n"', '"a"b"', '"a\\"'])
    expect(e.envUnquote(s)).toBeNull();
});

it('parses CRLF and comments while keeping all values raw', () => {
  const env = e.parseEnv(
    ' # comment\r\n\t\r\nSERVER_ADDRESS="raw"\r\nISP_SOCKS_USER="a$$"\nISP_SOCKS_PASS="$"',
  );
  expect(env).toEqual({
    values: {
      SERVER_ADDRESS: '"raw"',
      ISP_SOCKS_USER: '"a$$"',
      ISP_SOCKS_PASS: '"$"',
    },
    keys: new Set(['SERVER_ADDRESS', 'ISP_SOCKS_USER', 'ISP_SOCKS_PASS']),
  });
});

it('reports line numbers and keys without values', () => {
  expect(() => e.parseEnv(' # hi\n SECRET bad', 'label')).toThrow(
    'Invalid line 2 in label',
  );
  expect(() => e.parseEnv('VLESS_UUID=secret\nVLESS_UUID=hidden')).toThrow(
    'Duplicate key in .env: VLESS_UUID',
  );
  expect(() => e.parseEnv('UNKNOWN=secret')).toThrow(
    'Unknown key in .env: UNKNOWN',
  );
});

it.each(['', 'A=1\n', 'A=1', 'A=1\n\n', 'A=1\r\n'])(
  'roundtrips ISP block and is idempotent: %j',
  (s) => {
    const added = e.envWithIsp(s, isp);
    expect(e.envWithoutIsp(added)).toBe(s);
    expect(e.envWithIsp(added, isp)).toBe(added);
    expect(added).toContain(e.envQuote(isp.pass));
  },
);
it('strips managed keys, one preceding blank and respects NOEOL marker', () => {
  expect(
    e.envWithoutIsp('A=1\n\n' + e.ENV_HEADER + '\nISP_SOCKS_ADDR=x\nZ=2\n'),
  ).toBe('A=1\nZ=2\n');
  expect(
    e.envWithoutIsp('A=1\n\n' + e.ENV_HEADER_NOEOL + '\nISP_SOCKS_USER=x\n'),
  ).toBe('A=1');
});

it('renders generated layout exactly', () => {
  expect(e.renderGeneratedEnv(creds)).toBe(
    `SING_BOX_VERSION=1.12.0\n\n# VLESS\nVLESS_UUID=${creds.vlessUuid}\n\n# REALITY\nREALITY_PRIVATE_KEY=${creds.realityPrivateKey}\nREALITY_PUBLIC_KEY=${creds.realityPublicKey}\nREALITY_SHORT_ID=${creds.realityShortId}\n\n# Shadowsocks 2022\nSS_PASSWORD=${creds.ssPassword}\n\n# Client\nSERVER_ADDRESS=${creds.serverAddress}\n`,
  );
});

it('roundtrips explicit ports through generated env and ISP updates', () => {
  const ports = { ss: 18388, vless: 18443 };
  const text = e.renderGeneratedEnv({ ...creds, ports });
  expect(text).toBe(e.renderGeneratedEnv(creds) + '\n# Listening ports\nSS_PORT=18388\nVLESS_PORT=18443\n');
  const env = e.parseEnv(text);
  expect(env.keys.has('SS_PORT')).toBe(true);
  expect(env.keys.has('VLESS_PORT')).toBe(true);
  expect(buildModel(env).nodes.map((node) => node.inbound.port)).toEqual([ports.ss, ports.vless]);
  expect(e.envWithoutIsp(e.envWithIsp(text, isp))).toBe(text);
});

it.each([
  { ss: 0, vless: 8443 },
  { ss: 8388, vless: 65536 },
  { ss: 1.5, vless: 8443 },
  { ss: NaN, vless: 8443 },
  { ss: 8388, vless: Infinity },
  { ss: 8388, vless: 8388 },
])('rejects invalid numeric ports before env serialization: %j', (ports) => {
  expect(() => e.renderGeneratedEnv({ ...creds, ports })).toThrow(PortError);
});

it('validates raw port fields without accepting trailing newlines', () => {
  expect(parsePorts({ ss: '1', vless: '65535' })).toEqual({ ss: 1, vless: 65535 });
  expect(() => parsePorts({ ss: '8388\n', vless: 8443 })).toThrow('Invalid SS_PORT.');
  expect(() => parsePorts({ ss: 8388, vless: '8443\r' })).toThrow('Invalid VLESS_PORT.');
});

it('loads files, writes mode 0600 under both umasks, and never clobbers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2-env-'));
  const old = process.umask();
  try {
    for (const mask of [0, 0o077]) {
      process.umask(mask);
      const path = join(dir, `env${mask}`);
      e.writeEnvFile(path, e.renderGeneratedEnv(creds));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(e.loadEnvFile(path).values.VLESS_UUID).toBe(creds.vlessUuid);
      expect(() => e.writeEnvFile(path, 'bad')).toThrow(e.FileExistsError);
      expect(readFileSync(path, 'utf8')).toBe(e.renderGeneratedEnv(creds));
      e.writeFileAtomic(path, 'SS_PASSWORD=new\n');
      expect(readFileSync(path, 'utf8')).toBe('SS_PASSWORD=new\n');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(dir).filter((x) => x.includes('.tmp.'))).toEqual([]);
    expect(() => e.loadEnvFile(join(dir, 'missing'))).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
    expect(() => e.writeFileAtomic(join(dir, 'absent', 'file'), 'x')).toThrow();
  } finally {
    process.umask(old);
    rmSync(dir, { recursive: true, force: true });
  }
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    linkSync: vi.fn(actual.linkSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});
afterEach(() => vi.mocked(linkSync).mockReset());
it('keeps embedded carriage returns and Unicode separators raw', () => {
  expect(
    e.parseEnv('ISP_SOCKS_PASS=a\rb\u2028c\r\r\n').values.ISP_SOCKS_PASS,
  ).toBe('a\rb\u2028c\r');
});

it.each(['EPERM', 'ENOTSUP', 'EXDEV'])(
  'propagates unsupported link error %s and cleans up',
  (code) => {
    const dir = mkdtempSync(join(tmpdir(), 'p2-link-'));
    try {
      const path = join(dir, '.env');
      const error = Object.assign(new Error('Unsupported link.'), { code });
      vi.mocked(linkSync).mockImplementationOnce(() => {
        throw error;
      });
      expect(() => e.writeEnvFile(path, 'data')).toThrow(error);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
it('cleans temp files on write, rename and link failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2-failure-'));
  const path = join(dir, '.env');
  const fail = () => {
    throw Object.assign(new Error('Write failed.'), { code: 'EIO' });
  };
  try {
    vi.mocked(writeFileSync).mockImplementationOnce(fail);
    expect(() => e.writeEnvFile(path, 'data')).toThrow('Write failed.');
    expect(readdirSync(dir)).toEqual([]);
    vi.mocked(renameSync).mockImplementationOnce(fail);
    expect(() => e.writeFileAtomic(path, 'data')).toThrow('Write failed.');
    expect(readdirSync(dir)).toEqual([]);
    vi.mocked(linkSync).mockImplementationOnce(fail);
    expect(() => e.writeEnvFile(path, 'data')).toThrow('Write failed.');
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
