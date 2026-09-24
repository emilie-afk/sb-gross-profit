/**
 * narrative.js — rule-based weekly narrative
 * ==========================================
 * Deterministic sentences built from snapshot metrics. No model output. Every
 * sentence about profit says "provisional" whenever cost or shipping coverage is
 * incomplete (Revision 5).
 *
 * Week-over-week comparison (Revision 6): the stored narrative compares ONLY
 * with the previous week's PUBLISHED snapshot. A comparison against a draft or
 * blocked prior week is built separately by draftComparison(), labelled as a
 * draft preview, and never becomes part of published history.
 */
import { PROFITABILITY_STATUS, fmtUsd } from './metrics.js';

const pctText = v => (v === null || v === undefined ? 'n/a' : `${v.toFixed(1)}%`);

export function buildNarrative(current, previous = null) {
  const t = current.totals;
  const provisional = t.profitabilityStatus !== PROFITABILITY_STATUS.COMPLETE;
  const gpWord = provisional ? 'Provisional operating GP after shipping' : 'Operating GP after shipping';
  const points = [];

  const headline = `${gpWord} was ${fmtUsd(t.operatingGpAfterShipping)} on operating revenue of ` +
    `${fmtUsd(t.operatingRevenue)} (${pctText(t.operatingGpMargin)}) for the week of ${current.weekStart}.`;

  if (provisional) {
    points.push(`These figures are provisional: ${t.labels.notes.filter(n => /^Excludes/.test(n)).join('; ')}.`);
  }
  if (t.missingCostLines > 0) {
    points.push(`Known-cost product GP is ${fmtUsd(t.knownCostProductGp)} (${pctText(t.knownCostProductMargin)}) and is incomplete: ` +
      `${fmtUsd(t.missingCostRevenue)} of product revenue has no cost and is excluded.`);
  } else {
    points.push(`Product GP is ${fmtUsd(t.knownCostProductGp)} (${pctText(t.knownCostProductMargin)}), with complete cost coverage.`);
  }
  if (t.ordersRequiringShipStationRate) {
    points.push(`ShipStation expense is present on ${t.ordersWithValidShipStationRate} of ${t.ordersRequiringShipStationRate} orders that require it (${pctText(t.shipStationExpenseCoverage)}).`);
  }
  if (t.hpdOrdersPassThrough) {
    points.push(`${t.hpdOrdersPassThrough} HP Dropship orders use an assumed pass-through (Shopify shipping collected) instead of HPD actuals; their shipping is provisional.`);
  }
  points.push(`Route shipping protection: ${fmtUsd(t.routeCollected)} collected and remitted; Route net ${fmtUsd(t.routeNet)}.`);

  let comparison = null;
  if (previous?.totals) {
    if (previous.status && previous.status !== 'published') {
      throw new Error('The stored narrative may only compare with a published snapshot');
    }
    points.push(comparisonSentence(t, previous, provisional, gpWord));
    comparison = { basis: 'published', weekStart: previous.weekStart, snapshotId: previous.snapshotId || null };
  }

  const vendors = (current.breakdowns?.vendor || []).filter(v => v.knownCostRevenue > 0);
  if (vendors.length) {
    const top = [...vendors].sort((a, b) => b.knownCostGp - a.knownCostGp)[0];
    const label = top.coverageStatus === 'complete' ? 'product GP' : 'known-cost product GP (incomplete coverage)';
    points.push(`Largest vendor ${label}: ${top.key}, ${fmtUsd(top.knownCostGp)}.`);
  }

  return { provisional, headline, points, comparison };
}

function comparisonSentence(t, previous, provisional, gpWord) {
  const p = previous.totals;
  const bothComplete = !provisional && p.profitabilityStatus === PROFITABILITY_STATUS.COMPLETE;
  const d = t.operatingGpAfterShipping - p.operatingGpAfterShipping;
  const qual = bothComplete ? '' : ' (provisional comparison)';
  return `Versus the week of ${previous.weekStart}, operating revenue ${t.operatingRevenue >= p.operatingRevenue ? 'rose' : 'fell'} ` +
    `${fmtUsd(Math.abs(t.operatingRevenue - p.operatingRevenue))} and ${gpWord.toLowerCase()} ${d >= 0 ? 'rose' : 'fell'} ${fmtUsd(Math.abs(d))}${qual}.`;
}

/**
 * Admin-only preview against an UNPUBLISHED prior week (draft or blocked).
 * Returned only with ?includeDrafts=1 to an administrator; never stored in
 * the narrative and never shown as history.
 */
export function draftComparison(current, previousDraft) {
  if (!previousDraft?.totals) return null;
  const provisional = current.totals.profitabilityStatus !== PROFITABILITY_STATUS.COMPLETE;
  const gpWord = provisional ? 'Provisional operating GP after shipping' : 'Operating GP after shipping';
  return { label: 'DRAFT PREVIEW — compares with an unpublished prior week; not published history',
           basis: previousDraft.status, weekStart: previousDraft.weekStart, snapshotId: previousDraft.snapshotId || null,
           text: comparisonSentence(current.totals, previousDraft, provisional, gpWord) };
}
