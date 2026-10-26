# Gate release runbook (sb-gross-profit)

Branch gate-hardening-release on main 2783537 (the four gate commits, this runbook, and the deploy-context guard). Vendor classification is not part of this release.
Every step is yours to run or approve. No value below is a real secret; never paste one into chat or Git.

## 0. Netlify variable isolation (before anything else)
Decision (2026-10-26): staging stays, on the `weekly-automation-phase1` branch deploy only. Production and that branch are the
only builds that may read the private sources or push a catalog. In Netlify → sb-profit → Project configuration:
1. Deploy log visibility: **Private** (done 2026-10-26).
2. Sensitive variable policy for untrusted fork pull requests: **Require approval** (already set).
3. Environment variables (done 2026-10-26 except the staging password; values never pasted into chat):
   - Branch deploys are built for `weekly-automation-phase1` only (Build & deploy → Branches), so the generic **Branch
     deploys** context is the staging context. It is used instead of a branch-specific value on purpose: Netlify applies a
     branch-specific value to Deploy Previews opened from that branch too, the generic Branch deploys value it does not.
   - Every `*_SHEET_URL`, `SB_SKU_ALIAS_URL`, `SB_SKU_ALIAS_URL_2`, `HP_SKU_ALIAS_URL`, `HP_COSTS_FOLDER_ID`, `GDRIVE_API_KEY`,
     `CATALOG_PUSH_URL`, `SB_INGEST_SECRET`, `SITE_PASSWORD` (and the `SB_VERIFY_*` / `SB_WORKER_ORIGIN` values): a value
     in **Production** and **Branch deploys** only; Deploy Previews, Preview Server and Local development are empty.
     `SB_WORKER_READER_SECRET`: Production only.
   - `CATALOG_PUSH_URL`: checked in-page without showing values: Production is not a staging Worker host, Branch deploys is
     a staging `workers.dev` host. `SB_INGEST_SECRET`: the Production and Branch deploys values differ.
   - Credentials marked "Contains secret values": `GDRIVE_API_KEY`, `HP_COSTS_FOLDER_ID`, `SB_INGEST_SECRET`, `SB_VERIFY_SECRET`,
     `SB_VERIFY_TRIGGER_SECRET`, `SB_WORKER_READER_SECRET`, `SITE_PASSWORD` (Netlify then scopes it to Builds, Functions,
     Runtime; edge functions read the Functions scope).
   - `SITE_PASSWORD`: Branch deploys keeps the production password (owner decision 2026-10-26); it is set only in
     Production and Branch deploys, never in Deploy Previews.
   - A Deploy Preview now has no password, so its sign-in answers 503 and opens nothing. `build.py` also enforces the split
     (`deploy_context.py`): a Deploy Preview, any other branch deploy and `netlify dev` build with every private source and
     the push removed; production may not push to a staging Worker, and the staging branch only to one.
   - Check without printing values: the Environment variables page lists per variable which contexts have a value
     ("Empty" otherwise); after the next builds, each deploy log (now private) has a `[deploy context]` line naming the role
     and the ignored variable names. The next production build also confirms the secret-marked Drive values still work
     (HP costs read from Drive).
4. Check that no branch or preview build has pushed a catalog. A commit that is on `main` proves nothing by itself: a deploy
   preview or branch deploy can build the same commit. Match every pushed catalog to a **production** deploy:
   - In D1, list each push with its commit and build time:
     `SELECT upload_id, json_extract(meta,'$.commit') AS commit, json_extract(meta,'$.builtAt') AS built_at, json_extract(meta,'$.source') AS source, created_at FROM catalog_upload ORDER BY created_at`
     (and `SELECT catalog_rev, json_extract(meta,'$.commit'), json_extract(meta,'$.builtAt'), captured_at FROM cost_catalog ORDER BY captured_at`).
   - In Netlify → sb-profit → Deploys (or the deploys API, which returns `context`, `commit_ref`, `branch` and the build times),
     find for each row a deploy with **context = production**, the same `commit_ref`, and a build that ran at `built_at`
     (within the minutes of that build).
   - A push with no matching production deploy (context deploy-preview or branch-deploy, or no deploy at that time) came from
     a non-production build: stop, and treat that catalog as untrusted until it is reviewed (it is never deleted).
   Do this after items 1–3, so no new preview build can push while you check.

   **Result (2026-10-26, production D1, read-only):** 25 catalog uploads (Oct 2 – Oct 21), 10 accepted catalog revisions.
   - 20 uploads match a production deploy of the same commit, built within a minute of `built_at` (deploy times are shown
     in UTC+7 on the dashboard). For `4d2327d` (Oct 6) a production and a staging branch deploy built the same commit at the
     same time; the deploy logs settle it: production pushed `cat_99c82763…` (the revision in production D1), the branch
     deploy pushed a different revision to the staging Worker.
   - 5 uploads match no Netlify deploy. All are operator pushes from the release workspace, not builds (the push scripts are kept with the release records):
     Oct 2 07:35 UTC, the first production catalog (`cat_f9204acf…`, metadata of the staging build `2e80b5b` whose catalog
     it re-pushed); Oct 8 09:49 UTC (`a99dc6d` metadata) and Oct 9 08:44–08:46 UTC (`e6c8afd`, one full and two
     `correction_push`), the MCG pack-cost correction work.
   - No Deploy Preview or branch deploy pushed to production. The staging branch deploys push to the staging Worker.
   - **Acceptance of the 5 operator pushes: pending.** Record them as approved exceptions only after confirming each
     matches the intended initial catalog or pack-cost correction.
   - **Content check (2026-10-26, read-only; per-table canonical sha256 of the stored catalog parts):**
     - Oct 2 initial catalog `cat_f9204acf…`: every table identical to `cat_112803e1…`, the catalog the staging build of
       `2e80b5b` produced and the production build of `606a71b` pushed two hours later (only the revision id differs).
       **Matches the intended initial catalog.**
     - Oct 8 09:49 and Oct 9 08:44 uploads: sealed but **rejected** by the Worker (Calathea Collective SKU count more than
       10% below the newest catalog); no catalog became active from them. No effect.
     - Oct 9 08:45 and 08:46 correction uploads (`correctionOf` `cat_f9204acf…` and `cat_112803e1…`): both accepted as
       `cat_c29c7ed8…`, registered as correction `ccr_fc6c216c…` (Aug 3 – Sep 21 from `cat_f9204acf…`, Sep 28 from
       `cat_112803e1…`), as planned. Every table equals its base except the added `mcg_pack` (77 SKUs), which is identical
       to the pack table the production build of `090846d` read on Oct 8. **Differs from the approved Oct 6 change list**
       (kept outside the repository): 54 of its 60 costs match; 6 SKUs it left missing (the sheet showed $0 on Oct 6) carry
       the later sheet costs, and 17 SKUs are not on the list. In the corrected weeks this affects 3 order lines (details in
       the private release record, not here: this repository is public).
       **Owner decision needed** before these two are recorded as approved exceptions.

## Scripts for steps 1–5 (laptop, kept with the release records outside the repository)
- `release-gate-1.ps1` (`-DryRun` first: checks, live configuration, build only): steps 1, 2 and 3.1–3.2. It generates the
  gate secrets locally, pipes `GATE_SECRET` to wrangler and puts the two Netlify values on the clipboard one at a time;
  nothing is printed. Then you push the release to `main` (step 3.3).
- `release-gate-2.ps1`: waits for the new gate on production, moves the laptop's `production-release`, runs step 4's
  smoke test (masked password prompt) and the step 5 probe of an old deploy URL.

## 1. Back up
- `npx wrangler d1 export sb-gp --remote --output <encrypted folder outside the repo>\sb-gp-before-gate.sql`
- Note the published snapshot ids (`SELECT week_start, snapshot_id FROM snapshot WHERE status='published'`) and the two publication flags.

## 2. Secrets (generate each locally; none goes into chat)
Generate a value: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
- Worker: `npx wrangler secret put GATE_SECRET --config worker/wrangler.toml` (paste at the prompt)
- Netlify (Production scope): `SB_WORKER_GATE_SECRET` = the same value as `GATE_SECRET`
- Netlify: `GATE_SIGNING_KEY` = a second, different generated value (never the site password)
- Netlify (optional): `GATE_SESSION_EPOCH` = `1`

## 3. Deploy, back to back
1. Before deploying, record the current Worker version: `npx wrangler versions list --config worker/wrangler.toml` (the newest
   active one). This pre-gate version is **not** a rollback target once the new dashboard is live (see Rollback).
2. Worker first, from the release commit: `cd worker && npx wrangler deploy`. Record the new version id it prints: this is the
   gate-release Worker, the first rollback-compatible version. Until item 3 finishes, the old dashboard proxy's report reads
   return 401 (it does not send `X-Gate-Session`); sign-in still works.
3. Netlify: push the release commit to `main` (Netlify builds it). Record the production deploy id: the first rollback-compatible
   Netlify deploy. Everyone signs in once.

## 4. Check the deployed site
- `SITE_PASSWORD=… node tools/proxy-smoke.mjs https://sb-profit.netlify.app` → "All gate and proxy checks passed". It includes the encoded-path checks (`/x%2f..%2fdata/…` and variants → 400 for live and revoked sessions).
- Open the dashboard: a saved report, a provisional report, a CSV upload.
- `SELECT key, value FROM settings WHERE key IN ('publication_enabled','provisional_publication_enabled')` reads as in step 1.

## 5. Old deploys
Open an earlier deploy's own URL (`<deploy-id>--sb-profit.netlify.app`). If it still answers with the old gate, delete the deploys older than this release (needs your approval), keeping this release as the rollback target.

## Rollback
The new gate and proxy need the Worker's `/v1/gate/*` routes and its `X-Gate-Session` check; the pre-gate Worker has neither,
and the pre-gate dashboard brings back the replayable cookie. So the two halves are only ever rolled back together, and never
to a version older than this release.
- **Compatible targets only.** Worker: `npx wrangler rollback <version-id> --config worker/wrangler.toml` with the gate-release
  version id recorded in step 3.2, or a later version with the same gate routes; never an unqualified `wrangler rollback`, which
  goes to the previous (pre-gate) version right after this release. Netlify: publish the deploy recorded in step 3.3 or a later
  deploy of this release.
- **No compatible target yet** (the gate release itself is at fault): fix forward with a corrected commit, Worker first, then
  Netlify. Meanwhile use maintenance mode:
  - pause the collector's scheduled task on the office PC (no collection, compute or publication runs; the publication flags
    are not touched);
  - the dashboard needs no switch: if sign-in cannot work (Worker routes missing, a secret wrong), the gate answers 503
    "Sign-in is temporarily unavailable" and opens nothing. Published reports stay stored and come back with the fix.
- The gate secrets stay set in every case. Nothing in a rollback puts the old cookie or a constant back.

## Release notes
- Everyone signs in once (the old cookie format is refused).
- Logout revokes the session on the server: reports refuse it at once; cost data files (`data/*.json`, `/api/mcg-extra`) within up to 10 seconds across edge instances.
- Pages and scripts (public code) still load for a revoked session until it expires (at most 8 hours).
- Paths with an encoded `.`, `/` or `\` or a decoded dot segment answer 400.
- Sign-in: 10 attempts per minute per address (Netlify), and after 10 wrong passwords in 15 minutes that client (IPv4 address or IPv6 /64) is locked out for the window, even with the right password. No site-wide lockout.
