/**
 * Dashboard sign-in when the account's D1 daily allowance is used up (2026-10-06: every D1 query failed
 * with 500 internal_error, shown as "Sign-in is unavailable right now"). The Worker answers a distinct,
 * safe 503 with the reset time; wrong passwords and rate limiting are unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, PASSWORD } from './helpers.mjs';
import { d1DailyLimit, errorResponse } from '../src/http.js';
import { failureMessage, vietnamTime } from '../../js/weeklyReports.js';

const READ = "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
const WRITE = "Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
/** The env's D1 with every statement failing like D1 does once the daily limit is reached. */
function exhausted(env, message = READ) {
  const fail = async () => { throw new Error(message); };
  const stmt = { bind: () => stmt, first: fail, all: fail, run: fail, raw: fail };
  return { ...env, DB: { prepare: () => stmt, batch: fail, exec: fail } };
}

test('D1 daily limit: recognised by its documented text (also wrapped), with the next 00:00 UTC reset', () => {
  const now = new Date('2026-10-06T07:19:00Z');
  assert.deepEqual(d1DailyLimit(new Error(READ), now), { limit: 'read', resetAt: '2026-10-07T00:00:00.000Z' });
  assert.deepEqual(d1DailyLimit(new Error('wrapped', { cause: new Error(WRITE) }), now), { limit: 'write', resetAt: '2026-10-07T00:00:00.000Z' });
  assert.equal(d1DailyLimit(new Error('D1_ERROR: no such table: x'), now), null);
  const r = errorResponse(new Error(READ), null, now);
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('Retry-After'), String(16 * 3600 + 41 * 60));
  assert.equal(vietnamTime('2026-10-07T00:00:00.000Z'), 'Wed 7 Oct, 07:00');
});

test('D1 daily limit: sign-in answers 503 d1_daily_limit_reached, never "wrong password", and leaks nothing', async () => {
  const env = await makeEnv();
  for (const msg of [READ, WRITE]) {
    const r = await call(exhausted(env, msg), 'POST', '/v1/auth/login', { body: { password: PASSWORD } });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, 'd1_daily_limit_reached');
    assert.match(r.json.detail.resetAt, /T00:00:00\.000Z$/);
    assert.ok(!JSON.stringify(r.json).includes(PASSWORD) && !/upgrade|D1_ERROR/i.test(JSON.stringify(r.json)), 'no password, no internal text');
    const wrong = await call(exhausted(env, msg), 'POST', '/v1/auth/login', { body: { password: 'nope' } });
    assert.equal(wrong.status, 503, 'the password is not checked: a service failure is not a wrong password');
  }
  // Reads behind a session get the same answer; other D1 failures stay a plain 500.
  const other = { ...env, DB: { prepare: () => { throw new Error('D1_ERROR: something else'); } } };
  assert.equal((await call(other, 'POST', '/v1/auth/login', { body: { password: PASSWORD } })).json.error, 'internal_error');
  // With D1 available: a wrong password is 401 and the 11th failure is still rate limited.
  for (let i = 0; i < 10; i++) assert.equal((await call(env, 'POST', '/v1/auth/login', { body: { password: 'nope' } })).status, 401);
  assert.equal((await call(env, 'POST', '/v1/auth/login', { body: { password: PASSWORD } })).status, 429);
});

test('D1 daily limit: the dashboard says what happened, with the reset in Vietnam time', () => {
  const quota = { status: 503, code: 'd1_daily_limit_reached', detail: { resetAt: '2026-10-07T00:00:00.000Z' } };
  assert.equal(failureMessage(quota, { signIn: true }),
    'The reporting service has used its free daily database allowance. It is available again after Wed 7 Oct, 07:00 (Vietnam time). Your password was not checked.');
  assert.match(failureMessage(quota), /available again after Wed 7 Oct, 07:00/);
  assert.equal(failureMessage({ status: 401 }, { signIn: true }), 'That password was not accepted.');
  assert.match(failureMessage({ status: 429, code: 'rate_limited' }, { signIn: true }), /Too many sign-in attempts/);
  assert.equal(failureMessage({ status: 503, code: 'proxy_not_configured' }), 'The dashboard is not connected to the reporting service yet.');
  assert.equal(failureMessage({ status: 500, code: 'internal_error' }, { signIn: true }), 'Sign-in is unavailable right now.');
  assert.equal(failureMessage(null), 'The weekly reports are unavailable right now.');
});
