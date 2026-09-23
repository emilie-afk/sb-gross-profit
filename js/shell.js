/**
 * shell.js — navigation, theme, and the redesigned Overview / Shipping /
 * Reports renderers.
 *
 * Nothing here calculates anything. Every figure comes from summarize() and the
 * line items produced by calculate(); this module only decides what is shown and
 * where. Screens are URL-backed so they can be linked and the back button works.
 */

export const SCREENS = {
  overview:  ['Overview',            'Where profit is coming from, and what needs fixing'],
  channels:  ['Channels & vendors',  'Revenue, gross profit and top vendor per channel'],
  shipping:  ['Shipping',            'Collected vs paid across fulfilment profiles'],
  orders:    ['Order detail',        'Filter, search and export line items'],
  reports:   ['Reports',             'Subscription P&L and saved analyses'],
  scenarios: ['Scenarios',           'Model a change before you make it'],
};

// Fixed series order — a channel keeps its colour everywhere it appears.
export const SERIES = ['#15803d', '#1d4ed8', '#0e7490', '#b45309', '#6d28d9', '#be123c'];
export const SERIES_REST = '#9ca3af';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ─── Theme ────────────────────────────────────────────────────────────────────

const THEME_KEY = 'gp_theme';

export function initTheme() {
  let t = null;
  try { t = localStorage.getItem(THEME_KEY); } catch { /* private mode */ }
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  applyTheme(t);
}
export function applyTheme(t) {
  document.documentElement.setAttribute('data-gp-theme', t);
  const btn = $('theme-toggle');
  if (btn) btn.textContent = t === 'dark' ? 'Dark' : 'Light';
  try { localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
}
export function toggleTheme() {
  applyTheme(document.documentElement.getAttribute('data-gp-theme') === 'dark' ? 'light' : 'dark');
}

// ─── Screen routing ───────────────────────────────────────────────────────────

let onScreenChange = () => {};
export function initRouter(handler) {
  onScreenChange = handler || (() => {});
  window.addEventListener('hashchange', () => showScreen(screenFromHash(), false));
}
const screenFromHash = () => {
  const id = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
  return SCREENS[id] ? id : 'overview';
};
export const currentScreen = () => screenFromHash();

export function showScreen(id, pushHash = true) {
  if (!SCREENS[id]) id = 'overview';
  for (const key of Object.keys(SCREENS)) {
    const el = $('screen-' + key);
    if (!el) continue;
    const on = key === id;
    el.hidden = !on;
    el.style.display = on ? 'flex' : 'none';
    if (on && key === 'scenarios') el.style.display = 'block';
    if (on && key === 'channels') el.style.display = 'block';
  }
  document.querySelectorAll('.gp-nav-item').forEach(b => {
    if (b.dataset.screen === id) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const [title, sub] = SCREENS[id];
  if ($('screen-title')) $('screen-title').textContent = title;
  if ($('screen-sub')) $('screen-sub').textContent = sub;
  if (pushHash && screenFromHash() !== id) location.hash = '#/' + id;
  document.querySelector('.gp-main')?.scrollTo({ top: 0 });
  onScreenChange(id);
}

// ─── Needs attention ──────────────────────────────────────────────────────────

/**
 * Derive the alert set. Alerts are computed, never hardcoded, and the panel
 * hides entirely when nothing fires — "0 issues" is not a state worth a card.
 */
export function buildAlerts(lines, s) {
  const out = [];

  const missing = lines.filter(l => l.costSource === 'COST MISSING');
  if (missing.length) {
    out.push({
      kicker: 'Missing cost data', tone: 'var(--gp-warn)',
      value: `${missing.length.toLocaleString()} line item${missing.length === 1 ? '' : 's'}`,
      body: 'Gross profit is understated until SKU costs are added to products_export or mcg_total.',
      action: 'Download SKUs', onClick: 'downloadMissingSkus()',
    });
  }

  const losing = Object.entries(s.byChannel || {})
    .filter(([, v]) => v.revenue > 0 && v.gp < 0)
    .sort((a, b) => a[1].gp - b[1].gp)[0];
  if (losing) {
    const [name, v] = losing;
    out.push({
      kicker: 'Channel losing money', tone: 'var(--gp-neg)', value: name,
      body: `GP ${(v.gp / v.revenue * 100).toFixed(1)}% on ${money(v.revenue)} revenue. `
          + 'Worth checking for a mis-mapped cost before reading the rest of the channel table.',
      action: 'Inspect channel', onClick: `inspectChannel(${JSON.stringify(name)})`,
    });
  }

  const worst = Object.entries(s.shipByType || {})
    .map(([name, v]) => ({ name, ...v, net: (v.collected || 0) - (v.paid || 0) }))
    .filter(v => v.net < -0.005).sort((a, b) => a.net - b.net)[0];
  if (worst) {
    out.push({
      kicker: 'Shipping underwater', tone: 'var(--gp-neg)', value: money(worst.net),
      body: `${worst.name} orders collected ${money(worst.collected)} and paid `
          + `${money(worst.paid)} across ${worst.orders.toLocaleString()} orders.`,
      action: 'Open shipping', onClick: "gotoScreen('shipping')",
    });
  }
  return out;
}

export function renderAlerts(alerts) {
  const card = $('needs-attention'), body = $('alerts-body');
  if (!card || !body) return;
  if (!alerts.length) { card.hidden = true; return; }
  card.hidden = false;
  $('alerts-count').textContent =
    `${alerts.length} item${alerts.length === 1 ? '' : 's'} affecting this period's numbers`;
  body.innerHTML = alerts.map(a => `
    <div class="gp-alert">
      <div class="kicker">${esc(a.kicker)}</div>
      <div class="value" style="color:${a.tone}">${esc(a.value)}</div>
      <div class="body">${esc(a.body)}</div>
      <button class="gp-btn gp-btn-sm" onclick="${a.onClick}">${esc(a.action)}</button>
    </div>`).join('');
}

// ─── Formatting ───────────────────────────────────────────────────────────────

export const money = n => (n === null || n === undefined || Number.isNaN(n))
  ? '—' : (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = n => (n < 0 ? '-' : '') + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');

// ─── Overview charts ──────────────────────────────────────────────────────────

/** Horizontal bars: name, bar and amount on one readable row. Top 6 of N. */
export function renderStoreBars(byStore) {
  const el = $('store-bars');
  if (!el) return;
  const rows = Object.entries(byStore || {})
    .map(([name, v]) => ({ name, gp: v.gp || 0 }))
    .sort((a, b) => b.gp - a.gp);
  const top = rows.slice(0, 6);
  const max = Math.max(1, ...top.map(r => Math.abs(r.gp)));
  $('store-chart-meta').textContent = rows.length > 6 ? `Top 6 of ${rows.length}` : `${rows.length} stores`;
  $('store-see-all').style.display = rows.length > 6 ? '' : 'none';
  el.innerHTML = top.map(r => `
    <div class="gp-bar-row">
      <div class="gp-bar-name" title="${esc(r.name)}">${esc(r.name)}</div>
      <div class="gp-bar-track"><div class="gp-bar-fill" style="width:${
        Math.max(2, Math.abs(r.gp) / max * 100)}%;background:${
        r.gp < 0 ? 'var(--gp-neg)' : 'var(--gp-brand)'}"></div></div>
      <div class="gp-bar-val"${r.gp < 0 ? ' style="color:var(--gp-neg)"' : ''}>${compact(r.gp)}</div>
    </div>`).join('') || '<div class="gp-empty">No store revenue in this period.</div>';
}

/** Donut + capped legend: top 6 channels, the rest bucketed. */
export function renderChannelDonut(byChannel) {
  const donut = $('channel-donut'), legend = $('channel-legend');
  if (!donut || !legend) return;
  const rows = Object.entries(byChannel || {})
    .map(([name, v]) => ({ name, revenue: v.revenue || 0 }))
    .filter(r => r.revenue > 0).sort((a, b) => b.revenue - a.revenue);
  const total = rows.reduce((a, r) => a + r.revenue, 0);
  if (!total) {
    donut.style.background = 'var(--gp-subtle)';
    legend.innerHTML = '<div class="gp-empty">No channel revenue in this period.</div>';
    $('donut-pct').textContent = '—'; $('donut-name').textContent = '';
    return;
  }
  const top = rows.slice(0, 6);
  const restRev = rows.slice(6).reduce((a, r) => a + r.revenue, 0);
  const shown = top.map((r, i) => ({ ...r, color: SERIES[i] }));
  if (restRev > 0) shown.push({
    name: `${rows.length - 6} smaller channels`, revenue: restRev, color: SERIES_REST });

  let acc = 0;
  const stops = shown.map(r => {
    const from = acc / total * 100; acc += r.revenue;
    return `${r.color} ${from.toFixed(3)}% ${(acc / total * 100).toFixed(3)}%`;
  }).join(', ');
  donut.style.background = `conic-gradient(${stops})`;
  donut.setAttribute('aria-label',
    'Revenue share by channel: ' + shown.map(r =>
      `${r.name} ${(r.revenue / total * 100).toFixed(1)}%`).join(', '));

  $('donut-pct').textContent = `${(shown[0].revenue / total * 100).toFixed(1)}%`;
  $('donut-name').textContent = shown[0].name;
  $('channel-chart-meta').textContent = `${money(total)} attributed`;
  legend.innerHTML = shown.map(r => `
    <div class="gp-legend-row">
      <span class="gp-swatch" style="background:${r.color}"></span>
      <span class="gp-legend-name" title="${esc(r.name)}">${esc(r.name)}</span>
      <span class="gp-legend-pct">${(r.revenue / total * 100).toFixed(1)}%</span>
    </div>`).join('');
}

// ─── Shipping screen ──────────────────────────────────────────────────────────

/** Seven profile cards became one table: comparing net is now a single scan. */
export function renderShipping(s) {
  const rows = Object.entries(s.shipByType || {})
    .map(([name, v]) => ({
      name, orders: v.orders || 0, collected: v.collected || 0,
      paid: v.paid || 0, net: (v.collected || 0) - (v.paid || 0),
    }))
    .sort((a, b) => b.collected - a.collected);

  const tot = rows.reduce((a, r) => ({
    orders: a.orders + r.orders, collected: a.collected + r.collected,
    paid: a.paid + r.paid, net: a.net + r.net,
  }), { orders: 0, collected: 0, paid: 0, net: 0 });

  const underwater = rows.filter(r => r.net < 0).reduce((a, r) => a + r.orders, 0);
  const tone = n => n < 0 ? ' style="color:var(--gp-neg)"' : (n > 0 ? ' style="color:var(--gp-pos)"' : '');

  const kpis = $('ship-kpis');
  if (kpis) kpis.innerHTML = `
    <div class="gp-kpi gp-kpi-sm"><div class="label">Net shipping</div>
      <div class="value"${tone(tot.net)}>${money(tot.net)}</div>
      <div class="s1">Collected less paid</div><div class="s2">Across ${tot.orders.toLocaleString()} orders</div></div>
    <div class="gp-kpi gp-kpi-sm"><div class="label">Collected</div>
      <div class="value">${money(tot.collected)}</div>
      <div class="s1">Charged to customers</div><div class="s2">Shopify order shipping</div></div>
    <div class="gp-kpi gp-kpi-sm"><div class="label">Paid</div>
      <div class="value">${money(tot.paid)}</div>
      <div class="s1">Label and dropship cost</div><div class="s2">ShipStation rate + HPD</div></div>
    <div class="gp-kpi gp-kpi-sm"><div class="label">Orders underwater</div>
      <div class="value"${underwater ? ' style="color:var(--gp-neg)"' : ''}>${underwater.toLocaleString()}</div>
      <div class="s1">In profiles with negative net</div>
      <div class="s2">${rows.filter(r => r.net < 0).map(r => r.name).join(', ') || 'None'}</div></div>`;

  const table = $('ship-profile-table');
  if (table) table.innerHTML = `
    <thead><tr><th>Profile</th><th class="num">Orders</th><th class="num">Collected</th>
      <th class="num">Paid</th><th class="num">Net</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${esc(r.name)}</td>
      <td class="num">${r.orders.toLocaleString()}</td>
      <td class="num">${money(r.collected)}</td>
      <td class="num">${money(r.paid)}</td>
      <td class="num"${r.net === 0 ? ' style="color:var(--gp-text3)"' : tone(r.net)}>${money(r.net)}</td>
    </tr>`).join('')}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${tot.orders.toLocaleString()}</td>
      <td class="num">${money(tot.collected)}</td><td class="num">${money(tot.paid)}</td>
      <td class="num"${tone(tot.net)}>${money(tot.net)}</td></tr></tfoot>`;
  const meta = $('ship-profile-meta');
  if (meta) meta.textContent = `${rows.length} profiles · net ${money(tot.net)}`;

  const carrier = $('carrier-split');
  if (carrier) {
    const v = s.shipByVendor || {};
    carrier.innerHTML = `
      <div class="gp-card-head"><h3>Carrier split</h3>
        <span class="meta">Where the shipping spend went</span></div>
      <div class="gp-card-body" style="display:flex;gap:32px;flex-wrap:wrap">
        ${Object.entries(v).map(([name, d]) => `
          <div><div class="overline">${esc(name)}</div>
            <div class="mono" style="font-size:19px;font-weight:600;margin-top:6px">${money(d.paid || 0)}</div>
            <div class="t3" style="font-size:12px;margin-top:2px">${(d.orders || 0).toLocaleString()} orders</div>
          </div>`).join('')}
      </div>`;
  }
}

// ─── Reports screen ───────────────────────────────────────────────────────────

const TILES = [
  { id: 'subpl', name: 'Subscription P&L',
    desc: 'Per-delivery unit economics by subscription type — price, COGS, shipping and net GP.' },
  { id: 'lowsku', name: 'Low margin SKUs',
    desc: 'Products whose gross margin sits below your threshold, aggregated by SKU.' },
  { id: 'giftcard', name: 'Gift cards & influencer',
    desc: 'Zero-COGS gift card sales and gifted samples, separated from ordinary trade.' },
  { id: 'missing', name: 'Missing cost audit',
    desc: 'Every line with no matched cost, by vendor and SKU, with the revenue at stake.' },
];

export function renderReports(lines, s, openReport) {
  const subLines = lines.filter(l => /^(SUB|GSUB)/i.test(l.sku || ''));
  const subRev = subLines.reduce((a, l) => a + (l.lineRevenue || 0), 0);
  const subCogs = subLines.reduce((a, l) => a + (l.lineCogs || 0), 0);
  const subscribers = new Set(subLines.filter(l => (l.lineRevenue || 0) > 0).map(l => l.orderNum)).size;
  const attributed = s.productRevenue || 0;

  const kpis = $('report-kpis');
  if (kpis) kpis.innerHTML = `
    <div class="gp-kpi gp-kpi-sm"><div class="label">Subscription revenue</div>
      <div class="value">${money(subRev)}</div>
      <div class="s1">${attributed ? (subRev / attributed * 100).toFixed(1) : '0.0'}% of attributed revenue</div>
      <div class="s2">Recognised where it was collected</div></div>
    <div class="gp-kpi gp-kpi-sm"><div class="label">Subscription GP</div>
      <div class="value" style="color:var(--gp-pos)">${money(subRev - subCogs)}</div>
      <div class="s1">${subRev ? ((subRev - subCogs) / subRev * 100).toFixed(1) : '0.0'}% margin</div>
      <div class="s2">Revenue less product cost</div></div>
    <div class="gp-kpi gp-kpi-sm"><div class="label">Paying subscription orders</div>
      <div class="value">${subscribers.toLocaleString()}</div>
      <div class="s1">${subLines.length.toLocaleString()} subscription lines</div>
      <div class="s2">Deliveries included</div></div>`;

  const tiles = $('report-tiles');
  if (tiles) {
    tiles.innerHTML = TILES.map(t => `
      <div class="gp-tile">
        <div class="name">${esc(t.name)}</div>
        <div class="desc">${esc(t.desc)}</div>
        <button class="gp-btn gp-btn-sm" data-report="${t.id}">Open report</button>
      </div>`).join('');
    tiles.querySelectorAll('[data-report]').forEach(b =>
      b.addEventListener('click', () => openReport(b.dataset.report)));
  }
}
