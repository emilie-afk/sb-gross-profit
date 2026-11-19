-- 0005_revision6.sql — catalog versioning, freshness, atomic publish, audit,
-- schedule settings, staff-identity removal. Publication stays disabled.

-- ── Staff identity is not stored (ShipStation "Created By" may be an email) ──
ALTER TABLE shipment DROP COLUMN created_by;
ALTER TABLE shipment ADD COLUMN created_by_class TEXT;           -- blank | integration | person

-- ── Catalog selection recorded on runs and snapshots ─────────────────────────
-- catalog_info JSON: { rev, capturedAt, basis, refreshId, freshness: { status, reason, acceptance? } }
ALTER TABLE reporting_run ADD COLUMN catalog_info TEXT;
ALTER TABLE reporting_run ADD COLUMN reason TEXT;
ALTER TABLE snapshot ADD COLUMN catalog_info TEXT;
-- Which published prior-week snapshot the stored narrative compares with (NULL = none).
ALTER TABLE snapshot ADD COLUMN comparison_snapshot_id TEXT;
-- Admin-only preview against an unpublished prior week; never part of history.
ALTER TABLE snapshot ADD COLUMN draft_comparison TEXT;
-- hpd_actual | hpd_pass_through_assumed | NULL, per order.
ALTER TABLE snapshot_order ADD COLUMN hpd_shipping_basis TEXT;
-- Set by the publish transaction; later statements in the same batch key on it.
ALTER TABLE snapshot ADD COLUMN publish_token TEXT;

-- When identical catalog content is pushed again, it becomes the latest again.
ALTER TABLE cost_catalog ADD COLUMN last_pushed_at TEXT;

-- One expected catalog refresh per scheduled cycle (Make S5 → Netlify build → catalog push).
CREATE TABLE IF NOT EXISTS catalog_refresh (
  refresh_id        TEXT PRIMARY KEY,
  week_start        TEXT NOT NULL,
  requested_at      TEXT NOT NULL,
  requested_by_class TEXT NOT NULL,            -- server-assigned from the auth path
  requested_by_label TEXT,                     -- caller-supplied tag, not verified identity
  status            TEXT NOT NULL,             -- pending | fulfilled | rejected
  catalog_rev       TEXT,
  resolved_at       TEXT,
  detail            TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_catalog_refresh_week ON catalog_refresh(week_start, requested_at);

-- Applying a different catalog to a week that already has snapshots.
CREATE TABLE IF NOT EXISTS cost_restatement (
  restatement_id    TEXT PRIMARY KEY,
  week_start        TEXT NOT NULL,
  run_id            TEXT NOT NULL,
  from_catalog_rev  TEXT,
  to_catalog_rev    TEXT NOT NULL,
  reason            TEXT NOT NULL,
  actor_class       TEXT NOT NULL,             -- server-assigned (see 0002 run_transition)
  actor_label       TEXT,                      -- caller-supplied tag, not verified identity
  at                TEXT NOT NULL
);

-- An administrator accepting a stale catalog for one run.
CREATE TABLE IF NOT EXISTS catalog_reuse_acceptance (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL,
  week_start        TEXT NOT NULL,
  catalog_rev       TEXT NOT NULL,
  reason            TEXT NOT NULL,
  actor_class       TEXT NOT NULL,             -- server-assigned (see 0002 run_transition)
  actor_label       TEXT,                      -- caller-supplied tag, not verified identity
  at                TEXT NOT NULL
);

-- Every settings change, with who and why.
CREATE TABLE IF NOT EXISTS settings_audit (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  key               TEXT NOT NULL,
  old_value         TEXT,
  new_value         TEXT NOT NULL,
  reason            TEXT,
  actor_class       TEXT NOT NULL,             -- server-assigned (see 0002 run_transition)
  actor_label       TEXT,                      -- caller-supplied tag, not verified identity
  at                TEXT NOT NULL
);

-- Ingest runs: which kind of pull, and which earlier weeks its changes touched.
ALTER TABLE ingest_run ADD COLUMN mode TEXT;                     -- week | updated_since | NULL
ALTER TABLE ingest_run ADD COLUMN weeks_touched TEXT NOT NULL DEFAULT '{}';   -- { "YYYY-MM-DD": changedRecords }

-- A statement that inserts NULL here aborts the whole batch (NOT NULL), which
-- is how a publish transaction refuses to run when its preconditions fail.
CREATE TABLE IF NOT EXISTS write_guard (ok INTEGER NOT NULL);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('store_timezone_confirmed', 'false',                 '2026-09-24T00:00:00Z'),
  ('schedule_timezone',        '"Asia/Ho_Chi_Minh"',    '2026-09-24T00:00:00Z'),
  ('schedule_weekday',         '1',                     '2026-09-24T00:00:00Z'),
  ('schedule_time',            '"15:30"',               '2026-09-24T00:00:00Z');
