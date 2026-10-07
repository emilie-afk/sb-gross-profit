#!/usr/bin/env node
/**
 * correction-catalog.mjs — a pinned catalog plus the MCG pack table, for an audited cost correction
 * ===============================================================================================
 *   node tools/correction-catalog.mjs <base-parts.json> <mcg-pack-tab.csv> <out-tables.json>
 *
 * <base-parts.json>: the pinned catalog's stored parts, [{ table_name, part, payload }] (as
 * `SELECT table_name, part, payload FROM cost_catalog_part WHERE catalog_rev = ?` returns them).
 * <mcg-pack-tab.csv>: the MCG succulent-pack tab exported as CSV (outside the repository).
 * Writes the base's tables unchanged with `mcg_pack` added or replaced (parsed exactly as build.py and
 * the Worker do), ready for the chunked catalog push (catalog_push.py). So a corrected revision changes
 * the pack costs only, not whatever else changed in the sheets since the week's catalog was pinned. The
 * Worker checks the same when the correction is registered (POST /v1/admin/cost-corrections refuses a
 * catalog that differs from the week's original outside the MCG table).
 * Refuses a base whose mcgExtra / overrides are not empty (a chunked push carries tables only), and a
 * base that already has exactly this MCG table. Prints counts and hashes only.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseMcgPackRows } from '../shared/catalogBuild.js';
import { pyCsvRows } from '../shared/pyCompat.js';
import { catalogPartsRevOf, validateCatalog, CATALOG_TABLES } from '../shared/catalog.js';

const [partsFile, csvFile, outFile] = process.argv.slice(2);
if (!partsFile || !csvFile || !outFile) { console.error('usage: correction-catalog.mjs <base-parts.json> <mcg-pack-tab.csv> <out-tables.json>'); process.exit(2); }
const raw = JSON.parse(fs.readFileSync(partsFile, 'utf8'));
const parts = Array.isArray(raw) ? (raw[0]?.results || raw) : raw.results;
const baseRev = await catalogPartsRevOf(parts.map(p => [p.table_name, p.part, p.payload]));
const grouped = {};
for (const p of parts) (grouped[p.table_name] ??= []).push(p);
const tables = {}, fixed = {};
for (const [t, rows] of Object.entries(grouped)) {
  const v = JSON.parse(rows.sort((a, b) => a.part - b.part).map(r => r.payload).join(''));
  if (t.startsWith('__')) fixed[t] = v; else tables[t] = v;
}
if (Object.keys(fixed.__mcgExtra || {}).length || Object.keys(fixed.__overrides || {}).length) throw new Error('The base has mcgExtra or overrides; a chunked push cannot carry them');
const unknown = Object.keys(tables).filter(t => !CATALOG_TABLES.includes(t));
if (unknown.length) throw new Error(`Unknown tables in the base: ${unknown.join(', ')}`);
const bytes = fs.readFileSync(csvFile);
const pack = parseMcgPackRows(pyCsvRows(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '')));
if (!pack.costs) throw new Error(`MCG pack tab not imported: ${pack.stats.error}`);
const out = { ...tables, mcg_pack: Object.fromEntries(pack.costs) };            // only the MCG table changes (added or replaced)
if (JSON.stringify(tables.mcg_pack || null) === JSON.stringify(out.mcg_pack)) throw new Error('The base already has this MCG table: nothing to correct');
const v = validateCatalog({ tables: out });
if (!v.accepted) throw new Error(`The corrected catalog would be refused: ${v.reasons.join('; ')}`);
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(JSON.stringify({ baseCatalogRev: baseRev, tables: Object.fromEntries(Object.entries(out).map(([k, t]) => [k, Object.keys(t).length])),
  mcgPack: pack.stats, packCsvSha256: crypto.createHash('sha256').update(bytes).digest('hex') }));
