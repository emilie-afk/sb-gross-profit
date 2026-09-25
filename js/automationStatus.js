/**
 * automationStatus.js — render the Worker's weekly automation status (C7)
 * ======================================================================
 * Pure: status JSON in, escaped HTML out. The status carries codes, counts and
 * timestamps only (no paths, email details, tokens, sheet configuration or
 * customer data), and every value is escaped again here.
 */
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = iso => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const f = tz => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `${f('Asia/Ho_Chi_Minh')} ICT · ${f('America/Los_Angeles')} LA`;
};
const SOURCE_LABEL = {
  shopify: 'Shopify orders export', shopify_updates: 'Shopify updated-order scan', shipping_cost_report: 'ShipStation Shipping Cost Report',
  catalog_refresh: 'Cost catalog refresh', reporting_period: 'Reporting period closed',
};
const labelOf = code => { const [k, state] = String(code).split(':'); return `${SOURCE_LABEL[k] || k}${state ? ` (${state.replace(/_/g, ' ')})` : ''}`; };
const STATE_LABEL = {
  waiting_for_sources: 'Waiting for sources', source_timeout: 'Source timeout — waiting for a late upload', computing: 'Computing',
  validated: 'Draft ready (not published)', blocked: 'Draft blocked by the gate (not published)', draft: 'Draft', failed: 'Failed — will retry',
  published: 'Published', created: 'Created',
};

// C8: which report version(s) a draft used, and any newer one waiting for review.
const range = v => `${esc(v.requestedFrom)} – ${esc(v.requestedTo)}`;
function reportUsed(r) {
  if (!r) return '—';
  if (!(r.used || []).length) return esc(r.label || 'None accepted for this week — no financial snapshot');
  return r.used.map(u => `${range(u)} · received ${esc(when(u.receivedAt))} · ${esc(String(u.state).replace(/_/g, ' '))} · sha256 ${esc(u.sha256 || '—')}`).join('<br>');
}
function pendingText(s) {
  const r = s.shippingReport;
  if (r?.status === 'ok' && (r.newerPending || []).length) {
    return `<strong>Newer shipping report pending review</strong> — ${r.newerPending.map(v => `${range(v)} · received ${esc(when(v.receivedAt))}`).join('; ')}. This draft uses the accepted report above and cannot be published; accepting the newer report creates a new draft revision.`;
  }
  if (r?.status === 'pending_review') return 'ShipStation Shipping Cost Report received and pending review — no financial snapshot until it is accepted';
  return (s.sources?.pendingReview || []).length ? `${(s.sources.pendingReview).map(k => esc(SOURCE_LABEL[k] || k)).join(', ')} — cannot publish` : 'None';
}

export function renderAutomationStatus(s) {
  if (!s || typeof s !== 'object') return '<p class="meta">No status.</p>';
  const rows = [
    ['Reporting week', `${esc(s.weekStart)} (Mon–Sun, ${esc(s.reportingPeriod?.timeZone)})${s.reportingPeriod?.closed ? '' : ' — still open'}`],
    ['Scheduled collection', esc(when(s.schedule?.collectionAt))],
    ['First compute attempt', esc(when(s.schedule?.firstAttemptAt))],
    ['Last attempt', esc(when(s.cycle?.lastAttemptAt))],
    ['Next retry', s.sourceTimeout ? 'None — retry window closed; a late valid upload resumes it' : esc(when(s.cycle?.nextRetryAt))],
    ['Retry cutoff', esc(when(s.schedule?.cutoffAt))],
    ['State', esc(STATE_LABEL[s.run?.state] || (s.cycle ? s.cycle.status : 'Not started'))],
    ['Sources received', (s.sources?.received || []).map(k => esc(SOURCE_LABEL[k] || k)).join(', ') || '—'],
    ['Sources missing', (s.sources?.missing || []).map(c => esc(labelOf(c))).join(', ') || 'None'],
    ['Shipping Cost Report used', reportUsed(s.shippingReport)],
    ['Pending review', pendingText(s)],
    ['Catalog', `${esc(s.catalog?.rev || '—')} · ${esc(s.catalog?.completeness?.label || '')}${s.catalog?.reuseAccepted ? ' · reuse approved' : ''}`],
    ['Shipping source', s.shippingVerification === 'verified' ? 'Verified' : 'Unverified (provisional)'],
    ['Publication', s.publication?.enabled ? 'Enabled' : 'Disabled'],
  ];
  return `<table class="gp-auto-status" style="width:100%;border-collapse:collapse;font-size:.85rem">${rows.map(([k, v]) =>
    `<tr><th style="text-align:left;padding:4px 12px 4px 0;color:var(--muted);font-weight:500;white-space:nowrap;vertical-align:top">${esc(k)}</th><td style="padding:4px 0">${v}</td></tr>`).join('')}</table>`;
}

export function automationStatusError(e) {
  if (e?.status === 401) return 'Sign in to the Worker session to see the weekly automation status.';
  if (e?.status === 503) return 'The dashboard is not connected to the Worker yet.';
  return 'The weekly automation status is unavailable right now.';
}
