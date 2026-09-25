/**
 * C6d — live Products Master tabs overlaid on a pinned base catalog. Pure
 * functions, synthetic sheets only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticSheets, livelyRootTab } from './fixtures-catalog.mjs';
import { buildCatalogTables, parseLivelyRootTab } from '../shared/catalogBuild.js';
import { pyCsvRows } from '../shared/pyCompat.js';
import { MANUAL_LR_COSTS } from '../shared/catalogManual.js';
import {
  overlayVendorTabs, assertBasePreserved, validateBaseCatalog, catalogCompleteness, OVERLAY_SOURCES, UNRESOLVED_SOURCES, BASE_TABLES,
} from '../shared/catalogOverlay.js';
import { validateCatalog, engineArgsFromCatalog } from '../shared/catalog.js';

const tabs = (sheets = syntheticSheets({ scale: true })) => Object.fromEntries(OVERLAY_SOURCES.map(k => [k, sheets[k].replace(/^﻿/, '')]));
const base = () => ({
  tables: {
    mcg_total: { S2KY2965: 4.5, EEZZ7680: 9.99, 'LG-PAD-1': 7.77 },
    product_costs: { 'HPX-1': 9, 'AS-001': 7, 'PRAY DLX': 1.00 },           // a stale Live to Give cost
    sku_weights: { 'HPX-1': 1.5 }, sb_costs: { 'MG-ALOE': 4.5 }, hp_supplement: { 'FH-POTHOS': 9 }, hp_by_name: {}, sku_alias: { 'AMZ-1': 'S2KY1111' },
  },
  mcgExtra: { X1: { cost: 2 } }, overrides: {},
});

test('C6d: the five tabs are the only live sources; everything else is disclosed as unresolved', () => {
  assert.deepEqual(OVERLAY_SOURCES, ['L2G_SHEET_URL', 'LIVELY_GOOD_SHEET_URL', 'CALATHEA_COLLECTIVE_SHEET_URL', 'SURFSIDE_ARRANGEMENT_SHEET_URL', 'LINDAMAKES_SHEET_URL']);
  for (const k of ['MCG_SHEET_URL', 'MCG_POTS_SHEET_URL', 'AS_SHEET_URL', 'HP_SHEET_URL', 'SB_SKU_ALIAS_URL', 'MCG_EXTRA_SHEET_URL', 'productExport']) assert.ok(UNRESOLVED_SOURCES.includes(k), k);
  const c = catalogCompleteness({ baseCatalogRev: 'cat_0000000000000000', base: base() });
  assert.equal(c.status, 'incomplete');
  assert.match(c.label, /^Product-cost catalog incomplete: 12 cost sources are not refreshed live/);
  assert.deepEqual(c.missingBaseTables, ['hp_by_name']);
});

test('C6d: a base holds only the existing non-vendor tables, with a non-empty mcg_total', () => {
  assert.equal(validateBaseCatalog(base()).accepted, true);
  assert.deepEqual(Object.keys(validateBaseCatalog(base()).counts), BASE_TABLES);
  assert.match(validateBaseCatalog({ tables: { ...base().tables, vendor_costs: {} } }).reasons.join(), /must not be in a base/);
  assert.match(validateBaseCatalog({ tables: { ...base().tables, mcg_total: {} } }).reasons.join(), /mcg_total is empty/);
  assert.match(validateBaseCatalog({ tables: { ...base().tables, junk: {} } }).reasons.join(), /unknown table/);
  assert.match(validateBaseCatalog({ tables: { ...base().tables, product_costs: { A: 'x' } } }).reasons.join(), /not a finite number/);
});

test('C6d: the overlay adds the vendor tables and never replaces or zeroes MCG, HPD or any other base cost', () => {
  const built = buildCatalogTables(tabs());
  const b = base();
  const { candidate, report } = overlayVendorTabs(b, built);
  assert.deepEqual(candidate.tables.mcg_total, b.tables.mcg_total, 'mcg_total untouched in manual_list mode');
  for (const t of ['sku_weights', 'sb_costs', 'hp_supplement', 'hp_by_name', 'sku_alias']) assert.deepEqual(candidate.tables[t], b.tables[t], t);
  assert.deepEqual(candidate.mcgExtra, b.mcgExtra);
  assert.equal(candidate.tables.product_costs['HPX-1'], 9);
  assert.equal(candidate.tables.product_costs['AS-001'], 7);
  assert.equal(candidate.tables.product_costs['PRAY DLX'], 29.99, 'Live to Give sets its own SKUs, as build.py does');
  assert.deepEqual(candidate.tables.vendor_costs, built.tables.vendor_costs);
  assert.deepEqual(candidate.tables.vendor_index, built.tables.vendor_index);
  assert.equal(report.productCosts.changed, 1);
  assert.equal(report.productCosts.added, report.productCosts.liveToGiveSkus - 1);
  assert.deepEqual(assertBasePreserved(b, candidate, { built }), []);
  assert.equal(validateCatalog(candidate).accepted, true, JSON.stringify(validateCatalog(candidate).reasons));
  // The engine sees the base costs and the vendor tables together.
  const a = engineArgsFromCatalog(candidate);
  assert.equal(a.mcgCosts.S2KY2965, 4.5);
  assert.ok(a.vendorCosts['LindaMakes'] && a.vendorIndex['LindaMakes']);
});

test('C6d: any change outside the overlay rules is caught', () => {
  const built = buildCatalogTables(tabs());
  const b = base();
  const { candidate } = overlayVendorTabs(b, built);
  const bad = JSON.parse(JSON.stringify(candidate));
  bad.tables.mcg_total.S2KY2965 = 0;
  delete bad.tables.sb_costs['MG-ALOE'];
  bad.tables.hp_supplement['FH-POTHOS'] = 10;
  bad.tables.product_costs['NEW-SKU'] = 1;
  const v = assertBasePreserved(b, bad, { built });
  assert.deepEqual(v.map(x => `${x.table}:${x.kind}`).sort(), ['hp_supplement:changed', 'mcg_total:zeroed', 'product_costs:added', 'sb_costs:removed']);
  assert.ok(!JSON.stringify(v).includes('S2KY2965'), 'violations name tables and kinds, never SKUs');
});

test('C6d: in sheet mode the Lively Root tab sets its SKUs in mcg_total and nothing else', () => {
  const sheets = { ...syntheticSheets({ scale: true }), LIVELY_GOOD_SHEET_URL: livelyRootTab(MANUAL_LR_COSTS) };
  const t = tabs(sheets);
  const built = buildCatalogTables(t);
  const lr = parseLivelyRootTab(pyCsvRows(t.LIVELY_GOOD_SHEET_URL));
  const b = base();
  const { candidate, report } = overlayVendorTabs(b, built, { livelyRootSource: 'sheet', livelyRootCosts: lr.costs });
  const [k0, v0] = MANUAL_LR_COSTS[0];
  assert.equal(candidate.tables.mcg_total[k0.toUpperCase()], v0);
  assert.equal(candidate.tables.mcg_total.S2KY2965, 4.5);
  assert.ok(report.mcgTotal.added > 0);
  assert.throws(() => overlayVendorTabs(b, built, { livelyRootSource: 'sheet', livelyRootCosts: new Map() }), e => e.code === 'lively_root_unavailable');
});

test('C6d: a base carrying vendor tables is refused before any overlay', () => {
  const built = buildCatalogTables(tabs());
  assert.throws(() => overlayVendorTabs({ tables: { ...base().tables, vendor_costs: {} } }, built), e => e.code === 'base_invalid');
});
