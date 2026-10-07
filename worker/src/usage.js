/**
 * usage.js — D1 usage metering and the background-work budget (Free plan)
 * ======================================================================
 * The Workers Free plan allows 5,000,000 D1 rows read and 100,000 rows written per day for the
 * whole ACCOUNT (production and staging share it); once either is used up, every query fails until
 * 00:00 UTC, dashboard sign-in included. Background work (collection, compute, verification,
 * backfills) must stop well before that so the team can still sign in and browse.
 *
 * Measurement:
 *   1. This Worker meters its own D1 statements: every result's meta.rows_read / meta.rows_written
 *      (the figures D1 bills) is summed per request and added to d1_usage(day, scope). The meter
 *      sees only THIS Worker's queries: not staging, not the Cloudflare console or REST API, not
 *      migrations. Those are covered by a configured reserve, not measured.
 *   2. Optional: with CF_ANALYTICS_TOKEN (read-only Account Analytics) and CF_ACCOUNT_ID, the budget
 *      also reads the account-wide D1 totals for the day from Cloudflare's GraphQL Analytics API and
 *      uses the larger figure. Analytics lag by a few minutes.
 *
 * Budget (all configurable as Worker variables; defaults in BUDGET_DEFAULTS):
 *   defer background work when  measured / daily allowance + unmetered reserve  ≥ BACKGROUND_DEFER_AT
 *   for reads or for writes, or when background work alone used its own daily cap. This is a
 *   conservative limit, not a guaranteed reserve: unmetered use can still consume the headroom.
 */
import { json } from './http.js';

export const BUDGET_DEFAULTS = Object.freeze({
  D1_DAILY_READS: 5_000_000,            // Workers Free, per account
  D1_DAILY_WRITES: 100_000,
  BACKGROUND_DEFER_AT: 0.60,            // defer background work at 60% of either allowance
  D1_UNMETERED_RESERVE: 0.10,           // staging, console, REST API, migrations: not seen by the meter
  BACKGROUND_DAILY_READS: 2_000_000,    // background work's own daily cap (this Worker)
  BACKGROUND_DAILY_WRITES: 40_000,
});

/** Rows read and written by one meter upsert into d1_usage (measured with workerd's D1: tools/measure-run.mjs). */
export const METER_COST = Object.freeze({ read: 1, written: 1 });

/** Routes whose D1 use counts as background work (everything else is the dashboard). */
export const backgroundScope = path => /^\/v1\/(collect|ingest|verify|admin)\//.test(path) ? 'background' : 'dashboard';

/** A per-request meter: { read, written, statements, unmetered }. */
export const newMeter = () => ({ read: 0, written: 0, statements: 0 });

/**
 * The D1 binding with every statement's rows read / written added to `meter`. Same API for what the
 * Worker uses: prepare → bind → first / all / run, and batch. first() is answered from all(): D1's
 * first() runs the whole statement and returns its first row, so rows read are the same.
 */
export function meteredDb(db, meter) {
  const real = new WeakMap();
  const add = m => { if (!m) return; meter.statements++; meter.read += Number(m.rows_read) || 0; meter.written += Number(m.rows_written) || 0; };
  const wrap = stmt => {
    const w = {
      bind: (...args) => wrap(stmt.bind(...args)),
      async first(col) {
        const r = await stmt.all(); add(r?.meta);
        const row = r?.results?.[0] ?? null;
        return col === undefined ? row : (row && col in row ? row[col] : null);
      },
      async all() { const r = await stmt.all(); add(r?.meta); return r; },
      async run() { const r = await stmt.run(); add(r?.meta); return r; },
    };
    real.set(w, stmt);
    return w;
  };
  return {
    prepare: sql => wrap(db.prepare(sql)),
    async batch(stmts) { const rs = await db.batch(stmts.map(s => real.get(s) || s)); for (const r of rs || []) add(r?.meta); return rs; },
    exec: q => db.exec(q),
    get db() { return db.db; },                                      // test stand-in passthrough
  };
}

const today = (now = new Date()) => now.toISOString().slice(0, 10);
const nextReset = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

/** Add one request's metered use to the day's row (one upsert). Nothing is written for a request that used nothing. */
export async function recordUsage(db, scope, meter, now = new Date()) {
  if (!meter.read && !meter.written) return;
  await db.prepare(`INSERT INTO d1_usage (day, scope, rows_read, rows_written, requests) VALUES (?1, ?2, ?3, ?4, 1)
      ON CONFLICT(day, scope) DO UPDATE SET rows_read = rows_read + excluded.rows_read, rows_written = rows_written + excluded.rows_written, requests = requests + 1`)
    .bind(today(now), scope, meter.read, meter.written).run();
}

const num = (env, k) => { const v = Number(env?.[k]); return Number.isFinite(v) && v >= 0 ? v : BUDGET_DEFAULTS[k]; };
export function budgetConfig(env) {
  const c = Object.fromEntries(Object.keys(BUDGET_DEFAULTS).map(k => [k, num(env, k)]));
  if (!(c.BACKGROUND_DEFER_AT > 0 && c.BACKGROUND_DEFER_AT <= 1)) c.BACKGROUND_DEFER_AT = BUDGET_DEFAULTS.BACKGROUND_DEFER_AT;
  if (!(c.D1_UNMETERED_RESERVE < c.BACKGROUND_DEFER_AT)) c.D1_UNMETERED_RESERVE = BUDGET_DEFAULTS.D1_UNMETERED_RESERVE;
  return c;
}

/** Account-wide D1 rows read / written today from Cloudflare's GraphQL Analytics API, or null. */
export async function accountUsage(env, { fetchImpl = fetch, now = new Date() } = {}) {
  if (!env?.CF_ANALYTICS_TOKEN || !/^[0-9a-f]{32}$/.test(env?.CF_ACCOUNT_ID || '')) return null;
  const query = `query($a: String!, $d: Date!) { viewer { accounts(filter: { accountTag: $a }) {
    d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date: $d }) { sum { rowsRead rowsWritten } } } } }`;
  try {
    const r = await fetchImpl('https://api.cloudflare.com/client/v4/graphql', { method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { a: env.CF_ACCOUNT_ID, d: today(now) } }), signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    const groups = j?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
    if (!Array.isArray(groups)) return null;
    return groups.reduce((s, g) => ({ rowsRead: s.rowsRead + (Number(g?.sum?.rowsRead) || 0), rowsWritten: s.rowsWritten + (Number(g?.sum?.rowsWritten) || 0) }), { rowsRead: 0, rowsWritten: 0 });
  } catch { return null; }
}

/**
 * The day's budget state. → { state: 'ok' | 'defer', reasons, resetAt, measured, config, fractions }.
 * Reads one or two d1_usage rows (plus the optional analytics call).
 */
export async function budgetState(env, db, { now = new Date(), fetchImpl = fetch } = {}) {
  const c = budgetConfig(env);
  const rows = (await db.prepare('SELECT scope, rows_read, rows_written, requests FROM d1_usage WHERE day = ?1').bind(today(now)).all()).results || [];
  const sum = (k, scope = null) => rows.filter(r => !scope || r.scope === scope).reduce((s, r) => s + (Number(r[k]) || 0), 0);
  // The meter's own upsert (one per metered request) is not in its sums: it is added here at its measured
  // cost (METER_COST: rows read and written per upsert, tools/measure-run.mjs), so the budget counts it.
  const req = (scope = null) => rows.filter(r => !scope || r.scope === scope).reduce((s, r) => s + (Number(r.requests) || 0), 0);
  const metered = { rowsRead: sum('rows_read') + req() * METER_COST.read, rowsWritten: sum('rows_written') + req() * METER_COST.written,
                    backgroundRowsRead: sum('rows_read', 'background') + req('background') * METER_COST.read,
                    backgroundRowsWritten: sum('rows_written', 'background') + req('background') * METER_COST.written, meterRequests: req() };
  const account = await accountUsage(env, { fetchImpl, now });
  const used = { rowsRead: Math.max(metered.rowsRead, account?.rowsRead || 0), rowsWritten: Math.max(metered.rowsWritten, account?.rowsWritten || 0) };
  const fractions = { reads: used.rowsRead / c.D1_DAILY_READS + c.D1_UNMETERED_RESERVE, writes: used.rowsWritten / c.D1_DAILY_WRITES + c.D1_UNMETERED_RESERVE };
  const reasons = [];
  if (fractions.reads >= c.BACKGROUND_DEFER_AT) reasons.push('daily_reads_threshold');
  if (fractions.writes >= c.BACKGROUND_DEFER_AT) reasons.push('daily_writes_threshold');
  if (metered.backgroundRowsRead >= c.BACKGROUND_DAILY_READS) reasons.push('background_reads_cap');
  if (metered.backgroundRowsWritten >= c.BACKGROUND_DAILY_WRITES) reasons.push('background_writes_cap');
  return { state: reasons.length ? 'defer' : 'ok', reasons, resetAt: nextReset(now), day: today(now),
           measured: { ...metered, source: account ? 'worker_meter+account_analytics' : 'worker_meter', ...(account ? { account } : {}) },
           fractions: { reads: Math.round(fractions.reads * 1000) / 1000, writes: Math.round(fractions.writes * 1000) / 1000 },
           config: c };
}

/** GET /v1/collect/budget (ingest). */
export async function getBudget(env, db) {
  try { return json(await budgetState(env, db)); }
  catch { return json({ error: 'budget_unavailable', message: 'D1 usage could not be read; background work does not start' }, 503); }
}

/** Per-isolate cache of the budget for the Worker's own gate (one d1_usage read per minute at most). */
let cached = null;
export async function backgroundDeferred(env, db, now = new Date()) {
  if (cached && cached.until > now.getTime() && cached.env === env.SB_ENVIRONMENT) return cached.b.state === 'defer' ? cached.b : null;
  let b;
  // Fail closed: when usage cannot be read, background work does not run (it would be unmetered); the
  // dashboard is not affected. Not cached, so the next request reads again.
  try { b = await budgetState(env, db, { now }); }
  catch { return { state: 'defer', reasons: ['budget_unavailable'], resetAt: nextReset(now) }; }
  cached = { b, until: now.getTime() + 60_000, env: env.SB_ENVIRONMENT };
  return b.state === 'defer' ? b : null;
}
export const _resetBudgetCache = () => { cached = null; };
