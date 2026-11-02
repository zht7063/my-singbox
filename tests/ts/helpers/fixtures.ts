import {
  parseEnv,
  renderGeneratedEnv,
  envWithIsp,
} from '../../../src/core/env.js';
import { buildModel } from '../../../src/model.js';
export const FIXTURE_UUID = '11111111-2222-3333-4444-555555555555';
export const FIXTURE_PRIVATE_KEY =
  'PRIVprivPRIVprivPRIVprivPRIVprivPRIVprivP_-';
export const FIXTURE_PUBLIC_KEY = 'PUBpubPUBpubPUBpubPUBpubPUBpubPUBpubPUBpx_-';
export const FIXTURE_SHORT_ID = '0123456789abcdef';
export const FIXTURE_SS_PASSWORD = 'AAAAAAAAAAAAAAAAAAAAAA==';
export const FIXTURE_SERVER = '203.0.113.10';
export const creds = {
  singBoxVersion: '1.12.0',
  vlessUuid: FIXTURE_UUID,
  realityPrivateKey: FIXTURE_PRIVATE_KEY,
  realityPublicKey: FIXTURE_PUBLIC_KEY,
  realityShortId: FIXTURE_SHORT_ID,
  ssPassword: FIXTURE_SS_PASSWORD,
  serverAddress: FIXTURE_SERVER,
};
export const isp = {
  addr: '[2001:db8::1]:01080',
  user: 'name $ "雪',
  pass: 'secret\\$#"',
  egressIp: '198.51.100.2',
};
export function fixtureText(withIsp = false) {
  const text = renderGeneratedEnv(creds);
  return withIsp ? envWithIsp(text, isp) : text;
}
export function fixtureEnv(withIsp = false) {
  return parseEnv(fixtureText(withIsp));
}
export function fixtureModel(withIsp = false) {
  return buildModel(fixtureEnv(withIsp));
}
