/**
 * costTables.js — the site's cost tables for saved reports (scenario costs), loaded once per tab
 * ==============================================================================================
 * The tables under ./data/ and the extra MCG cost sheet are the same for every saved report in a tab, so a table
 * that LOADED is kept and never requested again. A request that FAILED is never kept: the next report open asks
 * for that table again. The two are told apart, never guessed from the value:
 *   loaded   an HTTP success whose body is a JSON object or null. An empty table ({}) and "no table" (null,
 *            e.g. no pack-cost sheet configured) are valid answers and are kept like any other.
 *   failed   a network error, a non-2xx status, a body that is not JSON (e.g. a sign-in page) or JSON of
 *            another shape. Nothing is kept; the caller gets a stand-in value and the table's name in `failed`.
 * Requests in flight are shared, so two report opens at once make one request per table.
 */

/** The tables a saved report needs, in the order the dashboard reads them. */
export const COST_TABLES = Object.freeze(['mcg_total', 'product_costs', 'hp_supplement', 'sb_costs', 'hp_by_name', 'sku_alias',
  'vendor_costs', 'vendor_index', 'mcg_pack']);
/** Tables whose stand-in (and "no table" value) is null instead of {}. */
const NULL_WHEN_ABSENT = new Set(['mcg_pack']);
export const MCG_EXTRA = 'mcg_extra';
const urlOf = name => (name === MCG_EXTRA ? '/api/mcg-extra' : `./data/${name}.json`);
const isTable = v => v === null || (typeof v === 'object' && !Array.isArray(v));

/**
 * @param {{ fetchImpl?: typeof fetch }} [o]
 * @returns {{ one(name): Promise<{ ok: boolean, value: object|null }>, all(names?): Promise<{ tables: object, failed: string[] }>, loaded(name): boolean }}
 */
export function createCostTableLoader({ fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const kept = new Map();        // name → table (loaded; also {} and null)
  const flying = new Map();      // name → the request in flight
  const standIn = name => (NULL_WHEN_ABSENT.has(name) ? null : {});

  /** One table: { ok: true, value } when loaded (now or earlier), { ok: false, value: stand-in } when the request failed. */
  function one(name) {
    if (kept.has(name)) return Promise.resolve({ ok: true, value: kept.get(name) });
    if (flying.has(name)) return flying.get(name);
    const p = (async () => {
      try {
        const r = await fetchImpl(urlOf(name));
        if (!r.ok) return { ok: false, value: standIn(name) };
        const body = await r.json();
        if (!isTable(body)) return { ok: false, value: standIn(name) };
        const value = body === null ? standIn(name) : body;
        kept.set(name, value);
        return { ok: true, value };
      } catch {
        return { ok: false, value: standIn(name) };
      } finally {
        flying.delete(name);
      }
    })();
    flying.set(name, p);
    return p;
  }

  /** All tables: { tables: { name: table or stand-in }, failed: [names whose request failed this time] }. */
  async function all(names = COST_TABLES) {
    const res = await Promise.all(names.map(one));
    return { tables: Object.fromEntries(names.map((n, i) => [n, res[i].value])), failed: names.filter((_, i) => !res[i].ok) };
  }

  return { one, all, loaded: name => kept.has(name) };
}
