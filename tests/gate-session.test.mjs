/** shared/gateSession.js: the signed gate session, password check and client hash (synthetic keys only). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { signGateToken, verifyGateToken, passwordMatches, clientIpHash, gateConfigProblem, isGateJti, readCookie, GATE_TTL_SECONDS } from '../shared/gateSession.js';

const KEY = 'k'.repeat(40), NOW = Date.parse('2026-10-23T12:00:00Z');

test('a token verifies only with its key and epoch, inside its lifetime, untampered', async () => {
  const { token, payload } = await signGateToken({ signingKey: KEY, epoch: '3', now: NOW });
  assert.ok(isGateJti(payload.jti));
  assert.equal(payload.exp - payload.iat, GATE_TTL_SECONDS);
  assert.deepEqual(await verifyGateToken(token, { signingKey: KEY, epoch: '3', now: NOW + 1000 }), payload);
  assert.equal(await verifyGateToken(token, { signingKey: KEY, epoch: '3', now: NOW + GATE_TTL_SECONDS * 1000 }), null, 'expired');
  assert.equal(await verifyGateToken(token, { signingKey: KEY, epoch: '4', now: NOW }), null, 'other epoch');
  assert.equal(await verifyGateToken(token, { signingKey: 'j'.repeat(40), epoch: '3', now: NOW }), null, 'other key');
  const [v, body, sig] = token.split('.');
  const forgedBody = Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + 86400 })).toString('base64url');
  for (const t of [`${v}.${forgedBody}.${sig}`, `g2.${body}.${sig}`, `${v}.${body}`, `${v}.${body}.${sig}.x`, '', 'x'.repeat(2000)])
    assert.equal(await verifyGateToken(t, { signingKey: KEY, epoch: '3', now: NOW }), null, t.slice(0, 12));
  // A token claiming a longer life than 8 hours is refused even when correctly signed.
  const long = await signGateToken({ signingKey: KEY, epoch: '3', now: NOW, ttl: GATE_TTL_SECONDS * 3 });
  assert.equal(await verifyGateToken(long.token, { signingKey: KEY, epoch: '3', now: NOW }), null);
  // An unset epoch is "1".
  const d = await signGateToken({ signingKey: KEY, now: NOW });
  assert.ok(await verifyGateToken(d.token, { signingKey: KEY, epoch: '1', now: NOW }));
});

test('password check, client hash, configuration and cookie parsing', async () => {
  assert.equal(await passwordMatches('pw-1', 'pw-1', KEY), true);
  for (const e of ['pw-2', 'pw-1 ', '', null, undefined]) assert.equal(await passwordMatches(e, 'pw-1', KEY), false);
  assert.equal(await passwordMatches('', '', KEY), false, 'no password configured never matches');
  const h = await clientIpHash('203.0.113.5', KEY);
  assert.match(h, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(h, await clientIpHash('203.0.113.5', KEY));
  assert.notEqual(h, await clientIpHash('203.0.113.6', KEY));
  assert.notEqual(h, await clientIpHash('203.0.113.5', 'j'.repeat(40)), 'keyed');
  assert.equal(gateConfigProblem({ sitePassword: 'p', signingKey: KEY }), null);
  assert.equal(gateConfigProblem({ signingKey: KEY }), 'site_password_unset');
  assert.equal(gateConfigProblem({ sitePassword: 'p' }), 'signing_key_unset');
  assert.equal(gateConfigProblem({ sitePassword: 'p', signingKey: 'short' }), 'signing_key_short');
  assert.equal(gateConfigProblem({ sitePassword: KEY, signingKey: KEY }), 'signing_key_is_password');
  const req = new Request('https://x.invalid/', { headers: { cookie: 'a=1; __gp_session=g1.b.c; x__gp_session=no' } });
  assert.equal(readCookie(req), 'g1.b.c');
});
