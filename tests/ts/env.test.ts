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

it('parses CRLF, comments, raw base values and decoded ISP values', () => {
  const env = e.parseEnv(
    ' # comment\r\n\t\r\nSERVER_ADDRESS="raw"\r\nISP_SOCKS_USER="a$$"\nISP_SOCKS_PASS="$"',
  );
  expect(e.getEnv(env, 'SERVER_ADDRESS')).toBe('"raw"');
  expect(env.ispUser).toBe('a$');
  expect(env.values.ISP_SOCKS_USER).toBe('"a$$"');
  expect(env.ispPass).toBeUndefined();
  expect(env.malformed).toEqual(['ISP_SOCKS_PASS']);
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
      e.writeFileAtomic(path, 'SS_PASSWORD=new\n', { mode: 0o777 });
      expect(readFileSync(path, 'utf8')).toBe('SS_PASSWORD=new\n');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(dir).filter((x) => x.includes('.tmp.'))).toEqual([]);
    expect(() => e.loadEnvFile(join(dir, 'missing'))).toThrow(
      '.env does not exist. Run scripts/gen-keys.sh first.',
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
  'uses exclusive fallback on %s and cleans up on collision',
  (code) => {
    const dir = mkdtempSync(join(tmpdir(), 'p2-fallback-'));
    try {
      const path = join(dir, '.env');
      vi.mocked(linkSync).mockImplementation(() => {
        throw Object.assign(new Error('Unsupported link.'), { code });
      });
      e.writeEnvFile(path, 'original');
      expect(readFileSync(path, 'utf8')).toBe('original');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(() => e.writeEnvFile(path, 'replacement')).toThrow(
        e.FileExistsError,
      );
      expect(readFileSync(path, 'utf8')).toBe('original');
      expect(readdirSync(dir)).toEqual(['.env']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
it('cleans temp files on write, rename and link failures and partial fallback writes', () => {
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
    vi.mocked(linkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('Unsupported link.'), { code: 'EPERM' });
    });
    const actual = vi.mocked(writeFileSync).getMockImplementation()!;
    vi.mocked(writeFileSync)
      .mockImplementationOnce(actual)
      .mockImplementationOnce(fail);
    expect(() => e.writeEnvFile(path, 'data')).toThrow('Write failed.');
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
