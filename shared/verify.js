/**
 * verify.js — independent recomputation of a collector-computed week
 * ==================================================================
 * Runs in the verifier (Netlify Function gp-verify), never on the office PC.
 * It fetches the week's pinned manifest and every input part from the Worker,
 * checks each part against its hash, recomputes the week with the unchanged
 * shared engine, derives the result parts exactly as the collector must have,
 * and compares:
 *   - every order (order row + its line rows) one by one,
 *   - every stored part byte-for-byte (order index, order and line parts, sections, scenario parts),
 *   - the stored snapshot head, totals row and narrative, and the order sequence;
 *   - the publication-gate inputs the collector supplied (totals, reconciliation, C3 shipping)
 *     against its own, and the stored gate decision against the gate re-evaluated with its own
 *     inputs and the Worker-recorded facts; the report carries the hash of the gate it verified;
 * and re-derives inputs from the RETAINED sanitized sources (provenance):
 *   - each order body from the Shopify source it was taken from,
 *   - each Shipping Cost Report date the week depends on from its source.
 *
 * Two outputs, kept apart on purpose:
 *   publicReport  status, reason code and COUNTS only — the only thing a caller
 *                 or a log line may ever see (no order names or numbers, SKUs,
 *                 amounts, field names or differences);
 *   privateDiff   field-level differences, sent only to the Worker's admin-only
 *                 verification store.
 */
import { stableStringify, addDays } from './normalized.js';
import { ENGINE_VERSION } from './snapshot.js';
import { computeFromParts, orderBodyString } from './bundle.js';
import { resultParts } from './resultParts.js';
import { sha256Hex, versionDays, dayHash, rebuildPreserved } from './scrDays.js';
import { parseCSV } from './calculator.js';
import { csvRowsToNormalizedOrders } from './adapters/legacy.js';
import { parseShippingCostReport } from './adapters/shippingCostReport.js';
import { evaluateGate, gateCore } from './gate.js';

export const MAX_DIFFS = 50;
export const PUBLIC_KEYS = ['status', 'reason', 'ordersChecked', 'orderMismatches', 'sectionsChecked', 'sectionMismatches', 'sequenceMatches',
  'provenanceChecked', 'provenanceMismatches', 'durationMs', 'engineVersion', 'gateInputsMatch', 'gateMatches', 'gateHash'];

/** The only shape a caller or a log line may receive: allowlisted keys; numbers, booleans and short codes. */
export function publicView(r) {
  const out = {};
  for (const k of PUBLIC_KEYS) {
    const v = r?.[k];
    if (v === undefined) continue;
    if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && /^[\w.:-]{1,64}$/.test(v))) out[k] = v;
  }
  return out;
}

function fieldDiffs(a, b, path, out) {
  if (out.length >= MAX_DIFFS) return;
  const t = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  if (t(a) === 'object' && t(b) === 'object') for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) fieldDiffs(a[k], b[k], path ? `${path}.${k}` : k, out);
  else if (t(a) === 'array' && t(b) === 'array') for (let i = 0; i < Math.max(a.length, b.length); i++) fieldDiffs(a[i], b[i], `${path}[${i}]`, out);
  else if (stableStringify(a ?? null) !== stableStringify(b ?? null)) {
    const d = { field: path, stored: a ?? null, recomputed: b ?? null };
    if (typeof a === 'number' && typeof b === 'number') d.deltaCents = Math.round(b * 100) - Math.round(a * 100);
    out.push(d);
  }
}
const parse = s => { try { return JSON.parse(s); } catch { return null; } };

/** The per-order strings the stored parts imply (same construction as resultParts). */
function storedOrderStrings(orderParts, lineParts) {
  const byOrder = new Map();
  const lines = lineParts.flatMap(p => p.lines).sort((a, b) => (a.order_name < b.order_name ? -1 : a.order_name > b.order_name ? 1 : a.line_index - b.line_index));
  for (const l of lines) (byOrder.get(l.order_name) || byOrder.set(l.order_name, []).get(l.order_name)).push(l);
  return new Map(orderParts.flatMap(p => p.orders).map(o => [o.order_name, stableStringify({ order: o, lines: byOrder.get(o.order_name) || [] })]));
}

/**
 * @param inputs   GET /v1/verify/snapshots/:id  { manifest, manifestHash, index, stored: { head, totals, narrative } }
 * @param api      { orderBodies(hashes) → [[hash, body]], scrDays(keys) → [[versionId, date, hash, groupsJson]],
 *                   catalogPart(rev, table, part) → text, aux(week) → { shipments, hpdOrders },
 *                   resultPart(name) → text, sourceMeta(id) → { segments, window }, sourceSegment(id, seq) → text }
 */
export async function verifySnapshot(inputs, api, { now = () => Date.now(), sourceCache = new Map() } = {}) {
  const t0 = now();
  const done = (status, extra = {}, privateDiff = null) => ({ publicReport: { status, engineVersion: ENGINE_VERSION, ...extra, durationMs: Math.round(now() - t0) }, privateDiff });
  const { manifest, index, stored } = inputs;
  if (index?.engineVersion !== ENGINE_VERSION || manifest?.engineVersion !== ENGINE_VERSION) return done('unavailable', { reason: 'engine_version_mismatch' });
  if (await sha256Hex(stableStringify(manifest)) !== inputs.manifestHash) return done('unavailable', { reason: 'manifest_hash_mismatch' });

  // 1. Inputs, each checked against its hash while the bundle is assembled.
  let parts;
  try {
    const orderBodies = new Map();
    const hashes = [...new Set(manifest.orders.map(o => o[1]))];
    for (let i = 0; i < hashes.length; i += 200) for (const [h, b] of await api.orderBodies(hashes.slice(i, i + 200))) orderBodies.set(h, b);
    const dayGroups = new Map();
    const keys = manifest.scrDays.map(([d, v]) => [v, d]);
    for (let i = 0; i < keys.length; i += 400) for (const [, , h, g] of await api.scrDays(keys.slice(i, i + 400))) dayGroups.set(h, JSON.parse(g));
    const catalogParts = [];
    for (const [t, p] of manifest.catalog.parts) catalogParts.push([t, p, await api.catalogPart(manifest.catalog.rev, t, p)]);
    const aux = await api.aux(manifest.weekStart);
    parts = { orderBodies, dayGroups, catalogParts, shipments: aux.shipments, hpdOrders: aux.hpdOrders };
  } catch { return done('unavailable', { reason: 'inputs_unreachable' }); }

  let snap;
  try { snap = await computeFromParts(manifest, parts); }
  catch (e) { return e?.code === 'part_hash_mismatch' || e?.code === 'part_missing' ? done('mismatch', { reason: 'inputs_integrity' }, { inputs: e.code }) : done('unavailable', { reason: 'recompute_failed' }); }
  const re = resultParts(snap, ENGINE_VERSION);

  // 2. Stored results, as the dashboard reads them.
  const storedParts = {};
  try { for (const name of Object.keys(index.parts)) storedParts[name] = await api.resultPart(name); }
  catch { return done('unavailable', { reason: 'results_unreachable' }); }
  const diff = { orders: [], sections: [] };
  const sections = [...new Set([...Object.keys(re.parts), ...Object.keys(storedParts)])].sort();
  let sectionMismatches = 0;
  for (const name of sections) {
    const a = storedParts[name], b = re.parts[name];
    if (a !== undefined && b !== undefined && await sha256Hex(a) === await sha256Hex(b) && index.parts[name] === await sha256Hex(b)) continue;
    sectionMismatches++;
    if (!name.startsWith('lines:') && !name.startsWith('orders:')) { const d = []; fieldDiffs(parse(a ?? 'null'), parse(b ?? 'null'), name, d); diff.sections.push(...d.slice(0, MAX_DIFFS)); }
  }
  for (const [name, a, b] of [['head', stored.head, re.head], ['totals', stored.totals, parse(re.totals)], ['narrative', parse(stored.narrative ?? 'null'), parse(re.narrative)]]) {
    if (stableStringify(a ?? null) === stableStringify(b ?? null)) continue;
    sectionMismatches++;
    const d = []; fieldDiffs(a ?? null, b ?? null, name, d); diff.sections.push(...d.slice(0, MAX_DIFFS));
  }
  // 3. Every order, one by one.
  const orderParts = Object.keys(storedParts).filter(n => n.startsWith('orders:')).map(n => parse(storedParts[n]) || { orders: [] });
  const lineParts = Object.keys(storedParts).filter(n => n.startsWith('lines:')).map(n => parse(storedParts[n]) || { lines: [] });
  const storedOrders = storedOrderStrings(orderParts, lineParts);
  const orderIndex = parse(storedParts.orderindex) || { orders: [] };
  const reOrders = new Map(re.orderStrings);
  const idxOrders = new Map(index.orders);
  let orderMismatches = 0;
  for (const n of [...new Set([...storedOrders.keys(), ...reOrders.keys(), ...idxOrders.keys()])].sort()) {
    const a = storedOrders.get(n), b = reOrders.get(n);
    if (a !== undefined && a === b && idxOrders.get(n) === await sha256Hex(b)) continue;
    orderMismatches++;
    if (diff.orders.length < MAX_DIFFS) {
      const d = []; fieldDiffs(parse(a ?? 'null') ?? { missing: 'stored' }, parse(b ?? 'null') ?? { missing: 'recomputed' }, '', d);
      for (const x of d.slice(0, MAX_DIFFS - diff.orders.length)) diff.orders.push({ order: n, ...x });
    }
  }
  const sequenceMatches = stableStringify((orderIndex.orders || []).map(t => t?.[0])) === stableStringify(snap.orders.map(o => o.orderName));

  // Publication gate. Finalize evaluated it with the collector's gate inputs: they must equal this
  // recomputation, and the stored decision must equal the gate re-evaluated with them and the facts
  // the Worker recorded (sources, catalog freshness, orders in another time zone).
  const g = inputs.gate;
  if (!g || !('ordersInOtherTimezone' in g) || !g.catalog) return done('unavailable', { reason: 'gate_record_incomplete' });
  const gateInputsMatch = stableStringify(inputs.index?.gateInputs ?? null) === stableStringify(re.gateInputs);
  if (!gateInputsMatch) { const d = []; fieldDiffs(inputs.index?.gateInputs ?? null, re.gateInputs, 'gateInputs', d); diff.sections.push(...d.slice(0, MAX_DIFFS)); }
  const regate = evaluateGate({ totals: re.gateInputs.totals, reconciliation: re.gateInputs.reconciliation, sources: g.sources,
    catalog: { accepted: true, rev: g.catalog.selectedRev, freshness: g.catalog.freshness }, settings: manifest.settings,
    ordersInOtherTimezone: g.ordersInOtherTimezone, shippingC3: re.gateInputs.shippingC3, shippingReport: manifest.shippingReportBasis });
  const gateMatches = stableStringify(gateCore(g)) === stableStringify(gateCore(regate));
  if (!gateMatches) { const d = []; fieldDiffs(gateCore(g), gateCore(regate), 'gate', d); diff.sections.push(...d.slice(0, MAX_DIFFS)); }
  const gateHash = await sha256Hex(stableStringify(gateCore(g)));

  // 4. Provenance: re-derive the inputs from the retained sanitized sources.
  let provenanceChecked = 0, provenanceMismatches = 0;
  try {
    const bySource = new Map();
    for (const [name, hash, src] of manifest.orders) (bySource.get(src) || bySource.set(src, []).get(src)).push([name, hash]);
    for (const [src, list] of bySource) {
      const rows = await sourceRows(api, src, sourceCache);
      const derived = new Map();
      for (const o of csvRowsToNormalizedOrders(rows)) derived.set(o.orderName, await sha256Hex(orderBodyString(o)));
      for (const [name, hash] of list) { provenanceChecked++; if (derived.get(name) !== hash) provenanceMismatches++; }
    }
    const weekKeys = new Set(snap.orders.map(o => String(o.orderNumber ?? '').replace(/^#/, '')).concat(manifest.orders.map(o => o[0].replace(/^#/, ''))));
    const weekEnd = addDays(manifest.weekStart, 6);
    const needed = manifest.scrDays.filter(([d, , h]) => (d >= manifest.weekStart && d <= weekEnd) || (parts.dayGroups.get(h) || []).some(g => weekKeys.has(g[0])));
    const byVersion = new Map();
    for (const [d, v, h, kept] of needed) (byVersion.get(v) || byVersion.set(v, []).get(v)).push([d, h, kept]);
    const versions = new Map(manifest.scrVersions.map(([v, src, from, to]) => [v, { src, from, to }]));
    const derivedCache = new Map();
    // A version's days as its retained source gives them (date → { hash, groups }).
    const derived = async v => {
      if (derivedCache.has(v)) return derivedCache.get(v);
      const meta = versions.get(v);
      if (!meta) { derivedCache.set(v, null); return null; }
      const rows = await sourceRows(api, meta.src, sourceCache);
      const m = new Map((await versionDays(parseShippingCostReport(rows, { requestedFrom: meta.from, requestedTo: meta.to }).rows, meta.from, meta.to)).map(x => [x.date, x]));
      derivedCache.set(v, m);
      return m;
    };
    for (const [v, dates] of byVersion) {
      const days = await derived(v);
      for (const [d, h, kept] of dates) {
        provenanceChecked++;
        if (!kept) { if (days?.get(d)?.hash !== h) provenanceMismatches++; continue; }
        // A date that kept accepted costs a later report omitted: its own source groups plus each kept
        // group exactly as the named source version holds it on that date.
        const sources = new Map();
        for (const [, kv] of kept) sources.set(kv, (await derived(kv))?.get(d)?.groups || null);
        const groups = rebuildPreserved({ ownGroups: days?.get(d)?.groups || [], preserved: kept, sourceGroups: kv => sources.get(kv) });
        if (!groups || await dayHash(d, groups) !== h) provenanceMismatches++;
      }
    }
  } catch { return done('unavailable', { reason: 'sources_unreachable' }); }
  if (provenanceMismatches) diff.provenance = { mismatches: provenanceMismatches };

  const counts = { ordersChecked: new Set([...storedOrders.keys(), ...reOrders.keys()]).size, orderMismatches, sectionsChecked: sections.length + 5,
                   sectionMismatches: sectionMismatches + (gateInputsMatch ? 0 : 1) + (gateMatches ? 0 : 1), sequenceMatches, provenanceChecked, provenanceMismatches,
                   gateInputsMatch, gateMatches };
  const ok = !orderMismatches && !sectionMismatches && sequenceMatches && !provenanceMismatches && gateInputsMatch && gateMatches;
  // The gate hash certifies a gate only when the whole draft verified.
  if (ok) counts.gateHash = gateHash;
  return ok ? done('verified', counts) : done('mismatch', counts, diff);
}

/** A retained source's rows (sources are immutable once retained, so one fetch per verifier run is enough). */
async function sourceRows(api, sourceId, cache) {
  if (cache.has(sourceId)) return cache.get(sourceId);
  const meta = await api.sourceMeta(sourceId);
  const rows = [];
  for (let i = 0; i < meta.segments.length; i++) rows.push(...parseCSV((await api.sourceSegment(sourceId, i)).replace(/^\uFEFF/, '')));
  cache.set(sourceId, rows);
  return rows;
}
