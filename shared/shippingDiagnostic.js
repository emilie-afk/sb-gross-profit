/**
 * shippingDiagnostic.js — level-2 (contextual) shipping expense diagnostic
 * =======================================================================
 * Runs after the Shopify join and order-category assignment, so it knows which
 * orders actually need a ShipStation cost. Only these orders count against
 * ShipStation expense coverage; Pure HP Dropship orders never enter ShipStation.
 *
 * Per order:
 *   requiresShipStationRate   false for Pure HP Dropship, and for orders where Shopify marks
 *                             every line as not requiring shipping (printables, e-gift cards)
 *   hasValidShipStationRate   every non-voided shipment has a selected, positive expense
 *   shippingExpenseSource     shipstation_rate | hpd_actual | hpd_pass_through | no_shipment_required |
 *                             mixed_shipstation_plus_hpd_actual |
 *                             mixed_shipstation_plus_hpd_pass_through | missing
 *   shippingExpenseStatus     complete | pass_through | missing_shipstation_rate |
 *                             missing_hpd_component | unmatched
 *   missingReason             no_shipment_found | zero_or_blank_cost | partial_shipment_cost |
 *                             voided_only | conflict
 *
 * `missing_hpd_component` is reserved: the engine always derives a mixed order's
 * HPD leg (actual or pass-through remainder), so it is not produced today.
 * Weekday or carrier patterns are never used here (Revision 5).
 */
import { normalizeOrderNumber } from './calculator.js';
import { selectShipmentExpense, DEFAULT_EXPENSE_POLICY } from './adapters/shipstation.js';
import { r2 } from './normalized.js';

const HPD_CATEGORIES = new Set(['Pure HP Dropship', 'Mixed (17381 + HP Dropship)', 'Mixed (HP + Free Ship)']);

/** True unless Shopify says, for every line, that nothing ships. Unknown counts as shippable. */
export function orderRequiresShipping(order) {
  const lines = order?.lines || [];
  if (!lines.length) return true;
  return !lines.every(l => l.requiresShipping === false || String(l.requiresShipping).toLowerCase() === 'false');
}

export function diagnoseShipping(lines, shipments, hpdMap, policy = DEFAULT_EXPENSE_POLICY, ordersByName = null) {
  const shipmentsByOrder = new Map();
  for (const s of shipments || []) {
    const k = normalizeOrderNumber(s.orderNumber);
    if (!shipmentsByOrder.has(k)) shipmentsByOrder.set(k, []);
    shipmentsByOrder.get(k).push(s);
  }

  const orders = [];
  const seenOrders = new Set();
  for (const li of lines) {
    if (!li.orderCat) continue;                            // first line of each order carries the category
    const orderName = li.orderNum;
    const key = normalizeOrderNumber(orderName);
    seenOrders.add(key);
    const cat = li.orderCat;
    const ships = ordersByName ? orderRequiresShipping(ordersByName.get(orderName)) : true;
    const requires = cat !== 'Pure HP Dropship' && ships;
    const list = shipmentsByOrder.get(key) || [];
    const sel = list.map(s => ({ shipmentNo: s.shipmentNo, ...selectShipmentExpense(s, policy) }));
    const valid = sel.filter(x => x.status === 'complete' && x.amount > 0);
    const live = sel.filter(x => x.status !== 'voided');
    const ssExpense = r2(valid.reduce((a, x) => a + x.amount, 0));
    // Covered only when every non-voided shipment carries a valid cost: a split
    // order with one priced and one unpriced label is still missing expense.
    const hasValid = live.length > 0 && valid.length === live.length;

    let missingReason = null;
    if (requires && !hasValid) {
      missingReason = !list.length ? 'no_shipment_found'
        : !live.length ? 'voided_only'
        : sel.some(x => x.status === 'conflict') ? 'conflict'
        : valid.length ? 'partial_shipment_cost'
        : 'zero_or_blank_cost';
    }

    const hpd = hpdMap ? hpdMap.get(key) : null;
    const hpdActual = !!(hpd && hpd.netTerms !== null && hpd.netTerms !== undefined);
    const involvesHpd = HPD_CATEGORIES.has(cat);

    let source, status;
    if (!ships && cat !== 'Pure HP Dropship') {
      source = 'no_shipment_required'; status = 'complete';
    } else if (cat === 'Pure HP Dropship') {
      source = hpdActual ? 'hpd_actual' : 'hpd_pass_through';
      status = hpdActual ? 'complete' : 'pass_through';
    } else if (involvesHpd) {
      if (!hasValid) { source = 'missing'; status = 'missing_shipstation_rate'; }
      else {
        source = hpdActual ? 'mixed_shipstation_plus_hpd_actual' : 'mixed_shipstation_plus_hpd_pass_through';
        status = hpdActual ? 'complete' : 'pass_through';
      }
    } else if (hasValid) { source = 'shipstation_rate'; status = 'complete'; }
    else { source = 'missing'; status = 'missing_shipstation_rate'; }

    orders.push({
      orderName, orderCat: cat,
      requiresShipStationRate: requires,
      hasValidShipStationRate: hasValid,
      shippingExpenseSource: source,
      shippingExpenseStatus: status,
      missingReason,
      shipStationExpense: ssExpense,
      insuranceDisclosed: r2(sel.reduce((a, x) => a + (x.insuranceDisclosed || 0), 0)),
      shipmentCount: list.length,
      hpdActual: involvesHpd ? hpdActual : null,
      shipCollected: li.shipCollected ?? null,
      shipPaid: li.shipPaid ?? null,
      shipPaidSS: li.shipPaidSS ?? null,
      shipPaidHP: li.shipPaidHP ?? null,
    });
  }

  const unmatchedShipments = [];
  for (const [k, list] of shipmentsByOrder) {
    if (!seenOrders.has(k)) for (const s of list) unmatchedShipments.push({ shipmentNo: s.shipmentNo, orderNumber: s.orderNumber, shippingExpenseStatus: 'unmatched' });
  }

  const required = orders.filter(o => o.requiresShipStationRate);
  const covered = required.filter(o => o.hasValidShipStationRate);
  return {
    orders,
    unmatchedShipments,
    coverage: {
      ordersRequiringShipStationRate: required.length,
      ordersWithValidShipStationRate: covered.length,
      shipStationExpenseCoverage: required.length ? covered.length / required.length : 1,
      missingByReason: required.filter(o => !o.hasValidShipStationRate)
        .reduce((m, o) => { m[o.missingReason] = (m[o.missingReason] || 0) + 1; return m; }, {}),
      hpdOrdersActual: orders.filter(o => o.hpdActual === true).length,
      hpdOrdersPassThrough: orders.filter(o => o.hpdActual === false).length,
      insuranceDisclosedTotal: r2(orders.reduce((a, o) => a + o.insuranceDisclosed, 0)),
    },
  };
}
