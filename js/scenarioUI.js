/**
 * scenarioUI.js — Scenario Calculator view
 * =========================================
 * All arithmetic lives in scenario.js; this module only reads inputs, calls
 * those pure functions, and paints the result. Uploaded order data never leaves
 * the browser and is never written to localStorage — only assumptions are saved.
 */

import {
  SCENARIO_DEFAULTS, summarizeScenario, calculateAllowableCogs,
  calculateSingleProductTargetCost,
} from './scenario.js';
import { VENDOR_KEYS } from './vendorCosts.js';

const LS_SCENARIOS = 'gp_scenarios_v1';
const MAX_SAVED = 12;                 // at least three, with room to spare

const $ = id => document.getElementById(id);
const money = n => (n === null || n === undefined || Number.isNaN(n))
  ? '—' : (n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString('en-US',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => (n === null || n === undefined || Number.isNaN(n)) ? '—' : `${n.toFixed(1)}%`;
const neg = n => (typeof n === 'number' && n < 0) ? ' class="neg"' : '';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let getLines = () => [];
let lastResult = null;
let overrideRows = [];   // [{ vendor, rate }]

// ─── Markup ───────────────────────────────────────────────────────────────────

const STYLES = `
<style>
#view-scenario .sc-card{background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);padding:16px;margin-bottom:16px}
#view-scenario .sc-h{font-size:.85rem;font-weight:600;margin-bottom:10px;display:flex;
  align-items:center;gap:8px;flex-wrap:wrap}
#view-scenario .sc-grid{display:grid;gap:12px;
  grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
#view-scenario label{display:block;font-size:.7rem;color:var(--muted);margin-bottom:4px;
  text-transform:uppercase;letter-spacing:.04em}
#view-scenario input,#view-scenario select{width:100%;padding:7px 10px;background:var(--surface2);
  border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:.85rem;
  font-family:inherit}
#view-scenario input:focus,#view-scenario select:focus{outline:none;border-color:var(--accent)}
#view-scenario .sc-note{font-size:.75rem;color:var(--muted);margin-top:8px;line-height:1.6}
#view-scenario .sc-flag{display:inline-block;padding:3px 9px;border-radius:999px;
  font-size:.7rem;background:rgba(56,189,248,.12);color:var(--accent2);border:1px solid rgba(56,189,248,.3)}
#view-scenario .sc-warn{background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.4);
  color:var(--yellow);padding:10px 14px;border-radius:8px;font-size:.8rem;margin-bottom:12px}
#view-scenario .sc-bad{background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.4);color:var(--red)}
#view-scenario table{width:100%;border-collapse:collapse;font-size:.8rem}
#view-scenario th,#view-scenario td{padding:6px 10px;border-bottom:1px solid var(--border);
  text-align:left;white-space:nowrap}
#view-scenario th{color:var(--muted);font-weight:600;font-size:.72rem;text-transform:uppercase}
#view-scenario td.num,#view-scenario th.num{text-align:right;font-variant-numeric:tabular-nums}
#view-scenario .neg{color:var(--red)}
#view-scenario .pos{color:var(--accent)}
#view-scenario .sc-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
#view-scenario .sc-ovr{display:flex;gap:8px;align-items:flex-end;margin-bottom:8px;flex-wrap:wrap}
#view-scenario .sc-ovr select{min-width:190px}
#view-scenario .sc-ovr input{width:110px}
#view-scenario .sc-btn{padding:7px 14px;background:transparent;border:1px solid var(--border);
  border-radius:6px;color:var(--muted);font-size:.78rem}
#view-scenario .sc-btn:hover{border-color:var(--accent);color:var(--accent)}
#view-scenario .sc-kpi{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
#view-scenario .sc-kpi div{background:var(--surface2);border-radius:8px;padding:12px}
#view-scenario .sc-kpi .k{font-size:.7rem;color:var(--muted);text-transform:uppercase}
#view-scenario .sc-kpi .v{font-size:1.15rem;font-weight:600;margin-top:4px;
  font-variant-numeric:tabular-nums}
@media(max-width:640px){#view-scenario .sc-card{padding:12px}
  #view-scenario th,#view-scenario td{padding:5px 7px;font-size:.75rem}}
</style>`;

const MARKUP = `
<div class="sc-card">
  <div class="sc-h">🎛️ Scenario assumptions
    <span class="sc-flag">Vendor discount replaces the sitewide discount.</span></div>
  <div class="sc-grid">
    <div><label>Scenario name</label><input id="sc-name" type="text" placeholder="e.g. 10% sitewide + 17% Calathea"></div>
    <div><label>Sitewide discount %</label><input id="sc-sitewide" type="number" step="0.5" min="0" max="100"></div>
    <div><label>Advertising cost %</label><input id="sc-ad" type="number" step="0.5" min="0"></div>
    <div><label>Monthly labor $</label><input id="sc-labor" type="number" step="100" min="0"></div>
    <div><label>Target operating margin %</label><input id="sc-target" type="number" step="0.5"></div>
    <div><label>Date from</label><input id="sc-from" type="date"></div>
    <div><label>Date to</label><input id="sc-to" type="date"></div>
    <div><label>Vendor filter</label><select id="sc-vendor-filter"></select></div>
    <div><label>Channel filter</label><select id="sc-channel-filter"></select></div>
    <div><label>Missing costs</label><select id="sc-missing">
      <option value="include">Include (totals marked incomplete)</option>
      <option value="exclude">Exclude lines with no cost</option>
    </select></div>
  </div>

  <div style="margin-top:14px">
    <div class="sc-h">Vendor-specific discount overrides</div>
    <div id="sc-overrides"></div>
    <button class="sc-btn" id="sc-add-override">+ Add vendor override</button>
  </div>

  <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <button class="sc-btn" id="sc-save">💾 Save scenario</button>
    <select id="sc-saved" style="max-width:260px"></select>
    <button class="sc-btn" id="sc-load">Load</button>
    <button class="sc-btn" id="sc-delete">Delete</button>
    <button class="sc-btn" id="sc-reset">↺ Reset to defaults</button>
    <button class="sc-btn" id="sc-export">↓ Export SKU analysis CSV</button>
  </div>
  <div class="sc-note">Saved scenarios hold assumptions only — no customer or order data is
    stored in the browser.</div>
</div>

<div id="sc-alerts"></div>

<div class="sc-card">
  <div class="sc-h">📊 Current actual vs scenario</div>
  <div class="sc-kpi" id="sc-kpis"></div>
  <div class="sc-scroll" style="margin-top:14px"><table id="sc-compare"></table></div>
  <div class="sc-note">
    Shipping collected and shipping expense remain at their historical actual amounts in
    discount scenarios.<br>
    Gross profit excludes advertising and labor. Operating profit is gross profit less
    advertising and allocated labor.
  </div>
</div>

<div class="sc-card">
  <div class="sc-h">🎯 Target operating margin — maximum allowable product cost</div>
  <div class="sc-kpi" id="sc-target-kpis"></div>
  <div class="sc-note" id="sc-target-note"></div>
</div>

<div class="sc-card">
  <div class="sc-h">🏷️ Vendor analysis</div>
  <div class="sc-scroll"><table id="sc-vendor"></table></div>
</div>

<div class="sc-card">
  <div class="sc-h">🔎 SKU / product analysis <span id="sc-sku-count" style="color:var(--muted);font-weight:400"></span></div>
  <div class="sc-scroll"><table id="sc-sku"></table></div>
</div>

<div class="sc-card">
  <div class="sc-h">⚠️ Cost coverage &amp; missing costs</div>
  <div class="sc-kpi" id="sc-coverage"></div>
  <div class="sc-scroll" style="margin-top:14px"><table id="sc-missing-table"></table></div>
</div>

<div class="sc-card">
  <div class="sc-h">🧮 Standalone product cost calculator
    <span class="sc-flag">No historical sales required</span></div>
  <div class="sc-grid">
    <div><label>Vendor</label><input id="sp-vendor" type="text" placeholder="Calathea Collective"></div>
    <div><label>SKU or product name</label><input id="sp-sku" type="text"></div>
    <div><label>Selling price $</label><input id="sp-price" type="number" step="0.01" value="0"></div>
    <div><label>Current unit cost $</label><input id="sp-cost" type="number" step="0.01" value="0"></div>
    <div><label>Discount %</label><input id="sp-disc" type="number" step="0.5" value="10"></div>
    <div><label>Advertising %</label><input id="sp-ad" type="number" step="0.5" value="15"></div>
    <div><label>Shipping collected $ (optional)</label><input id="sp-shipcol" type="number" step="0.01" value="0"></div>
    <div><label>Shipping expense $ (optional)</label><input id="sp-shipexp" type="number" step="0.01" value="0"></div>
    <div><label>Labor per unit $ (optional)</label><input id="sp-labor" type="number" step="0.01" value="0"></div>
    <div><label>Target margin %</label><input id="sp-target" type="number" step="0.5" value="15"></div>
  </div>
  <div class="sc-kpi" id="sp-out" style="margin-top:14px"></div>
  <div class="sc-note">This standalone result does not use historical product mix.</div>
</div>

<div class="sc-card">
  <div class="sc-h">📐 Method assumptions</div>
  <div class="sc-note" id="sc-method"></div>
</div>`;

// ─── Wiring ───────────────────────────────────────────────────────────────────

export function initScenarioView(container, linesGetter) {
  getLines = linesGetter;
  container.innerHTML = STYLES + MARKUP;
  resetToDefaults(false);

  ['sc-sitewide', 'sc-ad', 'sc-labor', 'sc-target', 'sc-from', 'sc-to',
   'sc-vendor-filter', 'sc-channel-filter', 'sc-missing'].forEach(id =>
    $(id).addEventListener('input', renderScenarioView));

  $('sc-add-override').addEventListener('click', () => { addOverrideRow(); renderScenarioView(); });
  $('sc-reset').addEventListener('click', () => { resetToDefaults(true); renderScenarioView(); });
  $('sc-save').addEventListener('click', saveScenario);
  $('sc-load').addEventListener('click', loadScenario);
  $('sc-delete').addEventListener('click', deleteScenario);
  $('sc-export').addEventListener('click', exportSkuCsv);

  ['sp-price', 'sp-cost', 'sp-disc', 'sp-ad', 'sp-shipcol', 'sp-shipexp', 'sp-labor',
   'sp-target', 'sp-vendor', 'sp-sku'].forEach(id =>
    $(id).addEventListener('input', renderStandalone));

  refreshSavedList();
  renderStandalone();
  renderScenarioView();
}

function resetToDefaults(keepName) {
  if (!keepName) $('sc-name').value = SCENARIO_DEFAULTS.name;
  $('sc-sitewide').value = SCENARIO_DEFAULTS.sitewideDiscount * 100;
  $('sc-ad').value       = SCENARIO_DEFAULTS.adRate * 100;
  $('sc-labor').value    = SCENARIO_DEFAULTS.monthlyLabor;
  $('sc-target').value   = SCENARIO_DEFAULTS.targetMargin * 100;
  $('sc-missing').value  = 'include';
  overrideRows = [];
  renderOverrides();
}

function populateFilters(lines) {
  const fill = (id, values, label) => {
    const el = $(id);
    const prev = el.value;
    el.innerHTML = `<option value="">${label}</option>` +
      values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    if (values.includes(prev)) el.value = prev;
  };
  const vendors = [...new Set(lines.map(l => l.vendorKey || l.vendor || 'Unknown'))].sort();
  const chans   = [...new Set(lines.map(l => l.source).filter(Boolean))].sort();
  fill('sc-vendor-filter', vendors, 'All vendors');
  fill('sc-channel-filter', chans, 'All channels');
  if (!$('sc-from').value || !$('sc-to').value) {
    const dates = lines.map(l => l.date).filter(Boolean).sort();
    if (dates.length) {
      $('sc-from').value = dates[0];
      $('sc-to').value   = dates[dates.length - 1];
    }
  }
}

// ─── Vendor overrides ─────────────────────────────────────────────────────────

function knownVendors() {
  const fromData = [...new Set(getLines().map(l => l.vendorKey || l.vendor).filter(Boolean))];
  return [...new Set([...VENDOR_KEYS, ...fromData])].sort();
}

function addOverrideRow(vendor = '', rate = 15) {
  const used = new Set(overrideRows.map(r => r.vendor));
  const next = vendor || knownVendors().find(v => !used.has(v)) || '';
  if (!next || used.has(next)) return;      // never allow a duplicate vendor row
  overrideRows.push({ vendor: next, rate });
  renderOverrides();
}

function renderOverrides() {
  const wrap = $('sc-overrides');
  if (!wrap) return;
  const vendors = knownVendors();
  wrap.innerHTML = overrideRows.map((r, i) => `
    <div class="sc-ovr">
      <div><label>Vendor</label><select data-i="${i}" class="sc-ovr-v">
        ${vendors.map(v => {
          const taken = overrideRows.some((o, j) => j !== i && o.vendor === v);
          return `<option value="${esc(v)}" ${v === r.vendor ? 'selected' : ''} ${taken ? 'disabled' : ''}>${esc(v)}${taken ? ' (already used)' : ''}</option>`;
        }).join('')}
      </select></div>
      <div><label>Discount %</label><input type="number" step="0.5" min="0" max="100"
        class="sc-ovr-r" data-i="${i}" value="${r.rate}"></div>
      <button class="sc-btn sc-ovr-x" data-i="${i}">Remove</button>
    </div>`).join('') ||
    '<div class="sc-note">No vendor overrides — every eligible product uses the sitewide discount.</div>';

  wrap.querySelectorAll('.sc-ovr-v').forEach(el => el.addEventListener('change', e => {
    overrideRows[+e.target.dataset.i].vendor = e.target.value;
    renderOverrides(); renderScenarioView();
  }));
  wrap.querySelectorAll('.sc-ovr-r').forEach(el => el.addEventListener('input', e => {
    overrideRows[+e.target.dataset.i].rate = parseFloat(e.target.value) || 0;
    renderScenarioView();
  }));
  wrap.querySelectorAll('.sc-ovr-x').forEach(el => el.addEventListener('click', e => {
    overrideRows.splice(+e.target.dataset.i, 1);
    renderOverrides(); renderScenarioView();
  }));
}

// ─── Assumptions ──────────────────────────────────────────────────────────────

function readAssumptions() {
  const vendorDiscounts = {};
  for (const r of overrideRows) if (r.vendor) vendorDiscounts[r.vendor] = (r.rate || 0) / 100;
  return {
    name:             $('sc-name').value || SCENARIO_DEFAULTS.name,
    sitewideDiscount: (parseFloat($('sc-sitewide').value) || 0) / 100,
    adRate:           (parseFloat($('sc-ad').value) || 0) / 100,
    monthlyLabor:     parseFloat($('sc-labor').value) || 0,
    targetMargin:     (parseFloat($('sc-target').value) || 0) / 100,
    vendorDiscounts,
    vendorFilter:     $('sc-vendor-filter').value,
    channelFilter:    $('sc-channel-filter').value,
    dateFrom:         $('sc-from').value,
    dateTo:           $('sc-to').value,
    excludeMissing:   $('sc-missing').value === 'exclude',
  };
}

function filterLines(lines, a) {
  return lines.filter(l => {
    if (a.vendorFilter && (l.vendorKey || l.vendor || 'Unknown') !== a.vendorFilter) return false;
    if (a.channelFilter && l.source !== a.channelFilter) return false;
    if (a.dateFrom && l.date && l.date < a.dateFrom) return false;
    if (a.dateTo && l.date && l.date > a.dateTo) return false;
    if (a.excludeMissing && l.missingCost) return false;
    return true;
  });
}

// ─── Render ───────────────────────────────────────────────────────────────────

export function renderScenarioView() {
  const all = getLines();
  if (!all || !all.length) return;
  populateFilters(all);
  const a = readAssumptions();
  const lines = filterLines(all, a);
  const res = summarizeScenario(lines, a);
  const target = calculateAllowableCogs(res);
  lastResult = res;

  renderAlerts(res, target);
  renderKpis(res);
  renderCompare(res);
  renderTarget(res, target);
  renderVendorTable(res);
  renderSkuTable(res);
  renderCoverage(res);
  renderMethod(res, target);
}

function renderAlerts(res, target) {
  const out = [];
  if (res.incomplete) {
    out.push(`<div class="sc-warn">Cost coverage is incomplete — ${res.coverage.matchedSkus}/${res.coverage.soldSkus} sold SKUs,
      ${res.coverage.matchedUnits}/${res.coverage.units} units and ${money(res.coverage.matchedRevenue)}/${money(res.coverage.revenue)}
      of product revenue have a matched cost. Margin totals below are <strong>incomplete</strong>; switch “Missing costs” to
      <em>Exclude</em> for conclusive totals.</div>`);
  }
  if (!res.reconciliation.ok) {
    const bad = res.reconciliation.checks.filter(c => !c.ok)
      .map(c => `${esc(c.label)} (off by ${money(c.diff)})`).join('; ');
    out.push(`<div class="sc-warn sc-bad">Reconciliation failed: ${bad}</div>`);
  }
  if (res.scenario.operatingProfit < 0) {
    out.push(`<div class="sc-warn sc-bad">This scenario loses ${money(Math.abs(res.scenario.operatingProfit))}
      at the operating line (${pct(res.scenario.operatingMargin)}).</div>`);
  }
  if (!target.achievable) {
    out.push(`<div class="sc-warn sc-bad">${esc(target.note)}</div>`);
  }
  $('sc-alerts').innerHTML = out.join('');
}

function renderKpis(res) {
  const s = res.scenario, c = res.current;
  const d = (a, b) => a - b;
  $('sc-kpis').innerHTML = `
    <div><div class="k">Scenario net product revenue</div><div class="v">${money(s.scenarioRevenue)}</div></div>
    <div><div class="k">Gross profit</div><div class="v"${neg(s.grossProfit)}>${money(s.grossProfit)}</div></div>
    <div><div class="k">Operating profit</div><div class="v"${neg(s.operatingProfit)}>${money(s.operatingProfit)}</div></div>
    <div><div class="k">Operating margin</div><div class="v"${neg(s.operatingMargin)}>${pct(s.operatingMargin)}</div></div>
    <div><div class="k">Δ operating vs current</div><div class="v"${neg(d(s.operatingProfit, c.operatingProfit))}>${money(d(s.operatingProfit, c.operatingProfit))}</div></div>`;
}

const COMPARE_ROWS = [
  ['Base merchandise revenue', 'baseMerchRevenue'],
  ['Discount dollars',         'scenarioDiscount'],
  ['Net product revenue',      'scenarioRevenue'],
  ['Shipping collected',       'shipCollected'],
  ['Product COGS',             'cogs'],
  ['Shipping expense',         'shipExpense'],
  ['Gross profit',             'grossProfit'],
  ['Advertising expense',      'adExpense'],
  ['Labor expense',            'labor'],
  ['Operating profit',         'operatingProfit'],
];

function renderCompare(res) {
  const rows = COMPARE_ROWS.map(([label, key]) => {
    const cur = res.current[key], sc = res.scenario[key], ch = sc - cur;
    return `<tr><td>${label}</td><td class="num"${neg(cur)}>${money(cur)}</td>
      <td class="num"${neg(sc)}>${money(sc)}</td><td class="num"${neg(ch)}>${money(ch)}</td></tr>`;
  }).join('');
  const cm = res.current.operatingMargin, sm = res.scenario.operatingMargin;
  const marginRow = `<tr><td>Operating margin</td><td class="num"${neg(cm)}>${pct(cm)}</td>
    <td class="num"${neg(sm)}>${pct(sm)}</td>
    <td class="num"${neg(sm - cm)}>${(sm === null || cm === null) ? '—' : `${(sm - cm).toFixed(1)} pp`}</td></tr>`;
  $('sc-compare').innerHTML = `
    <thead><tr><th>Metric</th><th class="num">Current actual</th>
      <th class="num">Scenario</th><th class="num">Change</th></tr></thead>
    <tbody>${rows}${marginRow}</tbody>`;
}

function renderTarget(res, t) {
  $('sc-target-kpis').innerHTML = `
    <div><div class="k">Target operating margin</div><div class="v">${pct(t.targetMargin * 100)}</div></div>
    <div><div class="k">Current total COGS</div><div class="v">${money(t.currentCogs)}</div></div>
    <div><div class="k">Maximum allowable COGS</div><div class="v"${neg(t.maxCogs)}>${money(t.maxCogs)}</div></div>
    <div><div class="k">Required COGS reduction</div><div class="v"${neg(-t.reductionDollars)}>${money(t.reductionDollars)}</div></div>
    <div><div class="k">Required reduction %</div><div class="v">${pct(t.reductionPct)}</div></div>
    <div><div class="k">Target achievable?</div><div class="v">${
      !t.achievable ? 'No — not through cost alone'
        : t.achievedAtCurrentCost ? 'Already met' : 'Yes, with cost reduction'}</div></div>`;
  $('sc-target-note').innerHTML = t.achievable
    ? `Target profit of ${money(t.targetProfit)} on total scenario revenue of ${money(t.totalScenarioRevenue)}.
       ${t.incomplete ? '<strong>Totals are incomplete — some sold SKUs have no cost.</strong>' : ''}`
    : esc(t.note);
}

function renderVendorTable(res) {
  const head = ['Vendor', 'Units', 'Scenario revenue', 'Current COGS', 'Shipping allocation',
                'Ad cost', 'Labor allocation', 'Operating profit', 'Operating margin',
                'Maximum COGS', 'Reduction needed'];
  const body = res.byVendor.map(v => `<tr>
    <td>${esc(v.vendor)}</td><td class="num">${v.units}</td>
    <td class="num">${money(v.scenarioRevenue)}</td><td class="num">${money(v.cogs)}</td>
    <td class="num">${money(v.shipExpense)}</td><td class="num">${money(v.adExpense)}</td>
    <td class="num">${money(v.labor)}</td>
    <td class="num"${neg(v.operatingProfit)}>${money(v.operatingProfit)}</td>
    <td class="num"${neg(v.operatingMargin)}>${pct(v.operatingMargin)}</td>
    <td class="num"${neg(v.maxCogs)}>${money(v.maxCogs)}</td>
    <td class="num"${neg(-v.cogsReduction)}>${money(v.cogsReduction)}</td></tr>`).join('');
  $('sc-vendor').innerHTML =
    `<thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead>
     <tbody>${body}</tbody>`;
}

function renderSkuTable(res) {
  const head = ['SKU', 'Product', 'Vendor', 'Units', 'Effective discount', 'Scenario revenue',
                'Current unit cost', 'Maximum unit cost', 'Required reduction',
                'Scenario profit', 'Viable'];
  const rows = res.bySku.slice(0, 500);
  $('sc-sku-count').textContent =
    `${res.bySku.length} products${res.bySku.length > 500 ? ' (showing first 500 — export for all)' : ''}`;
  const body = rows.map(s => `<tr>
    <td>${esc(s.sku)}</td><td>${esc((s.product || '').slice(0, 48))}</td>
    <td>${esc(s.vendor)}</td><td class="num">${s.units}</td>
    <td class="num">${pct(s.effectiveDiscount * 100)}</td>
    <td class="num">${money(s.scenarioRevenue)}</td>
    <td class="num">${s.currentUnitCost === null ? '<span class="neg">missing</span>' : money(s.currentUnitCost)}</td>
    <td class="num">${s.maxUnitCost === null ? '—' : money(s.maxUnitCost)}</td>
    <td class="num"${neg(-(s.requiredUnitReduction ?? 0))}>${s.requiredUnitReduction === null ? '—' : money(s.requiredUnitReduction)}</td>
    <td class="num"${neg(s.operatingProfit)}>${money(s.operatingProfit)}</td>
    <td>${s.viable === null ? '—' : (s.viable ? '<span class="pos">yes</span>' : '<span class="neg">no</span>')}</td>
  </tr>`).join('');
  $('sc-sku').innerHTML =
    `<thead><tr>${head.map((h, i) => `<th${i > 2 ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead>
     <tbody>${body}</tbody>`;
}

function renderCoverage(res) {
  const c = res.coverage;
  $('sc-coverage').innerHTML = `
    <div><div class="k">Matched sold SKUs</div><div class="v">${c.matchedSkus}/${c.soldSkus} · ${pct(c.skuPct)}</div></div>
    <div><div class="k">Matched units</div><div class="v">${c.matchedUnits}/${c.units} · ${pct(c.unitPct)}</div></div>
    <div><div class="k">Matched revenue</div><div class="v">${money(c.matchedRevenue)} / ${money(c.revenue)} · ${pct(c.revenuePct)}</div></div>`;
  const agg = new Map();
  for (const m of res.missingCostLines) {
    const k = `${m.vendor}|${m.sku}`;
    if (!agg.has(k)) agg.set(k, { ...m, qty: 0, scenarioRevenue: 0 });
    const e = agg.get(k);
    e.qty += m.qty || 0; e.scenarioRevenue += m.scenarioRevenue || 0;
  }
  const body = [...agg.values()].sort((a, b) => b.scenarioRevenue - a.scenarioRevenue)
    .map(m => `<tr><td>${esc(m.vendor)}</td><td>${esc(m.sku)}</td>
      <td>${esc((m.product || '').slice(0, 48))}</td><td class="num">${m.qty}</td>
      <td class="num">${money(m.scenarioRevenue)}</td></tr>`).join('');
  $('sc-missing-table').innerHTML = body
    ? `<thead><tr><th>Vendor</th><th>SKU</th><th>Product</th><th class="num">Units</th>
        <th class="num">Scenario revenue</th></tr></thead><tbody>${body}</tbody>`
    : '<tbody><tr><td>Every sold SKU in this selection has a matched cost.</td></tr></tbody>';
}

function renderMethod(res, t) {
  const l = res.labor;
  const overrides = Object.entries(res.assumptions.vendorDiscounts || {})
    .map(([v, r]) => `${esc(v)} ${(r * 100).toFixed(1)}%`).join(', ') || 'none';
  $('sc-method').innerHTML = `
    • Scenario results use the products and quantities in the uploaded historical orders.
      Vendors or products with no sales during the period do not affect the aggregated scenario.<br>
    • Scenario revenue = Lineitem price × quantity × (1 − effective discount). The scenario discount
      <strong>replaces</strong> the historical discount; it is never applied on top of it.<br>
    • Vendor discount replaces the sitewide discount. Discounts do not stack.
      Sitewide ${(res.assumptions.sitewideDiscount * 100).toFixed(1)}%; overrides: ${overrides}.<br>
    • Shipping collected and shipping expense remain at their historical actual amounts in discount
      scenarios. ShipStation expense is deduplicated per shipment and summed per order; House Plant
      Dropship shipping is passed through with zero contribution.<br>
    • Advertising = scenario net product revenue × ${(res.assumptions.adRate * 100).toFixed(1)}%, charged
      on product revenue only — never on taxes or shipping collected.<br>
    • Labor: ${money(l.monthlyLabor)}/month → ${money(l.allocated)} allocated
      (${l.method === 'whole_calendar_months' ? `${l.months} whole calendar month(s)`
        : l.days ? `${l.days} inclusive days ÷ 30.4375` : 'single month assumed'}).<br>
    • Order shipping and labor are allocated to vendors and SKUs by scenario product-revenue share;
      advertising is computed from each line's own scenario revenue.<br>
    • Cancelled orders are excluded. Order-level refunds are prorated across eligible product lines by
      actual net product-revenue share.<br>
    • Missing costs are never treated as zero. ${res.incomplete
        ? '<strong>This selection has unmatched costs, so totals are marked incomplete.</strong>'
        : 'All sold SKUs in this selection have a matched cost.'}<br>
    • Reconciliation: ${res.reconciliation.ok
        ? 'all vendor/SKU/shipping/labor totals tie back to the overall scenario.'
        : 'FAILED — see the warning above.'}`;
}

// ─── Standalone calculator ────────────────────────────────────────────────────

function renderStandalone() {
  const num = id => parseFloat($(id).value) || 0;
  const r = calculateSingleProductTargetCost({
    vendor: $('sp-vendor').value, sku: $('sp-sku').value,
    sellingPrice: num('sp-price'), currentUnitCost: num('sp-cost'),
    discountPct: num('sp-disc') / 100, adPct: num('sp-ad') / 100,
    shipCollected: num('sp-shipcol'), shipExpense: num('sp-shipexp'),
    laborPerUnit: num('sp-labor'), targetMargin: num('sp-target') / 100,
  });
  $('sp-out').innerHTML = `
    <div><div class="k">Discounted selling price</div><div class="v">${money(r.discountedPrice)}</div></div>
    <div><div class="k">Advertising expense</div><div class="v">${money(r.adExpense)}</div></div>
    <div><div class="k">Maximum allowable cost</div><div class="v"${neg(r.maxAllowableCost)}>${money(r.maxAllowableCost)}</div></div>
    <div><div class="k">Required cost reduction</div><div class="v">${r.requiredReduction === null ? '—' : money(r.requiredReduction)}</div></div>
    <div><div class="k">Profit at current cost</div><div class="v"${neg(r.profitAtCurrentCost)}>${money(r.profitAtCurrentCost)}</div></div>
    <div><div class="k">Margin at current cost</div><div class="v"${neg(r.marginAtCurrentCost)}>${pct(r.marginAtCurrentCost)}</div></div>
    <div><div class="k">Target achieved?</div><div class="v">${
      r.targetAchieved === null ? '—' : (r.targetAchieved ? 'Yes' : 'No')}</div></div>`;
}

// ─── Saved scenarios (assumptions only) ───────────────────────────────────────

function lsRead() {
  try { return JSON.parse(localStorage.getItem(LS_SCENARIOS) || '[]'); } catch { return []; }
}
function lsWrite(arr) {
  try { localStorage.setItem(LS_SCENARIOS, JSON.stringify(arr.slice(-MAX_SAVED))); }
  catch (e) { console.warn('Could not save scenario:', e); }
}
function refreshSavedList() {
  const el = $('sc-saved');
  const items = lsRead();
  el.innerHTML = items.length
    ? items.map((s, i) => `<option value="${i}">${esc(s.name)} · ${esc(s.savedAt)}</option>`).join('')
    : '<option value="">No saved scenarios</option>';
}
function saveScenario() {
  const a = readAssumptions();
  const items = lsRead().filter(s => s.name !== a.name);
  items.push({
    name: a.name, savedAt: new Date().toLocaleDateString(),
    sitewideDiscount: a.sitewideDiscount, vendorDiscounts: a.vendorDiscounts,
    adRate: a.adRate, monthlyLabor: a.monthlyLabor, targetMargin: a.targetMargin,
    vendorFilter: a.vendorFilter, channelFilter: a.channelFilter,
    dateFrom: a.dateFrom, dateTo: a.dateTo, excludeMissing: a.excludeMissing,
  });
  lsWrite(items);
  refreshSavedList();
}
function loadScenario() {
  const i = parseInt($('sc-saved').value, 10);
  const s = lsRead()[i];
  if (!s) return;
  $('sc-name').value     = s.name;
  $('sc-sitewide').value = (s.sitewideDiscount || 0) * 100;
  $('sc-ad').value       = (s.adRate || 0) * 100;
  $('sc-labor').value    = s.monthlyLabor || 0;
  $('sc-target').value   = (s.targetMargin || 0) * 100;
  $('sc-from').value     = s.dateFrom || '';
  $('sc-to').value       = s.dateTo || '';
  $('sc-missing').value  = s.excludeMissing ? 'exclude' : 'include';
  overrideRows = Object.entries(s.vendorDiscounts || {}).map(([vendor, rate]) =>
    ({ vendor, rate: rate * 100 }));
  renderOverrides();
  renderScenarioView();
  if (s.vendorFilter) $('sc-vendor-filter').value = s.vendorFilter;
  if (s.channelFilter) $('sc-channel-filter').value = s.channelFilter;
  renderScenarioView();
}
function deleteScenario() {
  const i = parseInt($('sc-saved').value, 10);
  const items = lsRead();
  if (Number.isNaN(i) || !items[i]) return;
  items.splice(i, 1);
  lsWrite(items);
  refreshSavedList();
}

function exportSkuCsv() {
  if (!lastResult) return;
  const head = ['SKU', 'Product', 'Vendor', 'Units', 'Effective discount', 'Scenario revenue',
                'Current unit cost', 'Maximum unit cost', 'Required reduction',
                'Scenario operating profit', 'Operating margin', 'Viable', 'Missing cost lines'];
  const rows = lastResult.bySku.map(s => [
    s.sku, (s.product || '').replace(/"/g, "'"), s.vendor, s.units,
    (s.effectiveDiscount * 100).toFixed(2), s.scenarioRevenue,
    s.currentUnitCost ?? '', s.maxUnitCost ?? '', s.requiredUnitReduction ?? '',
    s.operatingProfit, s.operatingMargin ?? '', s.viable === null ? '' : s.viable,
    s.missingCostLines,
  ]);
  const csv = [head, ...rows].map(r => r.map(v => `"${String(v ?? '')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `scenario_sku_analysis_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
