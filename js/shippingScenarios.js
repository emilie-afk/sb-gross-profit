/**
 * shippingScenarios.js — the money in the shipping Scenarios models, pure and tested
 * ==================================================================================
 * Used by index.html for CSV and saved reports alike (Free shipping threshold, Item count free shipping,
 * Combined scenario).
 *
 * Rules (the same in every model):
 *  - Only orders whose shippable products are all MCG (Succulents Box store, MCG items) are modelled. The free
 *    shipping threshold applies to MCG products only, and an order's shipping charge is recorded per order, not
 *    per vendor: in a mixed-vendor order the MCG part of the charge is not known, so those orders are counted and
 *    shown separately (their whole charge is an upper bound), never modelled as losing the whole charge.
 *  - Revenue impact and profit impact are separate figures. Revenue impact is the shipping charge customers would
 *    no longer pay (known for every affected order). Profit impact also needs the order's shipping cost when the
 *    model changes it; orders whose shipping cost is unknown are counted, never treated as $0.
 *  - Order GP before/after is shown only for orders with a complete GP (every product cost and the shipping cost
 *    known), and both columns use exactly the same orders.
 *  - Demand is assumed unchanged: the same orders and quantities. No model predicts how customers would respond.
 */
import { isMcgSku, mcgPlantUnits } from '../shared/calculator.js';

const r2 = x => Math.round((Number(x) || 0) * 100) / 100;
const sum = (arr, f) => r2(arr.reduce((s, x) => s + (Number(f(x)) || 0), 0));
const known = v => v !== null && v !== undefined && Number.isFinite(Number(v));

/** An MCG product line: Succulents Box store and a shippable MCG item (vendor Succulents Box / MCG, or an MCG SKU); gift cards and digital items are not. */
export function isMcgLine(li) {
  if (!String(li.store || '').includes('Succulents Box')) return false;
  if (li.isDigital || li.isRoute || li.isGiftCard || /^(Gift Card|Printable|Cancelled after shipping)/.test(String(li.costSource || ''))) return false;
  const v = String(li.vendor || '');
  if (/succulents box|mountain crest|\bmcg\b/i.test(v)) return true;
  return String(li.sku || '').toUpperCase().split('+').some(p => p.trim() && isMcgSku(p.trim()));
}
/** A line that ships and is not MCG (another vendor's product): gift cards, digital items, Route and $0 shipping-only rows do not count. */
function isOtherShippable(li) {
  if (isMcgLine(li) || li.isDigital || li.isRoute || li.isGiftCard) return false;
  if (String(li.costSource || '').startsWith('Gift Card')) return false;
  if (String(li.costSource || '').startsWith('Cancelled after shipping')) return false;
  return (li.qty || 0) > 0;
}

/**
 * Per order: the facts every shipping model needs.
 * @param {object[]} lines   calculator-shaped lines (CSV or saved report)
 * @param {(li) => boolean} [countLine]  which MCG lines count toward `mcgQty` (item count model's product filter)
 */
export function orderFacts(lines, { countLine = () => true } = {}) {
  const orders = new Map();
  for (const li of lines || []) {
    let o = orders.get(li.orderNum);
    if (!o) {
      o = { orderNum: li.orderNum, date: li.date || '', store: li.store || '', shipCollected: 0, shipPaid: null, shipPaidKnown: false,
            isFreeShip: false, revenue: 0, mcgSubtotal: 0, mcgQty: 0, items: 0, hasMcg: false, mixed: false, gp: 0, gpComplete: true };
      orders.set(li.orderNum, o);
    }
    // Order-level shipping sits on the order's first line (calculator); later lines carry null.
    if (known(li.shipCollected) && li.shipCollected !== 0 && o.shipCollected === 0) o.shipCollected = r2(li.shipCollected);
    if (!o.shipPaidKnown && known(li.shipPaid)) { o.shipPaid = r2(li.shipPaid); o.shipPaidKnown = true; }
    if (li.isFreeShip === 'YES') o.isFreeShip = true;
    o.revenue = r2(o.revenue + (li.lineRevenue || 0));
    o.items += li.qty || 0;
    if (isMcgLine(li)) {
      o.hasMcg = true;
      o.mcgSubtotal = r2(o.mcgSubtotal + (li.lineRevenue || 0));
      if (countLine(li)) o.mcgQty += li.qty || 0;
    } else if (isOtherShippable(li)) o.mixed = true;
    if (known(li.lineNetGp)) o.gp = r2(o.gp + Number(li.lineNetGp)); else o.gpComplete = false;
  }
  for (const o of orders.values()) {
    if (!o.shipPaidKnown) o.gpComplete = false;            // GP after shipping needs the shipping cost
    if (!o.gpComplete) o.gp = null;
  }
  return orders;
}

/**
 * Shared summary of an affected-order list.
 * @param rows  [{ ...facts, revenueLost, profitDelta (null when not calculable) }]
 */
function summarize(rows, mixedRows, extra = {}) {
  const calc = rows.filter(o => o.profitDelta !== null);
  const complete = rows.filter(o => o.gp !== null && o.profitDelta !== null);
  return {
    orders: rows.length,
    revenueLost: sum(rows, o => o.revenueLost),                          // every affected order
    profit: { orders: calc.length, delta: sum(calc, o => o.profitDelta),   // orders whose profit change is calculable
              notCalculable: rows.length - calc.length, notCalculableRevenueLost: sum(rows.filter(o => o.profitDelta === null), o => o.revenueLost) },
    gpTable: { orders: complete.length, before: sum(complete, o => o.gp), after: sum(complete, o => o.gp + o.profitDelta),
               revenue: sum(complete, o => o.revenue), excluded: rows.length - complete.length },
    mixed: { orders: mixedRows.length, shipCollected: sum(mixedRows, o => o.shipCollected) },
    rows, ...extra,
  };
}

/**
 * Lower the MCG free-shipping threshold from `cur` to `next`: MCG-only orders with an MCG subtotal in
 * [next, cur) that pay shipping today stop paying it. MCG still ships them, so the shipping cost is unchanged
 * and the profit change equals the lost shipping revenue (calculable for every affected order).
 */
export function thresholdImpact(facts, cur, next) {
  if (!(next < cur)) throw new Error('The new threshold must be lower than the current one.');
  const rows = [], mixed = [];
  for (const o of facts.values()) {
    if (!o.hasMcg || o.isFreeShip || !(o.shipCollected > 0)) continue;
    if (o.mcgSubtotal < next || o.mcgSubtotal >= cur) continue;
    if (o.mixed) { mixed.push(o); continue; }
    rows.push({ ...o, revenueLost: o.shipCollected, profitDelta: r2(-o.shipCollected) });
  }
  return summarize(rows, mixed, { assumption: 'Shipping cost unchanged: MCG still ships these orders.' });
}

/**
 * Free shipping for MCG-only orders with a given number of (matching) MCG items. `tiers` maps item count →
 * the shipping cost Succulents Box would pay for such an order (it replaces the order's actual shipping cost).
 * Orders already shipping free are not affected. Profit change = −shipping collected + actual cost − tier cost;
 * it needs the actual shipping cost, so orders without one are counted as not calculable (never $0).
 */
export function itemCountImpact(facts, tiers) {
  const rows = [], mixed = [];
  for (const o of facts.values()) {
    const tierCost = tiers[o.mcgQty];
    if (!o.hasMcg || !o.mcgQty || tierCost === undefined || tierCost === null) continue;
    if (o.isFreeShip || !(o.shipCollected > 0)) continue;
    if (o.mixed) { mixed.push(o); continue; }
    const profitDelta = o.shipPaidKnown ? r2(-o.shipCollected + o.shipPaid - Number(tierCost)) : null;
    rows.push({ ...o, tierCost: r2(tierCost), revenueLost: o.shipCollected, profitDelta });
  }
  const byTier = {};
  for (const o of rows) {
    const t = byTier[o.mcgQty] || (byTier[o.mcgQty] = { orders: 0, revenueLost: 0, profitDelta: 0, profitOrders: 0, tierCost: o.tierCost });
    t.orders++; t.revenueLost = r2(t.revenueLost + o.revenueLost);
    if (o.profitDelta !== null) { t.profitOrders++; t.profitDelta = r2(t.profitDelta + o.profitDelta); }
  }
  return summarize(rows, mixed, { byTier, assumption: 'The shipping cost entered per tier replaces each order’s actual shipping cost.' });
}

/**
 * Lower MCG's per-plant cost by `perPlant` dollars: only individual plants count, by the engine's rule (packs,
 * random/Mystery plants, pots, racks, wholesale and subscriptions count 0). Without the pack table packs cannot
 * be told apart, so nothing is projected.
 */
export function plantCostReduction(lines, perPlant, mcgPack) {
  if (!mcgPack || typeof mcgPack !== 'object' || !Object.keys(mcgPack).length) return { available: false, plants: 0, savings: null, excludedUnits: 0 };
  let plants = 0, units = 0;
  for (const li of lines || []) {
    if (!String(li.store || '').includes('Succulents Box')) continue;
    const q = li.qty || 0; units += q;
    plants += mcgPlantUnits(li.sku || '', q, mcgPack);
  }
  return { available: true, plants, savings: r2(plants * (Number(perPlant) || 0)), excludedUnits: units - plants };
}

/**
 * The report's own baseline, so every shipping model starts from the Overview's figures.
 * New GP = report GP + profit change; revenue falls by the shipping revenue lost when the report's revenue
 * includes shipping collected.
 */
export function applyToReport(report, profitDelta, revenueLost, { revenueInclShipping = true } = {}) {
  const gp = r2(report.gp + profitDelta);
  const revenue = r2(report.revenue - (revenueInclShipping ? revenueLost : 0));
  const pct = (a, b) => (b > 0 ? Math.round(a / b * 1000) / 10 : null);
  return { before: { gp: r2(report.gp), revenue: r2(report.revenue), margin: pct(report.gp, report.revenue) },
           after: { gp, revenue, margin: pct(gp, revenue) } };
}

/**
 * Bridge from the report's headline GP to a model's own baseline: named components, then whatever remains.
 * components: [{ label, amount }] where amount is what the model leaves out (+) or adds (−) relative to the report.
 */
export function baselineBridge(reportGp, modelGp, components) {
  const named = components.filter(c => Math.abs(c.amount) >= 0.005).map(c => ({ ...c, amount: r2(c.amount) }));
  const other = r2(reportGp - modelGp - named.reduce((s, c) => s + c.amount, 0));
  return { reportGp: r2(reportGp), modelGp: r2(modelGp), components: named, other };
}
