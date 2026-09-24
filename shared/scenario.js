/**
 * scenario.js — discount / advertising / labor scenario engine
 * =============================================================
 * Pure functions only. Nothing here touches the DOM, the network, or storage,
 * so every rule below is directly testable (see tests/scenario.test.mjs).
 *
 * Relationship to the historical calculator:
 *   • Historical gross profit  = actual revenue excl. taxes − product COGS − shipping expense
 *   • Operating profit         = gross profit − advertising − allocated labor
 * The two are reported separately. Advertising and labor are NEVER folded into
 * anything labelled gross profit.
 *
 * Scenario discounts REPLACE the historical discount — they are applied to base
 * merchandise revenue (Lineitem price × quantity), never to already-discounted
 * net revenue.
 *
 * Shipping collected and shipping expense stay at their historical actual
 * amounts in every scenario; a discount never re-prices checkout shipping.
 */

import { inferVendorKey, normalizeSku, costCoverage } from './vendorCosts.js';

export const AVG_DAYS_PER_MONTH = 30.4375;

export const SCENARIO_DEFAULTS = Object.freeze({
  name:             'Baseline scenario',
  sitewideDiscount: 0.10,   // 10%
  adRate:           0.15,   // 15% of scenario net product revenue
  monthlyLabor:     9500,   // whole Succulents Box business, editable without limit
  targetMargin:     0.15,   // starting point only — the user chooses the target
  vendorDiscounts:  {},     // { [vendor]: rate } — replaces, never stacks
  vendorFilter:     '',
  channelFilter:    '',
  dateFrom:         '',
  dateTo:           '',
});

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const pct1 = n => (n === null || n === undefined ? null : Math.round(n * 1000) / 10);

// ─── Discount rules ───────────────────────────────────────────────────────────

/**
 * A vendor-specific discount REPLACES the sitewide discount for that vendor's
 * products. Discounts never stack: 10% sitewide + 17% Calathea means Calathea
 * products get 17%, not 27%.
 */
export function resolveEffectiveDiscount(vendorKey, sitewideDiscount, vendorDiscounts = {}) {
  const key = vendorKey || '';
  const override = vendorDiscounts && Object.prototype.hasOwnProperty.call(vendorDiscounts, key)
    ? vendorDiscounts[key] : undefined;
  const rate = (override === undefined || override === null || override === '')
    ? sitewideDiscount : override;
  const n = Number(rate);
  if (!isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 1);
}

/**
 * Lines a scenario product discount must NOT touch. Subscriptions ARE eligible.
 */
export function isDiscountEligible(line) {
  if (!line) return false;
  if (line.isGiftCard || line.costSource === 'Gift Card (no COGS)') return false;
  if (line.isRoute) return false;
  if (line.isInfluencerSample) return false;                    // free sample lines
  if (!((line.baseMerchRevenue ?? (line.unitPrice || 0) * (line.qty || 0)) > 0)) return false;
  if ((line.lineRevenue || 0) <= 0) return false;               // already-zero-revenue lines
  return true;
}

/** Scenario view of one historical line. Pure; returns a new object. */
export function calculateScenarioLine(line, { sitewideDiscount = 0, vendorDiscounts = {} } = {}) {
  const vendorKey = line.vendorKey || inferVendorKey(line.sku, line.vendor) || (line.vendor || '').trim() || 'Unknown';
  const base = r2(line.baseMerchRevenue ?? (line.unitPrice || 0) * (line.qty || 0));
  const eligible = isDiscountEligible(line);
  const effectiveDiscount = eligible
    ? resolveEffectiveDiscount(vendorKey, sitewideDiscount, vendorDiscounts) : 0;

  // Excluded lines keep their actual historical revenue treatment.
  const scenarioRevenue = eligible ? r2(base * (1 - effectiveDiscount)) : r2(line.lineRevenue || 0);

  return {
    ...line,
    vendorKey,
    discountEligible: eligible,
    effectiveDiscount,
    baseMerchRevenue: base,
    currentRevenue: r2(line.lineRevenue || 0),
    currentDiscount: r2(base - (line.lineRevenue || 0)),
    scenarioRevenue,
    scenarioDiscount: r2(base - scenarioRevenue),
    cogs: line.lineCogs === null || line.lineCogs === undefined ? null : r2(line.lineCogs),
    missingCost: !!line.missingCost || line.lineCogs === null || line.lineCogs === undefined,
  };
}

// ─── Allocation ───────────────────────────────────────────────────────────────

/**
 * Split a total across weights so the parts sum back to the total exactly.
 * The last non-zero-weight entry absorbs the rounding remainder.
 */
function allocateByWeight(total, weights) {
  const out = new Array(weights.length).fill(0);
  const sum = weights.reduce((s, w) => s + (w > 0 ? w : 0), 0);
  const t = r2(total);
  if (!weights.length || t === 0) return out;
  if (sum <= 0) {                       // no revenue anywhere → split evenly
    let acc = 0;
    for (let i = 0; i < weights.length; i++) {
      out[i] = i === weights.length - 1 ? r2(t - acc) : r2(t / weights.length);
      acc = r2(acc + out[i]);
    }
    return out;
  }
  let acc = 0, lastIdx = -1;
  for (let i = 0; i < weights.length; i++) if (weights[i] > 0) lastIdx = i;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] <= 0) continue;
    if (i === lastIdx) { out[i] = r2(t - acc); }
    else { out[i] = r2(t * (weights[i] / sum)); acc = r2(acc + out[i]); }
  }
  return out;
}

/**
 * Route shipping protection is a pass-through (Revision 5): customer-paid,
 * remitted in full, zero contribution. It takes no share of shipping, labor or
 * advertising, and never appears in vendor, SKU or reverse-cost results.
 */
export const isPassThrough = line => !!(line && line.isRoute);

/**
 * Allocation weights that give pass-through lines nothing. If an order's other
 * lines all carry zero revenue, they split evenly; pass-through lines still get
 * nothing unless the order has no other lines at all.
 */
function productWeights(lines, weightOf) {
  const w = lines.map(l => (isPassThrough(l) ? 0 : (weightOf(l) || 0)));
  if (w.some(x => x > 0)) return w;
  const hasProduct = lines.some(l => !isPassThrough(l));
  return lines.map(l => (hasProduct ? (isPassThrough(l) ? 0 : 1) : 1));
}

/**
 * Allocate each order's ACTUAL shipping collected and shipping expense across
 * that order's lines by scenario product-revenue share.
 *
 * Shopify reports both at order level (on the order's first line), so the sums
 * of the allocations equal the included actual totals exactly.
 */
export function allocateOrderShipping(scenarioLines) {
  const byOrder = new Map();
  scenarioLines.forEach((li, i) => {
    if (!byOrder.has(li.orderNum)) byOrder.set(li.orderNum, []);
    byOrder.get(li.orderNum).push(i);
  });
  const allocCollected = new Array(scenarioLines.length).fill(0);
  const allocExpense   = new Array(scenarioLines.length).fill(0);

  for (const indices of byOrder.values()) {
    let collected = 0, expense = 0;
    for (const i of indices) {
      const li = scenarioLines[i];
      if (li.shipCollected !== null && li.shipCollected !== undefined) collected += li.shipCollected;
      if (li.shipPaid !== null && li.shipPaid !== undefined) expense += li.shipPaid;
    }
    const weights = productWeights(indices.map(i => scenarioLines[i]), l => l.scenarioRevenue);
    const c = allocateByWeight(collected, weights);
    const e = allocateByWeight(expense, weights);
    indices.forEach((idx, k) => { allocCollected[idx] = c[k]; allocExpense[idx] = e[k]; });
  }

  return scenarioLines.map((li, i) => ({
    ...li,
    allocShipCollected: allocCollected[i],
    allocShipExpense:   allocExpense[i],
  }));
}

// ─── Labor ────────────────────────────────────────────────────────────────────

function parseDate(s) {
  if (!s) return null;
  const m = String(s).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
const endOfMonth = d => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));

/**
 * The monthly labor figure covers the whole Succulents Box business represented
 * by the export.
 *   • complete calendar month(s)  → that many whole monthly amounts
 *   • partial period              → monthlyLabor × inclusive days ÷ 30.4375
 */
export function allocateLabor({ monthlyLabor = 0, dateFrom = '', dateTo = '' } = {}) {
  const from = parseDate(dateFrom), to = parseDate(dateTo);
  const monthly = Number(monthlyLabor) || 0;
  if (!from || !to || to < from) {
    return { allocated: r2(monthly), days: null, months: 1, method: 'single_month_assumed',
             monthlyLabor: r2(monthly) };
  }
  const days = Math.round((to - from) / 86400000) + 1;   // inclusive
  const startsMonth = from.getUTCDate() === 1;
  const endsMonth   = to.getTime() === endOfMonth(to).getTime();
  if (startsMonth && endsMonth) {
    const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12
                 + (to.getUTCMonth() - from.getUTCMonth()) + 1;
    return { allocated: r2(monthly * months), days, months, method: 'whole_calendar_months',
             monthlyLabor: r2(monthly) };
  }
  return { allocated: r2(monthly * days / AVG_DAYS_PER_MONTH), days,
           months: r2(days / AVG_DAYS_PER_MONTH), method: 'prorated_days',
           monthlyLabor: r2(monthly) };
}

// ─── Scenario summary ─────────────────────────────────────────────────────────

function emptyBucket() {
  return { units: 0, baseMerchRevenue: 0, currentRevenue: 0, currentDiscount: 0,
           scenarioRevenue: 0, scenarioDiscount: 0, cogs: 0, shipCollected: 0,
           shipExpense: 0, adExpense: 0, labor: 0, missingCostLines: 0,
           missingCostUnits: 0, missingCostRevenue: 0 };
}

function finishBucket(b, targetMargin) {
  const totalRevenue    = r2(b.scenarioRevenue + b.shipCollected);
  const grossProfit     = r2(b.scenarioRevenue + b.shipCollected - b.cogs - b.shipExpense);
  const operatingProfit = r2(grossProfit - b.adExpense - b.labor);
  const targetProfit    = r2(targetMargin * totalRevenue);
  const maxCogs         = r2(b.scenarioRevenue + b.shipCollected - b.shipExpense
                             - b.adExpense - b.labor - targetProfit);
  return {
    ...b,
    baseMerchRevenue: r2(b.baseMerchRevenue), currentRevenue: r2(b.currentRevenue),
    currentDiscount: r2(b.currentDiscount), scenarioRevenue: r2(b.scenarioRevenue),
    scenarioDiscount: r2(b.scenarioDiscount), cogs: r2(b.cogs),
    shipCollected: r2(b.shipCollected), shipExpense: r2(b.shipExpense),
    adExpense: r2(b.adExpense), labor: r2(b.labor),
    totalRevenue, grossProfit, operatingProfit,
    operatingMargin: totalRevenue !== 0 ? pct1(operatingProfit / totalRevenue) : null,
    maxCogs,
    cogsReduction: r2(b.cogs - maxCogs),
    cogsReductionPct: b.cogs > 0 ? pct1((b.cogs - maxCogs) / b.cogs) : null,
    targetAchievable: maxCogs >= 0,
  };
}

/**
 * Full scenario result: overall totals, the current-vs-scenario comparison,
 * per-vendor and per-SKU breakdowns, cost coverage, and reconciliation checks.
 *
 * `lines` are historical line items from calculate(). They should already be
 * filtered to the analysis period / vendor / channel the user selected.
 */
export function summarizeScenario(lines, assumptions = {}) {
  const a = { ...SCENARIO_DEFAULTS, ...assumptions };
  const adRate       = Number(a.adRate) || 0;
  const targetMargin = Number(a.targetMargin) || 0;

  const scen = allocateOrderShipping(
    lines.map(li => calculateScenarioLine(li, a)));

  // Advertising is charged on scenario net product revenue only — never on
  // taxes or shipping collected. Allocated per line so the parts sum exactly.
  // Route is not advertising-cost basis and takes no labor (Revision 5).
  const totalScenarioRevenue = r2(scen.reduce((s, l) => s + (isPassThrough(l) ? 0 : l.scenarioRevenue), 0));
  const totalAd = r2(totalScenarioRevenue * adRate);
  const adAlloc = allocateByWeight(totalAd, productWeights(scen, l => l.scenarioRevenue));

  const laborInfo = allocateLabor({
    monthlyLabor: a.monthlyLabor, dateFrom: a.dateFrom, dateTo: a.dateTo });
  const laborAlloc = allocateByWeight(laborInfo.allocated, productWeights(scen, l => l.scenarioRevenue));

  const enriched = scen.map((l, i) => {
    const lineAd    = adAlloc[i];
    const lineLabor = laborAlloc[i];
    if (isPassThrough(l)) {
      // Pass-through: collected and remitted in full. No reverse-cost result.
      return { ...l, adExpense: 0, laborExpense: 0, lineTotalRevenue: r2(l.scenarioRevenue + l.allocShipCollected),
               passThrough: true, maxLineCogs: null, maxUnitCost: null, requiredUnitReduction: null,
               scenarioProfit: 0, viable: null };
    }
    const lineTotalRevenue = r2(l.scenarioRevenue + l.allocShipCollected);
    const targetProfit = r2(targetMargin * lineTotalRevenue);
    const maxLineCogs  = r2(lineTotalRevenue - l.allocShipExpense - lineAd - lineLabor - targetProfit);
    const scenarioProfit = l.missingCost ? null
      : r2(lineTotalRevenue - (l.cogs || 0) - l.allocShipExpense - lineAd - lineLabor);
    return {
      ...l,
      adExpense: lineAd,
      laborExpense: lineLabor,
      lineTotalRevenue,
      maxLineCogs,
      maxUnitCost: (l.qty > 0 && maxLineCogs >= 0) ? r2(maxLineCogs / l.qty) : null,
      requiredUnitReduction: (l.qty > 0 && maxLineCogs >= 0 && !l.missingCost)
        ? r2((l.cogs || 0) / l.qty - maxLineCogs / l.qty) : null,
      scenarioProfit,
      viable: l.missingCost ? null : (maxLineCogs >= 0 && (l.cogs || 0) <= maxLineCogs),
    };
  });

  // ── Aggregate ──
  const overallScenario = emptyBucket();
  const overallCurrent  = emptyBucket();
  const byVendor = new Map(), bySku = new Map();
  const missing = [];

  const passThrough = { routeCollected: 0, routeRemitted: 0, routeNet: 0, lines: 0 };
  for (const l of enriched) {
    if (isPassThrough(l)) {
      passThrough.routeCollected = r2(passThrough.routeCollected + (l.currentRevenue || 0));
      passThrough.routeRemitted  = r2(passThrough.routeRemitted + (l.currentRevenue || 0));
      passThrough.lines++;
      continue;                          // never in overall, vendor, SKU or missing-cost results
    }
    const add = (b) => {
      b.units            += l.qty || 0;
      b.baseMerchRevenue += l.baseMerchRevenue;
      b.currentRevenue   += l.currentRevenue;
      b.currentDiscount  += l.currentDiscount;
      b.scenarioRevenue  += l.scenarioRevenue;
      b.scenarioDiscount += l.scenarioDiscount;
      b.cogs             += l.cogs || 0;
      b.shipCollected    += l.allocShipCollected;
      b.shipExpense      += l.allocShipExpense;
      b.adExpense        += l.adExpense;
      b.labor            += l.laborExpense;
      if (l.missingCost) {
        b.missingCostLines++;
        b.missingCostUnits   += l.qty || 0;
        b.missingCostRevenue += l.scenarioRevenue;
      }
    };
    add(overallScenario);

    const vk = l.vendorKey || 'Unknown';
    if (!byVendor.has(vk)) byVendor.set(vk, emptyBucket());
    add(byVendor.get(vk));

    const sk = `${vk}|${normalizeSku(l.sku)}`;
    if (!bySku.has(sk)) {
      bySku.set(sk, { ...emptyBucket(), sku: l.sku, vendor: vk, product: l.product,
                      effectiveDiscount: l.effectiveDiscount, unitCostSamples: [] });
    }
    const sb = bySku.get(sk);
    add(sb);
    if (!l.missingCost && l.qty > 0) sb.unitCostSamples.push(r2((l.cogs || 0) / l.qty));

    if (l.missingCost) {
      missing.push({ vendor: vk, sku: l.sku, product: l.product, qty: l.qty,
                     scenarioRevenue: l.scenarioRevenue, costSource: l.costSource });
    }
  }

  // Current-actual column: same shipping, same COGS, historical discounts.
  passThrough.routeNet = r2(passThrough.routeCollected - passThrough.routeRemitted);
  const currentProductRevenue = r2(enriched.reduce((s, l) => s + (isPassThrough(l) ? 0 : l.currentRevenue), 0));
  const currentAd = r2(currentProductRevenue * adRate);
  overallCurrent.units            = overallScenario.units;
  overallCurrent.baseMerchRevenue = overallScenario.baseMerchRevenue;
  overallCurrent.currentRevenue   = currentProductRevenue;
  overallCurrent.currentDiscount  = overallScenario.currentDiscount;
  overallCurrent.scenarioRevenue  = currentProductRevenue;     // "revenue" for this column
  overallCurrent.scenarioDiscount = overallScenario.currentDiscount;
  overallCurrent.cogs             = overallScenario.cogs;
  overallCurrent.shipCollected    = overallScenario.shipCollected;
  overallCurrent.shipExpense      = overallScenario.shipExpense;
  overallCurrent.adExpense        = currentAd;
  overallCurrent.labor            = laborInfo.allocated;
  overallCurrent.missingCostLines = overallScenario.missingCostLines;

  const scenarioTotals = finishBucket(overallScenario, targetMargin);
  const currentTotals  = finishBucket(overallCurrent, targetMargin);

  const vendorRows = [...byVendor.entries()]
    .map(([vendor, b]) => ({ vendor, ...finishBucket(b, targetMargin) }))
    .sort((x, y) => y.scenarioRevenue - x.scenarioRevenue);

  const skuRows = [...bySku.values()].map(b => {
    const f = finishBucket(b, targetMargin);
    const currentUnitCost = b.units > 0 && b.missingCostLines === 0 ? r2(b.cogs / b.units) : null;
    const maxUnitCost = (b.units > 0 && f.maxCogs >= 0) ? r2(f.maxCogs / b.units) : null;
    return {
      sku: b.sku, product: b.product, vendor: b.vendor,
      effectiveDiscount: b.effectiveDiscount,
      ...f,
      currentUnitCost, maxUnitCost,
      requiredUnitReduction: (currentUnitCost !== null && maxUnitCost !== null)
        ? r2(currentUnitCost - maxUnitCost) : null,
      viable: currentUnitCost === null ? null
        : (maxUnitCost !== null && currentUnitCost <= maxUnitCost),
    };
  }).sort((x, y) => y.scenarioRevenue - x.scenarioRevenue);

  const coverage = costCoverage(lines.filter(l => !isPassThrough(l)));

  return {
    assumptions: { ...a, adRate, targetMargin },
    labor: laborInfo,
    lines: enriched,
    current: currentTotals,
    scenario: scenarioTotals,
    byVendor: vendorRows,
    bySku: skuRows,
    coverage,
    missingCostLines: missing,
    passThrough,
    incomplete: !coverage.complete,
    reconciliation: reconcileScenario(enriched, scenarioTotals, vendorRows, skuRows, laborInfo),
  };
}

/** Allowable-COGS answer for the whole scenario. */
export function calculateAllowableCogs(summary, targetMargin = null) {
  const s = summary.scenario;
  const margin = targetMargin === null ? summary.assumptions.targetMargin : Number(targetMargin);
  const totalRevenue = s.totalRevenue;
  const targetProfit = r2(margin * totalRevenue);
  const maxCogs = r2(s.scenarioRevenue + s.shipCollected - s.shipExpense
                     - s.adExpense - s.labor - targetProfit);
  return {
    targetMargin: margin,
    totalScenarioRevenue: totalRevenue,
    targetProfit,
    currentCogs: s.cogs,
    maxCogs,
    reductionDollars: r2(s.cogs - maxCogs),
    reductionPct: s.cogs > 0 ? pct1((s.cogs - maxCogs) / s.cogs) : null,
    achievable: maxCogs >= 0,
    achievedAtCurrentCost: s.cogs <= maxCogs,
    note: maxCogs < 0
      ? 'Target cannot be reached through product-cost reduction alone — even a $0 product cost leaves the scenario short of the target margin.'
      : null,
    incomplete: summary.incomplete,
  };
}

/**
 * Standalone single-product reverse calculator, for products with no sales in
 * the uploaded period. This does NOT use historical product mix.
 */
export function calculateSingleProductTargetCost({
  vendor = '', sku = '', productName = '',
  sellingPrice = 0, currentUnitCost = null,
  discountPct = 0, adPct = 0,
  shipCollected = 0, shipExpense = 0, laborPerUnit = 0,
  targetMargin = 0,
} = {}) {
  const price = Number(sellingPrice) || 0;
  const disc  = Math.min(Math.max(Number(discountPct) || 0, 0), 1);
  const ad    = Math.max(Number(adPct) || 0, 0);
  const discountedPrice = r2(price * (1 - disc));
  const totalRevenue = r2(discountedPrice + (Number(shipCollected) || 0));
  const adExpense = r2(discountedPrice * ad);
  const labor = r2(Number(laborPerUnit) || 0);
  const shipExp = r2(Number(shipExpense) || 0);
  const targetProfit = r2((Number(targetMargin) || 0) * totalRevenue);
  const maxCost = r2(totalRevenue - shipExp - adExpense - labor - targetProfit);

  const cost = currentUnitCost === null || currentUnitCost === '' ? null : Number(currentUnitCost);
  const profitAtCurrent = cost === null ? null
    : r2(totalRevenue - shipExp - adExpense - labor - cost);
  const marginAtCurrent = (profitAtCurrent === null || totalRevenue === 0) ? null
    : pct1(profitAtCurrent / totalRevenue);

  return {
    vendor, sku, productName,
    discountedPrice, totalRevenue, adExpense, shipExpense: shipExp, laborPerUnit: labor,
    targetProfit, maxAllowableCost: maxCost,
    achievable: maxCost >= 0,
    currentUnitCost: cost,
    requiredReduction: cost === null || maxCost < 0 ? null : r2(Math.max(0, cost - maxCost)),
    profitAtCurrentCost: profitAtCurrent,
    marginAtCurrentCost: marginAtCurrent,
    targetAchieved: cost === null ? null : (cost <= maxCost && maxCost >= 0),
    note: 'Standalone result — it does not use historical product mix.',
  };
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

const TOLERANCE = 0.05;   // currency rounding only

export function reconcileScenario(lines, scenarioTotals, vendorRows, skuRows, laborInfo) {
  const sum = (arr, k) => r2(arr.reduce((s, x) => s + (x[k] || 0), 0));
  const checks = [
    ['vendor scenario revenue = overall scenario product revenue',
      sum(vendorRows, 'scenarioRevenue'), scenarioTotals.scenarioRevenue],
    ['SKU scenario revenue = overall scenario product revenue',
      sum(skuRows, 'scenarioRevenue'), scenarioTotals.scenarioRevenue],
    ['allocated shipping collected = included actual shipping collected',
      sum(lines, 'allocShipCollected'),
      r2(lines.reduce((s, l) => s + (l.shipCollected || 0), 0))],
    ['allocated shipping expense = included actual shipping expense',
      sum(lines, 'allocShipExpense'),
      r2(lines.reduce((s, l) => s + (l.shipPaid || 0), 0))],
    ['allocated labor = total allocated labor',
      sum(lines, 'laborExpense'), r2(laborInfo.allocated)],
    ['vendor operating profit = overall operating profit',
      sum(vendorRows, 'operatingProfit'), scenarioTotals.operatingProfit],
    ['SKU operating profit = overall operating profit',
      sum(skuRows, 'operatingProfit'), scenarioTotals.operatingProfit],
    ['advertising expense = scenario product revenue × ad rate',
      sum(lines, 'adExpense'), scenarioTotals.adExpense],
  ];
  const results = checks.map(([label, got, want]) => ({
    label, got, want, diff: r2(got - want), ok: Math.abs(got - want) <= TOLERANCE,
  }));
  return { ok: results.every(r => r.ok), checks: results, tolerance: TOLERANCE };
}
