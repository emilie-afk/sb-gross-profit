/**
 * scenario.js — discount / advertising / labor scenario engine
 * =============================================================
 * Pure functions: no DOM, network or storage.
 *
 *   gross profit     = scenario product revenue + shipping collected − COGS − shipping expense
 *   operating profit = gross profit − advertising − allocated labor
 *
 * A scenario discount replaces the historical discount and applies to base merchandise revenue.
 * Shipping collected and shipping expense stay at their historical amounts.
 *
 * Which lines a discount skips, which lines pass through, and how shipping, advertising and labor are
 * spread over lines come from `scenarioRules` in the private rules (see scenarioRules() below).
 * Without valid rules every calculation throws instead of using built-in choices.
 */

import { inferVendorKey, normalizeSku, costCoverage } from './vendorCosts.js';
import { privateRules, hasPrivateRules } from './privateRules.js';

export const AVG_DAYS_PER_MONTH = 30.4375;

// Neutral public starting values; `scenarioAssumptionDefaults` in the private rules overrides them.
const PUBLIC_SCENARIO_DEFAULTS = Object.freeze({
  name:             'Baseline scenario',
  sitewideDiscount: 0,
  adRate:           0,
  monthlyLabor:     0,
  targetMargin:     0,
  vendorDiscounts:  {},     // { [vendor]: rate } — replaces the general rate
  vendorFilter:     '',
  channelFilter:    '',
  dateFrom:         '',
  dateTo:           '',
});

const PRIVATE_DEFAULT_KEYS = ['sitewideDiscount', 'adRate', 'monthlyLabor', 'targetMargin'];

/** Starting assumptions: the public fallbacks overlaid with the private defaults when loaded. */
export function scenarioDefaults() {
  const p = hasPrivateRules() ? privateRules().scenarioAssumptionDefaults : null;
  const out = { ...PUBLIC_SCENARIO_DEFAULTS };
  if (p && typeof p === 'object') {
    for (const k of PRIVATE_DEFAULT_KEYS) if (Number.isFinite(p[k]) && p[k] >= 0) out[k] = p[k];
  }
  return Object.freeze(out);
}

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const pct1 = n => (n === null || n === undefined ? null : Math.round(n * 1000) / 10);

// ─── Scenario rules (private) ─────────────────────────────────────────────────

const pos = n => Math.max(0, Number(n) || 0);
const baseOf = l => Number(l.baseMerchRevenue ?? (l.unitPrice || 0) * (l.qty || 0)) || 0;

/** Named line weights a rule may choose for an allocation. */
export const WEIGHTS = Object.freeze({
  scenarioRevenue: l => Number(l.scenarioRevenue) || 0,
  currentRevenue:  l => pos(l.currentRevenue),
  lineRevenue:     l => pos(l.lineRevenue),
  baseRevenue:     l => baseOf(l) || Number(l.lineRevenue) || 0,
  units:           l => pos(l.qty),
  equal:           () => 1,
});
const ALLOCATIONS = ['shipping', 'advertising', 'labor', 'laborShare', 'selectionShipping'];
// These two weigh lines before any scenario is applied, so only weights of the historical line are allowed.
const RAW_ALLOCATIONS = ['laborShare', 'selectionShipping'];
const RAW_WEIGHTS = ['lineRevenue', 'baseRevenue', 'units', 'equal'];

export class ScenarioRulesError extends Error {
  constructor(detail) {
    super(`scenario_rules_invalid:${detail}`);
    this.name = 'ScenarioRulesError';
    this.detail = detail;
  }
}

const isStrList = v => Array.isArray(v) && v.every(x => typeof x === 'string' && x.length > 0);
let RULES_SRC = null, RULES = null;

/**
 * The validated `scenarioRules` of the registered private rules:
 *   discountExcludedFlags        line flags that keep their historical revenue (no scenario discount)
 *   discountExcludedCostSources  cost sources treated the same way
 *   passThroughFlags             line flags of pass-through lines: no discount, no share of shipping,
 *                                advertising or labor, and left out of vendor, SKU and cost results
 *   allocation                   { shipping, advertising, labor, laborShare, selectionShipping } → a WEIGHTS name
 * Throws ScenarioRulesError when the rules are missing or invalid.
 */
export function scenarioRules() {
  if (!hasPrivateRules()) throw new ScenarioRulesError('missing');
  const src = privateRules().scenarioRules;
  if (src === RULES_SRC && RULES) return RULES;
  if (!src || typeof src !== 'object' || Array.isArray(src)) throw new ScenarioRulesError('missing');
  for (const k of ['discountExcludedFlags', 'discountExcludedCostSources', 'passThroughFlags']) {
    if (!isStrList(src[k])) throw new ScenarioRulesError(k);
  }
  const al = src.allocation;
  if (!al || typeof al !== 'object') throw new ScenarioRulesError('allocation');
  for (const k of ALLOCATIONS) {
    const ok = RAW_ALLOCATIONS.includes(k) ? RAW_WEIGHTS.includes(al[k]) : Object.prototype.hasOwnProperty.call(WEIGHTS, al[k]);
    if (!ok) throw new ScenarioRulesError(`allocation.${k}`);
  }
  RULES = Object.freeze({
    excludedFlags: [...src.discountExcludedFlags],
    excludedSources: new Set(src.discountExcludedCostSources),
    passThroughFlags: [...src.passThroughFlags],
    weight: Object.freeze(Object.fromEntries(ALLOCATIONS.map(k => [k, WEIGHTS[al[k]]]))),
  });
  RULES_SRC = src;
  return RULES;
}

// ─── Discount rules ───────────────────────────────────────────────────────────

/** A vendor rate replaces the general rate for that vendor's lines; the two never add up. */
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

/** Whether a scenario discount applies to the line (rule exclusions, then positive base and net revenue). */
export function isDiscountEligible(line) {
  if (!line) return false;
  const R = scenarioRules();
  if (R.excludedFlags.some(f => line[f]) || R.excludedSources.has(line.costSource)) return false;
  if (isPassThrough(line)) return false;
  if (!(baseOf(line) > 0)) return false;
  if ((line.lineRevenue || 0) <= 0) return false;
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

/** Pass-through line (scenarioRules.passThroughFlags): collected and remitted in full, zero contribution. */
export const isPassThrough = line => !!line && scenarioRules().passThroughFlags.some(f => line[f]);

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
 * Spread each order's actual shipping collected and shipping expense over its lines by the
 * `allocation.shipping` weight. The parts sum to the order totals exactly.
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
    const weights = productWeights(indices.map(i => scenarioLines[i]), scenarioRules().weight.shipping);
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
 * Labor for a period from a monthly amount:
 *   • complete calendar month(s)  → that many whole monthly amounts
 *   • partial period              → monthly amount × inclusive days ÷ AVG_DAYS_PER_MONTH
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
 * Full scenario result: overall totals, current vs scenario, per-vendor and per-SKU rows, cost coverage
 * and reconciliation checks. `lines` are already filtered to the selection.
 */
export function summarizeScenario(lines, assumptions = {}) {
  const R = scenarioRules();
  const a = { ...scenarioDefaults(), ...assumptions };
  const adRate       = Number(a.adRate) || 0;
  const targetMargin = Number(a.targetMargin) || 0;

  const scen = allocateOrderShipping(
    lines.map(li => calculateScenarioLine(li, a)));

  // Advertising = ad rate × scenario product revenue (pass-through lines excluded), spread by `allocation.advertising`.
  const totalScenarioRevenue = r2(scen.reduce((s, l) => s + (isPassThrough(l) ? 0 : l.scenarioRevenue), 0));
  const totalAd = r2(totalScenarioRevenue * adRate);
  const adAlloc = allocateByWeight(totalAd, productWeights(scen, R.weight.advertising));

  // Labor: the period amount × `assumptions.laborShare` (a filtered selection's share, laborAllocationShare),
  // spread by `allocation.labor`. With no product lines nothing carries it and it is reported as unallocated.
  const laborPeriod = allocateLabor({
    monthlyLabor: a.monthlyLabor, dateFrom: a.dateFrom, dateTo: a.dateTo });
  const share = a.laborShare === undefined || a.laborShare === null ? null
    : Math.min(Math.max(Number(a.laborShare) || 0, 0), 1);
  const laborSelection = share === null ? laborPeriod
    : { ...laborPeriod, periodLabor: laborPeriod.allocated, share, allocated: r2(laborPeriod.allocated * share),
        basis: a.laborBasis || null };
  const laborInfo = scen.some(l => !isPassThrough(l)) ? laborSelection
    : { ...laborSelection, allocated: 0, unallocated: laborSelection.allocated, method: 'no_product_lines' };
  const laborAlloc = allocateByWeight(laborInfo.allocated, productWeights(scen, R.weight.labor));

  const enriched = scen.map((l, i) => {
    const lineAd    = adAlloc[i];
    const lineLabor = laborAlloc[i];
    if (isPassThrough(l)) {
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

  const passThrough = { collected: 0, remitted: 0, net: 0, lines: 0 };
  for (const l of enriched) {
    if (isPassThrough(l)) {
      passThrough.collected = r2(passThrough.collected + (l.currentRevenue || 0));
      passThrough.remitted  = r2(passThrough.remitted + (l.currentRevenue || 0));
      passThrough.lines++;
      continue;
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

  // Current column: same shipping and COGS, historical discounts.
  passThrough.net = r2(passThrough.collected - passThrough.remitted);
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

/** Single-product reverse calculator (no historical product mix). */
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

// ─── Decision answers: maximum discount and required cost reduction ──────────
//
// Both answers are found by running summarizeScenario itself. A missing cost stays missing and marks the
// answer `provisional`, unless the caller excludes those lines first (selectScenarioLines `excludeMissing`).

/** The general-discount increment the answer is rounded down to (the discount input's 0.5-point step). */
export const DISCOUNT_STEP = 0.005;
/** Upper bound for a general discount (the discount input's maximum). */
export const MAX_GENERAL_DISCOUNT = 1;
export const DEFAULT_COMPARISON_LEVELS = Object.freeze([0.05, 0.10, 0.15, 0.20]);

/**
 * The lines a scenario covers: period, vendor and channel filters, and optionally only lines with a cost.
 * When a filter keeps part of an order, the kept lines carry the order's shipping in proportion to their
 * `allocation.selectionShipping` weight.
 */
export function selectScenarioLines(lines, a = {}) {
  const inPeriod = (lines || []).filter(l => {
    if (a.channelFilter && l.source !== a.channelFilter) return false;
    if (a.dateFrom && l.date && l.date < a.dateFrom) return false;
    if (a.dateTo && l.date && l.date > a.dateTo) return false;
    return true;
  });
  const R = scenarioRules();
  const keep = l => !(a.vendorFilter && (l.vendorKey || l.vendor || 'Unknown') !== a.vendorFilter)
                 && !(a.excludeMissing && l.missingCost);
  if (!a.vendorFilter && !a.excludeMissing) return inPeriod;
  const byOrder = new Map();
  for (const l of inPeriod) {
    if (!byOrder.has(l.orderNum)) byOrder.set(l.orderNum, []);
    byOrder.get(l.orderNum).push(l);
  }
  const out = [];
  for (const order of byOrder.values()) {
    const kept = order.filter(keep);
    if (!kept.length) continue;
    if (kept.length === order.length) { out.push(...kept); continue; }
    const has = k => order.some(l => l[k] !== null && l[k] !== undefined);
    const sum = k => order.reduce((s, l) => s + (Number(l[k]) || 0), 0);
    const weight = l => (isPassThrough(l) ? 0 : R.weight.selectionShipping(l));
    const total = order.reduce((s, l) => s + weight(l), 0);
    const share = total > 0 ? kept.reduce((s, l) => s + weight(l), 0) / total
      : kept.filter(l => !isPassThrough(l)).length / Math.max(1, order.filter(l => !isPassThrough(l)).length);
    kept.forEach((l, i) => out.push({
      ...l,
      shipCollected: !has('shipCollected') ? l.shipCollected : (i === 0 ? r2(sum('shipCollected') * share) : null),
      shipPaid:      !has('shipPaid') ? l.shipPaid : (i === 0 ? r2(sum('shipPaid') * share) : null),
      shippingShare: share,
    }));
  }
  return out;
}

/** What excluding lines without a cost leaves out of a selection (lines already filtered by period/vendor/channel). */
export function excludedCostCoverage(lines) {
  const all = new Set(), missing = new Set();
  let units = 0, revenue = 0, totalUnits = 0, totalRevenue = 0, lineCount = 0;
  for (const l of lines || []) {
    if (isPassThrough(l)) continue;
    const key = normalizeSku(l.sku) || `#${l.product || ''}`;
    all.add(key);
    totalUnits += l.qty || 0; totalRevenue += l.lineRevenue || 0;
    if (l.missingCost) { missing.add(key); units += l.qty || 0; revenue += l.lineRevenue || 0; lineCount++; }
  }
  return { skus: missing.size, totalSkus: all.size, units, totalUnits, lines: lineCount,
           revenue: r2(revenue), totalRevenue: r2(totalRevenue),
           revenuePct: totalRevenue > 0 ? pct1(revenue / totalRevenue) : null };
}

/**
 * Labor share of a filtered selection: its `allocation.laborShare` weight over the whole period's (pass-through
 * lines excluded), measured before filters. Pass `share` as `assumptions.laborShare`.
 */
export function laborAllocationShare(allLines, a = {}) {
  const period = selectScenarioLines(allLines, { dateFrom: a.dateFrom, dateTo: a.dateTo });
  const selected = selectScenarioLines(allLines, a);
  const w = scenarioRules().weight.laborShare;
  const rev = ls => ls.reduce((s, l) => s + (isPassThrough(l) ? 0 : w(l)), 0);
  const periodRevenue = rev(period), selectionRevenue = rev(selected);
  const filtered = !!(a.vendorFilter || a.channelFilter || a.excludeMissing);
  let share;
  if (!filtered) share = 1;
  else if (periodRevenue > 0) share = Math.min(1, selectionRevenue / periodRevenue);
  else share = 0;
  return { share, filtered, selectionRevenue: r2(selectionRevenue), periodRevenue: r2(periodRevenue) };
}

/**
 * Everything a decision needs: the selected lines, the assumptions with the selection's labor share, what
 * excluding lines without a cost left out, and which orders' shipping was split by the selection.
 */
export function prepareDecision(allLines, a = {}) {
  const lines = selectScenarioLines(allLines, a);
  const labor = laborAllocationShare(allLines, a);
  const split = new Set();
  let collected = 0, expense = 0;
  for (const l of lines) {
    if (l.shippingShare === undefined) continue;
    split.add(l.orderNum);
    collected += Number(l.shipCollected) || 0; expense += Number(l.shipPaid) || 0;
  }
  return {
    lines,
    assumptions: { ...a, laborShare: labor.share, laborBasis: labor },
    labor,
    excluded: a.excludeMissing ? excludedCostCoverage(selectScenarioLines(allLines, { ...a, excludeMissing: false })) : null,
    shippingSplit: { orders: split.size, collected: r2(collected), expense: r2(expense) },
  };
}

/** Exact test of the target on an engine result (no display rounding): operating profit ≥ target × total revenue. */
export function meetsTargetMargin(summary, targetMargin) {
  const s = summary.scenario;
  if (!(s.totalRevenue > 0)) return false;
  return s.operatingProfit - Number(targetMargin) * s.totalRevenue >= -1e-9;
}

/** Lines that take the general discount: eligible and without a vendor rate. */
export function generalDiscountScope(lines, vendorDiscounts = {}) {
  let count = 0, baseRevenue = 0;
  // A line takes the general discount exactly when resolveEffectiveDiscount falls back to it: probe with two
  // different general rates and see whether the line's rate follows.
  for (const li of lines || []) {
    const l = calculateScenarioLine(li, { sitewideDiscount: 0, vendorDiscounts });
    if (!l.discountEligible || isPassThrough(l)) continue;
    if (resolveEffectiveDiscount(l.vendorKey, 0.5, vendorDiscounts) !== 0.5
        || resolveEffectiveDiscount(l.vendorKey, 0.25, vendorDiscounts) !== 0.25) continue;
    count++; baseRevenue += l.baseMerchRevenue;
  }
  return { lines: count, baseRevenue: r2(baseRevenue) };
}

const ratio = s => (s.totalRevenue > 0 ? s.operatingProfit / s.totalRevenue : null);
const stepsOf = (d, step) => Math.round(d / step);

/**
 * Largest general discount (in DISCOUNT_STEP increments) that still meets the target operating margin, with
 * vendor rates fixed. Checked: that discount meets the target and the next increment does not.
 *
 * status: 'ok' | 'upper_bound' | 'target_not_met_at_zero' | 'no_general_scope' | 'no_revenue'
 */
export function findMaximumDiscount(lines, assumptions = {}, { step = DISCOUNT_STEP, max = MAX_GENERAL_DISCOUNT } = {}) {
  const a = { ...scenarioDefaults(), ...assumptions };
  const target = Number(a.targetMargin) || 0;
  const kMax = stepsOf(max, step);
  const memo = new Map();
  const at = k => {
    if (!memo.has(k)) memo.set(k, summarizeScenario(lines, { ...a, sitewideDiscount: k * step }));
    return memo.get(k);
  };
  const meets = k => meetsTargetMargin(at(k), target);
  const scope = generalDiscountScope(lines, a.vendorDiscounts);
  const zero = at(0);
  const base = {
    targetMargin: target, step, max, generalScope: scope,
    vendorDiscounts: { ...(a.vendorDiscounts || {}) },
    provisional: zero.incomplete, coverage: zero.coverage,
    marginAtZero: zero.scenario.operatingMargin,
  };
  const out = (status, k, extra = {}) => {
    const summary = k === null ? zero : at(k);
    return { ...base, status, ...extra, evaluations: memo.size, summary,
             discount: k === null ? null : r2(k * step * 10000) / 10000 };
  };
  if (!(zero.scenario.totalRevenue > 0)) return out('no_revenue', null);
  if (scope.lines === 0) return out('no_general_scope', null, { meetsAtCurrent: meets(0) });
  if (!meets(0)) return out('target_not_met_at_zero', null);
  let k;
  if (meets(kMax)) k = kMax;
  else {
    let lo = 0, hi = kMax;              // invariant: lo meets, hi fails
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (meets(mid)) lo = mid; else hi = mid; }
    k = lo;
  }
  const atUpperBound = k === kMax;
  const next = atUpperBound ? null : at(k + 1);
  const verification = {
    meets: meets(k),
    nextFails: atUpperBound ? null : !meetsTargetMargin(next, target),
    atUpperBound,
    margin: ratio(at(k).scenario),
    nextMargin: next ? ratio(next.scenario) : null,
  };
  verification.ok = verification.meets && (atUpperBound || verification.nextFails);
  return out(atUpperBound ? 'upper_bound' : 'ok', k, {
    verification,
    next: next ? { discount: r2((k + 1) * step * 10000) / 10000, operatingMargin: next.scenario.operatingMargin,
                   operatingProfit: next.scenario.operatingProfit } : null,
  });
}

/** Lines with every known product cost multiplied by `factor` (missing costs stay missing). */
function scaleCosts(lines, factor) {
  return lines.map(l => (l.lineCogs === null || l.lineCogs === undefined || l.missingCost)
    ? l : { ...l, lineCogs: l.lineCogs * factor });
}

/**
 * Aggregate product-cost reduction needed for the target operating margin at a general discount.
 *
 * status: 'reduction_needed' | 'none_needed' | 'cost_alone_insufficient' | 'no_revenue'
 * `verify` re-runs the engine with the costs substituted: maximum affordable COGS reaches the target within
 * rounding tolerance; or, when costs alone cannot, even $0 product cost misses it.
 */
export function calculateCostReduction(lines, assumptions = {}, { verify = true } = {}) {
  const a = { ...scenarioDefaults(), ...assumptions };
  const target = Number(a.targetMargin) || 0;
  const summary = summarizeScenario(lines, a);
  const t = calculateAllowableCogs(summary, target);
  const s = summary.scenario;
  // Exact maximum affordable COGS (no cent rounding of the target profit), so the status always agrees with
  // meetsTargetMargin; the dollar requirement is then rounded UP to the cent and the percentage UP to 0.1%.
  const exactMax = s.scenarioRevenue + s.shipCollected - s.shipExpense - s.adExpense - s.labor - target * s.totalRevenue;
  const result = {
    targetMargin: target, discount: Number(a.sitewideDiscount) || 0,
    vendorDiscounts: { ...(a.vendorDiscounts || {}) },
    generalScope: generalDiscountScope(lines, a.vendorDiscounts),
    provisional: summary.incomplete, coverage: summary.coverage, summary,
    currentCogs: s.cogs, maxCogs: t.maxCogs,
    marginWithoutReduction: s.operatingMargin, operatingProfitWithoutReduction: s.operatingProfit,
    reductionDollars: null, reductionPct: null,
  };
  if (!(s.totalRevenue > 0)) return { ...result, status: 'no_revenue' };
  let status;
  if (meetsTargetMargin(summary, target)) status = 'none_needed';
  else if (exactMax < 0) status = 'cost_alone_insufficient';
  else status = 'reduction_needed';
  if (status === 'reduction_needed') {
    const exact = s.cogs - exactMax;                       // > 0 here
    result.reductionDollars = Math.ceil(exact * 100 - 1e-6) / 100 || 0.01;
    result.maxCogs = r2(s.cogs - result.reductionDollars);
    const exactPct = s.cogs > 0 ? exact / s.cogs * 100 : null;
    result.reductionPct = exactPct === null ? null : Math.max(0.1, Math.ceil(exactPct * 10 - 1e-9) / 10);
    result.reductionPctExact = exactPct;
  } else if (status === 'cost_alone_insufficient') {
    result.maxCogs = Math.min(t.maxCogs, -0.01);
  } else {
    result.maxCogs = Math.max(t.maxCogs, s.cogs);
  }
  result.status = status;
  if (!verify) return result;

  const costed = lines.filter(l => !(l.lineCogs === null || l.lineCogs === undefined || l.missingCost)).length;
  if (status === 'reduction_needed') {
    const factor = s.cogs > 0 ? result.maxCogs / s.cogs : 1;
    const sub = summarizeScenario(scaleCosts(lines, factor), a);
    const gap = sub.scenario.operatingProfit - target * sub.scenario.totalRevenue;
    const tolerance = Math.max(0.05, 0.005 * costed);       // per-line cent rounding of the substituted costs
    result.verification = { cogs: sub.scenario.cogs, margin: ratio(sub.scenario), gapDollars: r2(gap),
                            tolerance: r2(tolerance), ok: Math.abs(gap) <= tolerance };
  } else if (status === 'cost_alone_insufficient') {
    const sub = summarizeScenario(scaleCosts(lines, 0), a);
    result.marginAtZeroCogs = sub.scenario.operatingMargin;
    result.verification = { cogs: sub.scenario.cogs, margin: ratio(sub.scenario),
                            ok: !meetsTargetMargin(sub, target) };
  } else {
    result.verification = { margin: ratio(s), ok: true };
  }
  return result;
}

/** Margin and required cost reduction per discount level, with the same lines and assumptions. */
export function compareDiscountLevels(lines, assumptions = {}, levels = DEFAULT_COMPARISON_LEVELS) {
  const uniq = [...new Set(levels.map(d => Math.round(Number(d) * 10000) / 10000)
    .filter(d => isFinite(d) && d >= 0 && d <= MAX_GENERAL_DISCOUNT))].sort((x, y) => x - y);
  return uniq.map(d => {
    const r = calculateCostReduction(lines, { ...assumptions, sitewideDiscount: d }, { verify: false });
    return { discount: d, status: r.status, operatingMargin: r.marginWithoutReduction,
             operatingProfit: r.operatingProfitWithoutReduction, currentCogs: r.currentCogs, maxCogs: r.maxCogs,
             labor: r.summary.scenario.labor,
             reductionDollars: r.reductionDollars, reductionPct: r.reductionPct, provisional: r.provisional };
  });
}
