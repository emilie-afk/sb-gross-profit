/**
 * Cost tables for saved reports (js/costTables.js): a table that loaded is kept for the tab (also an empty one);
 * a request that failed is never kept and is made again by the next load. Synthetic tables.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCostTableLoader, COST_TABLES, MCG_EXTRA } from '../js/costTables.js';

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body) });
/** A fake site: `answers[name]` is a queue of answers ('fail-500' | 'network' | 'html' | 'array' | a table); the last one repeats. */
function site(answers = {}) {
  const calls = [];
  const fetchImpl = async url => {
    const name = url === '/api/mcg-extra' ? MCG_EXTRA : /^\.\/data\/(\w+)\.json$/.exec(url)?.[1];
    assert.ok(name, `unexpected URL ${url}`);
    calls.push(name);
    const q = answers[name] ?? [{ [`${name}-sku`]: 1 }];
    const a = q.length > 1 ? q.shift() : q[0];
    if (a === 'network') throw new TypeError('Failed to fetch');
    if (a === 'fail-500') return json('error', 500);
    if (a === 'html') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    if (a === 'array') return json('[1,2]');
    return json(JSON.stringify(a));
  };
  return { fetchImpl, calls, count: name => calls.filter(c => c === name).length };
}

test('failure then recovery: the failed table is requested again on the next load and then kept; loaded tables are not requested again', async () => {
  const s = site({ vendor_costs: ['fail-500', { 'LM': { 'X-1': { unitCost: 2 } } }] });
  const loader = createCostTableLoader({ fetchImpl: s.fetchImpl });
  const first = await loader.all();
  assert.deepEqual(first.failed, ['vendor_costs']);
  assert.deepEqual(first.tables.vendor_costs, {}, 'a stand-in for this report only');
  assert.equal(loader.loaded('vendor_costs'), false);
  assert.equal(s.calls.length, COST_TABLES.length);
  const second = await loader.all();                       // the next report open
  assert.deepEqual(second.failed, []);
  assert.deepEqual(second.tables.vendor_costs, { 'LM': { 'X-1': { unitCost: 2 } } }, 'recovered');
  assert.equal(s.calls.length, COST_TABLES.length + 1, 'only the failed table was requested again');
  assert.equal(s.count('vendor_costs'), 2);
  await loader.all();
  assert.equal(s.calls.length, COST_TABLES.length + 1, 'everything loaded: no request');
});

test('every kind of failure is retried: network error, error status, a sign-in page, JSON of another shape; any table, not only mcg_total', async () => {
  const s = site({ mcg_total: ['network', { A: 1 }], product_costs: ['html', { B: 2 }], sku_alias: ['array', { C: 'D' }], mcg_pack: ['fail-500', { 'P-10': 10 }],
                   [MCG_EXTRA]: ['network', { E: 5 }] });
  const loader = createCostTableLoader({ fetchImpl: s.fetchImpl });
  const first = await loader.all();
  assert.deepEqual(first.failed, ['mcg_total', 'product_costs', 'sku_alias', 'mcg_pack']);
  assert.deepEqual([first.tables.mcg_total, first.tables.sku_alias, first.tables.mcg_pack], [{}, {}, null], 'stand-ins: {} or null for the pack table');
  assert.deepEqual(await loader.one(MCG_EXTRA), { ok: false, value: {} });
  const second = await loader.all();
  assert.deepEqual(second.failed, []);
  assert.deepEqual([second.tables.mcg_total, second.tables.product_costs, second.tables.sku_alias, second.tables.mcg_pack], [{ A: 1 }, { B: 2 }, { C: 'D' }, { 'P-10': 10 }]);
  assert.deepEqual(await loader.one(MCG_EXTRA), { ok: true, value: { E: 5 } });
  for (const n of ['mcg_total', 'product_costs', 'sku_alias', 'mcg_pack', MCG_EXTRA]) assert.equal(s.count(n), 2, n);
});

test('a valid empty table and "no table" (null) are loaded answers: kept, never reported as failed, never requested again', async () => {
  const s = site({ vendor_costs: [{}], mcg_pack: [null], hp_by_name: [null], [MCG_EXTRA]: [{}] });
  const loader = createCostTableLoader({ fetchImpl: s.fetchImpl });
  const first = await loader.all();
  assert.deepEqual(first.failed, []);
  assert.deepEqual([first.tables.vendor_costs, first.tables.mcg_pack, first.tables.hp_by_name], [{}, null, {}]);
  assert.deepEqual(await loader.one(MCG_EXTRA), { ok: true, value: {} });
  await loader.all(); await loader.one(MCG_EXTRA);
  for (const n of [...COST_TABLES, MCG_EXTRA]) assert.equal(s.count(n), 1, n);
  assert.ok(loader.loaded('vendor_costs') && loader.loaded('mcg_pack'));
});

test('two loads at once share one request per table; a failure in flight is shared, then retried', async () => {
  const s = site({ vendor_index: ['fail-500', { ok: 1 }] });
  const loader = createCostTableLoader({ fetchImpl: s.fetchImpl });
  const [a, b] = await Promise.all([loader.all(), loader.all()]);
  assert.equal(s.calls.length, COST_TABLES.length, 'one request per table for both');
  assert.deepEqual([a.failed, b.failed], [['vendor_index'], ['vendor_index']]);
  assert.deepEqual((await loader.all()).failed, []);
  assert.equal(s.count('vendor_index'), 2);
});
