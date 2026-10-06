/**
 * weeklyReports.js — the automated weekly reports, read from the production Worker
 * ===============================================================================
 * Read-only. Reaches the Worker only through workerClient.js (same-origin /api/v1 proxy, the
 * dashboard session cookie). Lists the weeks a signed-in session may see — published (or, once
 * approved, provisionally published) weeks; unpublished drafts never reach a session — and opens a
 * week: headline figures with their labels, channel and vendor tables, and the orders with
 * expandable line items. No upload, no recompute, no customer fields (the Worker serves none).
 * Every value is escaped; money is shown as stored.
 */
import * as api from './workerClient.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (typeof n === 'number' && Number.isFinite(n)) ? (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
// The Worker stores margins and coverage as percentages (53.3 means 53.3%).
const pct = n => (typeof n === 'number' && Number.isFinite(n)) ? `${n.toFixed(1)}%` : '—';
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
export const PAGE_SIZE = 100;

const STATUS_LABEL = { published: 'Published', provisional: 'Provisional', validated: 'Draft', blocked: 'Draft (not published)', draft: 'Draft' };
const PROFIT_LABEL = {
  complete: 'Complete', provisional: 'Provisional', provisional_missing_costs: 'Provisional — some product costs missing',
  provisional_missing_shipping: 'Provisional — some shipping costs missing', provisional_missing_costs_and_shipping: 'Provisional — some product and shipping costs missing',
};
/** A week is labelled provisional unless the Worker says its profitability is complete. */
export const isProvisional = s => !(s && s.profitabilityStatus === 'complete' && s.narrative?.provisional === false);
const verificationText = v => v?.status === 'verified' ? 'Independently verified' : v?.status ? `Verification: ${String(v.status).replace(/_/g, ' ')}` : 'Verification not recorded';

/**
 * Shipping-cost coverage in plain words. Orders without a Shipping Cost Report cost are left out of
 * shipping expense (never counted as $0), so GP after shipping is overstated by their missing cost.
 */
export function shippingCoverageText(c) {
  const need = c?.ordersRequiringCost ?? c?.ordersRequiringShipStationRate, have = c?.ordersWithCost ?? c?.ordersWithValidShipStationRate;
  if (!(Number.isFinite(need) && Number.isFinite(have)) || need <= 0) return null;
  if (have >= need) return `Shipping cost present on all ${need} orders that need it.`;
  return `Shipping cost missing on ${need - have} of ${need} orders (${pct(have / need * 100)} covered). GP after shipping leaves out their shipping expense (not counted as $0), so it is overstated.`;
}
const shortCoverage = c => {
  const need = c?.ordersRequiringCost, have = c?.ordersWithCost;
  return Number.isFinite(need) && Number.isFinite(have) && need > 0 ? `${pct(have / need * 100)}${have < need ? ' ⚠' : ''}` : '—';
};
const FLAG_TEXT = {
  first_version: 'first report for these dates', coverage_gap: 'report does not join earlier reports', zero_shipping_cost: '$0.00 shipping rows',
  over_review_cap: 'unusually large shipping rows', nonzero_insurance_cost: 'insurance charges (disclosed, not added)', nonzero_duties: 'duties',
  nonzero_taxes: 'taxes', nonzero_import_fee: 'import fees', changed_cost: 'shipping costs of this week\'s orders changed by a later report',
  accepted_cost_removed: 'a later report omitted accepted shipping costs of this week\'s orders (the accepted costs are kept)',
};
export function reportFlagsText(status) {
  const sr = status?.sources?.shippingReport || {};
  const flags = (sr.flags || []).map(f => FLAG_TEXT[f] || String(f).replace(/_/g, ' '));
  const parts = [];
  if (flags.length) parts.push(`Shipping Cost Report flags: ${flags.join('; ')}.`);
  if ((sr.changedDates || []).length) parts.push(`Late cost corrections on ${sr.changedDates.join(', ')}.`);
  if ((sr.omittedDates || []).length) parts.push(`Accepted costs kept after a later report omitted them on ${sr.omittedDates.join(', ')}.`);
  return parts.join(' ') || null;
}

export function renderSignIn(message = '') {
  return `<form class="gp-auto-signin" onsubmit="event.preventDefault();weeklyReports.signIn(this.password.value)">
    <p class="meta">Sign in with the dashboard password to read the automated weekly reports. Nothing is uploaded.</p>
    <input type="password" name="password" autocomplete="current-password" placeholder="Dashboard password" required style="padding:6px 8px;min-width:220px">
    <button class="gp-btn" type="submit">Sign in</button>
    ${message ? `<p class="error-msg" role="alert">${esc(message)}</p>` : ''}
  </form>`;
}

export function renderWeekList(weeks) {
  const list = (Array.isArray(weeks) ? weeks : []).filter(w => WEEK_RE.test(w?.weekStart || ''));
  if (!list.length) return `<p class="meta">No weekly reports are visible yet. Computed and verified weeks stay hidden until their publication is approved; manual uploads remain available below.</p>`;
  const rows = list.map(w => {
    const r = (w.revisions || [])[0] || {};
    return `<tr><td><button class="logout-btn" onclick="weeklyReports.openWeek('${esc(w.weekStart)}')">${esc(w.weekStart)}</button></td>
      <td>${esc(STATUS_LABEL[r.status] || r.status || '—')}</td><td>${esc(PROFIT_LABEL[r.profitabilityStatus] || r.profitabilityStatus || '—')}</td>
      <td style="text-align:right">${money(r.operatingRevenue)}</td><td style="text-align:right">${money(r.operatingGpAfterShipping)}</td><td style="text-align:right">${pct(r.operatingGpMargin)}</td>
      <td style="text-align:right">${esc(shortCoverage(r.shippingCoverage))}</td><td style="text-align:right">${pct(r.costCoverageByRevenue)}</td>
      <td>${esc(verificationText(r.verification))}${r.partialWeek ? ` · partial week (${esc(r.partialWeek.from)}–${esc(r.partialWeek.to)})` : ''}</td></tr>`;
  }).join('');
  return `<table class="gp-auto-weeks" style="width:100%;border-collapse:collapse;font-size:.85rem">
    <thead><tr><th style="text-align:left">Week (Mon–Sun, LA)</th><th style="text-align:left">Status</th><th style="text-align:left">Profitability</th><th style="text-align:right">Operating revenue</th><th style="text-align:right">GP after shipping</th><th style="text-align:right">Margin</th><th style="text-align:right">Shipping cost coverage</th><th style="text-align:right">Product cost coverage</th><th style="text-align:left">Verification</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function breakdownTable(title, rows) {
  const body = (rows || []).map(r => `<tr><td>${esc(r.key)}</td><td style="text-align:right">${esc(r.units ?? '')}</td><td style="text-align:right">${money(r.knownCostRevenue)}</td>
    <td style="text-align:right">${money(r.knownCostGp)}</td><td style="text-align:right">${pct(r.knownCostMargin)}</td><td style="text-align:right">${money(r.missingCostRevenue)}</td></tr>`).join('');
  return `<h4>${esc(title)}</h4><table style="width:100%;border-collapse:collapse;font-size:.8rem"><thead><tr><th style="text-align:left">${esc(title.split(' ')[0])}</th><th style="text-align:right">Units</th>
    <th style="text-align:right">Known-cost revenue</th><th style="text-align:right">Known-cost GP</th><th style="text-align:right">Margin</th><th style="text-align:right">Revenue with missing cost</th></tr></thead><tbody>${body}</tbody></table>`;
}

export function renderWeek(s, status = null) {
  if (!s || !WEEK_RE.test(s.weekStart || '')) return '<p class="meta">This week could not be read.</p>';
  const t = s.totals || {}, labels = t.labels || {};
  const notes = (labels.notes || []).map(n => `<li>${esc(n)}</li>`).join('');
  const disclosures = [
    labels.partialWeek ? `Partial reporting week: orders from ${labels.partialWeek.from} to ${labels.partialWeek.to} only (reporting starts ${labels.partialWeek.reportingStart}).` : null,
    shippingCoverageText(t),
    labels.costCoverage || null,
    s.catalog?.freshness?.status === 'reused_accepted' ? 'Product costs: the cost catalog pinned to this week, accepted as correct for this period.' : null,
    reportFlagsText(status),
  ].filter(Boolean).map(d => `<li>${esc(d)}</li>`).join('');
  const points = (s.narrative?.points || []).map(p => `<li>${esc(p)}</li>`).join('');
  const prov = isProvisional(s);
  return `<div class="gp-auto-week">
    <p><strong>Week of ${esc(s.weekStart)}</strong> · revision ${esc(s.revision)} · ${esc(STATUS_LABEL[s.status] || s.status)} · ${esc(verificationText(s.verification))}
      ${prov ? '<span class="chip" style="margin-left:6px">Provisional</span>' : ''}</p>
    <div class="gp-kpi-row" style="display:flex;gap:16px;flex-wrap:wrap">
      <div><div class="meta">${esc(labels.headline || 'Operating GP after shipping')}</div><div style="font-size:1.3rem;font-weight:600">${money(t.operatingGpAfterShipping)}</div></div>
      <div><div class="meta">Operating revenue</div><div style="font-size:1.3rem;font-weight:600">${money(t.operatingRevenue)}</div></div>
      <div><div class="meta">Margin</div><div style="font-size:1.3rem;font-weight:600">${pct(t.operatingGpMargin)}</div></div>
      <div><div class="meta">${esc(labels.productGp || 'Known-cost product GP')}</div><div style="font-size:1.3rem;font-weight:600">${money(t.knownCostProductGp)}</div></div>
      <div><div class="meta">Shipping expense</div><div style="font-size:1.3rem;font-weight:600">${money(t.shippingExpense)}</div></div>
    </div>
    <p class="meta">${esc(PROFIT_LABEL[s.profitabilityStatus] || s.profitabilityStatus || '')}${labels.costCoverage ? ` · ${esc(labels.costCoverage)}` : ''}${labels.hpdShipping ? ` · ${esc(labels.hpdShipping)}` : ''}</p>
    ${disclosures ? `<h4>Coverage and disclosures</h4><ul class="meta gp-auto-disclosures">${disclosures}</ul>` : ''}
    ${notes ? `<ul class="meta">${notes}</ul>` : ''}
    ${points ? `<details><summary class="meta">Summary</summary><ul class="meta">${points}</ul></details>` : ''}
    ${breakdownTable('Channel', s.breakdowns?.channel)}
    ${breakdownTable('Vendor', s.breakdowns?.vendor)}
    <h4>Orders</h4><div id="auto-orders"><p class="meta">Loading orders…</p></div>
  </div>`;
}

export function renderOrders(list, { week, offset = 0 } = {}) {
  const orders = list?.orders || [], total = list?.page?.total ?? orders.length;
  const rows = orders.map((o, i) => `<tr class="gp-auto-order" data-i="${i}"><td><button class="logout-btn" onclick="weeklyReports.toggleOrder('${esc(week)}', ${i})">${esc(o.orderName)}</button></td>
    <td>${esc(o.businessDate)}</td><td>${esc(o.channel)}</td><td style="text-align:right">${money(o.operatingRevenue)}</td><td style="text-align:right">${money(o.knownProductCogs)}</td>
    <td style="text-align:right">${money(o.shipPaid)}</td><td style="text-align:right">${money(o.operatingGp)}</td><td>${esc(String(o.profitabilityStatus || '').replace(/_/g, ' '))}</td></tr>
    <tr class="gp-auto-lines" id="auto-lines-${i}" hidden><td colspan="8"></td></tr>`).join('');
  const prev = offset > 0 ? `<button class="logout-btn" onclick="weeklyReports.ordersPage('${esc(week)}', ${Math.max(0, offset - PAGE_SIZE)})">← Previous</button>` : '';
  const next = offset + orders.length < total ? `<button class="logout-btn" onclick="weeklyReports.ordersPage('${esc(week)}', ${offset + PAGE_SIZE})">Next →</button>` : '';
  return `<p class="meta">Orders ${orders.length ? offset + 1 : 0}–${offset + orders.length} of ${esc(total)} ${prev} ${next}</p>
    <table style="width:100%;border-collapse:collapse;font-size:.8rem"><thead><tr><th style="text-align:left">Order</th><th style="text-align:left">Date</th><th style="text-align:left">Channel</th>
    <th style="text-align:right">Revenue</th><th style="text-align:right">Product cost</th><th style="text-align:right">Shipping paid</th><th style="text-align:right">GP</th><th style="text-align:left">Profitability</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function renderLines(detail) {
  const lines = detail?.lines || [];
  if (!lines.length) return '<p class="meta">No line items.</p>';
  return `<table style="width:100%;border-collapse:collapse;font-size:.75rem"><thead><tr><th style="text-align:left">SKU</th><th style="text-align:left">Product</th><th style="text-align:left">Vendor</th>
    <th style="text-align:right">Qty</th><th style="text-align:right">Revenue</th><th style="text-align:right">Cost</th><th style="text-align:right">GP</th><th style="text-align:left">Cost source</th></tr></thead><tbody>${
    lines.map(l => `<tr><td>${esc(l.sku)}</td><td>${esc(l.product)}</td><td>${esc(l.vendorKey)}</td><td style="text-align:right">${esc(l.qty)}</td>
      <td style="text-align:right">${money(l.contractRevenue)}</td><td style="text-align:right">${l.missingCost ? 'missing' : money(l.lineCogs)}</td>
      <td style="text-align:right">${money(l.knownCostGp)}</td><td>${esc(l.costSource)}</td></tr>`).join('')}</tbody></table>`;
}

/** Controller: renders into `root` (and the orders container inside it). `client` defaults to workerClient. */
export function createWeeklyReports(root, client = api) {
  let orders = [];
  const show = html => { root.innerHTML = html; };
  const fail = e => show(e?.status === 401 ? renderSignIn() : `<p class="meta">${esc(e?.status === 503 ? 'The dashboard is not connected to the reporting service yet.' : 'The weekly reports are unavailable right now.')}</p>`);
  const ctl = {
    async load() {
      try { show(renderWeekList((await client.weeks()).weeks)); } catch (e) { fail(e); }
    },
    async signIn(password) {
      try { await client.login(password); await ctl.load(); } catch (e) { show(renderSignIn(e?.status === 401 ? 'That password was not accepted.' : 'Sign-in is unavailable right now.')); }
    },
    async openWeek(week) {
      if (!WEEK_RE.test(week)) return;
      try {
        const [snap, status] = await Promise.all([client.snapshot(week), client.weekStatus ? client.weekStatus(week).catch(() => null) : null]);
        show(`<p><button class="logout-btn" onclick="weeklyReports.load()">← All weeks</button></p>${renderWeek(snap, status)}`); await ctl.ordersPage(week, 0);
      }
      catch (e) { fail(e); }
    },
    async ordersPage(week, offset) {
      const el = root.querySelector('#auto-orders');
      if (!el || !WEEK_RE.test(week)) return;
      try { const l = await client.orders(week, { offset, limit: PAGE_SIZE }); orders = l.orders || []; el.innerHTML = renderOrders(l, { week, offset }); }
      catch (e) { el.innerHTML = '<p class="meta">Orders are unavailable right now.</p>'; }
    },
    async toggleOrder(week, i) {
      const row = root.querySelector(`#auto-lines-${Number(i)}`), o = orders[Number(i)];
      if (!row || !o) return;
      if (!row.hidden) { row.hidden = true; return; }
      row.hidden = false;
      try { row.firstElementChild.innerHTML = renderLines(await client.order(week, o.orderName)); }
      catch { row.firstElementChild.innerHTML = '<p class="meta">Line items are unavailable right now.</p>'; }
    },
  };
  return ctl;
}
