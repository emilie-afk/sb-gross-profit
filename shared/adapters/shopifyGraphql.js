/**
 * shopifyGraphql.js — Shopify Admin GraphQL orders → normalized source model
 * ==========================================================================
 * Retired ingest path: the Worker refuses `format: graphql` (no Shopify API
 * integration). The adapter is kept for tests and the manual/backfill
 * `normalized` path, which normalizes GraphQL-shaped fixtures here. Shopify's own discount allocations and refund lines are
 * the truth for this path and are never recreated (Revision 5 contract).
 *
 * The query selects no customer, address, email, phone or order note. If a
 * response arrives carrying any of those, normalizeShopifyOrders() throws
 * CustomerDataError rather than silently dropping them: it means the query has
 * drifted from the approved one.
 *
 * Field names follow the Admin API as of the 2025-01+ versions. Pin the API
 * version wherever the query is run and re-run the adapter tests after changing it.
 */
import {
  SOURCE_SYSTEMS, DISCOUNT_SOURCES, REFUND_SOURCES, DEFAULT_STORE_TIMEZONE,
  toMoney, moneyOrZero, r2, orderNumberOf, filterNoteAttributes,
  assertNoCustomerFields, toStoreLocal, businessDateOf,
} from '../normalized.js';

export const SHOPIFY_ORDERS_QUERY = `
query WeeklyOrders($cursor: String, $q: String!) {
  orders(first: 50, after: $cursor, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      cancelledAt
      tags
      sourceName
      discountCodes
      customAttributes { key value }
      subtotalPriceSet        { shopMoney { amount } }
      totalShippingPriceSet   { shopMoney { amount } }
      totalTaxSet             { shopMoney { amount } }
      totalPriceSet           { shopMoney { amount } }
      totalDiscountsSet       { shopMoney { amount } }
      totalRefundedSet        { shopMoney { amount } }
      originalTotalDutiesSet  { shopMoney { amount } }
      lineItems(first: 100) {
        nodes {
          id
          sku
          name
          quantity
          currentQuantity
          requiresShipping
          vendor
          originalUnitPriceSet { shopMoney { amount } }
          discountAllocations {
            allocatedAmountSet { shopMoney { amount } }
            discountApplication {
              __typename
              index
              allocationMethod
              targetSelection
              targetType
              ... on DiscountCodeApplication   { code }
              ... on ManualDiscountApplication { title }
              ... on AutomaticDiscountApplication { title }
              ... on ScriptDiscountApplication { title }
            }
          }
        }
      }
      refunds {
        id
        createdAt
        totalRefundedSet { shopMoney { amount } }
        refundLineItems(first: 100) {
          nodes {
            lineItem { id }
            quantity
            subtotalSet { shopMoney { amount } }
            totalTaxSet { shopMoney { amount } }
          }
        }
        refundShippingLines(first: 20) {
          nodes {
            subtotalAmountSet { shopMoney { amount } }
            taxAmountSet      { shopMoney { amount } }
          }
        }
        orderAdjustments(first: 20) {
          nodes {
            amountSet    { shopMoney { amount } }
            taxAmountSet { shopMoney { amount } }
            reason
          }
        }
      }
    }
  }
}`;

/** Build the `q` search argument for one Monday–Sunday business week. */
export function weekSearchQuery(weekStart, weekEndExclusive) {
  return `created_at:>=${weekStart} created_at:<${weekEndExclusive}`;
}

/** Connection shapes vary between `{ nodes }`, `{ edges: [{ node }] }` and plain arrays. */
const nodesOf = c => !c ? [] : Array.isArray(c) ? c : c.nodes ? c.nodes : c.edges ? c.edges.map(e => e.node) : [];

function normalizeLine(li, lineIndex) {
  const allocations = (li.discountAllocations || []).map(a => {
    const app = a.discountApplication || {};
    return {
      amount:           r2(moneyOrZero(a.allocatedAmountSet ?? a.allocatedAmount)),
      applicationType:  app.__typename || null,
      applicationIndex: app.index ?? null,
      allocationMethod: app.allocationMethod || null,
      targetSelection:  app.targetSelection || null,
      targetType:       app.targetType || null,
      code:             app.code || null,
      title:            app.title || null,
    };
  });
  const lineDiscount = r2(allocations.reduce((s, a) => s + a.amount, 0));
  return {
    lineIndex,
    lineId:          li.id || null,
    sku:             (li.sku || '').trim(),
    productName:     (li.name || '').trim(),
    quantity:        Number.isFinite(+li.quantity) ? +li.quantity : 0,
    currentQuantity: Number.isFinite(+li.currentQuantity) ? +li.currentQuantity : null,
    unitPrice:       moneyOrZero(li.originalUnitPriceSet ?? li.originalUnitPrice),
    vendor:          (li.vendor || '').trim(),
    requiresShipping: typeof li.requiresShipping === 'boolean' ? li.requiresShipping : null,
    lineDiscount,
    discountSource:  lineDiscount > 0 ? DISCOUNT_SOURCES.SHOPIFY_LINE_ALLOCATION : DISCOUNT_SOURCES.NONE,
    discountAllocations: allocations,
  };
}

function normalizeRefund(rf, lineIndexById) {
  const lines = nodesOf(rf.refundLineItems).map(rl => {
    const lineId = rl.lineItem?.id || null;
    return {
      lineId,
      lineIndex: lineId && lineIndexById.has(lineId) ? lineIndexById.get(lineId) : null,
      quantity:  Number.isFinite(+rl.quantity) ? +rl.quantity : 0,
      subtotal:  r2(moneyOrZero(rl.subtotalSet)),
      tax:       r2(moneyOrZero(rl.totalTaxSet)),
    };
  });
  return {
    refundId:     rf.id,
    processedAt:  rf.createdAt || null,
    amount:       r2(moneyOrZero(rf.totalRefundedSet)),
    refundSource: REFUND_SOURCES.SHOPIFY_REFUND_LINE,
    lines,
    shippingLines: nodesOf(rf.refundShippingLines).map(s => ({
      subtotal: r2(moneyOrZero(s.subtotalAmountSet)), tax: r2(moneyOrZero(s.taxAmountSet)),
    })),
    adjustments: nodesOf(rf.orderAdjustments).map(a => ({
      amount: r2(moneyOrZero(a.amountSet)), tax: r2(moneyOrZero(a.taxAmountSet)), reason: a.reason || null,
    })),
  };
}

/**
 * GraphQL order nodes → NormalizedOrder[].
 * @param {object[]} nodes  `data.orders.nodes`, possibly concatenated across pages
 * @param {{ store?: string, timeZone?: string }} opts
 */
export function normalizeShopifyOrders(nodes, { store = 'Succulents Box', timeZone = DEFAULT_STORE_TIMEZONE } = {}) {
  assertNoCustomerFields(nodes);
  return (nodes || []).map(o => {
    const lines = nodesOf(o.lineItems).map(normalizeLine);
    const lineIndexById = new Map(lines.filter(l => l.lineId).map(l => [l.lineId, l.lineIndex]));
    const createdAtLocal = toStoreLocal(o.createdAt, timeZone);
    return {
      orderName:      String(o.name || '').trim(),
      orderNumber:    orderNumberOf(o.name),
      shopifyId:      o.id || null,
      createdAt:      o.createdAt || null,
      createdAtLocal,
      businessDate:   businessDateOf(createdAtLocal),
      cancelledAt:    o.cancelledAt ? toStoreLocal(o.cancelledAt, timeZone) : null,
      subtotal:       r2(moneyOrZero(o.subtotalPriceSet)),
      shipping:       r2(moneyOrZero(o.totalShippingPriceSet)),
      taxes:          r2(moneyOrZero(o.totalTaxSet)),
      total:          r2(moneyOrZero(o.totalPriceSet)),
      duties:         r2(moneyOrZero(o.originalTotalDutiesSet)),
      discountAmount: r2(moneyOrZero(o.totalDiscountsSet)),
      refundedAmount: r2(moneyOrZero(o.totalRefundedSet)),
      discountCodes:  (o.discountCodes || []).map(String),
      sourceName:     o.sourceName || '',
      tags:           Array.isArray(o.tags) ? o.tags.map(String) : String(o.tags || '').split(',').map(t => t.trim()).filter(Boolean),
      noteAttributes: filterNoteAttributes(o.customAttributes),
      store,
      sourceSystem:   SOURCE_SYSTEMS.SHOPIFY_GRAPHQL,
      lines,
      refunds:        (o.refunds || []).map(rf => normalizeRefund(rf, lineIndexById)),
    };
  });
}

/** Exposed for tests and the ingest diagnostics. */
export { toMoney };
