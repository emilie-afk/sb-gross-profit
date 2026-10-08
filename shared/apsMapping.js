/**
 * apsMapping.js — Air Plant Shop shipment mapping (scenario input only)
 * =====================================================================
 * Source: the saved ShipStation line-item export format "SB GP APS mapping v2" (Shipments → Export Shipments →
 * Export Shipment Line Items; role: mapping only; columns APS_MAPPING_COLUMNS, no customer fields). ServiceCode holds
 * the same values as the Shipping Cost Report's Service (GA, Ground, PM, 3-Day, 2nd Day…), so labels of one order on
 * one date are told apart by service. The first format (no ServiceCode) is still accepted. It says which
 * shipments carry Air Plant Shop items (SKU prefix AS-). It is never an expense source: shipping expense
 * stays the Shipping Cost Report. The result is a separate scenario input; it never changes a computed
 * week, a catalog or a revision.
 *
 * Rules:
 *  - Exact duplicate export rows (every column equal) count once; a shipment's item rows are grouped by
 *    Shipment # (the export repeats shipment fields on every item row, so nothing is summed per row).
 *  - Voided shipments are ignored (counted in the diagnostics).
 *  - A shipment is `aps` (every item AS-), `other` (no AS- item), `mixed` (both) or `no_items`.
 *  - Per order holding at least one AS- item:
 *      aps_only        every shipment is APS-only: the APS shipping cost is the order's ShipStation expense
 *                      from the Shipping Cost Report (the published figure).
 *      split_matched   APS-only and other shipments; each shipment matched to exactly one Shipping Cost
 *                      Report row (same ship date and service): APS cost = the APS rows' cost. Each ship date
 *                      of the order is pinned (scrPins, below), so the Worker's reader route accepts the cost
 *                      only when the published snapshot accepted exactly those rows (otherwise
 *                      split_cost_unverified, no cost). A matching order TOTAL is never enough.
 *      split_unmatched the rows could not be matched one to one: no cost (never guessed).
 *      split_cost_unavailable  the Shipping Cost Report rows for those dates were not available.
 *      mixed_shipment  a shipment holds APS and other items: no allocation is guessed; no cost.
 *      items_unknown   a shipment of the order has no item rows.
 *      shipment_count_mismatch  aps_only, but the report has a different number of labels for the order.
 *      split_cost_unverified    a ship date holds APS and other labels of the order, and the exact rows the
 *                      published report accepted for that date could not be read (no cost).
 *
 * Split pins, one per ship date of a split_matched order: [date, labels, cents, apsLabels, apsCents, rowVersion].
 *  - A date whose labels are all APS or all other: the rows are the order's report group of that date; the
 *    reader route checks the published snapshot's pinned group (cents and row count) equals it. rowVersion null.
 *  - A date holding BOTH: a date group cannot tell which row is which, so the APS share is taken from the
 *    retained source rows of the Shipping Cost Report version that owns that date (rowsFor), and rowVersion
 *    names it; the reader route requires the published snapshot to pin exactly that version for the date.
 */
import { normalizeShipStationRows } from './adapters/shipstation.js';
import { canonicalOrderKey, parseShipDate, toCents } from './adapters/shippingCostReport.js';

export const APS_MAP_SCHEMA = 'aps_map.v1';
/** The saved export format and its exact columns (as ShipStation writes them; verified on the live export, Oct 7, 2026). */
export const APS_EXPORT_FORMAT = 'SB GP APS mapping v2';
export const APS_MAPPING_COLUMNS = Object.freeze(['ShipmentID', 'OrderNumber', 'ShipDate', 'SKU', 'Quantity', 'Voided', 'ServiceCode']);
/**
 * Every accepted saved format, by its exact columns (verified on the live exports, Oct 7–8, 2026). The first format
 * stays accepted so the collector code and the laptop's recorded steps can change in either order; without ServiceCode
 * the labels of one order on one date are matched by date alone (ambiguous costs → no cost, as before).
 */
export const APS_EXPORT_FORMATS = Object.freeze({
  [APS_EXPORT_FORMAT]: APS_MAPPING_COLUMNS,
  'SB GP APS mapping': Object.freeze(['ShipmentID', 'OrderNumber', 'ShipDate', 'SKU', 'Quantity', 'Voided']),
});
/** The accepted format whose columns are exactly these headers (any order), or null. */
export function apsFormatOf(headers) {
  const h = [...new Set((headers || []).map(x => String(x).trim()))].sort().join('|');
  for (const [name, cols] of Object.entries(APS_EXPORT_FORMATS)) if ([...cols].sort().join('|') === h && cols.length === (headers || []).length) return name;
  return null;
}
export const isApsSku = s => /^AS-/i.test(String(s || '').trim());
export const APS_COST_STATUSES = new Set(['aps_only', 'split_matched']);

/** Plain-language reason per status (dashboard and diagnostics). */
export const APS_STATUS_TEXT = Object.freeze({
  aps_only: 'APS-only shipments',
  split_matched: 'split shipments, matched to the Shipping Cost Report',
  split_unmatched: 'split shipments that could not be matched one to one to Shipping Cost Report rows',
  split_cost_unavailable: 'split shipments whose Shipping Cost Report rows were not available',
  mixed_shipment: 'a shipment holds Air Plant Shop and other items (no allocation is guessed)',
  items_unknown: 'a shipment has no item rows in the line-item export',
  shipment_count_mismatch: 'the Shipping Cost Report has a different number of labels for the order',
  split_cost_unverified: 'split shipments whose Shipping Cost Report rows could not be matched to the exact rows accepted in the published report',
  not_in_mapping: 'not found in the line-item export (not shipped in the exported dates)',
});

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Mapping-export ship date ("9/22/2026", "9/22/2026 10:31:00 AM", "2026-09-22…") → YYYY-MM-DD or null. */
export function mappingShipDate(v) {
  const s = String(v ?? '').trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return parseShipDate(`${us[1]}/${us[2]}/${us[3]}`)?.date || null;
  return null;
}

/** Exact duplicate rows (every column equal) → kept once. */
export function dedupeRows(rows) {
  const seen = new Set(), out = [];
  let duplicates = 0;
  for (const r of rows || []) {
    const k = JSON.stringify(Object.keys(r).sort().map(h => [h, String(r[h] ?? '').trim()]));
    if (seen.has(k)) { duplicates++; continue; }
    seen.add(k); out.push(r);
  }
  return { rows: out, duplicates };
}

/** Shipping Cost Report rows (sanitized CSV objects) → order key → [{ shipDate, service, cents }]. */
export function scrRowsByOrder(scrRows) {
  const m = new Map();
  for (const r of scrRows || []) {
    const key = canonicalOrderKey(r['Order #']);
    const shipDate = parseShipDate(r['Ship Date'])?.date || null;
    const cents = toCents(r['Shipping Cost']);
    if (!key || !shipDate || cents === null) continue;
    if (!m.has(key)) m.set(key, []);
    m.get(key).push({ shipDate, service: norm(r.Service), cents });
  }
  return m;
}

/**
 * Match an order's mapping shipments to its Shipping Cost Report rows one to one (same ship date and
 * service). Returns Map(shipmentNo → cents) or null when the match is not unique and complete.
 */
export function matchShipments(shipments, rows) {
  if (!rows || rows.length !== shipments.length) return null;
  const used = new Set(), out = new Map();
  for (const s of shipments) {
    const cands = rows.map((r, i) => ({ r, i })).filter(({ r, i }) => !used.has(i) && r.shipDate === s.shipDate && (!s.service || !r.service || r.service === s.service));
    // Unique only: two candidates with different costs would be a guess.
    if (!cands.length) return null;
    if (cands.length > 1 && new Set(cands.map(c => c.r.cents)).size > 1) return null;
    used.add(cands[0].i); out.set(s.shipmentNo, cands[0].r.cents);
  }
  return out;
}

const SCR_VERSION_RE = /^scr_[0-9a-f]{20}$/;

/**
 * One split order's pins (see the header), or { reason } when a date cannot be pinned.
 * matched: Map(shipmentNo → cents) from the collector's own report rows.
 */
function splitPins(orderKey, list, matched, rowsFor, needRows) {
  const byDate = new Map();
  for (const s of list) (byDate.get(s.shipDate) || byDate.set(s.shipDate, []).get(s.shipDate)).push(s);
  const pins = [];
  for (const [date, ships] of [...byDate].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const aps = ships.filter(s => s.cls === 'aps');
    if (aps.length && aps.length < ships.length) {
      // APS and other labels on one date: only the owning version's retained rows can tell them apart.
      if (!rowsFor) { needRows.push([date, orderKey]); return { reason: 'rows_not_read' }; }
      const r = rowsFor(date, orderKey);
      if (!r || !SCR_VERSION_RE.test(r.versionId || '')) return { reason: 'rows_unavailable' };
      const m = matchShipments(ships, (r.rows || []).map(x => ({ shipDate: date, service: norm(x.service), cents: x.cents })));
      if (!m) return { reason: 'rows_unmatched' };
      const cents = ships.reduce((t, s) => t + m.get(s.shipmentNo), 0), apsCents = aps.reduce((t, s) => t + m.get(s.shipmentNo), 0);
      pins.push([date, ships.length, cents, aps.length, apsCents, r.versionId]);
    } else {
      const cents = ships.reduce((t, s) => t + matched.get(s.shipmentNo), 0);
      pins.push([date, ships.length, cents, aps.length, aps.length ? cents : 0, null]);
    }
  }
  return { pins };
}

/**
 * Line-item export rows → the APS scenario input.
 * @param {object[]} mappingRows   parsed CSV rows of the saved template (customer columns already refused)
 * @param {{ window: {from,to}, scrRows?: object[]|null, source?: object, rowsFor?: Function }} o
 *        window: the ship dates the export covers; scrRows: sanitized Shipping Cost Report rows for split
 *        orders (null → split orders are `split_cost_unavailable`); source: { sanitizedSha256, exportedAt, template };
 *        rowsFor(date, orderKey) → { versionId, rows: [{ service, cents }] } | null: the order's rows on that date in
 *        the retained source of the report version that owns the date (dates holding APS and other labels only).
 *        Without rowsFor, such orders are split_cost_unverified and meta.needRows lists the [date, orderKey] pairs.
 */
export function buildApsMap(mappingRows, { window, scrRows = null, scrSource = null, source = {}, rowsFor = null } = {}) {
  if (!window?.from || !window?.to) throw new Error('The export window (ship dates) is required');
  const { rows, duplicates } = dedupeRows(mappingRows);
  const { shipments, diagnostics } = normalizeShipStationRows(rows, { sourceFormat: 'custom' });
  const scr = scrRows ? scrRowsByOrder(scrRows) : null;
  const byOrder = new Map();
  let voided = 0;
  for (const s of shipments) {
    if (s.voided) { voided++; continue; }
    const skus = s.items.map(i => i.sku).filter(Boolean);
    const aps = skus.filter(isApsSku).length;
    const cls = !skus.length ? 'no_items' : aps === skus.length ? 'aps' : aps ? 'mixed' : 'other';
    const key = canonicalOrderKey(s.orderNumber);
    if (!key) continue;
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push({ shipmentNo: s.shipmentNo, cls, shipDate: mappingShipDate(s.shipDate), service: norm(s.service),
      apsUnits: s.items.filter(i => isApsSku(i.sku)).reduce((t, i) => t + (i.quantity || 0), 0) });
  }
  const orders = [], needRows = [];
  for (const [orderKey, list] of byOrder) {
    if (!list.some(s => s.cls === 'aps' || s.cls === 'mixed')) continue;            // no Air Plant Shop item shipped
    const n = c => list.filter(s => s.cls === c).length;
    const dates = list.map(s => s.shipDate).filter(Boolean).sort();
    const o = { orderKey, apsShipments: n('aps'), otherShipments: n('other'), mixedShipments: n('mixed'), noItemShipments: n('no_items'),
                apsUnits: list.reduce((t, s) => t + s.apsUnits, 0), firstShipDate: dates[0] || null, lastShipDate: dates[dates.length - 1] || null,
                status: null, apsCostCents: null, scrOrderCents: null, scrPins: null, scrCheck: scr ? 'checked' : 'not_checked' };
    const orderRows = scr ? scr.get(orderKey) : null;
    if (o.mixedShipments) o.status = 'mixed_shipment';
    else if (o.noItemShipments) o.status = 'items_unknown';
    else if (!o.otherShipments) {
      o.status = scr && orderRows && orderRows.length !== list.length ? 'shipment_count_mismatch' : 'aps_only';
    } else if (!scr) o.status = 'split_cost_unavailable';
    else {
      const matched = matchShipments(list, orderRows);
      if (!matched) o.status = orderRows ? 'split_unmatched' : 'split_cost_unavailable';
      else {
        const p = splitPins(orderKey, list, matched, rowsFor, needRows);
        if (!p.pins) { o.status = 'split_cost_unverified'; o.pinReason = p.reason; }
        else {
          o.status = 'split_matched';
          o.scrPins = p.pins;
          o.apsCostCents = p.pins.reduce((t, x) => t + x[4], 0);
          o.scrOrderCents = p.pins.reduce((t, x) => t + x[2], 0);
        }
      }
    }
    orders.push(o);
  }
  orders.sort((a, b) => (a.firstShipDate || '').localeCompare(b.firstShipDate || '') || a.orderKey.localeCompare(b.orderKey));
  const byStatus = {};
  for (const o of orders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  return {
    meta: { schemaVersion: APS_MAP_SCHEMA, window: { from: window.from, to: window.to }, source: { template: APS_EXPORT_FORMAT, ...source },
            rows: (mappingRows || []).length, duplicateRows: duplicates, shipments: shipments.length, voidedShipments: voided,
            rowDisagreements: diagnostics.rowDisagreements.length, apsOrders: orders.length, byStatus, scrRowsAvailable: !!scr,
            ...(needRows.length ? { needRows } : {}),
            ...(scr && scrSource ? { scrSource: { sanitizedSha256: scrSource.sanitizedSha256, from: scrSource.from, to: scrSource.to } } : {}) },
    orders,
  };
}
