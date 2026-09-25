/**
 * kinds.mjs — the two ShipStation export roles the collector can produce
 * =====================================================================
 *   shipstation_shipping_cost_report  Analytics → Reports → Shipping Cost Report.
 *                                     The proposed carrier-expense source (Revision 9).
 *                                     Sanitized here to the 15 approved columns:
 *                                     Recipient, Shipping Paid and +/- never leave this machine.
 *   shipstation_mapping_export        The saved "SB GP weekly" custom export. Dormant:
 *                                     mapping only, never an expense source; retired
 *                                     after acceptance.
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

export const KINDS = Object.freeze({
  shipstation_shipping_cost_report: { path: '/v1/ingest/shipping-cost-report' },
  shipstation_mapping_export: { path: '/v1/ingest/shipstation' },
});
export const DEFAULT_KIND = 'shipstation_shipping_cost_report';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const us = iso => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };

/** The rolling eight-week ship-date window ending on the reporting week's Sunday. */
export function reportWindow(week) {
  const from = addDays(week.weekEnd, -55), to = week.weekEnd;
  return { from, to, fromUS: us(from), toUS: us(to) };
}

export function prepareExport(kind, text, { week, exportedAt }) {
  if (!KINDS[kind]) throw new Error(`Unknown export kind ${kind}`);
  const rawSha256 = sha(text);                                       // kept in the local manifest only
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
