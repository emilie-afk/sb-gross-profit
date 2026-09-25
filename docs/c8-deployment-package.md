# C8 deployment package (prepared, NOT executed)

Nothing here has been run against Cloudflare, Netlify or the office PC. Every
value in angle brackets is a placeholder. Real values live only in Cloudflare
secrets, the Netlify environment, Windows Credential Manager and the password
manager, never in Git. All five controls stay **false** until the last section,
and each step there needs its own explicit approval:

- `shipping_cost_report_source_verified`
- `provisional_publication_enabled`
- `publication_enabled`
- `PUBLICATION_ALLOWED`
- `AUTOMATION_ENABLED`

Order of work: **staging first** (all of sections 1–4 with `--env staging`,
then `docs/deploy-preview-acceptance.md` and `docs/c8-live-acceptance.md`),
then production with automation disabled, then the shadow run.

## 1. D1 migrations (in this order; both databases start empty)

| # | File | Adds |
| --- | --- | --- |
| 1 | `0001_source.sql` | normalized Shopify / ShipStation / HPD source tables |
| 2 | `0002_snapshot.sql` | cost catalogs, reporting runs, immutable snapshots |
| 3 | `0003_ops.sql` | ingest runs, settings (publication off), auth attempts, storage |
| 4 | `0004_publish_unique.sql` | at most one published snapshot per week |
| 5 | `0005_revision6.sql` | catalog refresh / freshness / restatement, settings audit |
| 6 | `0006_revision7.sql` | schedule cycle ownership; store time zone confirmed (audited) |
| 7 | `0007_automation.sql` | Worker-owned automation tables |
| 8 | `0008_shipping_cost_report.sql` | Shipping Cost Report versions, rows, segments, activations |
| 9 | `0009_c3_shipping_policy.sql` | C3 shipping-policy settings (source unverified, provisional off) |
| 10 | `0010_c6d_catalog_overlay.sql` | base catalog + Products Master overlay |
| 11 | `0011_c7_orchestration.sql` | waiting / timeout cycle columns, automation lease and events |

```
cd worker
npx wrangler d1 create sb-gp-staging                    # put the id in [env.staging] (placeholder today)
npx wrangler d1 migrations apply sb-gp-staging --remote --env staging
npx wrangler d1 migrations list  sb-gp-staging --remote --env staging   # expect 0001–0011 applied, none pending
# production, only after staging acceptance:
npx wrangler d1 create sb-gp                            # put the id in the top-level [[d1_databases]]
npx wrangler d1 migrations apply sb-gp --remote
npx wrangler d1 migrations list  sb-gp --remote
```

Never run the staging command without `--env staging`. The isolation guard
(section 2) makes a staging Worker on the production D1 refuse every request,
but the migration CLI does not pass through the Worker.

## 2. Worker secrets and configuration checklist

Per environment (`--env staging` for staging). Every value is different between environments.

| Name | Kind | Value |
| --- | --- | --- |
| `INGEST_SECRET` | secret | ≥ 32 random chars (`openssl rand -base64 48`) |
| `ADMIN_SECRET` | secret | ≥ 32 random chars, different |
| `SESSION_SIGNING_KEY` | secret | ≥ 32 random chars, different |
| `DASHBOARD_PASSWORD_HASH` | secret | `node tools/hash-password.mjs` output (never the password) |
| `CATALOG_SOURCES_JSON` | secret | Products Master public CSV export URLs keyed by source (deployment configuration, not a credential; never in Git or logs) |
| `ALLOWED_ORIGINS` | var | production `https://sb-profit.netlify.app`; staging = the branch-deploy origin **of the branch actually pushed** (the file names `weekly-automation-phase1`; update it if the review branch has another name) |
| `COOKIE_SAMESITE` | var | `Strict` |
| `SB_ENVIRONMENT` | var | `production` / `staging` (C8 isolation guard) |
| `PUBLICATION_ALLOWED` | var | `"false"` |
| `AUTOMATION_ENABLED` | var | `"false"` |
| `D1_QUOTA_BYTES` | var | `5000000000` |
| `SESSION_TTL_SECONDS` | var | staging only, `60` (expiry test); unset in production |
| cron trigger | config | **none** until section 7 step 2 |
| `TEST_HOOK`, `TEST_HOOKS_ENABLED`, `TEST_STALE_MS` | — | **never** set in any deployed environment |

After the migrations and the first deploy, bind the database once (audited):

```
curl -X POST https://<worker>/v1/admin/environment/bind -H "X-Admin-Secret: <admin secret>" \
     -H "Content-Type: application/json" -d '{"environment":"staging","reason":"initial bind"}'
```

Until bound, writes are refused (`database_environment_unbound`). A database
bound to the other environment refuses every request
(`database_environment_mismatch`).

Then register the overlay base catalog (`POST /v1/admin/catalog/base`) and set
`catalog_overlay_base_rev`, as C6d describes in `DEPLOYMENT.md`.

## 3. Netlify checklist

| Variable | Context | Value |
| --- | --- | --- |
| `SITE_PASSWORD` | all | existing site gate |
| `SB_WORKER_ORIGIN` | branch deploy → staging Worker origin; production → **unset until the shadow run passes** (the proxy answers 503 while unset, and the manual workflow is unchanged) | `https://<worker>.workers.dev` |
| `MCG_SHEET_URL`, `MCG_POTS_SHEET_URL`, `MCG_EXTRA_SHEET_URL`, `AS_SHEET_URL`, `HP_SHEET_URL`, `SKU_WEIGHTS_JSON`, `HP_COSTS_FOLDER_ID`, `GDRIVE_API_KEY`, `VENDOR_IMPORT_STRICT` | as today | unchanged by C8 |
| `CATALOG_PUSH_URL`, `SB_INGEST_SECRET` | branch deploy only, for the build-hook acceptance (A1–A11) | staging Worker base URL / staging ingest secret; retired after acceptance |

Edge functions: `auth` on `/*`, then `api-proxy` on `/api/v1/*`, as in
`netlify.toml`. Run `tools/proxy-smoke.mjs` against the branch deploy
(B1–B13).

## 4. Windows host checklist

1. Both collectors set up per `automation/shipstation-export/README.md` and `automation/shopify-export/README.md`: Node 20+, Chromium, recorded selectors, dedicated Shopify staff account, Gmail read-only authorization.
2. Credential Manager targets: `sb-shipstation-export`, `sb-shopify-export`, `sb-gmail-oauth-client`, `sb-gmail-readonly`, `sb-gp-ingest` (staging ingest secret first).
3. `automation/collector/config.local.json`: `workerUrl` = staging.
4. One task, "SB weekly collector": weekly Monday 15:05 ICT, plus at logon; `StartWhenAvailable`; `MultipleInstances IgnoreNew`; 3 h limit. Remove or disable the old per-collector tasks; keep the daily quarantine purges.
5. Run W1–W10, SH1–SH11 and SS1–SS8 (`docs/c8-live-acceptance.md`), recording aggregates with `npm run summary`.
6. Switching to production later means changing only `workerUrl` and the `sb-gp-ingest` credential.

## 5. Rollback procedure

| Layer | Action | Effect |
| --- | --- | --- |
| Dashboard | unset `SB_WORKER_ORIGIN` in Netlify production and redeploy | `/api/v1` answers 503; the manual upload workflow is untouched |
| Automation | `AUTOMATION_ENABLED = "false"`, remove the cron trigger, `wrangler deploy` | no tick runs; nothing is computed on schedule |
| Collection | `Disable-ScheduledTask "SB weekly collector"` | no uploads |
| Publication | `publication_enabled=false` (audited) and `PUBLICATION_ALLOWED="false"` | publish refused; published snapshots stay readable |
| Worker code | `npx wrangler deployments list`, then `npx wrangler rollback <version-id>` | the previous Worker version serves |
| Shipping data | `POST /v1/admin/shipping-cost/activations/<id>/rollback { reason }` (latest activation only, exact) | restores the prior segments; the tick drafts basis revisions |
| D1 data | `npx wrangler d1 time-travel info sb-gp`, then `… restore sb-gp --timestamp=<before>` | point-in-time restore (use only with an approved incident note; re-bind is not needed, since settings are restored too) |

Migrations are forward-only. Rolling back code never requires dropping tables,
because a later migration only adds columns and tables that older code ignores.

## 6. Production shadow run (one weekly cycle; nothing published)

1. Deploy production with all five controls false and **no cron trigger**. Bind the database (`production`). Register the base catalog.
2. Point the Windows collector at production (`workerUrl`, `sb-gp-ingest`). Let the Monday 15:05 run upload the Shopify rolling export and the Shipping Cost Report.
3. Accept the report version after review. Because C8 needs an accepted basis, the week stays `pending_review` until then.
4. Run the catalog fetch for the week (`POST /v1/admin/catalog/fetch { weekStart }`) or accept reuse with a reason.
5. Compute manually: `POST /v1/admin/runs { weekStart }`. With automation off, a scheduled call is refused (`automation_disabled`).
6. Compare with the manual dashboard calculation for the same week: revenue, COGS, shipping expense, GP, margin, missing-cost lines. Apply the materiality rule: a difference under $50 or 0.1% of revenue, whichever is lower, may be accepted if documented. Anything larger stops the rollout.
7. Record the result (aggregates only) and get approval before section 7.

## 7. Final control-enablement sequence (each step needs its own approval)

1. **Collection automation:** the Windows task stays enabled against production (already done in the shadow run).
2. **Worker orchestration:** add `[triggers] crons = ["*/15 * * * *"]` (UTC; hits 08:30, 08:45, …), set `AUTOMATION_ENABLED = "true"`, then deploy. Watch one full cycle: waiting, retries and one draft. **Open item:** decide what triggers the week's catalog refresh automatically. Today an admin runs `POST /v1/admin/catalog/fetch`, or accepts reuse (see the C8 report).
3. **Shipping source verification:** `shipping_cost_report_source_verified = true`, only after the verification checklist or a formally accepted limitation.
4. **Provisional dashboard updates:** `provisional_publication_enabled = true` (audited reason).
5. **Publication:** `publication_enabled = true` (audited) **and** `PUBLICATION_ALLOWED = "true"`, then deploy. This needs the final explicit approval. The Carrier Fee priority lock and the store-time-zone confirmation are also required, and neither switch overrides them.

## 8. Review artefacts

The C8 handoff (`claude/sb-gp-c8-handoff.md` in the project) holds the
following:

- the commit list;
- the cumulative test report;
- the tracked-file privacy and secret scan;
- the Git bundle, made from the common base with `origin/main`.
