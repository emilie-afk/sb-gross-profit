-- 0012 — Free-tier weekly path (redesign rev 3)
-- ============================================
-- The office PC computes each week with the unchanged shared engine; the Worker
-- validates and stores. Tables are content-addressed and WITHOUT ROWID where the
-- key is text, so one stored row costs one D1 write (no separate key index).
-- Nothing here changes a financial formula or any existing table's meaning.

-- Sanitized source files (Shopify rolling export, Shipping Cost Report), retained
-- only after every segment passed validation. Raw exports never reach the Worker.
CREATE TABLE IF NOT EXISTS src_object (
  source_id      TEXT PRIMARY KEY,               -- src_<id>
  kind           TEXT NOT NULL,                  -- shopify | shipping_cost_report
  sha256         TEXT NOT NULL,                  -- whole sanitized file
  status         TEXT NOT NULL,                  -- pending | retained | rejected
  segment_count  INTEGER NOT NULL,
  declared       TEXT NOT NULL,                  -- JSON: rows, cents, window, exportedAt, segment hashes
  summary        TEXT,                           -- JSON at seal: rows, per-date sums, review-flag counts (no values)
  error          TEXT,                           -- rejection code (never a value)
  created_at     TEXT NOT NULL,
  sealed_at      TEXT
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_src_object_sha ON src_object(kind, sha256) WHERE status <> 'rejected';

CREATE TABLE IF NOT EXISTS src_segment (
  source_id      TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  sha256         TEXT NOT NULL,                  -- of the gzip bytes
  rows           INTEGER NOT NULL,
  raw_bytes      INTEGER NOT NULL,
  facts          TEXT NOT NULL,                  -- JSON: per-date sums / flag counts from validation
  body           BLOB NOT NULL,                  -- gzip of the sanitized CSV segment (header repeated)
  PRIMARY KEY (source_id, seq)
) WITHOUT ROWID;

-- Normalized orders in their stored form, content-addressed; the pointer says
-- which body is in force for an order name.
CREATE TABLE IF NOT EXISTS ord_body (
  body_hash      TEXT PRIMARY KEY,               -- sha256 of the canonical string
  body           TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ord_ptr (
  order_name     TEXT PRIMARY KEY,
  order_number   TEXT NOT NULL,
  week_start     TEXT NOT NULL,
  body_hash      TEXT NOT NULL,
  source_id      TEXT NOT NULL,                  -- the retained Shopify source the body was derived from
  timezone       TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_ord_ptr_week ON ord_ptr(week_start);

-- Shipping Cost Report, date level: one row per (version, ship date) holding the
-- per-order groups of that date; one owner per ship date.
CREATE TABLE IF NOT EXISTS scr_version (
  version_id     TEXT PRIMARY KEY,               -- scr_<id>
  source_id      TEXT NOT NULL,
  requested_from TEXT NOT NULL,
  requested_to   TEXT NOT NULL,
  exported_at    TEXT,
  imported_at    TEXT NOT NULL,
  status         TEXT NOT NULL,                  -- accepted | partially_accepted | pending_review | rejected | no_change
  outcome        TEXT NOT NULL,                  -- JSON: per-date outcome codes, review reasons, counts (no amounts)
  decided_at     TEXT,
  decided_by     TEXT,
  decision_reason TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS scr_day (
  version_id     TEXT NOT NULL,
  ship_date      TEXT NOT NULL,
  day_hash       TEXT NOT NULL,
  cost_cents     INTEGER NOT NULL,
  row_count      INTEGER NOT NULL,
  groups         TEXT NOT NULL,                  -- JSON [[orderKey, costCents, rowCount], ...] sorted by orderKey
  outcome        TEXT NOT NULL,                  -- new | fill_in | held | activated_on_review
  PRIMARY KEY (version_id, ship_date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS scr_day_owner (
  ship_date      TEXT PRIMARY KEY,
  version_id     TEXT NOT NULL,
  day_hash       TEXT NOT NULL,
  activation_id  TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS scr_activation (
  activation_id  TEXT PRIMARY KEY,
  version_id     TEXT NOT NULL,
  at             TEXT NOT NULL,
  actor_class    TEXT NOT NULL,
  dates          TEXT NOT NULL,                  -- JSON [[date, previousVersionId|null, previousHash|null], ...] for exact rollback
  weeks          TEXT NOT NULL                   -- JSON weeks whose shipping costs changed (they get draft revisions)
) WITHOUT ROWID;

-- Collector-computed results. Parts are gzip JSON, stored under the future
-- snapshot id; the snapshot row appears only at finalize.
CREATE TABLE IF NOT EXISTS result_upload (
  snapshot_id    TEXT PRIMARY KEY,
  week_start     TEXT NOT NULL,
  manifest_hash  TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  idx            TEXT NOT NULL,                  -- JSON: part hashes, per-order hashes, head, totals row, narrative, gate inputs
  manifest       TEXT NOT NULL,                  -- JSON: the pinned input manifest
  status         TEXT NOT NULL,                  -- open | finalized | abandoned
  created_at     TEXT NOT NULL,
  finalized_at   TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS snapshot_blob (
  snapshot_id    TEXT NOT NULL,
  part           TEXT NOT NULL,                  -- summary | sections | scenario | lines:<k>
  sha256         TEXT NOT NULL,                  -- of the uncompressed canonical JSON
  body           BLOB NOT NULL,                  -- gzip
  PRIMARY KEY (snapshot_id, part)
) WITHOUT ROWID;

-- Independent verification (Netlify Function gp-verify). A chunked snapshot is
-- labelled Verified only when this says `verified`; field differences are kept
-- here for the logged-in dashboard and never returned to the verifier's caller.
CREATE TABLE IF NOT EXISTS verify_report (
  snapshot_id    TEXT PRIMARY KEY,
  status         TEXT NOT NULL,                  -- verified | mismatch | unavailable
  report         TEXT NOT NULL,                  -- JSON counts/codes only
  diff           TEXT,                           -- JSON field-level differences (mismatch only)
  attempts       INTEGER NOT NULL,
  first_at       TEXT NOT NULL,
  at             TEXT NOT NULL
) WITHOUT ROWID;

ALTER TABLE snapshot ADD COLUMN storage TEXT NOT NULL DEFAULT 'rows';     -- rows | chunked
ALTER TABLE snapshot ADD COLUMN manifest_hash TEXT;

-- Owner decision 2026-09-29: per-row Shipping Cost review threshold (cents), audited.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('shipping_cost_review_cap_cents', '10000', '2026-09-30T00:00:00.000Z');
