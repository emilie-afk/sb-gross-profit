/**
 * Bounded D1 lookups (migration 0020, 2026-10-06). Production query insights showed most rows read came
 * from searching every stored Shipping Cost Report day's JSON groups (≈15–21k rows per call) and from
 * order-number lookups that scanned ord_ptr. These lookups must use an index, return exactly what the
 * old full searches returned, and stay bounded as history grows; storing a day writes one key row per order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './helpers.mjs';
import { freeTierEnv, api, ok, client, scrPayload } from './freeTierHarness.mjs';
import * as FT from '../../automation/collector/src/freeTier.mjs';
import { reportRow } from '../../tests/fixtures-shipping-cost.mjs';
import { RELATED_DATES_SQL, KNOWN_KEYS_SQL, RELATED_VERSIONS_SQL } from '../src/collectWeeks.js';
import { ACCEPTED_KEYS_SQL } from '../src/collectScr.js';

const OLD_RELATED = `SELECT DISTINCT o.ship_date, o.version_id, o.day_hash FROM scr_day_owner o JOIN scr_day d ON d.version_id = o.version_id AND d.ship_date = o.ship_date,
  json_each(d.groups) g WHERE json_extract(g.value, '$[0]') IN (SELECT value FROM json_each(?1))`;
const OLD_ACCEPTED = `SELECT DISTINCT json_extract(g.value, '$[0]') AS k FROM scr_day_owner o JOIN scr_day d ON d.version_id = o.version_id AND d.ship_date = o.ship_date,
  json_each(d.groups) g WHERE json_extract(g.value, '$[0]') IN (SELECT value FROM json_each(?1))`;

function migrated() {
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  return db;
}

test('bounded lookups: every hot lookup searches an index; only the parameter list is scanned', () => {
  const db = migrated();
  for (const sql of [RELATED_DATES_SQL, KNOWN_KEYS_SQL, RELATED_VERSIONS_SQL, ACCEPTED_KEYS_SQL,
                     'SELECT DISTINCT week_start FROM ord_ptr WHERE order_number IN (SELECT value FROM json_each(?1))']) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(r => r.detail);
    const scans = plan.filter(d => /^SCAN /.test(d) && !/json_each/.test(d));
    assert.deepEqual(scans, [], `${sql.slice(0, 60)}… scans: ${scans.join('; ')}`);
    assert.ok(!plan.some(d => /scr_day d\b|SCAN d\b/.test(d)), 'no stored day groups are read');
  }
});

test('bounded lookups: the migration backfills one key row per stored order and the new lookups equal the old full searches', () => {
  const db = new DatabaseSync(':memory:');
  const files = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
  for (const f of files.filter(f => f < '0020')) db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  // A history before 0020: 3 versions, 120 days, a later version owning part of an earlier one's range.
  const ins = (sql, ...a) => db.prepare(sql).run(...a);
  const day = (v, d, keys) => { const g = keys.map(k => [k, 500, 1]); ins("INSERT INTO scr_day VALUES (?, ?, ?, 500, 1, ?, 'new')", v, d, `h${v}${d}`, JSON.stringify(g)); };
  const dates = Array.from({ length: 120 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
  for (const v of ['scr_a', 'scr_b', 'scr_c']) ins("INSERT INTO scr_version VALUES (?, ?, '2026-01-01', '2026-04-30', NULL, '2026-05-01', 'accepted', '{}', NULL, NULL, NULL)", v, `src_${v}`);
  dates.forEach((d, i) => {
    day('scr_a', d, [String(1000 + i * 3), String(1001 + i * 3)]);
    if (i >= 60) day('scr_b', d, [String(1000 + i * 3), String(1002 + i * 3)]);       // a later report of the same dates
    ins('INSERT INTO scr_day_owner VALUES (?, ?, ?, ?)', d, i >= 60 ? 'scr_b' : 'scr_a', `h${i >= 60 ? 'scr_b' : 'scr_a'}${d}`, 'sca');
  });
  for (let i = 0; i < 400; i++) ins("INSERT INTO ord_ptr VALUES (?, ?, '2026-01-05', 'h', 'src', 'America/Los_Angeles', 't')", `#${1000 + i}`, String(1000 + i));
  const keys = JSON.stringify(Array.from({ length: 50 }, (_, i) => String(1000 + i * 7)));
  const before = { related: db.prepare(OLD_RELATED).all(keys), accepted: db.prepare(OLD_ACCEPTED).all(keys) };
  db.exec(fs.readFileSync(path.join(MIGRATIONS, files.find(f => f.startsWith('0020'))), 'utf8'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scr_day_key').get().n, 120 * 2 + 60 * 2, 'one key row per stored order of every stored day');
  const sort = rows => JSON.stringify(rows.map(r => ({ ...r })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  assert.equal(sort(db.prepare(RELATED_DATES_SQL).all(keys)), sort(before.related), 'related owned dates unchanged');
  assert.equal(sort(db.prepare(ACCEPTED_KEYS_SQL).all(keys)), sort(before.accepted), 'keys with accepted cost unchanged');
  assert.ok(before.related.length > 0 && before.accepted.length > 0);
});

test('bounded lookups: storing a report writes its order keys, including costs kept from an omitting report', async () => {
  const env = await freeTierEnv(), c = client(env);
  for (const [k, v] of [['shipping_cost_auto_accept_enabled', true], ['shipping_cost_auto_accept_rules', 'flag_and_accept']]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: ${k}` }), k);
  const rows = list => list.map(([date, order, cost]) => reportRow({ date, order, cost, paid: '5.00' }));
  const v1 = await FT.uploadShippingCostReport(c, scrPayload(rows([['2026-08-04', '900301', '5.00'], ['2026-08-04', '900302', '7.00']]), '2026-08-03', '2026-08-09'));
  const v2 = await FT.uploadShippingCostReport(c, scrPayload(rows([['2026-08-04', '900302', '9.00']]), '2026-08-03', '2026-08-09', '2026-08-12T15:00:00Z'));
  const keysOf = v => env.DB.prepare('SELECT order_key FROM scr_day_key WHERE version_id = ?1 ORDER BY order_key').bind(v).all().then(r => r.results.map(x => x.order_key));
  assert.deepEqual(await keysOf(v1.versionId), ['900301', '900302']);
  assert.deepEqual(await keysOf(v2.versionId), ['900301', '900302'], 'the kept 900301 is in the stored day, so it is indexed too');
  const owned = await env.DB.prepare(RELATED_DATES_SQL).bind(JSON.stringify(['900301'])).all();
  assert.deepEqual(owned.results.map(r => [r.ship_date, r.version_id]), [['2026-08-04', v2.versionId]], 'only the current owner is found');
});
