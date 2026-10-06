/**
 * SB GP Worker — router
 * =====================
 * Credential classes (never interchangeable):
 *   /v1/ingest/*            X-Ingest-Secret     Windows collector, backfill tool
 *   /v1/admin/*             X-Admin-Secret      operator (the Cron handler calls the Worker in-process)
 *   /v1/auth/*              password → session  dashboard
 *   /v1/weeks, /v1/snapshot/*, /v1/history, /v1/compare
 *                           session (published only) or X-Admin-Secret (?includeDrafts=1)
 *   /v1/collect/*           X-Ingest-Secret     Free-tier path: sources, orders, SCR dates, results
 *                           (read-only parts also X-Verify-Secret)
 *   /v1/verify/*            X-Verify-Secret     independent verifier (Netlify Function gp-verify)
 *
 * The Worker never returns a secret, a D1 credential or customer data.
 */
import { ApiError, json, errorResponse, withCors, preflight } from './http.js';
import { openCatalogUpload, putCatalogChunk, sealCatalogUpload } from './catalogUpload.js';
import { requireSecret, requireReader, login, logout, sessionInfo } from './auth.js';
import { ingestShopify, ingestShipStation, ingestHpd, ingestCatalog } from './ingest.js';
import { ingestShippingCostReport, listVersions, getVersion, acceptVersion, rejectVersion, rollbackActivation, getSegments, getEffectiveSummary } from './shippingCost.js';
import { listWeeks, getSnapshot, listOrders, getOrder, listIssues, scenarioInput, history, compare } from './read.js';
import { createAndCompute, recompute, revise, restateCosts, listRestatements, weekPlan, getReadiness, createCatalogRefresh, getCatalogRefresh,
         reviseTouchedWeeks, catalogPushes, getRunDetail, publish, settings, backfill, shipstationFieldComparison, storage, acceptWeekPinnedCatalog } from './admin.js';
import { adminCatalogFetch, adminCatalogBase } from './catalogFetch.js';
import { ENGINE_VERSION } from '../../shared/snapshot.js';
import { scheduledTick, automationStatus, acceptCycleCatalogReuse, adminCycleStatus } from './orchestrate.js';
import { publishLatestVerified } from './compute.js';
import { environmentGuard, bindEnvironment, isSafeRead } from './environment.js';
import { requireOneOf } from './auth.js';
import { openSource, putSegment, sealSource, getSourceMeta, getSegment } from './collectSources.js';
import { uploadScrVersion, getScrOwners, getScrDays, listScrVersions, getScrVersion, acceptScrVersion, rejectScrVersion, rollbackScrActivation } from './collectScr.js';
import { ordersDiff, uploadOrders, getManifest, orderBodies, catalogPart, weekAux, pinAux, openResults, putResultPart, finalizeResults } from './collectWeeks.js';
import { pendingVerifications, verifyInputs, verifyPart, postVerifyReport } from './verifyRoutes.js';
import { getWeekStatus, verificationStatuses } from './weekStatus.js';

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = request.method;
  let g;

  if (p === '/v1/health' && m === 'GET') return json({ ok: true, engineVersion: ENGINE_VERSION, environment: env.SB_ENVIRONMENT || null });

  // C8: a Worker never touches a D1 database bound to another environment.
  const bindCall = p === '/v1/admin/environment/bind' && m === 'POST';
  if (bindCall) { requireSecret(request, env, 'admin'); return bindEnvironment(request, env); }
  // Explicit safe-read classification: login, logout, ingest, admin and any
  // unknown or future route count as writes.
  await environmentGuard(env, { write: !isSafeRead(m, p) });

  // ── Auth ──
  if (p === '/v1/auth/login' && m === 'POST') return login(request, env);
  if (p === '/v1/auth/logout' && m === 'POST') return logout(request, env);
  if (p === '/v1/auth/session' && m === 'GET') return sessionInfo(request, env);

  // ── Ingest ──
  if (p.startsWith('/v1/ingest/')) {
    requireSecret(request, env, 'ingest');
    if (p === '/v1/ingest/week-plan' && m === 'GET') return weekPlan(request, env);
    // Chunked catalog push (bounded CPU per request); the one-request POST /v1/ingest/catalog stays.
    if ((g = p.match(/^\/v1\/ingest\/catalog\/uploads\/(cup_[0-9a-f]{20})\/chunks\/([a-z_]{1,40})\/(\d{1,4})$/)) && m === 'PUT') return putCatalogChunk(request, env, g[1], g[2], g[3]);
    if (p === '/v1/ingest/catalog/uploads' && m === 'POST') return openCatalogUpload(request, env);
    if ((g = p.match(/^\/v1\/ingest\/catalog\/uploads\/(cup_[0-9a-f]{20})\/seal$/)) && m === 'POST') return sealCatalogUpload(request, env, g[1]);
    if (m !== 'POST') throw new ApiError(405, 'method_not_allowed', 'POST only');
    if (p === '/v1/ingest/shopify') return ingestShopify(request, env);
    if (p === '/v1/ingest/shipstation') return ingestShipStation(request, env);
    if (p === '/v1/ingest/hpd') return ingestHpd(request, env);
    if (p === '/v1/ingest/catalog') return ingestCatalog(request, env);
    if (p === '/v1/ingest/shipping-cost-report') return ingestShippingCostReport(request, env);
  }

  // ── Free-tier collector path ──
  if (p.startsWith('/v1/collect/')) {
    const W = '(\\d{4}-\\d{2}-\\d{2})';
    // Read-only parts, shared with the verifier.
    if ((g = p.match(new RegExp(`^/v1/collect/weeks/${W}/manifest$`))) && m === 'GET') { requireOneOf(request, env, ['ingest', 'verify']); return getManifest(env, g[1]); }
    if ((g = p.match(new RegExp(`^/v1/collect/weeks/${W}/aux$`))) && m === 'GET') { requireOneOf(request, env, ['ingest', 'verify']); return weekAux(env, g[1]); }
    if (p === '/v1/collect/order-bodies' && m === 'POST') { requireOneOf(request, env, ['ingest', 'verify']); return orderBodies(request, env); }
    if (p === '/v1/collect/scr/days' && m === 'POST') { requireOneOf(request, env, ['ingest', 'verify']); return getScrDays(request, env); }
    if ((g = p.match(/^\/v1\/collect\/catalog\/(cat_[0-9a-f]{16})\/parts\/([\w-]+)\/(\d+)$/)) && m === 'GET') { requireOneOf(request, env, ['ingest', 'verify']); return catalogPart(env, g[1], g[2], g[3]); }
    if ((g = p.match(/^\/v1\/collect\/sources\/(src_[0-9a-f]{20})$/)) && m === 'GET') { requireOneOf(request, env, ['ingest', 'verify']); return getSourceMeta(env, g[1]); }
    if ((g = p.match(/^\/v1\/collect\/sources\/(src_[0-9a-f]{20})\/segments\/(\d+)$/)) && m === 'GET') { requireOneOf(request, env, ['ingest', 'verify']); return getSegment(env, g[1], g[2]); }
    // Writes (and the week's collection status): the collector only.
    requireSecret(request, env, 'ingest');
    if ((g = p.match(new RegExp(`^/v1/collect/weeks/${W}/status$`))) && m === 'GET') return getWeekStatus(env, g[1]);
    if (p === '/v1/collect/verification' && m === 'GET') return verificationStatuses(request, env);
    if (p === '/v1/collect/sources' && m === 'POST') return openSource(request, env);
    if ((g = p.match(/^\/v1\/collect\/sources\/(src_[0-9a-f]{20})\/segments\/(\d+)$/)) && m === 'PUT') return putSegment(request, env, g[1], g[2]);
    if ((g = p.match(/^\/v1\/collect\/sources\/(src_[0-9a-f]{20})\/seal$/)) && m === 'POST') return sealSource(request, env, g[1]);
    if (p === '/v1/collect/scr/versions' && m === 'POST') return uploadScrVersion(request, env);
    if (p === '/v1/collect/scr/owners' && m === 'POST') return getScrOwners(request, env);
    if (p === '/v1/collect/orders/diff' && m === 'POST') return ordersDiff(request, env);
    if (p === '/v1/collect/orders' && m === 'POST') return uploadOrders(request, env);
    if ((g = p.match(new RegExp(`^/v1/collect/weeks/${W}/aux-pin$`))) && m === 'POST') return pinAux(env, g[1]);
    if ((g = p.match(new RegExp(`^/v1/collect/weeks/${W}/results$`))) && m === 'POST') return openResults(request, env, g[1]);
    if ((g = p.match(/^\/v1\/collect\/results\/(snp_[0-9a-f]{20})\/parts\/(orderindex|sections|orders:\d{1,4}|lines:\d{1,4}|scenario:\d{1,4})$/)) && m === 'PUT') return putResultPart(request, env, g[1], g[2]);
    if ((g = p.match(/^\/v1\/collect\/results\/(snp_[0-9a-f]{20})\/finalize$/)) && m === 'POST') return finalizeResults(request, env, g[1]);
    if ((g = p.match(new RegExp(`^/v1/collect/weeks/${W}/publish$`))) && m === 'POST') return json(await publishLatestVerified(env, g[1]));
    throw new ApiError(404, 'not_found', 'No such route');
  }

  // ── Independent verifier ──
  if (p.startsWith('/v1/verify/')) {
    requireSecret(request, env, 'verify');
    if (p === '/v1/verify/pending' && m === 'GET') return pendingVerifications(env);
    if ((g = p.match(/^\/v1\/verify\/snapshots\/(snp_[0-9a-f]{20})$/)) && m === 'GET') return verifyInputs(env, g[1]);
    if ((g = p.match(/^\/v1\/verify\/snapshots\/(snp_[0-9a-f]{20})\/parts\/(orderindex|sections|orders:\d{1,4}|lines:\d{1,4}|scenario:\d{1,4})$/)) && m === 'GET') return verifyPart(env, g[1], g[2]);
    if ((g = p.match(/^\/v1\/verify\/snapshots\/(snp_[0-9a-f]{20})\/report$/)) && m === 'POST') return postVerifyReport(request, env, g[1]);
    throw new ApiError(404, 'not_found', 'No such route');
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
    if ((g = p.match(/^\/v1\/admin\/weeks\/(\d{4}-\d{2}-\d{2})\/accept-pinned-catalog$/)) && m === 'POST') return acceptWeekPinnedCatalog(request, env, g[1]);
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
    // Free-tier Shipping Cost Report versions (date level)
    if (p === '/v1/admin/scr/versions' && m === 'GET') return listScrVersions(env);
    if ((g = p.match(/^\/v1\/admin\/scr\/versions\/(scr_[0-9a-f]{20})$/)) && m === 'GET') return getScrVersion(env, g[1]);
    if ((g = p.match(/^\/v1\/admin\/scr\/versions\/(scr_[0-9a-f]{20})\/accept$/)) && m === 'POST') return acceptScrVersion(request, env, g[1]);
    if ((g = p.match(/^\/v1\/admin\/scr\/versions\/(scr_[0-9a-f]{20})\/reject$/)) && m === 'POST') return rejectScrVersion(request, env, g[1]);
    if ((g = p.match(/^\/v1\/admin\/scr\/activations\/(sca_[0-9a-f]{20})\/rollback$/)) && m === 'POST') return rollbackScrActivation(request, env, g[1]);
  }

  // ── Reads ──
  if (m === 'GET') {
    if (p === '/v1/weeks') return listWeeks(request, env, await requireReader(request, env));
    if (p === '/v1/history') return history(request, env, await requireReader(request, env));
    if (p === '/v1/automation/status') return automationStatus(request, env, await requireReader(request, env));
    if (p === '/v1/compare') return compare(request, env, await requireReader(request, env));
    if ((g = p.match(/^\/v1\/weeks\/(\d{4}-\d{2}-\d{2})\/status$/))) { await requireReader(request, env); return getWeekStatus(env, g[1]); }
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
