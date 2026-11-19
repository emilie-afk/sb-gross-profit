// stableStringify is the basis of every content hash: the faster form must give
// byte-identical output to the original map/join form for every value shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stableStringify } from '../shared/normalized.js';
import { dataset } from '../worker/test/freeTierHarness.mjs';
import { dayCanonical, versionDays } from '../shared/scrDays.js';
import { parseShippingCostReport } from '../shared/adapters/shippingCostReport.js';
import { parseCSV } from '../shared/calculator.js';

function reference(v) {
  if (Array.isArray(v)) return `[${v.map(reference).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${reference(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const leaf = () => [null, undefined, true, false, 0, -0, 1.5, -3, 1e21, NaN, Infinity, '', 'a"b', 'é \\', '﻿x', 12345678901234567890][Math.floor(rnd() * 16)];
function gen(depth) {
  const r = rnd();
  if (depth > 4 || r < 0.35) return leaf();
  if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 5) }, () => gen(depth + 1));
  const o = {}; for (let i = 0; i < Math.floor(rnd() * 5); i++) o[['b', 'a', '10', '2', 'z"', 'é', ''][Math.floor(rnd() * 7)] + i] = gen(depth + 1);
  return o;
}

test('stableStringify: identical to the map/join form on random values, sparse arrays, dates and a full dataset', () => {
  for (let i = 0; i < 5000; i++) { const v = gen(0); assert.equal(stableStringify(v), reference(v)); }
  const sparse = [1, , 3]; sparse[6] = { b: undefined, a: [undefined] };            // eslint-disable-line no-sparse-arrays
  for (const v of [sparse, new Date(0), { d: new Date(0) }, [], {}, 'x', 5, null, undefined, [[[]]], { a: { b: { c: [] } } }]) assert.equal(stableStringify(v), reference(v));
  const d = dataset({ n: 400 });
  for (const v of [d.catalog, d.shopify, d.scr, d.meta]) assert.equal(stableStringify(v), reference(v));
});

test('dayCanonical: native JSON equals the key-sorted form for every date of a full report', async () => {
  const d = dataset({ n: 400 });
  const rows = parseShippingCostReport(parseCSV(d.scr.text), { requestedFrom: d.scr.requestedFrom, requestedTo: d.scr.requestedTo }).rows;
  const days = await versionDays(rows, d.scr.requestedFrom, d.scr.requestedTo);
  assert.ok(days.some(x => x.groups.length > 1));
  for (const x of days) assert.equal(dayCanonical(x.date, x.groups), stableStringify({ date: x.date, groups: x.groups }));
  assert.equal(dayCanonical('2026-08-03', []), stableStringify({ date: '2026-08-03', groups: [] }));
});
