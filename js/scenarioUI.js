/**
 * scenarioUI.js — Discount & operating margin
 * ============================================
 * Answers two decisions directly:
 *   • Maximum discount — the largest general discount that keeps the target operating margin;
 *   • Cost reduction for a bigger discount — how far product costs must fall for a proposed discount.
 * All arithmetic lives in the shared scenario engine (findMaximumDiscount, calculateCostReduction,
 * compareDiscountLevels, summarizeScenario); this module only reads inputs, calls those pure functions and
 * paints the result. Uploaded order data never leaves the browser and is never written to localStorage — only
 * assumptions are saved.
 */

import {
  SCENARIO_DEFAULTS, summarizeScenario, calculateSingleProductTargetCost,
  findMaximumDiscount, calculateCostReduction, compareDiscountLevels, prepareDecision,
  DEFAULT_COMPARISON_LEVELS, DISCOUNT_STEP,
} from './scenario.js';
import { VENDOR_KEYS } from './vendorCosts.js';

const LS_SCENARIOS = 'gp_scenarios_v1';
const MAX_SAVED = 12;                 // at least three, with room to spare

const $ = id => document.getElementById(id);
const money = n => (n === null || n === undefined || Number.isNaN(n))
  ? '—' : (n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString('en-US',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => (n === null || n === undefined || Number.isNaN(n)) ? '—' : `${n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`;
/** A discount fraction as a percentage with only the decimals it needs (12.5%, 10%). */
const dpct = d => `${(Math.round(d * 1000) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
const neg = n => (typeof n === 'number' && n < 0) ? ' class="neg"' : '';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let getLines = () => [];
let lastResult = null;      // engine summary behind the details section (SKU export reads it)
let overrideRows = [];      // [{ vendor, rate }]
let mode = 'max';           // 'max' | 'cost'
const results = { max: null, cost: null };   // { res, scope, key, statusText } per mode
let comparison = null;      // { rows, key, lines, a, scope }
let customLevels = [];      // extra comparison levels (fractions)

// ─── Markup ───────────────────────────────────────────────────────────────────

const STYLES = `
<style>
#view-scenario .sc-card{background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);padding:16px;margin-bottom:16px;min-width:0}
#view-scenario .sc-h{font-size:.85rem;font-weight:600;margin-bottom:10px;display:flex;
  align-items:center;gap:8px;flex-wrap:wrap}
#view-scenario .sc-grid{display:grid;gap:12px;
  grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
#view-scenario label{display:block;font-size:.7rem;color:var(--muted);margin-bottom:4px;
  text-transform:uppercase;letter-spacing:.04em}
#view-scenario input,#view-scenario select{width:100%;padding:7px 10px;background:var(--surface2);
  border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:.85rem;
  font-family:inherit;box-sizing:border-box}
#view-scenario input:focus,#view-scenario select:focus{outline:none;border-color:var(--accent)}
#view-scenario .sc-note{font-size:.75rem;color:var(--muted);margin-top:8px;line-height:1.6}
#view-scenario .sc-flag{display:inline-block;padding:3px 9px;border-radius:999px;font-weight:500;
  font-size:.7rem;background:rgba(56,189,248,.12);color:var(--accent2);border:1px solid rgba(56,189,248,.3)}
#view-scenario .sc-warn{background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.4);
  color:var(--yellow);padding:10px 14px;border-radius:8px;font-size:.8rem;margin-bottom:12px;line-height:1.5}
#view-scenario .sc-bad{background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.4);color:var(--red)}
#view-scenario .sc-ok{background:var(--gp-pos-soft,rgba(52,211,153,.1));border:1px solid var(--border);
  color:var(--gp-pos,var(--accent));padding:8px 12px;border-radius:8px;font-size:.8rem;margin-bottom:12px}
#view-scenario .sc-info{background:var(--gp-info-soft,rgba(56,189,248,.1));border:1px solid var(--border);
  color:var(--gp-info,var(--accent2));padding:8px 12px;border-radius:8px;font-size:.8rem;margin-bottom:12px;line-height:1.5}
#view-scenario table{width:100%;border-collapse:collapse;font-size:.8rem}
#view-scenario th,#view-scenario td{padding:6px 10px;border-bottom:1px solid var(--border);
  text-align:left;white-space:nowrap}
#view-scenario th{color:var(--muted);font-weight:600;font-size:.72rem;text-transform:uppercase}
#view-scenario td.num,#view-scenario th.num{text-align:right;font-variant-numeric:tabular-nums}
#view-scenario .neg{color:var(--red)}
#view-scenario .pos{color:var(--accent)}
#view-scenario .sc-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
#view-scenario .sc-ovr{display:flex;gap:8px;align-items:flex-end;margin-bottom:8px;flex-wrap:wrap}
#view-scenario .sc-ovr>div:first-child{flex:1 1 190px}
#view-scenario .sc-ovr input{width:110px}
#view-scenario .sc-btn{padding:7px 14px;background:transparent;border:1px solid var(--border);
  border-radius:6px;color:var(--muted);font-size:.78rem;cursor:pointer}
#view-scenario .sc-btn:hover{border-color:var(--accent);color:var(--accent)}
#view-scenario .sc-primary{background:var(--gp-brand,#15803d);border-color:var(--gp-brand,#15803d);color:#fff;font-weight:600;font-size:.85rem;padding:9px 18px}
#view-scenario .sc-primary:hover{color:#fff;opacity:.92}
#view-scenario .sc-primary[disabled]{opacity:.6;cursor:progress}
#view-scenario .sc-status{font-size:12px;color:var(--muted)}
#view-scenario .sc-status.stale{color:var(--gp-warn,#92600a);font-weight:600}
#view-scenario .sc-status.error{color:var(--gp-neg,#b91c1c);font-weight:600}
#view-scenario .sc-empty{padding:14px 16px;border:1px dashed var(--border);border-radius:10px;font-size:13px}
#view-scenario.sc-updating #sc-answer-card,#view-scenario.sc-updating #sc-levels-card{opacity:.45;transition:opacity .1s}
#view-scenario .sc-kpi{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(132px,1fr))}
#view-scenario .sc-kpi div{background:var(--surface2);border-radius:8px;padding:12px;min-width:0}
#view-scenario .sc-kpi .k{font-size:.7rem;color:var(--muted);text-transform:uppercase}
#view-scenario .sc-kpi .v{font-size:1.1rem;font-weight:600;margin-top:4px;
  font-variant-numeric:tabular-nums;white-space:normal;overflow-wrap:normal}
#view-scenario .sc-kpi .s{font-size:.72rem;color:var(--muted);margin-top:3px;line-height:1.4}
/* Mode selector */
#view-scenario .sc-modes{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
#view-scenario .sc-mode{text-align:left;padding:12px 14px;border:1.5px solid var(--border);border-radius:10px;
  background:var(--surface2);color:var(--text);cursor:pointer;font-family:inherit}
#view-scenario .sc-mode .n{display:block;font-weight:650;font-size:.95rem}
#view-scenario .sc-mode .d{display:block;font-size:.75rem;color:var(--muted);margin-top:3px}
#view-scenario .sc-mode[aria-checked="true"]{border-color:var(--gp-brand,#15803d);
  background:var(--gp-brand-soft,rgba(21,128,61,.08));box-shadow:inset 0 0 0 1px var(--gp-brand,#15803d)}
#view-scenario .sc-sub{font-size:.72rem;font-weight:600;color:var(--muted);text-transform:uppercase;
  letter-spacing:.05em;margin:14px 0 8px}
/* Collapsible panels */
#view-scenario details.sc-panel{border:1px solid var(--border);border-radius:8px;margin-top:14px}
#view-scenario details.sc-panel>summary{cursor:pointer;padding:10px 12px;font-size:.82rem;font-weight:600;
  list-style-position:inside}
#view-scenario details.sc-panel>summary .sc-sum{display:block;font-weight:400;color:var(--muted);
  font-size:.75rem;margin-top:3px;padding-left:16px}
#view-scenario details.sc-panel>.sc-panel-body{padding:4px 12px 12px}
#view-scenario details.sc-details>summary{cursor:pointer;font-size:.9rem;font-weight:600;padding:2px 0}
#view-scenario details.sc-details[open]>summary{margin-bottom:14px}
#view-scenario .sc-section{margin-top:18px}
#view-scenario .sc-section:first-of-type{margin-top:0}
/* Main answer */
#view-scenario .sc-answer{font-size:1.45rem;font-weight:700;line-height:1.3;margin:4px 0 6px;overflow-wrap:anywhere}
#view-scenario .sc-answer.is-bad{color:var(--gp-neg,#b91c1c)}
#view-scenario .sc-answer-sub{font-size:.85rem;color:var(--text);line-height:1.55;margin-bottom:10px}
#view-scenario .sc-scope{font-size:.78rem;color:var(--muted);margin-bottom:14px;line-height:1.6}
#view-scenario .sc-badges{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px}
#view-scenario .sc-badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:.72rem;font-weight:600}
#view-scenario .sc-badge.prov{background:var(--gp-warn-soft,rgba(251,191,36,.15));color:var(--gp-warn,#92600a);border:1px solid currentColor}
#view-scenario .sc-badge.costed{background:var(--gp-info-soft,rgba(56,189,248,.12));color:var(--gp-info,#0369a1);border:1px solid currentColor}
#view-scenario .sc-badge.stale{background:var(--gp-warn,#92600a);color:#fff;display:none}
#view-scenario .is-stale .sc-badge.stale{display:inline-block}
#view-scenario .is-stale .sc-stale-dim{opacity:.55}
/* Comparison table */
#view-scenario table.sc-levels th,#view-scenario table.sc-levels td{white-space:normal;vertical-align:top}
#view-scenario table.sc-levels tbody tr{cursor:pointer}
#view-scenario table.sc-levels tbody tr:hover{background:var(--surface2)}
#view-scenario table.sc-levels tbody tr.sel{background:var(--gp-brand-soft,rgba(21,128,61,.1));
  box-shadow:inset 3px 0 0 var(--gp-brand,#15803d)}
#view-scenario table.sc-levels .lvl{font-weight:650}
#view-scenario table.sc-levels .muted{color:var(--muted);font-size:.75rem}
#view-scenario .sc-x{border:0;background:none;color:var(--muted);cursor:pointer;font-size:.9rem;padding:0 4px}
#view-scenario .sc-add-level{display:flex;gap:8px;align-items:flex-end;margin-top:10px;flex-wrap:wrap}
#view-scenario .sc-add-level input{width:110px}
/* The view sizes itself by its own width (the app shell keeps a side rail even on phones). */
#view-scenario{container-type:inline-size;container-name:scv}
@media(max-width:640px){.gp-scen-model[data-model="discount"]{padding:10px}
  #view-scenario th,#view-scenario td{padding:5px 7px;font-size:.75rem}}
@container scv (max-width:560px){
  #view-scenario .sc-card{padding:12px}
  #view-scenario .sc-modes{grid-template-columns:1fr}
  #view-scenario .sc-answer{font-size:1.15rem}
  #view-scenario .sc-kpi{grid-template-columns:1fr 1fr}
  #view-scenario .sc-kpi .v{font-size:1rem}
  /* Comparison rows become labelled blocks: no sideways scrolling. */
  #view-scenario table.sc-levels thead{display:none}
  #view-scenario table.sc-levels,#view-scenario table.sc-levels tbody{display:block}
  #view-scenario table.sc-levels tr{display:block;padding:8px 8px;border-bottom:1px solid var(--border)}
  #view-scenario table.sc-levels td{display:flex;justify-content:space-between;gap:10px;border:0;padding:2px 0;text-align:right}
  #view-scenario table.sc-levels td::before{content:attr(data-label);color:var(--muted);font-size:.72rem;text-align:left;flex:0 1 auto;font-family:var(--gp-sans,inherit);letter-spacing:0}
  #view-scenario table.sc-levels td.lvl::before{content:none}
  #view-scenario table.sc-levels td.lvl{justify-content:flex-start;text-align:left}
}
@container scv (max-width:420px){
  #view-scenario .sc-grid{grid-template-columns:1fr}
  #view-scenario .sc-kpi{grid-template-columns:1fr}
}
</style>`;

const MARKUP = `
<div class="sc-card" id="sc-controls">
  <div class="sc-modes" role="radiogroup" aria-label="Decision">
    <button type="button" class="sc-mode" id="sc-mode-max" role="radio" aria-checked="true" data-mode="max">
      <span class="n">Maximum discount</span>
      <span class="d">The largest discount that keeps your target operating margin</span></button>
    <button type="button" class="sc-mode" id="sc-mode-cost" role="radio" aria-checked="false" data-mode="cost">
      <span class="n">Cost reduction for a bigger discount</span>
      <span class="d">How much product costs must fall to keep the margin</span></button>
  </div>

  <div class="sc-grid">
    <div><label for="sc-from">Period from</label><input id="sc-from" type="date"></div>
    <div><label for="sc-to">Period to</label><input id="sc-to" type="date"></div>
    <div><label for="sc-vendor-filter">Vendors</label><select id="sc-vendor-filter"></select></div>
    <div><label for="sc-channel-filter">Channels</label><select id="sc-channel-filter"></select></div>
    <div><label for="sc-missing">Products without a cost</label><select id="sc-missing">
      <option value="include">Include (provisional)</option>
      <option value="exclude">Exclude (costed only)</option>
    </select></div>
  </div>

  <div class="sc-sub">Decision inputs</div>
  <div class="sc-grid">
    <div><label for="sc-target">Target operating margin %</label><input id="sc-target" type="number" step="0.5"></div>
    <div id="sc-proposed-wrap" hidden><label for="sc-sitewide">Proposed discount %</label>
      <input id="sc-sitewide" type="number" step="0.5" min="0" max="100"></div>
  </div>

  <div class="sc-sub" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">Discount by vendor
    <span class="sc-flag" style="text-transform:none;letter-spacing:0">Replaces the general discount</span></div>
  <div id="sc-overrides"></div>
  <button class="sc-btn" id="sc-add-override" type="button">+ Add vendor discount</button>

  <details class="sc-panel" id="sc-assump">
    <summary>Costs and assumptions<span class="sc-sum" id="sc-assump-sum"></span></summary>
    <div class="sc-panel-body">
      <div class="sc-grid">
        <div><label for="sc-ad">Advertising % of product revenue</label><input id="sc-ad" type="number" step="0.5" min="0"></div>
        <div><label for="sc-labor">Monthly labor $</label><input id="sc-labor" type="number" step="100" min="0"></div>
      </div>
      <div class="sc-note">Shipping collected and shipping expense stay at their historical actual amounts for the
        selected period; a discount does not re-price checkout shipping. ShipStation expense is deduplicated per
        shipment; House Plant Dropship shipping passes through with zero contribution.</div>
      <div class="sc-sub">Saved assumptions</div>
      <div class="sc-grid">
        <div><label for="sc-name">Name</label><input id="sc-name" type="text" placeholder="e.g. 15% target, Calathea 17%"></div>
        <div><label for="sc-saved">Saved</label><select id="sc-saved"></select></div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="sc-btn" id="sc-save" type="button">Save</button>
        <button class="sc-btn" id="sc-load" type="button">Load</button>
        <button class="sc-btn" id="sc-delete" type="button">Delete</button>
        <button class="sc-btn" id="sc-reset" type="button">Reset to defaults</button>
      </div>
      <div class="sc-note">Saved assumptions hold inputs only — no customer or order data is stored in the browser.</div>
    </div>
  </details>

  <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
    <button class="sc-btn sc-primary" id="sc-calc-max" type="button">Find maximum discount</button>
    <button class="sc-btn sc-primary" id="sc-calc-cost" type="button" hidden>Calculate required cost reduction</button>
    <span class="sc-status" id="sc-status" role="status" aria-live="polite"></span>
  </div>
</div>

<div id="sc-alerts"></div>

<div class="sc-card" id="sc-answer-card" hidden>
  <div id="sc-coverage-status"></div>
  <div class="sc-badges"><span id="sc-basis"></span><span class="sc-badge stale">Recalculate needed</span></div>
  <div class="sc-stale-dim">
    <div class="sc-answer" id="sc-answer" aria-live="polite"></div>
    <div class="sc-answer-sub" id="sc-answer-sub"></div>
    <div class="sc-scope" id="sc-scope"></div>
    <div class="sc-kpi" id="sc-support"></div>
    <div id="sc-check"></div>
  </div>
  <div class="sc-note">Uses the selected period’s quantities and sales mix. Does not predict additional sales from a discount.</div>
</div>

<div class="sc-card" id="sc-levels-card" hidden>
  <div class="sc-h">Discount comparison <span id="sc-levels-basis"></span><span class="sc-badge stale">Recalculate needed</span></div>
  <div class="sc-stale-dim"><table class="sc-levels" id="sc-levels"></table></div>
  <div class="sc-add-level">
    <div><label for="sc-level-input">Add a discount level %</label><input id="sc-level-input" type="number" step="0.5" min="0" max="100"></div>
    <button class="sc-btn" id="sc-level-add" type="button">Add level</button>
  </div>
  <div class="sc-note">Select a row to see its cost-reduction answer. Every row uses the same period, vendors,
    channels, eligibility, Discount by vendor rates and assumptions. The reduction is an aggregate target for the
    selection's product costs, not an equal cut for each SKU or vendor.</div>
</div>

<div class="sc-card" id="sc-details-card" hidden>
  <details class="sc-details" id="sc-details">
    <summary>View calculation details <span class="sc-badge stale">Recalculate needed</span></summary>
    <div class="sc-section">
      <div class="sc-h">Current actual vs scenario <span id="sc-details-at" style="color:var(--muted);font-weight:400"></span></div>
      <div class="sc-kpi" id="sc-kpis"></div>
      <div class="sc-scroll" style="margin-top:14px"><table id="sc-compare"></table></div>
      <div class="sc-note">Gross profit excludes advertising and labor. Operating profit is gross profit less
        advertising and allocated labor. Operating margin = operating profit ÷ (net product revenue + shipping collected).</div>
    </div>
    <div class="sc-section">
      <div class="sc-h">Vendor analysis</div>
      <div class="sc-scroll"><table id="sc-vendor"></table></div>
    </div>
    <div class="sc-section">
      <div class="sc-h">SKU / product analysis <span id="sc-sku-count" style="color:var(--muted);font-weight:400"></span>
        <button class="sc-btn" id="sc-export" type="button">↓ Export SKU analysis CSV</button></div>
      <div class="sc-scroll"><table id="sc-sku"></table></div>
    </div>
    <div class="sc-section">
      <div class="sc-h">Cost coverage &amp; missing costs</div>
      <div class="sc-kpi" id="sc-coverage"></div>
      <div class="sc-scroll" style="margin-top:14px"><table id="sc-missing-table"></table></div>
    </div>
    <div class="sc-section">
      <div class="sc-h">Method</div>
      <div class="sc-note" id="sc-method"></div>
    </div>
  </details>
</div>

<details class="sc-card sc-details" id="sc-single">
  <summary>Check an individual product</summary>
  <div class="sc-note" style="margin:0 0 10px">A single product's maximum allowable cost at a price, discount and
    target. It does not use historical sales or product mix.</div>
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
</details>`;

// ─── Wiring ───────────────────────────────────────────────────────────────────

const INPUT_IDS = ['sc-sitewide', 'sc-ad', 'sc-labor', 'sc-target', 'sc-from', 'sc-to',
  'sc-vendor-filter', 'sc-channel-filter', 'sc-missing'];

export function initScenarioView(container, linesGetter) {
  getLines = linesGetter;
  container.innerHTML = STYLES + MARKUP;
  results.max = results.cost = null; comparison = null; lastResult = null;
  resetToDefaults(false);

  // Inputs apply only when an action button is pressed: a date typed digit by digit passes through invalid
  // values (year 0026, from after to). Earlier results stay visible, marked "Recalculate needed".
  INPUT_IDS.forEach(id => { $(id).addEventListener('input', markStale); $(id).addEventListener('change', markStale); });
  $('sc-sitewide').addEventListener('input', renderLevels);
  ['sc-ad', 'sc-labor', 'sc-from', 'sc-to'].forEach(id => $(id).addEventListener('input', renderAssumptionSummary));
  $('sc-mode-max').addEventListener('click', () => setMode('max'));
  $('sc-mode-cost').addEventListener('click', () => setMode('cost'));
  $('sc-calc-max').addEventListener('click', () => calculateScenario('max'));
  $('sc-calc-cost').addEventListener('click', () => calculateScenario('cost'));
  $('sc-add-override').addEventListener('click', () => { addOverrideRow(); markStale(); });
  $('sc-reset').addEventListener('click', () => { resetToDefaults(true); markStale(); });
  $('sc-save').addEventListener('click', saveScenario);
  $('sc-load').addEventListener('click', loadScenario);
  $('sc-delete').addEventListener('click', deleteScenario);
  $('sc-export').addEventListener('click', exportSkuCsv);
  $('sc-level-add').addEventListener('click', addLevel);
  $('sc-level-input').addEventListener('keydown', e => { if (e.key === 'Enter') addLevel(); });

  ['sp-price', 'sp-cost', 'sp-disc', 'sp-ad', 'sp-shipcol', 'sp-shipexp', 'sp-labor',
   'sp-target', 'sp-vendor', 'sp-sku'].forEach(id =>
    $(id).addEventListener('input', renderStandalone));

  refreshSavedList();
  renderStandalone();
  renderAssumptionSummary();
  calcLines = null;
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
  customLevels = [];
  renderOverrides();
  renderAssumptionSummary();
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
  renderAssumptionSummary();
}

// ─── Mode ─────────────────────────────────────────────────────────────────────

function setMode(m) {
  mode = m;
  $('sc-mode-max').setAttribute('aria-checked', String(m === 'max'));
  $('sc-mode-cost').setAttribute('aria-checked', String(m === 'cost'));
  $('sc-proposed-wrap').hidden = m !== 'cost';
  $('sc-calc-max').hidden = m !== 'max';
  $('sc-calc-cost').hidden = m !== 'cost';
  renderAnswer();
  renderLevels();
  const r = results[m];
  $('sc-details-card').hidden = !r;
  if (r) { renderDetails(r.res.summary, r.res.discount, r.scope); lastResult = r.res.summary; }
  refreshStale();
}

// ─── Vendor discounts ─────────────────────────────────────────────────────────

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
      <div><label>Vendor</label><select data-i="${i}" class="sc-ovr-v" aria-label="Vendor">
        ${vendors.map(v => {
          const taken = overrideRows.some((o, j) => j !== i && o.vendor === v);
          return `<option value="${esc(v)}" ${v === r.vendor ? 'selected' : ''} ${taken ? 'disabled' : ''}>${esc(v)}${taken ? ' (already used)' : ''}</option>`;
        }).join('')}
      </select></div>
      <div><label>Discount %</label><input type="number" step="0.5" min="0" max="100"
        class="sc-ovr-r" data-i="${i}" value="${r.rate}" aria-label="Vendor discount %"></div>
      <button class="sc-btn sc-ovr-x" data-i="${i}" type="button">Remove</button>
    </div>`).join('') ||
    '<div class="sc-note" style="margin:0 0 8px">None. Every eligible product takes the general discount.</div>';

  wrap.querySelectorAll('.sc-ovr-v').forEach(el => el.addEventListener('change', e => {
    overrideRows[+e.target.dataset.i].vendor = e.target.value;
    renderOverrides(); markStale();
  }));
  wrap.querySelectorAll('.sc-ovr-r').forEach(el => el.addEventListener('input', e => {
    overrideRows[+e.target.dataset.i].rate = parseFloat(e.target.value) || 0;
    markStale();
  }));
  wrap.querySelectorAll('.sc-ovr-x').forEach(el => el.addEventListener('click', e => {
    overrideRows.splice(+e.target.dataset.i, 1);
    renderOverrides(); markStale();
  }));
}

// ─── Assumptions ──────────────────────────────────────────────────────────────

function readAssumptions() {
  const vendorDiscounts = {};
  for (const r of overrideRows) if (r.vendor) vendorDiscounts[r.vendor] = (r.rate || 0) / 100;
  return {
    name:             $('sc-name').value || SCENARIO_DEFAULTS.name,
    sitewideDiscount: Math.min(Math.max((parseFloat($('sc-sitewide').value) || 0) / 100, 0), 1),
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

function renderAssumptionSummary() {
  const el = $('sc-assump-sum');
  if (!el) return;
  const ad = parseFloat($('sc-ad').value) || 0, labor = parseFloat($('sc-labor').value) || 0;
  el.textContent = `Advertising ${ad.toLocaleString('en-US', { maximumFractionDigits: 2 })}% of product revenue · `
    + `Labor ${money(labor)}/month, prorated to the period · Shipping at historical actuals`;
}

// ─── Render entry points ──────────────────────────────────────────────────────

/** The "Current actual" column exactly as the Discount & operating margin view computes it now (its filters included). */
export function scenarioCurrentActual() {
  const all = getLines ? getLines() : null;
  if (!all || !all.length) return null;
  let a;
  try { a = readAssumptions(); } catch { a = { ...SCENARIO_DEFAULTS }; }
  const prep = prepareDecision(all, a);
  const d = all.map(l => l.date).filter(Boolean).sort();
  const narrower = (a.dateFrom && d.length && a.dateFrom > d[0]) || (a.dateTo && d.length && a.dateTo < d[d.length - 1]);
  const filtered = !!(a.vendorFilter || a.channelFilter || narrower || a.excludeMissing);
  return { current: summarizeScenario(prep.lines, prep.assumptions).current, filtered };
}

/**
 * Shown when the view opens: calculates only for new data (a new report or upload); otherwise keeps the last
 * results, so edited inputs are applied only by the action buttons.
 */
export function renderScenarioView() {
  const all = getLines();
  if (!all || !all.length) return;
  if (calcLines === all && (results.max || results.cost)) return;
  calculateScenario(mode);
}

let calcLines = null;
function setStatus(text, cls = '') { const el = $('sc-status'); if (el) { el.textContent = text; el.className = `sc-status ${cls}`.trim(); } }
/**
 * The inputs a result depends on. The maximum discount does not depend on the proposed discount, and the
 * comparison rows do not either (each row is its own discount), so editing it leaves those results current.
 */
function inputKey(m) {
  const a = readAssumptions();
  delete a.name;
  if (m !== 'cost') delete a.sitewideDiscount;
  return JSON.stringify(a);
}
const isStale = (r, m) => !!r && r.key !== inputKey(m);
function markStale() { refreshStale(); }
function refreshStale() {
  const r = results[mode];
  const answerStale = isStale(r, mode), levelsStale = isStale(comparison, 'levels');
  $('sc-answer-card')?.classList.toggle('is-stale', answerStale);
  $('sc-details-card')?.classList.toggle('is-stale', answerStale);
  $('sc-levels-card')?.classList.toggle('is-stale', levelsStale);
  if (answerStale || levelsStale) setStatus('Inputs changed — Recalculate needed.', 'stale');
  else if (r) setStatus(r.statusText);
  else setStatus('');
}

function clearResults(message) {
  results.max = results.cost = null; comparison = null; lastResult = null;
  for (const id of ['sc-answer-card', 'sc-levels-card', 'sc-details-card']) { const el = $(id); if (el) el.hidden = true; }
  for (const id of ['sc-kpis', 'sc-compare', 'sc-vendor', 'sc-sku', 'sc-sku-count', 'sc-coverage', 'sc-missing-table', 'sc-method']) {
    const el = $(id); if (el) el.innerHTML = '';
  }
  $('sc-alerts').innerHTML = message ? `<div class="sc-empty" role="status">${esc(message)}</div>` : '';
}

const DATE_OK = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= '2000-01-01' && d <= '2100-12-31' && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const fmtDay = d => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

const BUTTON_LABEL = { max: 'Find maximum discount', cost: 'Calculate required cost reduction' };

/** Run one decision with the current inputs: visible updating state, validation, a clear message when nothing matches. */
export function calculateScenario(which = mode) {
  const all = getLines();
  if (!all || !all.length) return;
  if (which !== mode) setMode(which);
  const btn = $(which === 'max' ? 'sc-calc-max' : 'sc-calc-cost');
  const view = btn?.closest('#view-scenario') || document.getElementById('view-scenario');
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  view?.classList.add('sc-updating');
  setStatus('Updating…');
  // Let the browser paint the updating state before the work.
  setTimeout(() => {
    try { applyDecision(all, which); }
    catch (e) { clearResults('The scenario could not be calculated. Check the inputs and try again.'); setStatus('Calculation failed.', 'error'); console.error(e); }
    finally {
      if (btn) { btn.disabled = false; btn.textContent = BUTTON_LABEL[which]; }
      view?.classList.remove('sc-updating');
    }
  }, 30);
}

/** Default levels, custom levels, the proposed discount and (in maximum-discount mode) the solved maximum. */
function comparisonLevels(a, maxDiscount = null) {
  return [...DEFAULT_COMPARISON_LEVELS, ...customLevels, a.sitewideDiscount, ...(maxDiscount === null ? [] : [maxDiscount])];
}

function applyDecision(all, which) {
  populateFilters(all);
  calcLines = all;
  const a = readAssumptions();
  if ((a.dateFrom && !DATE_OK(a.dateFrom)) || (a.dateTo && !DATE_OK(a.dateTo))) {
    clearResults('Enter complete dates (year 2000 or later) before calculating.'); setStatus('Dates are incomplete.', 'error'); return;
  }
  if (a.dateFrom && a.dateTo && a.dateFrom > a.dateTo) {
    clearResults(`The start date (${fmtDay(a.dateFrom)}) is after the end date (${fmtDay(a.dateTo)}).`); setStatus('Dates are reversed.', 'error'); return;
  }
  // One preparation for the answer, the comparison and the details: selected lines, the selection's frozen
  // labor share, the excluded-cost coverage and which orders' shipping was divided by revenue share.
  const prep = prepareDecision(all, a);
  const lines = prep.lines, aa = prep.assumptions;
  if (!lines.some(l => !l.isRoute)) {
    const range = a.dateFrom && a.dateTo ? ` from ${fmtDay(a.dateFrom)} to ${fmtDay(a.dateTo)}` : '';
    clearResults(`No orders match these filters${range}${a.vendorFilter ? `, vendor ${a.vendorFilter}` : ''}${a.channelFilter ? `, channel ${a.channelFilter}` : ''}${a.excludeMissing ? ', products with a cost' : ''}. Previous results were cleared.`);
    setStatus('No orders match.', 'error');
    return;
  }
  $('sc-alerts').innerHTML = '';
  const res = which === 'max' ? findMaximumDiscount(lines, aa) : calculateCostReduction(lines, aa);
  const orders = new Set(lines.filter(l => !l.isRoute).map(l => l.orderNum)).size;
  const scope = {
    a, orders,
    units: lines.reduce((s, l) => s + (l.isRoute ? 0 : (l.qty || 0)), 0),
    excluded: prep.excluded, labor: prep.labor, shippingSplit: prep.shippingSplit,
  };
  const statusText = `Calculated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${orders.toLocaleString()} order${orders === 1 ? '' : 's'}${a.dateFrom && a.dateTo ? ` · ${fmtDay(a.dateFrom)} – ${fmtDay(a.dateTo)}` : ''}`;
  results[which] = { res, scope, key: inputKey(which), statusText };
  comparison = { rows: compareDiscountLevels(lines, aa, comparisonLevels(a, which === 'max' && typeof res.discount === 'number' ? res.discount : null)), key: inputKey('levels'), lines, a: aa, scope };
  lastResult = res.summary;

  $('sc-answer-card').hidden = false;
  $('sc-levels-card').hidden = false;
  $('sc-details-card').hidden = false;
  renderAnswer();
  renderLevels();
  renderDetails(res.summary, which === 'max' ? res.discount : a.sitewideDiscount, scope);
  refreshStale();
}

// ─── Main answer ──────────────────────────────────────────────────────────────

function scopeText(scope, res) {
  const a = scope.a;
  const period = a.dateFrom && a.dateTo ? `${fmtDay(a.dateFrom)} – ${fmtDay(a.dateTo)}` : 'All dates';
  const parts = [period, a.vendorFilter || 'All vendors', a.channelFilter || 'All channels',
    `${scope.orders.toLocaleString()} order${scope.orders === 1 ? '' : 's'}`,
    `${scope.units.toLocaleString()} unit${scope.units === 1 ? '' : 's'}`,
    `${money(res.summary.scenario.baseMerchRevenue)} product revenue before discounts`];
  return parts.map(esc).join(' · ');
}

function vendorText(vd) {
  const e = Object.entries(vd || {});
  return e.length ? e.map(([v, r]) => `${esc(v)} ${dpct(r)}`).join(', ') : '';
}

function coverageStatusHtml(res, scope) {
  if (scope.excluded) {
    const x = scope.excluded;
    if (!x.skus) return '<div class="sc-ok">Cost coverage: every sold product in this selection has a cost.</div>';
    return `<div class="sc-info"><strong>Costed products only.</strong> Excluded: ${x.skus} of ${x.totalSkus} SKUs,
      ${x.units.toLocaleString()} of ${x.totalUnits.toLocaleString()} units and ${money(x.revenue)} of
      ${money(x.totalRevenue)} product revenue (${pct(x.revenuePct)}) have no cost. Their orders’ other lines stay in with
      their revenue share of the order’s shipping, and labor is allocated to the costed products only.</div>`;
  }
  if (!res.provisional) return '<div class="sc-ok">Cost coverage: every sold product in this selection has a cost.</div>';
  const c = res.coverage;
  const miss = res.summary.scenario.missingCostLines;
  return `<div class="sc-warn"><strong>Provisional: missing product costs.</strong>
    ${c.soldSkus - c.matchedSkus} of ${c.soldSkus} SKUs (${(c.units - c.matchedUnits).toLocaleString()} of
    ${c.units.toLocaleString()} units, ${money(c.revenue - c.matchedRevenue)} of ${money(c.revenue)} product revenue;
    ${miss} line${miss === 1 ? '' : 's'}) have no cost. Their revenue is included with no cost deducted, so margins
    are overstated${mode === 'max' ? ' and the maximum discount is too high' : ' and the reduction needed is understated'}.
    Choose <em>Exclude</em> under “Products without a cost” to answer for costed products only.</div>`;
}

function basisBadge(res, scope) {
  const out = [];
  if (scope.excluded) out.push('<span class="sc-badge costed">Costed products only</span>');
  else if (res.provisional) out.push('<span class="sc-badge prov">Provisional: missing product costs</span>');
  if (scope.labor && scope.labor.filtered) out.push('<span class="sc-badge costed">Allocated labor</span>');
  return out.join(' ');
}

/** A margin just under the target, shown with enough decimals not to read as the target itself. */
function belowTarget(ratio, target) {
  if (ratio === null || ratio === undefined) return '—';
  const one = (ratio * 100).toFixed(1);
  return `${one === (target * 100).toFixed(1) ? (Math.floor(ratio * 10000) / 100).toFixed(2) : one}%`.replace('-', '−');
}

const kpi = (k, v, s = '', bad = false) =>
  `<div><div class="k">${k}</div><div class="v${bad ? ' neg' : ''}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;

/** Share of the period's labor carried by the selection (1 when nothing is filtered). */
const laborShareOf = summary => (summary.labor.share === undefined || summary.labor.share === null ? 1 : summary.labor.share);
const periodLaborOf = summary => (summary.labor.periodLabor ?? summary.labor.allocated);
function laborLine(summary) {
  return `Allocated labor: ${money(summary.scenario.labor)}, representing ${pct(laborShareOf(summary) * 100)} of the period’s labor.`;
}

function laborKpi(summary) {
  const l = summary.labor;
  const share = laborShareOf(summary);
  const note = share < 1
    ? `${pct(share * 100)} of the period’s ${money(periodLaborOf(summary))}, by historical net product revenue`
    : (l.method === 'whole_calendar_months' ? `100% of the period’s labor · ${l.months} whole month${l.months === 1 ? '' : 's'}`
      : l.days ? `100% of the period’s labor · ${l.days} days ÷ 30.4375 × monthly` : '100% of the period’s labor');
  return kpi('Allocated labor', money(summary.scenario.labor), note);
}

function shippingKpi(summary, scope) {
  const s = summary.scenario, split = scope.shippingSplit;
  if (split && split.orders) {
    return kpi('Allocated shipping', money(s.shipExpense),
      `Expense; collected ${money(s.shipCollected)}. ${split.orders} mixed order${split.orders === 1 ? '' : 's'} divided by product revenue share — not a verified vendor shipping cost`);
  }
  return kpi('Shipping expense', money(s.shipExpense), `Historical actual; collected ${money(s.shipCollected)}`);
}

function renderAnswer() {
  const r = results[mode];
  const card = $('sc-answer-card');
  if (!card) return;
  if (!r) {
    if (results.max || results.cost) {
      card.hidden = false;
      $('sc-coverage-status').innerHTML = ''; $('sc-basis').innerHTML = '';
      $('sc-answer').className = 'sc-answer'; $('sc-answer').textContent = '';
      $('sc-answer-sub').innerHTML = `Press <strong>${BUTTON_LABEL[mode]}</strong> to answer this question with the current inputs.`;
      $('sc-scope').innerHTML = ''; $('sc-support').innerHTML = ''; $('sc-check').innerHTML = '';
    }
    return;
  }
  card.hidden = false;
  const { res, scope } = r;
  const a = scope.a;
  $('sc-coverage-status').innerHTML = coverageStatusHtml(res, scope);
  $('sc-basis').innerHTML = basisBadge(res, scope);
  const filteredNote = laborShareOf(res.summary) < 1 || (scope.shippingSplit && scope.shippingSplit.orders)
    ? `<br><strong>${esc(laborLine(res.summary))}</strong> Filtered results use allocated labor${scope.shippingSplit && scope.shippingSplit.orders ? ' and allocated shipping' : ''};
       they do not predict payroll savings from removing a vendor.`
    : `<br>${esc(laborLine(res.summary))}`;
  $('sc-scope').innerHTML = scopeText(scope, res) + filteredNote;
  const s = res.summary.scenario;
  const ans = $('sc-answer'), sub = $('sc-answer-sub');
  ans.className = 'sc-answer';
  const target = pct(res.targetMargin * 100);
  const vd = vendorText(res.vendorDiscounts);
  let check = '';

  if (mode === 'max') {
    const fixed = vd ? ` Discount by vendor stays fixed: ${vd}.` : '';
    if (res.status === 'ok' || res.status === 'upper_bound') {
      ans.textContent = `You can offer up to ${dpct(res.discount)} discount.`;
      sub.innerHTML = `General discount on eligible products, keeping a ${target} operating margin.${fixed}
        ${res.status === 'upper_bound' ? ' This is the upper bound of the discount input: the target still holds at 100%.'
          : ` At ${dpct(res.next.discount)} the margin falls to ${belowTarget(res.verification.nextMargin, res.targetMargin)}.`}
        Rounded down to the nearest ${dpct(DISCOUNT_STEP)}.`;
      $('sc-support').innerHTML = [
        kpi('Operating profit', money(s.operatingProfit), `At ${dpct(res.discount)} discount`, s.operatingProfit < 0),
        kpi('Operating margin', pct(s.operatingMargin), `Target ${target}`),
        kpi('Net product revenue', money(s.scenarioRevenue), `Discounts ${money(s.scenarioDiscount)}`),
        kpi('Advertising', money(s.adExpense), `${pct(res.summary.assumptions.adRate * 100)} of product revenue`),
        shippingKpi(res.summary, scope),
        laborKpi(res.summary),
      ].join('');
      if (res.verification && !res.verification.ok) {
        check = '<div class="sc-warn sc-bad">The check of this answer failed: recalculating at this discount and the next increment did not confirm it. Do not rely on this result.</div>';
      }
    } else {
      ans.classList.add('is-bad');
      if (res.status === 'target_not_met_at_zero') {
        ans.textContent = `The ${target} target can’t be met, even with no general discount.`;
        sub.innerHTML = `With 0% general discount the operating margin is ${pct(res.marginAtZero)}.${vd ? ` Discount by vendor still applies: ${vd}.` : ''}
          To find what it would take, switch to <em>Cost reduction for a bigger discount</em>.`;
      } else if (res.status === 'no_general_scope') {
        ans.textContent = 'No products in this selection take the general discount.';
        sub.innerHTML = `Every eligible product has a Discount by vendor${vd ? ` (${vd})` : ''}, or none is eligible.
          Operating margin with these discounts: ${pct(res.marginAtZero)}${res.meetsAtCurrent ? ', which meets' : ', which misses'} the ${target} target.`;
      } else {
        ans.textContent = 'This selection has no revenue to calculate a margin.';
        sub.innerHTML = '';
      }
      $('sc-support').innerHTML = [
        kpi('Operating profit', money(s.operatingProfit), 'At 0% general discount', s.operatingProfit < 0),
        kpi('Operating margin', pct(s.operatingMargin), `Target ${target}`),
        kpi('Advertising', money(s.adExpense)),
        shippingKpi(res.summary, scope),
        laborKpi(res.summary),
      ].join('');
    }
  } else {
    const at = `a ${dpct(res.discount)} discount`;
    const fixed = (vd ? ` Discount by vendor replaces it for ${vd}.` : '')
      + (res.generalScope && res.generalScope.lines === 0
        ? ' No product in this selection takes the general discount, so the proposed discount changes nothing here.' : '');
    if (res.status === 'reduction_needed') {
      ans.textContent = `Product costs must fall by ${pct(res.reductionPct)} (${money(res.reductionDollars)}).`;
      sub.innerHTML = `To keep a ${target} operating margin with ${at}.${fixed} This is an aggregate target for the
        selection’s product costs, not an equal cut for every SKU or vendor; it does not show whether vendors can supply it.`;
    } else if (res.status === 'none_needed') {
      ans.textContent = 'No cost reduction needed.';
      sub.innerHTML = `With ${at} the operating margin is ${pct(res.marginWithoutReduction)}, at or above the ${target} target.${fixed}`;
    } else if (res.status === 'cost_alone_insufficient') {
      ans.classList.add('is-bad');
      ans.textContent = 'Product-cost reduction alone cannot achieve this target.';
      sub.innerHTML = `Even with $0 product costs, ${at} gives an operating margin of ${pct(res.marginAtZeroCogs)}, below the ${target} target.${fixed}`;
    } else {
      ans.classList.add('is-bad');
      ans.textContent = 'This selection has no revenue to calculate a margin.';
      sub.innerHTML = '';
    }
    $('sc-support').innerHTML = [
      kpi('Current product COGS', money(res.currentCogs)),
      kpi('Maximum affordable COGS', res.maxCogs < 0 ? 'Below $0' : money(res.maxCogs), `For a ${target} margin`, res.maxCogs < 0),
      kpi('Operating margin without cost reduction', pct(res.marginWithoutReduction), `Operating profit ${money(res.operatingProfitWithoutReduction)}`, res.operatingProfitWithoutReduction < 0),
      kpi('Advertising', money(s.adExpense), `${pct(res.summary.assumptions.adRate * 100)} of product revenue`),
      shippingKpi(res.summary, scope),
      laborKpi(res.summary),
    ].join('');
    if (res.verification && !res.verification.ok) {
      check = '<div class="sc-warn sc-bad">The check of this answer failed: recalculating with the maximum affordable cost did not reach the target. Do not rely on this result.</div>';
    }
  }
  if (!res.summary.reconciliation.ok) {
    const bad = res.summary.reconciliation.checks.filter(c => !c.ok).map(c => `${esc(c.label)} (off by ${money(c.diff)})`).join('; ');
    check += `<div class="sc-warn sc-bad">Reconciliation failed: ${bad}</div>`;
  }
  $('sc-check').innerHTML = check;
}

// ─── Comparison table ─────────────────────────────────────────────────────────

function selectedLevel() {
  return Math.round(Math.min(Math.max((parseFloat($('sc-sitewide').value) || 0) / 100, 0), 1) * 10000) / 10000;
}

function renderLevels() {
  const table = $('sc-levels');
  if (!table || !comparison) return;
  const maxD = results.max && typeof results.max.res.discount === 'number' ? results.max.res.discount : null;
  const sel = mode === 'cost' ? selectedLevel() : maxD;
  const selLabel = mode === 'cost' ? 'selected' : 'maximum';
  const res = results.max || results.cost;
  $('sc-levels-basis').innerHTML = res ? basisBadge(res.res, comparison.scope) : '';
  const custom = new Set(customLevels.map(d => Math.round(d * 10000) / 10000));
  const target = pct(comparison.a.targetMargin * 100);
  const body = comparison.rows.map(r => {
    const need = r.status === 'none_needed' ? 'None needed'
      : r.status === 'cost_alone_insufficient' ? 'Cannot achieve through product costs alone'
      : r.status === 'reduction_needed' ? `${money(r.reductionDollars)} <span class="muted">(${pct(r.reductionPct)})</span>` : '—';
    const isSel = sel !== null && Math.abs(r.discount - sel) < 1e-9;
    return `<tr data-d="${r.discount}" class="${isSel ? 'sel' : ''}" tabindex="0" aria-selected="${isSel}">
      <td class="lvl">${dpct(r.discount)}${isSel ? ` <span class="muted">${selLabel}</span>` : ''}${custom.has(r.discount)
        ? ` <button class="sc-x" data-rm="${r.discount}" type="button" aria-label="Remove ${dpct(r.discount)}">×</button>` : ''}</td>
      <td class="num" data-label="Margin at current costs"${neg(r.operatingMargin)}>${pct(r.operatingMargin)}</td>
      <td class="num" data-label="Cost reduction needed">${need}</td></tr>`;
  }).join('');
  table.innerHTML = `<thead><tr><th>Discount offered</th><th class="num">Operating margin at current costs</th>
    <th class="num">Product-cost reduction needed for ${target}</th></tr></thead><tbody>${body}</tbody>`;
  table.querySelectorAll('tbody tr').forEach(tr => {
    const pick = e => {
      if (e.target.closest('.sc-x')) return;
      selectComparisonRow(Number(tr.dataset.d));
    };
    tr.addEventListener('click', pick);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); } });
  });
  table.querySelectorAll('.sc-x').forEach(b => b.addEventListener('click', () => {
    const d = Number(b.dataset.rm);
    customLevels = customLevels.filter(x => Math.abs(x - d) > 1e-9);
    const keepAlso = [selectedLevel(), ...(results.max && typeof results.max.res.discount === 'number' ? [results.max.res.discount] : []),
      ...DEFAULT_COMPARISON_LEVELS];
    comparison.rows = comparison.rows.filter(r => Math.abs(r.discount - d) > 1e-9 || keepAlso.some(x => Math.abs(x - d) < 1e-9));
    renderLevels();
  }));
}

/** A comparison row: select that discount and show its cost-reduction answer. */
function selectComparisonRow(d) {
  $('sc-sitewide').value = Math.round(d * 1000) / 10;
  markStale();
  calculateScenario('cost');
}

function addLevel() {
  const v = parseFloat($('sc-level-input').value);
  if (!isFinite(v) || v < 0 || v > 100) return;
  const d = Math.round(v * 100) / 10000;
  if (!customLevels.some(x => Math.abs(x - d) < 1e-9)) customLevels.push(d);
  $('sc-level-input').value = '';
  // With current results, the new row is calculated with exactly the same lines and assumptions as the others;
  // with stale results it waits for the next calculation (the table is already marked "Recalculate needed").
  if (comparison && !comparison.rows.some(r => Math.abs(r.discount - d) < 1e-9)) {
    if (!isStale(comparison, 'levels')) {
      comparison.rows = [...comparison.rows, ...compareDiscountLevels(comparison.lines, comparison.a, [d])]
        .sort((x, y) => x.discount - y.discount);
    }
    renderLevels();
  }
}

// ─── Calculation details ──────────────────────────────────────────────────────

function renderDetails(summary, discount, scope = {}) {
  $('sc-details-at').textContent = discount === null || discount === undefined
    ? '(at 0% general discount)' : `(at ${dpct(discount)} general discount)`;
  renderKpis(summary);
  renderCompare(summary, scope);
  renderVendorTable(summary);
  renderSkuTable(summary);
  renderCoverage(summary);
  renderMethod(summary, scope);
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

// Expense lines: a decrease is favourable, so their change is never red for being negative (the minus sign
// stays); an increase is the unfavourable direction and is shown in red.
const EXPENSE_KEYS = new Set(['scenarioDiscount', 'cogs', 'shipExpense', 'adExpense', 'labor']);
function renderCompare(res, scope = {}) {
  const shipSplit = !!(scope.shippingSplit && scope.shippingSplit.orders);
  const laborAllocated = laborShareOf(res) < 1;
  const labelOf = (label, key) => (shipSplit && (key === 'shipCollected' || key === 'shipExpense'))
    ? `${label} (allocated)` : (laborAllocated && key === 'labor' ? 'Allocated labor' : label);
  const rows = COMPARE_ROWS.map(([label0, key]) => {
    const label = labelOf(label0, key);
    const cur = res.current[key], sc = res.scenario[key], ch = sc - cur;
    const chCell = EXPENSE_KEYS.has(key)
      ? `<td class="num" data-sign="neutral"${ch > 0.005 ? ' style="color:var(--gp-neg)"' : ''}>${money(ch)}</td>`
      : `<td class="num"${neg(ch)}>${money(ch)}</td>`;
    return `<tr><td>${label}</td><td class="num"${neg(cur)}>${money(cur)}</td>
      <td class="num"${neg(sc)}>${money(sc)}</td>${chCell}</tr>`;
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

function renderVendorTable(res) {
  const head = ['Vendor', 'Units', 'Scenario revenue', 'Current COGS', 'Allocated shipping',
                'Ad cost', 'Allocated labor', 'Operating profit', 'Operating margin',
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

function renderMethod(res, scope = {}) {
  const l = res.labor;
  const overrides = Object.entries(res.assumptions.vendorDiscounts || {})
    .map(([v, r]) => `${esc(v)} ${(r * 100).toFixed(1)}%`).join(', ') || 'none';
  $('sc-method').innerHTML = `
    • <strong>Maximum discount</strong>: the largest general discount, in ${dpct(DISCOUNT_STEP)} steps, whose
      operating margin still meets the target. Each candidate is recalculated through the full scenario; the answer is
      confirmed by recalculating it and the next step (which must miss, unless 100% is reached). Discount by vendor
      rates stay fixed.<br>
    • <strong>Cost reduction</strong>: maximum affordable product COGS = net product revenue + shipping collected −
      shipping expense − advertising − labor − target × (net product revenue + shipping collected), at the proposed
      discount. Confirmed by recalculating with every known cost scaled to that total. It is an aggregate requirement,
      not a per-SKU or per-vendor purchasing target.<br>
    • Results use the products and quantities sold in the selected period; a discount is not assumed to change
      volume or mix.<br>
    • Scenario revenue = Lineitem price × quantity × (1 − effective discount). The scenario discount
      <strong>replaces</strong> the historical discount; it is never applied on top of it. Gift cards, Route,
      influencer samples and zero-revenue lines are not discounted.<br>
    • Discount by vendor replaces the general discount for that vendor. Discounts do not stack.
      General ${(res.assumptions.sitewideDiscount * 100).toFixed(1)}%; by vendor: ${overrides}.<br>
    • Shipping collected and shipping expense remain at their historical actual amounts. ShipStation expense is
      deduplicated per shipment and summed per order; House Plant Dropship shipping is passed through with zero
      contribution.<br>
    • <strong>Allocated shipping</strong>: an order's shipping is recorded once per order. ${scope.shippingSplit && scope.shippingSplit.orders
        ? `In this selection, ${scope.shippingSplit.orders} order${scope.shippingSplit.orders === 1 ? '' : 's'} also had
          lines outside it (another vendor, or a product without a cost); their shipping was divided by each line's share
          of the order's base merchandise revenue (${money(scope.shippingSplit.collected)} collected and
          ${money(scope.shippingSplit.expense)} expense kept here).`
        : 'No order in this selection was divided.'}
      Vendor and SKU rows divide each order's shipping by scenario product revenue. These are allocations, not
      verified vendor-specific shipping costs.<br>
    • Advertising = scenario net product revenue × ${(res.assumptions.adRate * 100).toFixed(1)}%, so it falls with
      a discount; it is charged on product revenue only — never on taxes or shipping collected.<br>
    • <strong>Allocated labor</strong>: ${money(l.monthlyLabor)}/month → ${money(periodLaborOf(res))} for the period
      (${l.method === 'whole_calendar_months' ? `${l.months} whole calendar month(s)`
        : l.days ? `${l.days} inclusive days ÷ 30.4375` : 'single month assumed'}), carried in full by all vendors and
      channels together. ${laborShareOf(res) < 1 && l.basis
        ? `This selection's share is its historical net product revenue, ${money(l.basis.selectionRevenue)}, over the
          period's ${money(l.basis.periodRevenue)} across all vendors and channels (before filters and before
          excluding products without a cost) = ${pct(laborShareOf(res) * 100)} → ${money(res.scenario.labor)}.`
        : 'This selection is the whole period, so it carries 100%.'}
      The share uses historical revenue, so it is the same at every discount level. It is an allocation: it does not
      predict payroll savings from removing a vendor.<br>
    ${l.unallocated ? `• ${money(l.unallocated)} of labor for this period is not allocated: the filters leave no product lines to carry it.<br>` : ''}
    • Within the selection, labor is allocated to vendors and SKUs by historical net product revenue, order shipping
      by scenario product revenue; advertising is computed from each line's own scenario revenue.<br>
    • Cancelled orders are excluded. Order-level refunds are prorated across eligible product lines by
      actual net product-revenue share.<br>
    • Missing costs are never treated as a known cost. ${res.incomplete
        ? '<strong>This selection has products without a cost: their revenue is included with no cost deducted, so every answer is provisional.</strong>'
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
    : '<option value="">No saved assumptions</option>';
}
function saveScenario() {
  const a = readAssumptions();
  const items = lsRead().filter(s => s.name !== a.name);
  items.push({
    name: a.name, savedAt: new Date().toLocaleDateString(), mode,
    sitewideDiscount: a.sitewideDiscount, vendorDiscounts: a.vendorDiscounts,
    adRate: a.adRate, monthlyLabor: a.monthlyLabor, targetMargin: a.targetMargin,
    vendorFilter: a.vendorFilter, channelFilter: a.channelFilter,
    dateFrom: a.dateFrom, dateTo: a.dateTo, excludeMissing: a.excludeMissing,
    customLevels,
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
  customLevels = Array.isArray(s.customLevels) ? s.customLevels.filter(d => isFinite(d)) : [];
  renderOverrides();
  populateFilters(getLines() || []);
  if (s.vendorFilter) $('sc-vendor-filter').value = s.vendorFilter;
  if (s.channelFilter) $('sc-channel-filter').value = s.channelFilter;
  renderAssumptionSummary();
  markStale();
  calculateScenario(s.mode === 'cost' ? 'cost' : 'max');
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
