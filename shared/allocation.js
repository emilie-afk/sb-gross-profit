/**
 * allocation.js — the Revision 5 discount and refund allocation contract
 * =====================================================================
 * A pure post-processing step over calculate() output. The legacy engine and
 * the live dashboard are untouched: this produces a parallel, audited view of
 * each line that the Worker's snapshot metrics use.
 *
 * Automated Shopify (GraphQL)
 *   - Line discounts come from Shopify's discountAllocations and are already on
 *     the line. Nothing is recreated.
 *   - Refunds are applied to the exact lines Shopify's refundLineItems name.
 *     Refund shipping lines and order adjustments stay at order level.
 *
 * Historical CSV
 *   1. `Lineitem discount` is kept as recorded.
 *   2. Order-level residual M = Σ(price × qty) − Σ Lineitem discount − Subtotal.
 *   3. M is a PROVEN product discount only if Discount Amount − Σ Lineitem
 *      discount ≥ M (within 1¢). Otherwise it stays unallocated and visible.
 *   4. A proven M is allocated across eligible product lines by net revenue;
 *      the last eligible line absorbs rounding.
 *   5. Refunded Amount is allocated across eligible product lines, capped at
 *      each line's revenue after discount; any excess stays order-level.
 *   6. Eligible = a product line (not Route, not a gift-card purchase) with
 *      positive net revenue. Route, gift cards, shipping and tax never receive
 *      a synthesized allocation.
 *
 * Route
 *   route_collected = Route line net of its line discount and of Route-specific
 *   refunds (GraphQL only — the CSV proves none). route_remitted = collected.
 */
import { DISCOUNT_SOURCES, REFUND_SOURCES, SOURCE_SYSTEMS, r2 } from './normalized.js';

const TOL = 0.01;

/** Split `total` across positive weights so the parts sum to the total exactly. */
export function allocateProportionally(total, weights) {
  const out = weights.map(() => 0);
  const t = r2(total);
  const sum = weights.reduce((s, w) => s + (w > 0 ? w : 0), 0);
  if (t === 0 || sum <= 0) return out;
  let last = -1; weights.forEach((w, i) => { if (w > 0) last = i; });
  let acc = 0;
  weights.forEach((w, i) => {
    if (!(w > 0)) return;
    if (i === last) out[i] = r2(t - acc);
    else { out[i] = r2(t * (w / sum)); acc = r2(acc + out[i]); }
  });
  return out;
}

/** Like allocateProportionally, but no part may exceed its cap; overflow is returned. */
function allocateCapped(total, weights, caps) {
  let remaining = r2(total);
  const out = weights.map(() => 0);
  let open = weights.map((w, i) => (w > 0 && caps[i] > 0 ? i : -1)).filter(i => i >= 0);
  for (let guard = 0; guard < 50 && remaining > 0.004 && open.length; guard++) {
    const parts = allocateProportionally(remaining, open.map(i => weights[i]));
    let overflow = 0; const stillOpen = [];
    open.forEach((i, k) => {
      const room = r2(caps[i] - out[i]);
      if (parts[k] >= room) { out[i] = r2(out[i] + room); overflow = r2(overflow + parts[k] - room); }
      else { out[i] = r2(out[i] + parts[k]); stillOpen.push(i); }
    });
    remaining = overflow; open = stillOpen;
  }
  return { parts: out, unallocated: r2(remaining) };
}

export const isProductLine = li => !li.isRoute && !li.isGiftCard;

/** Net revenue before any refund: what the engine computed at line creation. */
const preRefundNet = li => r2((li.baseMerchRevenue || 0) - (li.historicalDiscount || 0));

/**
 * @param {object[]} lines   calculate() output with `lineIndex` attached (legacy.attachLineKeys)
 * @param {object[]} orders  NormalizedOrder[] the lines were built from
 * @returns {{ lines: object[], orders: object[] }}  contract lines and per-order audit
 */
export function applyAllocationContract(lines, orders) {
  const orderByName = new Map(orders.map(o => [o.orderName, o]));
  const byOrder = new Map();
  lines.forEach((li, i) => {
    if (!byOrder.has(li.orderNum)) byOrder.set(li.orderNum, []);
    byOrder.get(li.orderNum).push(i);
  });

  const out = lines.map(li => {
    const product = isProductLine(li);
    const net = preRefundNet(li);
    return {
      ...li,
      isProductLine: product,
      allocationEligible: product && net > 0,
      netBeforeAllocation: net,
      discountAllocated: 0,
      discountSource: null,
      refundAllocatedContract: 0,
      refundSource: REFUND_SOURCES.NONE,
      contractRevenue: product ? net : 0,
      routeCollected: 0,
      routeRemitted: 0,
    };
  });

  const audit = [];
  for (const [orderName, idx] of byOrder) {
    const o = orderByName.get(orderName);
    if (!o) throw new Error(`No normalized order for engine order ${orderName}`);
    const nlByIndex = new Map((o.lines || []).map(l => [l.lineIndex, l]));
    const isGraphql = o.sourceSystem === SOURCE_SYSTEMS.SHOPIFY_GRAPHQL;

    // ── Line discount source as recorded ──
    for (const i of idx) {
      const nl = nlByIndex.get(out[i].lineIndex);
      out[i].discountSource = nl?.discountSource
        || ((out[i].historicalDiscount || 0) > 0 ? DISCOUNT_SOURCES.HISTORICAL_CSV_LINE_DISCOUNT : DISCOUNT_SOURCES.NONE);
    }

    // ── Order-level merchandise residual (all order lines, as Subtotal counts them) ──
    const gross = r2((o.lines || []).reduce((s, l) => s + (l.unitPrice || 0) * (l.quantity ?? 1), 0));
    const lineDisc = r2((o.lines || []).reduce((s, l) => s + (l.lineDiscount || 0), 0));
    const residual = o.subtotal === null || o.subtotal === undefined ? 0 : r2(gross - lineDisc - o.subtotal);
    const discountBeyondLines = r2((o.discountAmount || 0) - lineDisc);
    let residualClass = 'none', residualAllocated = 0, residualUnallocated = 0;
    // Influencer / sample orders: the engine already forces every line's revenue
    // to zero, which absorbs the order-level discount. Allocating it again, or
    // reporting it as unallocated, would count it twice.
    const isSampleOrder = idx.length > 0 && idx.every(i => out[i].isInfluencerSample);
    if (isSampleOrder && Math.abs(residual) > 0.005) {
      residualClass = 'influencer_sample';
    } else if (Math.abs(residual) > 0.005) {
      const proven = residual > 0 && discountBeyondLines >= residual - TOL;
      residualClass = proven ? 'proven_product_discount' : 'unproven';
      if (proven && !isGraphql) {
        const eligible = idx.filter(i => out[i].allocationEligible);
        const parts = allocateProportionally(residual, eligible.map(i => out[i].netBeforeAllocation));
        eligible.forEach((i, k) => {
          if (!parts[k]) return;
          out[i].discountAllocated = parts[k];
          out[i].contractRevenue = r2(out[i].contractRevenue - parts[k]);
          out[i].discountSource = DISCOUNT_SOURCES.HISTORICAL_RESIDUAL_ALLOCATION;
        });
        residualAllocated = r2(parts.reduce((s, p) => s + p, 0));
      }
      residualUnallocated = r2(residual - residualAllocated);
    }

    // ── Refunds ──
    let refundTotal = 0, refundToLines = 0, refundOrderLevel = 0, shippingRefund = 0, adjustments = 0;
    for (const rf of o.refunds || []) refundTotal = r2(refundTotal + (rf.amount || 0));
    if (isGraphql) {
      for (const rf of o.refunds || []) {
        for (const rl of rf.lines || []) {
          const i = idx.find(j => out[j].lineIndex === rl.lineIndex);
          if (i === undefined) continue;
          const amt = r2(rl.subtotal || 0);
          out[i].refundAllocatedContract = r2(out[i].refundAllocatedContract + amt);
          out[i].refundSource = REFUND_SOURCES.SHOPIFY_REFUND_LINE;
          if (out[i].isProductLine) out[i].contractRevenue = r2(out[i].contractRevenue - amt);
          refundToLines = r2(refundToLines + amt);
        }
        shippingRefund = r2(shippingRefund + (rf.shippingLines || []).reduce((s, x) => s + (x.subtotal || 0), 0));
        adjustments = r2(adjustments + (rf.adjustments || []).reduce((s, x) => s + (x.amount || 0), 0));
      }
      refundOrderLevel = r2(refundTotal - refundToLines);
    } else if (refundTotal > 0) {
      const eligible = idx.filter(i => out[i].allocationEligible && out[i].contractRevenue > 0);
      const { parts, unallocated } = allocateCapped(
        refundTotal, eligible.map(i => out[i].contractRevenue), eligible.map(i => out[i].contractRevenue));
      eligible.forEach((i, k) => {
        if (!parts[k]) return;
        out[i].refundAllocatedContract = parts[k];
        out[i].refundSource = REFUND_SOURCES.HISTORICAL_PRORATED_REFUND;
        out[i].contractRevenue = r2(out[i].contractRevenue - parts[k]);
      });
      refundToLines = r2(refundTotal - unallocated);
      refundOrderLevel = unallocated;
    }

    // ── Route pass-through ──
    let routeCollected = 0;
    for (const i of idx) {
      if (!out[i].isRoute) continue;
      const c = r2(Math.max(0, out[i].netBeforeAllocation - out[i].refundAllocatedContract));
      out[i].routeCollected = c;
      out[i].routeRemitted = c;
      routeCollected = r2(routeCollected + c);
    }

    audit.push({
      orderName, sourceSystem: o.sourceSystem,
      merchResidual: residual, residualClass, residualAllocated, residualUnallocated,
      discountBeyondLines, refundTotal, refundToLines, refundOrderLevel, shippingRefund, adjustments,
      routeCollected,
    });
  }
  return { lines: out, orders: audit };
}
