import { it, expect } from 'vitest';
import * as v from '../../src/core/validate.js';
import { creds } from './helpers/fixtures.js';
it('validates the shell credential patterns', () => {
  expect(v.UUID_RE.test(creds.vlessUuid)).toBe(true);
  expect(v.PRIVATE_KEY_RE.test(creds.realityPrivateKey)).toBe(true);
  expect(v.PUBLIC_KEY_RE.test(creds.realityPublicKey)).toBe(true);
  expect(v.SHORT_ID_RE.test(creds.realityShortId)).toBe(true);
  expect(v.SS_PASSWORD_RE.test(creds.ssPassword)).toBe(true);
  expect(v.SHORT_ID_RE.test('ABCDEF0123456789')).toBe(false);
});

it.each(['0.0.0.0', '255.255.255.255', '1.2.3.4'])('accepts IPv4 %s', (s) =>
  expect(v.isIpv4(s)).toBe(true),
);
it.each(['01.2.3.4', '256.1.1.1', '1.1.1', '1.2.3.4\n'])(
  'rejects IPv4 %s',
  (s) => expect(v.isIpv4(s)).toBe(false),
);
it('distinguishes permissive and strict IPv6', () => {
  for (const s of ['::', '::1', '2001:db8::1', '1:2:3:4:5:6:7:8'])
    expect(v.isIpv6Strict(s)).toBe(true);
  for (const s of ['1:2:3', '12345::1']) {
    expect(v.isIpv6(s)).toBe(true);
    expect(v.isIpv6Strict(s)).toBe(false);
  }
  for (const s of ['1:::2', '1::2::3', 'fe80::1%eth0', '::ffff:1.2.3.4']) {
    expect(v.isIpv6(s)).toBe(false);
    expect(v.isIpv6Strict(s)).toBe(false);
  }
});

it('validates hostnames and dispatches numeric and colon addresses', () => {
  expect(v.isHostname('a-b.example')).toBe(true);
  for (const s of ['-bad', 'a.', 'a'.repeat(64), 'a'.repeat(254)])
    expect(v.isHostname(s)).toBe(false);
  expect(v.isValidServerAddress('999.1')).toBe(false);
  expect(v.isValidServerAddress('example.org')).toBe(true);
  expect(v.isValidServerAddress('1:2:3')).toBe(true);
});

it('matches public address exclusions', () => {
  for (const s of ['8.8.8.8', '2606:4700::1111', '192.0.0.1'])
    expect(v.isPublicIp(s)).toBe(true);
  for (const s of [
    '0.1.2.3',
    '10.1.1.1',
    '127.0.0.1',
    '224.0.0.1',
    '100.64.0.1',
    '169.254.1.1',
    '172.31.1.1',
    '192.168.1.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '198.18.1.1',
    'fc00::1',
    '::1',
    '2001:0db8::1',
  ])
    expect(v.isPublicIp(s)).toBe(false);
});

it('parses only IP ISP hosts and normalizes ports', () => {
  expect(v.parseIspAddr('[2001:db8::1]:01080')).toEqual({
    host: '2001:db8::1',
    port: 1080,
    addr: '[2001:db8::1]:1080',
  });
  expect(v.parseIspAddr('1.2.3.4:00001')?.port).toBe(1);
  for (const s of ['host:80', '1.2.3.4:0', '1.2.3.4:65536', '[1:2:3]:80'])
    expect(v.parseIspAddr(s)).toBeNull();
});

it('counts credentials in bytes and rejects controls and lone surrogates', () => {
  expect(v.validCred('雪😀')).toBe(true);
  expect(v.validCred('a'.repeat(255))).toBe(true);
  for (const s of ['', '雪'.repeat(86), 'a\x7f', 'a\n', '\ud800', '\udc00'])
    expect(v.validCred(s)).toBe(false);
});
