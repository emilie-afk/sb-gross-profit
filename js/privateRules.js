/**
 * Browser loader for the private business rules (see shared/privateRules.js).
 * data/private-rules.json is written by build.py and served only behind the site gate.
 * On failure the dashboard still opens; any calculation that needs the rules then stops
 * with a clear message instead of using different numbers.
 */
import { setPrivateRules, hasPrivateRules, privateRules } from '../shared/privateRules.js';

let loadError = null;

export async function loadPrivateRules(fetchImpl = fetch) {
  if (hasPrivateRules()) return true;
  try {
    const r = await fetchImpl('data/private-rules.json', { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    setPrivateRules(await r.json());
    return true;
  } catch (e) {
    loadError = e;
    return false;
  }
}

export function privateRulesError() {
  return loadError ? 'Cost rules could not be loaded, so calculations are unavailable. Reload the page or ask an admin to check the deployment.' : null;
}

/** Fills the scenario screen's per-plant discount inputs with the configured defaults. */
export function applyScenarioDiscountDefaults(doc = document) {
  if (!hasPrivateRules()) return;
  for (const [n, value] of privateRules().scenarioDiscountDefaults) {
    const el = doc.getElementById(`vd-disc-${n}`);
    if (el && el.value === '') el.value = String(value);
  }
}

/** Inputs whose starting values are private (`scenarioInputDefaults` in the rules: input id → number). */
export const SCENARIO_INPUT_IDS = Object.freeze([
  'sc-cost-reduce', 'sc-cur-thresh', 'sc-new-thresh',
  'aps-disc-2', 'aps-disc-3', 'aps-disc-4', 'aps-pct-2', 'aps-pct-3', 'aps-pct-4',
  'fs-cur-thresh', 'fs-new-thresh',
]);
// Inputs that start from another input's private value when the rules give none of their own.
const SAME_AS = Object.freeze({ 'fs-cur-thresh': 'sc-cur-thresh', 'fs-new-thresh': 'sc-new-thresh' });

/** Fills the scenario inputs above with their private starting values (only empty inputs). */
export function applyScenarioInputDefaults(doc = document) {
  if (!hasPrivateRules()) return;
  const d = privateRules().scenarioInputDefaults;
  if (!d || typeof d !== 'object') return;
  for (const id of SCENARIO_INPUT_IDS) {
    const el = doc.getElementById(id);
    const v = Number.isFinite(d[id]) ? d[id] : d[SAME_AS[id]];
    if (el && el.value === '' && Number.isFinite(v)) el.value = String(v);
  }
}

/** Lists the vendor codes and their full names (the private legend) in the dashboard footer. */
export function renderVendorLegend(doc = document) {
  const el = doc.getElementById('vendor-legend');
  if (!el || !hasPrivateRules()) return;
  const legend = privateRules().vendorLegend || {};
  const entries = Object.entries(legend).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return;
  el.textContent = 'Vendor codes: ' + entries.map(([code, name]) => `${code} = ${name}`).join(' · ');
  el.hidden = false;
}
