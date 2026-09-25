/**
 * gate.js — the per-week publication gate and the go-live switch
 * ===============================================================
 * evaluateGate() decides whether a draft snapshot could be published. Passing
 * the gate is necessary but not sufficient: automated publication also needs
 * the go-live switch, which is off until the go-live gate in Revision 5 passes
 * (baseline match, HPD behavior preserved, Carrier Fee priority locked, Route
 * and Product GP definitions confirmed).
 *
 * Thresholds come from settings, never from shared calculation code.
 */

export const DEFAULT_SETTINGS = Object.freeze({
  ss_coverage_threshold: 0.95,
  catalog_shrink_tolerance: 0.10,
  publication_enabled: false,
  carrier_fee_priority_locked: false,
  insurance_treatment: 'awaiting_confirmation',
  store_timezone: 'America/Los_Angeles',
  store_timezone_confirmed: false,
  schedule_timezone: 'Asia/Ho_Chi_Minh',
  schedule_weekday: 1,
  schedule_time: '15:30',
  // Revision 9 (C2): Shipping Cost Report source. Audited operator settings; the
  // source-verified flag has no effect until C3 and cannot be set true yet.
  shipping_report_currency: 'USD',
  shipping_report_timezone: 'America/Los_Angeles',
  shipping_report_store: 'Succulents Box (Shopify)',
  shipping_cost_report_source_verified: false,
});

/**
 * Catalog freshness states recorded on every run and snapshot.
 *   current               the catalog imported by this week's verified refresh
 *   intentionally_reused  a revision keeps the catalog of the week's earlier snapshot
 *   restated              an audited cost restatement chose this catalog
 *   reused_accepted       stale, but an administrator accepted reuse with a reason
 *   stale                 none of the above — blocks publication
 */
export const CATALOG_FRESHNESS = Object.freeze(['current', 'intentionally_reused', 'restated', 'reused_accepted', 'stale']);

/**
 * @param {object} p
 * @param {object} p.totals          computeMetrics().totals
 * @param {object[]} p.reconciliation  [{ check, passed, blocking }]
 * @param {object} p.sources         { shopify: 'ok'|'pending'|'failed', shipstation: ..., hpd: ... }
 * @param {object} p.catalog         { accepted: boolean, rev, freshness: { status, reason, ... } }
 * @param {object} p.settings
 */
export function evaluateGate({ totals, reconciliation, sources, catalog, settings, ordersInOtherTimezone = 0 }) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const failures = [], warnings = [];

  if (sources?.shopify !== 'ok') failures.push({ code: 'source_shopify', message: `Shopify ingest is ${sources?.shopify || 'missing'}` });
  if (sources?.shipstation !== 'ok') failures.push({ code: 'source_shipstation', message: `ShipStation ingest is ${sources?.shipstation || 'missing'}` });
  if (sources?.hpd !== 'ok') warnings.push({ code: 'source_hpd', message: 'HPD shipping log not ingested; HPD orders use an ASSUMED Shopify-shipping pass-through' });

  if (!catalog?.accepted) failures.push({ code: 'catalog', message: 'No accepted cost catalog for this snapshot' });
  const fresh = catalog?.freshness?.status;
  if (catalog?.accepted && (!fresh || fresh === 'stale')) {
    failures.push({ code: 'catalog_stale', message: `Cost catalog ${catalog.rev} is not verified current for this week (${catalog?.freshness?.reason || 'no freshness record'}); refresh it, or accept reuse with a reason` });
  } else if (fresh === 'reused_accepted') {
    warnings.push({ code: 'catalog_reused', message: `Cost catalog reuse accepted by an administrator: ${catalog.freshness.acceptance?.reason || ''}` });
  }

  for (const r of reconciliation || []) {
    if (!r.passed && r.blocking) failures.push({ code: `reconciliation_${r.check}`, message: `Reconciliation failed: ${r.check} (expected ${r.expected}, got ${r.actual})` });
    else if (!r.passed) warnings.push({ code: `reconciliation_${r.check}`, message: `Reconciliation note: ${r.check} differs by ${r.delta}` });
  }

  if (totals.routeNet !== 0) failures.push({ code: 'route_net', message: `Route net is ${totals.routeNet}, must be 0` });

  const threshold = Number(s.ss_coverage_threshold);
  const cov = totals.ordersRequiringShipStationRate
    ? totals.ordersWithValidShipStationRate / totals.ordersRequiringShipStationRate : 1;
  if (cov + 1e-9 < threshold) {
    failures.push({ code: 'ss_coverage', message: `ShipStation expense coverage ${(cov * 100).toFixed(1)}% is below the ${(threshold * 100).toFixed(0)}% threshold` });
  } else if (cov < 1) {
    warnings.push({ code: 'ss_coverage', message: `${totals.ordersRequiringShipStationRate - totals.ordersWithValidShipStationRate} orders still lack ShipStation expense; listed in the issue table` });
  }

  if (totals.missingCostLines > 0) warnings.push({ code: 'cost_coverage', message: totals.labels.notes[0] });
  // Revision 6: a provisional ShipStation cost-field priority BLOCKS publication.
  if (s.carrier_fee_priority_locked !== true) failures.push({ code: 'carrier_fee_priority', message: 'ShipStation cost-field priority (Carrier Fee → Rate) is provisional; lock it after the zero-Rate investigation' });
  if (totals.hpdOrdersPassThrough > 0) {
    warnings.push({ code: 'hpd_pass_through_assumed', message: `${totals.hpdOrdersPassThrough} HP Dropship orders use an assumed pass-through, not HPD actuals; results are provisional` });
  }
  // Revision 7: an unconfirmed store time zone BLOCKS (reporting-week boundaries depend on it).
  if (ordersInOtherTimezone > 0) failures.push({ code: 'orders_in_other_timezone', message: `${ordersInOtherTimezone} orders of this week were normalized under a different store time zone; re-ingest the week` });
  if (s.store_timezone_confirmed !== true) failures.push({ code: 'store_timezone_unconfirmed', message: `Store time zone ${s.store_timezone} is not confirmed against Shopify store settings` });
  if (s.insurance_treatment === 'awaiting_confirmation' && totals.insuranceDisclosed > 0) {
    warnings.push({ code: 'insurance', message: 'Insurance treatment awaiting confirmation; insurance disclosed, not added to expense' });
  }

  return { passed: failures.length === 0, failures, warnings };
}

/**
 * Publication needs the gate AND the go-live switch. The switch is two locks:
 * the `publication_enabled` setting and the PUBLICATION_ALLOWED environment
 * flag on the Worker. Neither is set by this build. The Carrier Fee priority
 * lock and the store-time-zone confirmation are checked first, against current
 * settings; neither switch overrides them.
 */
export function canPublish(gate, settings, envAllowed) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const enabled = s.publication_enabled === true || s.publication_enabled === 'true';
  // Checked against CURRENT settings as well as the stored gate, so unlocking
  // the priority after a compute cannot be overridden by the publication switches.
  if (s.carrier_fee_priority_locked !== true) return { allowed: false, reason: 'carrier_fee_priority_unlocked' };
  // Same for the store time zone: it must be confirmed NOW, and be the zone the
  // snapshot was computed in (a changed zone moves the week's boundaries).
  if (s.store_timezone_confirmed !== true) return { allowed: false, reason: 'store_timezone_unconfirmed' };
  if (gate?.storeTimezone && gate.storeTimezone !== s.store_timezone) return { allowed: false, reason: 'store_timezone_changed' };
  if (!gate?.passed) return { allowed: false, reason: 'gate_failed' };
  if (!enabled) return { allowed: false, reason: 'publication_disabled' };
  if (envAllowed !== true && envAllowed !== 'true') return { allowed: false, reason: 'publication_not_allowed_in_environment' };
  return { allowed: true, reason: null };
}
