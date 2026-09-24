# Deploy-preview acceptance (Revision 8)

These checks need a real Netlify build and a real Worker, so they cannot run in
the unit or Miniflare suites. **Status: NOT RUN.** Nothing has been deployed.
Do not mark any line as passed until it has actually run against the preview.

Publication stays off throughout: the staging Worker keeps
`PUBLICATION_ALLOWED = "false"`, and `publication_enabled` and
`carrier_fee_priority_locked` stay false.

## Environment

| Piece | Value |
| --- | --- |
| Worker | the **staging** environment in `worker/wrangler.toml` (`[env.staging]`: name `sb-gp-worker-staging`, its own D1 `sb-gp-staging`, `PUBLICATION_ALLOWED = "false"`, `SESSION_TTL_SECONDS = "60"`). Run `wrangler d1 create sb-gp-staging`, put its id in `[env.staging]`, then `wrangler d1 migrations apply sb-gp-staging --remote --env staging`, `wrangler secret put … --env staging` (four secrets, different from production) and `wrangler deploy --env staging`. Never point staging at the production `sb-gp` database. |
| Netlify | a **branch deploy** of `weekly-automation-phase1`. Build hooks build a branch, so the hook uses `trigger_branch`. |
| Netlify env, branch-deploy context | `CATALOG_PUSH_URL` = staging Worker base URL; `SB_INGEST_SECRET` = staging ingest secret; `SB_WORKER_ORIGIN` = staging Worker origin; `SITE_PASSWORD` as usual |
| Build hook | Netlify → Site configuration → Build hooks → "SB GP catalog refresh (staging)", branch `weekly-automation-phase1` |

## A. Catalog refresh through the Netlify build hook

```
SB_WORKER_URL=… SB_ADMIN_SECRET=… SB_INGEST_SECRET=… NETLIFY_BUILD_HOOK=https://api.netlify.com/build_hooks/<id> \
  node tools/catalog-refresh-acceptance.mjs --branch weekly-automation-phase1 [--expiry]
```

The script sends the hook request exactly as Make S0 does: `POST`,
`Content-Type: application/json`, raw body `{"refreshId":"crf_…","weekStart":"…"}`.
It then waits for the build's catalog push (`GET /v1/admin/catalog-pushes`).

| # | Check | How | Result |
| --- | --- | --- | --- |
| A1 | Make's payload reaches the build as `INCOMING_HOOK_BODY` | Build log shows `Catalog push: answering catalog refresh crf_…`; the push echoes the same id | NOT RUN |
| A2 | `build.py` extracts the right id | push `refresh.refreshId` equals the id sent | NOT RUN |
| A3 | The push resolves **that** refresh | `GET /v1/admin/catalog-refresh/<id>` shows `fulfilled`, with `catalogRev` equal to the pushed revision | NOT RUN |
| A4 | Identical accepted content fulfils a new refresh | second refresh `fulfilled`, same `catalogRev` | NOT RUN |
| A5 | A build with no body, or with `{}`, resolves nothing | push `refresh.status = none`; a pending refresh stays `pending` | NOT RUN |
| A6 | A malformed id resolves nothing | `build.py` drops it, so the push carries none; the pending refresh stays `pending` | NOT RUN |
| A7 | An unrelated, well-formed id resolves nothing | push `refresh.status = unknown`; the pending refresh stays `pending` | NOT RUN |
| A8 | Rejected content marks the refresh `rejected` | direct push of a shrunken catalog to the staging Worker (forcing the live sheets to shrink is unsafe) | NOT RUN |
| A9 | An expired refresh is not fulfilled | `--expiry`: waits 46 minutes, then builds; the push reports `expired` | NOT RUN |
| A10 | Publication controls stay off on staging, before and after the run | script checks `publication_enabled=false`, `carrier_fee_priority_locked=false`, `PUBLICATION_ALLOWED=false` | NOT RUN |
| A11 | No staging request writes to the production D1 | script (with `PROD_WORKER_URL` + `PROD_ADMIN_SECRET`, read-only) finds no production catalog push since the run began; **and** manually: `wrangler d1 execute sb-gp --remote --command "SELECT COUNT(*) FROM ingest_run; SELECT COUNT(*) FROM catalog_refresh"` before and after, unchanged | NOT RUN |

Already covered offline:

- **Unit tests** (`worker/test/revision7.test.mjs`):
  - no, malformed, unknown, expired and unrelated refresh ids;
  - identical content;
  - rejected content;
  - `catalog_hook.py` parsing of `INCOMING_HOOK_BODY`: valid, reordered, empty, not JSON, a list, a non-string, uppercase, extra characters, wrong key.
- **Not covered offline:** anything that needs Netlify's build runtime.

## B. Dashboard → Worker through the real `/api/v1` proxy

```
SITE_PASSWORD=… DASHBOARD_PASSWORD=… node tools/proxy-smoke.mjs https://<branch>--sb-profit.netlify.app
```

| # | Check | Result |
| --- | --- | --- |
| B1 | The site password gate issues its cookie | NOT RUN |
| B2 | No session before login (401) | NOT RUN |
| B3 | Login through `/api/v1`; cookie is `HttpOnly; Secure; SameSite=Strict; Path=/` | NOT RUN |
| B4 | Session check (200) | NOT RUN |
| B5 | Published read `/api/v1/weeks` (200) | NOT RUN |
| B6 | Admin and ingest routes are not reachable (404) | NOT RUN |
| B7 | Cross-origin POST refused (403) | NOT RUN |
| B8 | Logout clears the cookie; a copied cookie is refused afterwards (401) | NOT RUN |
| B9 | Forged cookie refused (401) | NOT RUN |
| B10 | Expired session refused (401). Run the staging Worker with `SESSION_TTL_SECONDS = "60"` and add `--expired-wait 90` to the smoke script. | NOT RUN |

Already covered offline (`worker/test/proxy.test.mjs`): the real proxy module
in front of the real Worker handler, covering login, session, logout, expired
and revoked sessions, route allowlist, header stripping and the CSRF origin check.

The script refuses to run unless `SB_WORKER_URL` is the staging Worker.

## Sign-off

The revision is **not deploy-ready** until every A and B line above has
actually passed against the staging Worker, its staging D1, the Netlify branch
deploy and the real build hook.


Record the preview URL, the date, and each A/B result above, and attach the
output of both scripts. Only then may the dashboard read from the Worker.
