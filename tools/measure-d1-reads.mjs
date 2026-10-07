#!/usr/bin/env node
/**
 * measure-d1-reads.mjs — rows read / written by the hot D1 lookups, before and after migration 0020,
 * plus the per-run checks for unfinished verification and stale comparisons,
 * on a production-sized synthetic history, using workerd's local D1 (Miniflare reports rows_read and
 * rows_written exactly as D1 does). Local only: no Cloudflare account, no quota.
 *   node tools/measure-d1-reads.mjs [--orders-per-day 73] [--from 2025-12-22] [--to 2026-10-04]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = path.join(ROOT, 'worker/node_modules/.bin/wrangler');
const { Miniflare } = await import(pathToFileURL(path.join(ROOT, 'worker/node_modules/miniflare/dist/src/index.js')).href);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PER_DAY = Number(arg('--orders-per-day', 73)), FROM = arg('--from', '2025-12-22'), TO = arg('--to', '2026-10-04');
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const weekStart = d => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));

// Schema up to 0019 through wrangler's own local migration runner.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-measure-'));
fs.mkdirSync(path.join(dir, 'migrations'));
for (const f of fs.readdirSync(path.join(ROOT, 'worker/migrations')).filter(f => f < '0020')) fs.copyFileSync(path.join(ROOT, 'worker/migrations', f), path.join(dir, 'migrations', f));
fs.writeFileSync(path.join(dir, 'wrangler.toml'), 'name = "m"\nmain = "w.js"\ncompatibility_date = "2026-01-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "m"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\nmigrations_dir = "migrations"\n');
fs.writeFileSync(path.join(dir, 'w.js'), 'export default { fetch() { return new Response("x") } }');
execFileSync(W, ['d1', 'migrations', 'apply', 'm', '--local'], { cwd: dir, env: { ...process.env, CI: 'true' }, stdio: 'ignore' });
const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("x") } }',
  d1Databases: { DB: '00000000-0000-0000-0000-000000000000' }, d1Persist: path.join(dir, '.wrangler/state/v3/d1') });
const db = await mf.getD1Database('DB');

// Synthetic history: PER_DAY orders a day from Jan 1, each shipped 1–3 days later; 56-day report versions
// owning their dates, the last one overlapping the previous (as the weekly rolling report does).
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const days = []; for (let d = FROM; d <= TO; d = addDays(d, 1)) days.push(d);
const versions = []; for (let a = FROM; a <= TO; a = addDays(a, 56)) versions.push([`scr_${String(versions.length).padStart(20, '0')}`, a, addDays(a, 55) > TO ? TO : addDays(a, 55)]);
versions.push([`scr_${String(versions.length).padStart(20, '0')}`, addDays(TO, -55), TO]);
const owner = d => [...versions].reverse().find(v => v[1] <= d && d <= v[2])[0];
const groups = new Map(days.map(d => [d, []])), orders = [];
let n = 0;
for (const d of days) if (d >= '2026-01-01') for (let i = 0; i < PER_DAY; i++) {
  const key = String(100000 + ++n), ship = addDays(d, 1 + Math.floor(rnd() * 3));
  orders.push([key, weekStart(d)]);
  if (groups.has(ship)) groups.get(ship).push([key, 300 + Math.floor(rnd() * 1200), 1]);
}
const V = db.prepare("INSERT INTO scr_version (version_id,source_id,requested_from,requested_to,exported_at,imported_at,status,outcome) VALUES (?1,?1,?2,?3,?3,?3,'accepted','{}')");
const D = db.prepare("INSERT INTO scr_day (version_id,ship_date,day_hash,cost_cents,row_count,groups,outcome) VALUES (?1,?2,?3,0,0,?4,'new')");
const O = db.prepare("INSERT INTO scr_day_owner (ship_date,version_id,day_hash,activation_id) VALUES (?1,?2,?3,'sca')");
const P = db.prepare("INSERT INTO ord_ptr (order_name,order_number,week_start,body_hash,source_id,timezone,updated_at) VALUES (?1,?2,?3,'h','src','America/Los_Angeles','t')");
await db.batch(versions.map(v => V.bind(...v)));
for (let i = 0; i < days.length; i += 20) await db.batch(days.slice(i, i + 20).flatMap(d => [D.bind(owner(d), d, `h${d}`, JSON.stringify(groups.get(d).sort((a, b) => (a[0] < b[0] ? -1 : 1)))), O.bind(d, owner(d), `h${d}`)]));
for (let i = 0; i < orders.length; i += 200) await db.batch(orders.slice(i, i + 200).map(o => P.bind(`#${o[0]}`, o[0], o[1])));

// A typical closed week: its orders plus the report keys shipped in it (what the manifest searches for).
const wk = weekStart(addDays(TO, -13));
const weekOrders = orders.filter(o => o[1] === wk).map(o => o[0]);
const shipKeys = []; for (let d = wk; d <= addDays(wk, 6); d = addDays(d, 1)) shipKeys.push(...(groups.get(d) || []).map(g => g[0]));
const keys = [...new Set([...weekOrders, ...shipKeys])], newKeys = shipKeys.slice(0, 100);
const vids = [...new Set(Array.from({ length: 7 }, (_, i) => owner(addDays(wk, i))))];
const { RELATED_DATES_SQL, KNOWN_KEYS_SQL, RELATED_VERSIONS_SQL } = await import(pathToFileURL(path.join(ROOT, 'worker/src/collectWeeks.js')).href);
const { ACCEPTED_KEYS_SQL } = await import(pathToFileURL(path.join(ROOT, 'worker/src/collectScr.js')).href);
const J = 'json_each(d.groups) g WHERE json_extract(g.value, \'$[0]\') IN (SELECT value FROM json_each(?1))';
const OWN = 'scr_day_owner o JOIN scr_day d ON d.version_id = o.version_id AND d.ship_date = o.ship_date';
const queries = {
  relatedDates: [`SELECT DISTINCT o.ship_date, o.version_id, o.day_hash FROM ${OWN}, ${J}`, RELATED_DATES_SQL, [keys]],
  knownKeys: [KNOWN_KEYS_SQL, KNOWN_KEYS_SQL, [shipKeys]],
  relatedVersions: [`SELECT v.version_id, v.source_id, v.requested_from, v.requested_to, json_extract(v.outcome, '$.preserved') AS preserved FROM scr_version v WHERE v.version_id IN (SELECT DISTINCT o.version_id FROM ${OWN}, ${J}) OR v.version_id IN (SELECT value FROM json_each(?2)) ORDER BY v.version_id`, RELATED_VERSIONS_SQL, [keys, vids]],
  acceptedKeys: [`SELECT DISTINCT json_extract(g.value, '$[0]') AS k FROM ${OWN}, ${J}`, ACCEPTED_KEYS_SQL, [newKeys]],
  affectedWeeks: ['SELECT DISTINCT week_start FROM ord_ptr WHERE order_number IN (SELECT value FROM json_each(?1))', null, [newKeys]],
};
const run = async (sql, args) => { const r = await db.prepare(sql).bind(...args.map(a => JSON.stringify(a))).all(); return { read: r.meta.rows_read, res: JSON.stringify(r.results.map(x => Object.values(x)).sort()) }; };
const before = {}; for (const [k, [old, , a]] of Object.entries(queries)) before[k] = await run(old, a);
const migration = { read: 0, written: 0 };
const sql = fs.readFileSync(path.join(ROOT, 'worker/migrations/0020_bounded_lookups.sql'), 'utf8').replace(/--.*$/gm, '');
for (const s of sql.split(';').map(x => x.trim()).filter(Boolean)) { const m = (await db.prepare(s).run()).meta; migration.read += m.rows_read; migration.written += m.rows_written; }
const rows = {}; for (const [k, [old, cur, a]] of Object.entries(queries)) { const r = await run(cur || old, a); rows[k] = { before: before[k].read, after: r.read, sameResult: r.res === before[k].res }; }
const g = groups.get(addDays(wk, 1));
const ins = (await db.prepare("INSERT OR IGNORE INTO scr_day_key (order_key, version_id, ship_date) SELECT json_extract(value, '$[0]'), ?1, ?2 FROM json_each(?3)").bind('scr_scratch', addDays(wk, 1), JSON.stringify(g)).run()).meta;
const ordIns = (await db.prepare("INSERT INTO ord_ptr (order_name,order_number,week_start,body_hash,source_id,timezone,updated_at) VALUES ('#x1','x1','2026-01-05','h','src','tz','t')").run()).meta;
// Per-run lookups added for unfinished verification and stale comparisons: two chunked revisions per
// week (the newer one published or a draft), all but the last few weeks verified.
const weeks = []; for (let w = weekStart('2026-01-01'); w <= weekStart(TO); w = addDays(w, 7)) weeks.push(w);
const S = db.prepare("INSERT INTO snapshot (snapshot_id,week_start,revision,status,computed_at,engine_version,policy,profitability_status,storage,comparison_snapshot_id) VALUES (?1,?2,?3,?4,'t','e','{}','ok','chunked',?5)");
const R = db.prepare("INSERT INTO verify_report (snapshot_id,status,report,attempts,first_at,at) VALUES (?1,'verified','{}',1,'t','t')");
const sid = (w, r) => `snp_${w.replace(/-/g, '')}${r}`;
await db.batch(weeks.flatMap((w, i) => [S.bind(sid(w, 1), w, 1, 'superseded', null), S.bind(sid(w, 2), w, 2, w >= '2026-08-03' ? 'published' : 'draft', i ? sid(weeks[i - 1], 2) : null),
  R.bind(sid(w, 1)), ...(i < weeks.length - 3 ? [R.bind(sid(w, 2))] : [])]));
const { PENDING_VERIFICATION_SQL } = await import(pathToFileURL(path.join(ROOT, 'worker/src/verifyRoutes.js')).href);
const meta = async (q, ...a) => (await db.prepare(q).bind(...a).all()).meta.rows_read;
const pendingRead = await meta(PENDING_VERIFICATION_SQL, '0000-00-00', 51);
const staleCheckRead = (await meta("SELECT snapshot_id, revision, status, comparison_snapshot_id FROM snapshot WHERE week_start = ?1 AND storage = 'chunked' ORDER BY revision DESC LIMIT 1", weeks.at(-2)))
  + (await meta("SELECT snapshot_id FROM snapshot WHERE week_start = ?1 AND status = 'published'", weeks.at(-3)));
console.log(JSON.stringify({ history: { orders: orders.length, storedDays: days.length, versions: versions.length, weekKeys: keys.length, snapshots: weeks.length * 2 },
  rowsReadPerCall: rows, perRunChecks: { pendingVerificationList: pendingRead, publishedComparisonCheckPerWeek: staleCheckRead }, migration0020: migration, writeCost: { storeOneReportDay: { orderKeys: g.length, rowsWritten: ins.rows_written }, upsertOneOrderPointer: { rowsWritten: ordIns.rows_written } } }, null, 1));
await mf.dispose();
fs.rmSync(dir, { recursive: true, force: true });
