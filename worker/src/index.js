/**
 * SB GP Worker — router
 * =====================
 * Credential classes (never interchangeable):
 *   /v1/ingest/*            X-Ingest-Secret     Windows collector, backfill tool
 *   /v1/admin/*             X-Admin-Secret      operator (the Cron handler calls the Worker in-process)
 *   /v1/auth/*              password → session  dashboard
 *   /v1/weeks, /v1/snapshot/*, /v1/history, /v1/compare
 *                           session (published only) or X-Admin-Secret (?includeDrafts=1)
 *
 * The Worker never returns a secret, a D1 credential or customer data.
 */
import { ApiError, json, errorResponse, withCors, preflight } from './http.js';
import { requireSecret, requireReader, login, logout, sessionInfo } from './auth.js';
import { ingestShopify, ingestShipStation, ingestHpd, ingestCatalog } from './ingest.js';
import { ingestShippingCostReport, listVersions, getVersion, acceptVersion, rejectVersion, rollbackActivation, getSegments, getEffectiveSummary } from './shippingCost.js';
import { listWeeks, getSnapshot, listOrders, getOrder, listIssues, scenarioInput, history, compare } from './read.js';
import { createAndCompute, recompute, revise, restateCosts, listRestatements, weekPlan, getReadiness, createCatalogRefresh, getCatalogRefresh,
         reviseTouchedWeeks, catalogPushes, getRunDetail, publish, settings, backfill, shipstationFieldComparison, storage } from './admin.js';
import { adminCatalogFetch, adminCatalogBase } from './catalogFetch.js';
import { ENGINE_VERSION } from '../../shared/snapshot.js';
import { scheduledTick, automationStatus, acceptCycleCatalogReuse, adminCycleStatus } from './orchestrate.js';
import { environmentGuard, bindEnvironment } from './environment.js';

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = request.method;
  let g;

  if (p === '/v1/health' && m === 'GET') return json({ ok: true, engineVersion: ENGINE_VERSION, environment: env.SB_ENVIRONMENT || null });

  // C8: a Worker never touches a D1 database bound to another environment.
  const bindCall = p === '/v1/admin/environment/bind' && m === 'POST';
  if (bindCall) { requireSecret(request, env, 'admin'); return bindEnvironment(request, env); }
  const writes = m !== 'GET' && (p.startsWith('/v1/ingest/') || p.startsWith('/v1/admin/'));
  await environmentGuard(env, { write: writes });

  // ── Auth ──
  if (p === '/v1/auth/login' && m === 'POST') return login(request, env);
  if (p === '/v1/auth/logout' && m === 'POST') return logout(request, env);
  if (p === '/v1/auth/session' && m === 'GET') return sessionInfo(request, env);

  // ── Ingest ──
  if (p.startsWith('/v1/ingest/')) {
    requireSecret(request, env, 'ingest');
    if (p === '/v1/ingest/week-plan' && m === 'GET') return weekPlan(request, env);
    if (m !== 'POST') throw new ApiError(405, 'method_not_allowed', 'POST only');
    if (p === '/v1/ingest/shopify') return ingestShopify(request, env);
    if (p === '/v1/ingest/shipstation') return ingestShipStation(request, env);
    if (p === '/v1/ingest/hpd') return ingestHpd(request, env);
    if (p === '/v1/ingest/catalog') return ingestCatalog(request, env);
    if (p === '/v1/ingest/shipping-cost-report') return ingestShippingCostReport(request, env);
  }

  // ── Admin ──
  if (p.startsWith('/v1/admin/')) {
    requireSecret(request, env, 'admin');
    if (p === '/v1/admin/runs' && m === 'POST') return createAndCompute(request, env);
    if ((g = p.match(/^\/v1\/admin\/runs\/([\w-]+)$/)) && m === 'GET') return getRunDetail(env, g[1]);
    if ((g = p.match(/^\/v1\/admin\/runs\/([\w-]+)\/compute$/)) && m === 'POST') return recompute(request, env, g[1]);
    if (p === '/v1/admin/revise' && m === 'POST') return revise(request, env);
    if (p === '/v1/admin/restate-costs' && m === 'POST') return restateCosts(request, env);
    if (p === '/v1/admin/restatements' && m === 'GET') return listRestatements(request, env);
    if (p === '/v1/admin/revise-touched' && m === 'POST') return reviseTouchedWeeks(request, env);
    if (p === '/v1/admin/week-plan' && m === 'GET') return weekPlan(request, env);
    if (p === '/v1/admin/readiness' && m === 'GET') return getReadiness(request, env);
    if (p === '/v1/admin/catalog-refresh' && m === 'POST') return createCatalogRefresh(request, env);
    if (p === '/v1/admin/catalog-pushes' && m === 'GET') return catalogPushes(request, env);
    if (p === '/v1/admin/catalog/fetch' && m === 'POST') return adminCatalogFetch(request, env);
    if (p === '/v1/admin/catalog/base' && m === 'POST') return adminCatalogBase(request, env);
    if ((g = p.match(/^\/v1\/admin\/cycles\/(\d{4}-\d{2}-\d{2})$/)) && m === 'GET') return adminCycleStatus(env, g[1]);
    if ((g = p.match(/^\/v1\/admin\/cycles\/(\d{4}-\d{2}-\d{2})\/accept-catalog-reuse$/)) && m === 'POST') return acceptCycleCatalogReuse(request, env, g[1]);
    if ((g = p.match(/^\/v1\/admin\/catalog-refresh\/([\w-]+)$/)) && m === 'GET') return getCatalogRefresh(env, g[1]);
    if (p === '/v1/admin/publish' && m === 'POST') return publish(request, env);
    if (p === '/v1/admin/settings' && (m === 'GET' || m === 'POST')) return settings(request, env);
    if (p === '/v1/admin/backfill' && m === 'POST') return backfill(request, env);
    if (p === '/v1/admin/shipstation-field-comparison' && m === 'POST') return shipstationFieldComparison(request, env);
    if (p === '/v1/admin/storage' && m === 'GET') return storage(request, env);
    if (p === '/v1/admin/shipping-cost/versions' && m === 'GET') return listVersions(env);
    if ((g = p.match(/^\/v1\/admin\/shipping-cost\/versions\/([\w-]+)$/)) && m === 'GET') return getVersion(env, g[1]);
    if ((g = p.match(/^\/v1\/admin\/shipping-cost\/versions\/([\w-]+)\/accept$/)) && m === 'POST') return acceptVersion(request, env, g[1]);
    if ((g = p.match(/^\/v1\/admin\/shipping-cost\/versions\/([\w-]+)\/reject$/)) && m === 'POST') return rejectVersion(request, env, g[1]);
    if ((g = p.match(/^\/v1\/admin\/shipping-cost\/activations\/([\w-]+)\/rollback$/)) && m === 'POST') return rollbackActivation(request, env, g[1]);
    if (p === '/v1/admin/shipping-cost/segments' && m === 'GET') return getSegments(env);
    if (p === '/v1/admin/shipping-cost/effective' && m === 'GET') return getEffectiveSummary(env);
  }

  // ── Reads ──
  if (m === 'GET') {
    if (p === '/v1/weeks') return listWeeks(request, env, await requireReader(request, env));
    if (p === '/v1/history') return history(request, env, await requireReader(request, env));
    if (p === '/v1/automation/status') return automationStatus(request, env, await requireReader(request, env));
    if (p === '/v1/compare') return compare(request, env, await requireReader(request, env));
    if ((g = p.match(/^\/v1\/snapshot\/(\d{4}-\d{2}-\d{2})$/))) return getSnapshot(request, env, await requireReader(request, env), g[1]);
    if ((g = p.match(/^\/v1\/snapshot\/(\d{4}-\d{2}-\d{2})\/orders$/))) return listOrders(request, env, await requireReader(request, env), g[1]);
    if ((g = p.match(/^\/v1\/snapshot\/(\d{4}-\d{2}-\d{2})\/orders\/([^/]+)$/))) return getOrder(request, env, await requireReader(request, env), g[1], decodeURIComponent(g[2]));
    if ((g = p.match(/^\/v1\/snapshot\/(\d{4}-\d{2}-\d{2})\/issues$/))) return listIssues(request, env, await requireReader(request, env), g[1]);
    if ((g = p.match(/^\/v1\/snapshot\/(\d{4}-\d{2}-\d{2})\/scenario-input$/))) return scenarioInput(request, env, await requireReader(request, env), g[1]);
  }

  throw new ApiError(404, 'not_found', 'No such route');
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return preflight(request, env);
    let response;
    try { response = await route(request, env); }
    catch (e) { response = errorResponse(e); }
    return withCors(response, request, env);
  },
  /**
   * C7 Cron entry. No cron trigger is configured in wrangler.toml, and the tick
   * does nothing unless AUTOMATION_ENABLED = "true". Tests call it directly.
   */
  async scheduled(event, env, ctx) {
    const p = environmentGuard(env, { write: true })
      .then(() => scheduledTick(env, new Date(event?.scheduledTime ?? Date.now())), e => ({ skipped: e.code || 'environment_guard' }));
    if (ctx?.waitUntil) ctx.waitUntil(p.catch(() => {}));
    return p;
  },
};
