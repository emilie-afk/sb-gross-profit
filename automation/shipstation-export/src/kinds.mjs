/**
 * kinds.mjs — the two ShipStation export roles the collector can produce
 * =====================================================================
 *   shipstation_shipping_cost_report  Analytics → Reports → Shipping Cost Report.
 *                                     The proposed carrier-expense source (Revision 9).
 *                                     Sanitized here to the 15 approved columns:
 *                                     Recipient, Shipping Paid and +/- never leave this machine.
 *   shipstation_mapping_export        The saved "SB GP weekly" custom export, uploaded as
 *                                     shipments (rollback diagnostics only; dormant).
 *   shipstation_aps_mapping           The saved line-item format "SB GP APS mapping v2" (seven columns
 *                                     incl. ServiceCode; the first six-column format is still accepted;
 *                                     no customer fields): the Air Plant Shop scenario input,
 *                                     mapping only, never an expense source.
 *                                     Reduced on this PC to per-order APS classifications
 *                                     (shared/apsMapping.js); the raw file never leaves it.
 *
 * prepareExport() is pure (no Playwright, no network) so it is tested in the
 * main suite. It returns what to upload and the manifest facts (hashes and
 * counts, never rows), or a refusal.
 */
import crypto from 'node:crypto';
import { parseCSV } from '../../../shared/calculator.js';
import { addDays } from '../../../shared/normalized.js';
import { toCsvText } from '../../../shared/adapters/shopifyCsv.js';
import { sanitizeShippingCostReport, parseShippingCostReport, fromCents } from '../../../shared/adapters/shippingCostReport.js';
import { customerHeaders, csvHeaderNames, invalidExportReason, unexpectedColumns, MAPPING_EXPORT_COLUMNS } from './lib.mjs';
import { buildApsMap, APS_MAPPING_COLUMNS, APS_EXPORT_FORMAT, apsFormatOf } from '../../../shared/apsMapping.js';
import { PUBLICATION_EARLIEST_DATE } from '../../../shared/apsWindow.js';

export const KINDS = Object.freeze({
  shipstation_shipping_cost_report: { path: '/v1/ingest/shipping-cost-report' },
  shipstation_mapping_export: { path: '/v1/ingest/shipstation' },
  shipstation_aps_mapping: { path: '/v1/collect/aps-map' },
});
export { PUBLICATION_EARLIEST_DATE };
export const DEFAULT_KIND = 'shipstation_shipping_cost_report';

/**
 * C5: the mapping export is dormant. It never feeds profitability (the Worker
 * computes expense from the Shipping Cost Report only, and the mapping export
 * does not satisfy shipping readiness). The collector runs it only when the
 * operator re-enables it explicitly for rollback diagnostics.
 */
export function assertKindEnabled(kind, config = {}) {
  if (!KINDS[kind]) throw new Error(`Unknown export kind ${kind}`);
  if (kind === 'shipstation_aps_mapping') {
    // On by default (approved: Air Plant Shop in automatic reports). It needs the saved template's recorded steps.
    if (config.kinds?.shipstation_aps_mapping?.enabled === false) { const e = new Error('shipstation_aps_mapping is turned off in config'); e.code = 'aps_mapping_off'; throw e; }
    if (!apsStepsReady(config)) { const e = new Error('The Air Plant Shop export steps are not recorded (kinds.shipstation_aps_mapping.exportSteps)'); e.code = 'aps_mapping_not_configured'; throw e; }
    return true;
  }
  if (kind === 'shipstation_mapping_export' && config.kinds?.shipstation_mapping_export?.enabled !== true) {
    const e = new Error('shipstation_mapping_export is dormant; set kinds.shipstation_mapping_export.enabled = true only for rollback diagnostics');
    e.code = 'mapping_export_dormant';
    throw e;
  }
  return true;
}

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

/** The APS export's recorded steps (kinds.shipstation_aps_mapping.exportSteps), only when fully recorded. */
export function apsSteps(config = {}) { return config.kinds?.shipstation_aps_mapping?.exportSteps || []; }
export function apsStepsReady(config = {}) {
  const steps = apsSteps(config).filter(s => s && s.action);
  return steps.some(s => s.action === 'download') && !steps.some(s => /REPLACE:/.test(String(s.selector || '') + String(s.url || '') + String(s.value || '')));
}
const us = iso => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };

/** The rolling eight-week ship-date window ending on the reporting week's Sunday. */
export function reportWindow(week) {
  const from = addDays(week.weekEnd, -55), to = week.weekEnd;
  return { from, to, fromUS: us(from), toUS: us(to) };
}

export function prepareExport(kind, text, { week, exportedAt, apsWindow = null, scrRows = null, scrSource = null, rowsFor = null }) {
  if (!KINDS[kind]) throw new Error(`Unknown export kind ${kind}`);
  const rawSha256 = sha(text);                                       // kept in the local manifest only
  if (kind === 'shipstation_aps_mapping') {
    // The saved format's exact columns (an allowlist): anything else means the format changed, and it is refused.
    const headers = csvHeaderNames(text);
    const format = apsFormatOf(headers);
    if (!format || customerHeaders(headers).length) {
      const bad = [...new Set([...customerHeaders(headers), ...unexpectedColumns(headers, APS_MAPPING_COLUMNS)])];
      const missing = APS_MAPPING_COLUMNS.filter(c => !headers.includes(c));
      return { refused: 'refused_customer_columns', reason: `The export must contain exactly the "${APS_EXPORT_FORMAT}" columns`, columns: [...bad, ...missing.map(c => `missing:${c}`)] };
    }
    const rows = parseCSV(text.replace(/^\uFEFF/, ''));
    if (!rows.length) return { refused: 'invalid_export', reason: 'The export has no rows' };
    if (!apsWindow?.from || !apsWindow?.to) throw new Error('apsWindow is required');
    // Reduced here to per-order APS classifications; only that leaves this PC (no tracking numbers, no rows).
    const m = buildApsMap(rows, { window: apsWindow, scrRows, scrSource, rowsFor, source: { sanitizedSha256: sha(text), exportedAt, template: format } });
    // needRows: split dates holding APS and other labels, whose exact rows come from the owning report version's
    // retained source (the caller reads them and prepares again with rowsFor). Not sent to the Worker.
    const { needRows = [], ...meta } = m.meta;
    return { path: KINDS[kind].path, payload: { meta, orders: m.orders }, needRows,
             facts: { kind, rawSha256, sanitizedSha256: sha(text), rowCount: rows.length, window: apsWindow, apsOrders: m.orders.length,
                      byStatus: m.meta.byStatus, duplicateRows: m.meta.duplicateRows, voidedShipments: m.meta.voidedShipments, scrRowsAvailable: m.meta.scrRowsAvailable, format } };
  }
  if (kind === 'shipstation_mapping_export') {
    const headers = csvHeaderNames(text);
    const bad = [...new Set([...customerHeaders(headers), ...unexpectedColumns(headers, MAPPING_EXPORT_COLUMNS)])];
    if (bad.length) return { refused: 'refused_customer_columns', reason: 'The export must contain exactly the saved template columns', columns: bad };
    const rowCount = text.split(/\r?\n/).filter(l => l.trim()).length - 1;
    const invalid = invalidExportReason(headers, rowCount);
    if (invalid) return { refused: 'invalid_export', reason: invalid };
    return { path: KINDS[kind].path, payload: { format: 'csv_text', text, weekStart: week.weekStart, sanitizedSha256: sha(text), exportedAt, sourceFormat: 'custom' },
             facts: { kind, rawSha256, sanitizedSha256: sha(text), rowCount, headers } };
  }
  // Shipping Cost Report: sanitize to the 15 approved columns before anything else.
  const win = reportWindow(week);
  let s, p;
  try {
    s = sanitizeShippingCostReport(parseCSV(text.replace(/^\uFEFF/, '')));
    p = parseShippingCostReport(s.rows, { requestedFrom: win.from, requestedTo: win.to });
  } catch (e) {
    return { refused: e.code === 'report_schema_changed' ? 'report_schema_changed' : 'invalid_export', reason: e.message.slice(0, 200) };
  }
  const clean = toCsvText(s.rows, s.columns);
  return {
    path: KINDS[kind].path, sanitizedText: clean,
    payload: { format: 'csv_text', text: clean, requestedFrom: win.from, requestedTo: win.to, rowCount: p.rowCount,
               shippingCostTotal: fromCents(p.shippingCostCents), sanitizedSha256: sha(clean), exportedAt },
    facts: { kind, rawSha256, sanitizedSha256: sha(clean), rowCount: p.rowCount, shippingCostTotal: fromCents(p.shippingCostCents),
             requestedFrom: win.from, requestedTo: win.to, dropped: s.dropped, reviewFlags: p.reviewFlags },
  };
}

/**
 * The ship dates to export for the Air Plant Shop mapping: the rolling eight weeks (as the Shipping Cost Report),
 * widened back to the first reporting date while the stored mapping does not reach it (backfill of published
 * weeks) or to just after the stored mapping when a run was missed. Never before the first reporting date.
 * @param {{ coveredFrom?: string|null, coveredTo?: string|null }|null} coverage  from the Worker (null: unknown)
 */
export function apsExportWindow(week, coverage) {
  const rolling = reportWindow(week);
  let from = rolling.from;
  if (!coverage || !coverage.coveredFrom || coverage.coveredFrom > PUBLICATION_EARLIEST_DATE) from = PUBLICATION_EARLIEST_DATE;
  else if (coverage.coveredTo && coverage.coveredTo < addDays(rolling.from, -1)) from = addDays(coverage.coveredTo, 1);
  if (from < PUBLICATION_EARLIEST_DATE) from = PUBLICATION_EARLIEST_DATE;
  return { from, to: rolling.to, fromUS: us(from), toUS: us(rolling.to) };
}
