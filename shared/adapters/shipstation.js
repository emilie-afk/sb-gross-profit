/**
 * shipstation.js — ShipStation shipment export → normalized shipments
 * ===================================================================
 * Used by the automated pipeline only. Manual uploads keep using the legacy
 * parseShipStation() in calculator.js, unchanged, so historical previews
 * reproduce exactly (Revision 5: do not delete existing upload parsers).
 *
 * Differences from the legacy parser, all deliberate:
 *   - Reads the custom export's diagnostic fields (Carrier Fee, Insurance Cost,
 *     void flag, provider, transaction IDs, No Postage, ...).
 *   - `Created By` can hold a staff name or email. It is NOT kept: only a
 *     non-identifying class (blank | integration | person) survives, for the
 *     zero-Rate investigation. The raw value never leaves this function.
 *   - Validates EVERY row of a shipment, not just the first, and flags a
 *     shipment whose rows disagree instead of silently picking one.
 *   - Never uses `Shipping Paid` as expense. It is kept as a field because it
 *     is customer-paid shipping, which Shopify already supplies.
 *   - A missing cost is stored as null, never 0.
 *
 * Columns are matched through an allowlist of known header spellings. Any
 * column not on the allowlist — including Recipient, Ship To name, address,
 * phone and email — is never read, and its header is reported (name only) in
 * the diagnostics so a template change is visible.
 */
import { toMoney, r2 } from '../normalized.js';

/**
 * `Created By` → a class with no identity in it. Integrations and automation
 * rules are recognised by name; anything else is a person, whatever it says.
 */
const CREATED_BY_CLASSES = new Set(['blank', 'integration', 'person']);
export function classifyCreatedBy(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'blank';
  if (CREATED_BY_CLASSES.has(s)) return s;                 // already classified (tools/backfill.mjs)
  if (/\b(api|integration|automation|automated|rule|rules|batch|import|system|shopify|app)\b/i.test(s) && !/@/.test(s)) return 'integration';
  return 'person';
}

/** canonical field → accepted header spellings (compared case- and punctuation-insensitively) */
export const SHIPSTATION_FIELDS = Object.freeze({
  shipmentNo:     ['Shipment #', 'Shipment ID', 'Shipment Id', 'ShipmentID', 'Shipment - ID'],
  orderNumber:    ['Order #', 'Order Number', 'Order - Number', 'OrderNumber'],
  trackingNumber: ['Tracking #', 'Tracking Number', 'Shipment - Tracking Number'],
  shipDate:       ['Ship Date', 'Shipment - Ship Date', 'Shipped Date'],
  modifyDate:     ['Modify Date', 'Modified Date', 'Shipment - Modify Date'],
  voided:         ['Void Flag', 'Voided', 'Is Voided', 'Shipment - Voided'],
  voidDate:       ['Void Date', 'Voided Date', 'Shipment - Void Date'],
  carrier:        ['Carrier', 'Carrier - Name', 'Carrier Name', 'Carrier Code'],
  service:        ['Service', 'Carrier - Service', 'Service Name', 'Service Code'],
  carrierFee:     ['Carrier Fee', 'Carrier - Fee', 'CarrierFee', 'Shipment - Carrier Fee'],
  legacyRate:     ['Rate'],
  insuranceCost:  ['Insurance Cost', 'Insurance Fee', 'Carrier - Insurance Cost', 'Insurance - Cost'],
  shippingPaid:   ['Shipping Paid', 'Order - Shipping Paid'],
  provider:       ['Provider', 'Provider Name', 'Postage Provider'],
  carrierTxnId:   ['Carrier Transaction ID', 'Carrier Transaction Id'],
  internalTxnId:  ['Internal Transaction ID', 'Internal Transaction Id'],
  externalId:     ['External ID', 'External Id'],
  noPostage:      ['No Postage', 'Do Not Prepay Postage'],
  createdBy:      ['Created By', 'User Name', 'Created By User', 'Username'],
  storeName:      ['Store Name', 'Store', 'Marketplace'],
  packageCount:   ['Package Count', 'Packages'],
  weight:         ['Weight', 'Shipment - Weight'],
  itemSku:        ['Item SKU', 'SKU', 'Item - SKU'],
  itemQuantity:   ['Item Quantity', 'Quantity', 'Item - Qty', 'Item Qty'],
});

/**
 * The saved "SB GP weekly" mapping-export template, exactly (role
 * shipstation_mapping_export: dormant, mapping only, never an expense source in
 * Revision 9). The collector refuses any other column and the Worker's csv_text
 * route rejects it. Created By is not allowed: it can hold a staff email.
 */
export const SHIPSTATION_MAPPING_EXPORT_COLUMNS = Object.freeze([
  'Shipment ID', 'Order Number', 'Tracking Number', 'Ship Date', 'Modify Date', 'Void Flag', 'Void Date', 'Carrier',
  'Service', 'Carrier Fee', 'Rate', 'Insurance Cost', 'Shipping Paid', 'Provider', 'Carrier Transaction ID',
  'Internal Transaction ID', 'External ID', 'No Postage', 'Store Name', 'Package Count', 'Weight', 'Item SKU', 'Item Quantity',
]);

/** Shipment-level fields that must agree across a shipment's rows. */
const SHIPMENT_CONSISTENT = ['orderNumber', 'carrierFee', 'legacyRate', 'insuranceCost', 'voided', 'noPostage'];

const hkey = h => String(h ?? '').toLowerCase().replace(/[^a-z0-9#]/g, '');

function resolveHeaders(headers) {
  const byKey = new Map(headers.map(h => [hkey(h), h]));
  const map = {};
  for (const [field, spellings] of Object.entries(SHIPSTATION_FIELDS)) {
    for (const s of spellings) { const h = byKey.get(hkey(s)); if (h !== undefined) { map[field] = h; break; } }
  }
  const used = new Set(Object.values(map));
  return { map, ignored: headers.filter(h => !used.has(h)) };
}

const truthy = v => /^(true|yes|y|1|x)$/i.test(String(v ?? '').trim());
const str = v => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
const num = v => { const n = toMoney(v); return n === null ? null : r2(n); };

/**
 * Parsed export rows (objects keyed by header) → normalized shipments + level-1
 * diagnostics. Level-1 diagnostics are informational only: at this point the
 * importer does not know which orders require a ShipStation cost.
 */
export function normalizeShipStationRows(rows, { sourceFormat = 'custom' } = {}) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const { map, ignored } = resolveHeaders(headers);
  if (!map.shipmentNo || !map.orderNumber) {
    throw new Error('ShipStation export is missing a shipment number or order number column');
  }
  const get = (r, f) => (map[f] === undefined ? undefined : r[map[f]]);

  const byShipment = new Map();
  for (const r of rows) {
    const id = str(get(r, 'shipmentNo'));
    if (!id) continue;
    if (!byShipment.has(id)) byShipment.set(id, []);
    byShipment.get(id).push(r);
  }

  const shipments = [];
  const disagreements = [];
  for (const [shipmentNo, rs] of byShipment) {
    const read = r => ({
      orderNumber:   str(get(r, 'orderNumber'))?.replace(/^#+/, '') ?? null,
      carrierFee:    num(get(r, 'carrierFee')),
      legacyRate:    num(get(r, 'legacyRate')),
      insuranceCost: num(get(r, 'insuranceCost')),
      voided:        map.voided ? truthy(get(r, 'voided')) : null,
      noPostage:     map.noPostage ? truthy(get(r, 'noPostage')) : null,
    });
    const vals = rs.map(read);
    const issues = [];
    const pickFirst = f => { const v = vals.find(x => x[f] !== null && x[f] !== undefined); return v ? v[f] : null; };
    for (const f of SHIPMENT_CONSISTENT) {
      const distinct = new Set(vals.map(v => v[f]).filter(v => v !== null && v !== undefined).map(String));
      if (distinct.size > 1) { issues.push(`row_disagreement:${f}`); disagreements.push({ shipmentNo, field: f }); }
    }
    const f0 = rs[0];
    shipments.push({
      shipmentNo,
      orderNumber:    pickFirst('orderNumber'),
      trackingNumber: str(get(f0, 'trackingNumber')),
      shipDate:       str(get(f0, 'shipDate')),
      modifyDate:     str(get(f0, 'modifyDate')),
      voided:         pickFirst('voided') === true,
      voidDate:       str(get(f0, 'voidDate')),
      carrier:        str(get(f0, 'carrier')),
      service:        str(get(f0, 'service')),
      provider:       str(get(f0, 'provider')),
      carrierFee:     pickFirst('carrierFee'),
      legacyRate:     pickFirst('legacyRate'),
      insuranceCost:  pickFirst('insuranceCost'),
      shippingPaid:   num(get(f0, 'shippingPaid')),
      carrierTxnId:   str(get(f0, 'carrierTxnId')),
      internalTxnId:  str(get(f0, 'internalTxnId')),
      externalId:     str(get(f0, 'externalId')),
      noPostage:      pickFirst('noPostage') === true,
      createdByClass: classifyCreatedBy(get(f0, 'createdBy')),
      storeName:      str(get(f0, 'storeName')),
      packageCount:   (() => { const n = parseInt(get(f0, 'packageCount'), 10); return isNaN(n) ? null : n; })(),
      weight:         num(get(f0, 'weight')),
      sourceFormat,
      fieldsPresent:  { carrierFee: !!map.carrierFee, legacyRate: !!map.legacyRate, insuranceCost: !!map.insuranceCost },
      issues,
      items: rs.map((r, i) => ({
        itemIndex: i,
        sku:       str(get(r, 'itemSku')),
        quantity:  (() => { const n = parseInt(get(r, 'itemQuantity'), 10); return isNaN(n) ? null : n; })(),
      })),
    });
  }

  const blankOrZero = s => !(s.carrierFee > 0) && !(s.legacyRate > 0);
  return {
    shipments,
    diagnostics: {
      level: 'raw_import',
      rows: rows.length,
      shipments: shipments.length,
      costFieldsPresent: { carrierFee: !!map.carrierFee, legacyRate: !!map.legacyRate, insuranceCost: !!map.insuranceCost },
      shipmentsWithoutPositiveCost: shipments.filter(blankOrZero).length,
      voidedShipments: shipments.filter(s => s.voided).length,
      rowDisagreements: disagreements,
      ignoredColumns: ignored,          // header names only; values are never read
    },
  };
}

// ─── Expense selection ────────────────────────────────────────────────────────

/**
 * Provisional until the Carrier Fee vs Rate comparison is reviewed (Revision 5).
 * `locked: false` is recorded on every snapshot that uses it.
 *
 * insuranceTreatment:
 *   'awaiting_confirmation' — expense = selected fee; insurance disclosed, not added (default)
 *   'add'                   — Carrier Fee excludes insurance: expense = fee + insurance
 *   'included'              — Carrier Fee already includes insurance: expense = fee
 */
export const DEFAULT_EXPENSE_POLICY = Object.freeze({
  priority: ['carrierFee', 'legacyRate'],
  locked: false,
  insuranceTreatment: 'awaiting_confirmation',
});

const FIELD_LABEL = { carrierFee: 'carrier_fee', legacyRate: 'legacy_rate', approvedActual: 'approved_actual' };

/**
 * One shipment → { amount, field, status, reason, insuranceDisclosed }.
 * status: 'complete' | 'missing' | 'voided' | 'conflict'
 * `shippingPaid` is never consulted.
 */
export function selectShipmentExpense(s, policy = DEFAULT_EXPENSE_POLICY) {
  const insuranceDisclosed = s.insuranceCost > 0 ? s.insuranceCost : 0;
  if (s.voided) return { amount: null, field: null, status: 'voided', reason: 'voided_label', insuranceDisclosed };
  const costConflict = (s.issues || []).some(i => /^row_disagreement:(carrierFee|legacyRate|insuranceCost)$/.test(i));
  if (costConflict) return { amount: null, field: null, status: 'conflict', reason: 'row_disagreement', insuranceDisclosed };
  for (const f of policy.priority || DEFAULT_EXPENSE_POLICY.priority) {
    const v = s[f];
    if (v > 0) {
      let amount = v;
      if (f === 'carrierFee' && policy.insuranceTreatment === 'add' && insuranceDisclosed > 0) amount = r2(v + insuranceDisclosed);
      return { amount, field: FIELD_LABEL[f] || f, status: 'complete', reason: null, insuranceDisclosed };
    }
  }
  return { amount: null, field: null, status: 'missing', reason: 'zero_or_blank_cost', insuranceDisclosed };
}

/**
 * The comparison the Revision 5 gate requires before the priority is locked.
 * Only shipments carrying both fields are compared.
 */
export function compareCarrierFeeToRate(shipments) {
  const out = { compared: 0, exactMatches: 0, differences: 0, differenceSum: 0,
                zeroFeePositiveRate: 0, positiveFeeZeroRate: 0, bothZero: 0, differenceBuckets: {} };
  for (const s of shipments) {
    if (!s.fieldsPresent?.carrierFee || !s.fieldsPresent?.legacyRate || s.voided) continue;
    out.compared++;
    const fee = s.carrierFee || 0, rate = s.legacyRate || 0;
    if (fee > 0 && rate > 0) {
      if (Math.abs(fee - rate) < 0.005) out.exactMatches++;
      else {
        out.differences++; out.differenceSum = r2(out.differenceSum + fee - rate);
        const b = fee - rate < -5 ? '< -$5' : fee - rate < -1 ? '-$5 to -$1' : fee - rate < 0 ? '-$1 to $0'
                : fee - rate <= 1 ? '$0 to $1' : fee - rate <= 5 ? '$1 to $5' : '> $5';
        out.differenceBuckets[b] = (out.differenceBuckets[b] || 0) + 1;
      }
    } else if (fee <= 0 && rate > 0) out.zeroFeePositiveRate++;
    else if (fee > 0 && rate <= 0) out.positiveFeeZeroRate++;
    else out.bothZero++;
  }
  return out;
}

/**
 * Insurance non-duplication check: for shipments with positive insurance and a
 * known transaction total from ShipStation's shipment detail, which rule fits?
 * `observedTotals` maps shipmentNo → the total ShipStation shows for the label.
 */
export function classifyInsuranceTreatment(shipments, observedTotals) {
  let includes = 0, excludes = 0, neither = 0, checked = 0;
  for (const s of shipments) {
    if (!(s.insuranceCost > 0) || !(s.carrierFee > 0)) continue;
    const total = observedTotals.get ? observedTotals.get(s.shipmentNo) : observedTotals[s.shipmentNo];
    if (total === undefined || total === null) continue;
    checked++;
    if (Math.abs(total - s.carrierFee) < 0.005) includes++;
    else if (Math.abs(total - (s.carrierFee + s.insuranceCost)) < 0.005) excludes++;
    else neither++;
  }
  const outcome = checked === 0 ? 'awaiting_confirmation'
    : includes === checked ? 'included'
    : excludes === checked ? 'add'
    : 'awaiting_confirmation';
  return { checked, includes, excludes, neither, outcome };
}
