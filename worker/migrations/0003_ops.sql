-- 0003_ops.sql — ingestion runs, settings, auth state, storage monitoring

CREATE TABLE IF NOT EXISTS ingest_run (
  run_id            TEXT PRIMARY KEY,
  source            TEXT NOT NULL,             -- shopify | shipstation | hpd | catalog
  week_start        TEXT,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  rows_seen         INTEGER NOT NULL DEFAULT 0,
  rows_written      INTEGER NOT NULL DEFAULT 0,
  duplicates        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,             -- running | ok | failed
  error             TEXT,
  diagnostics       TEXT NOT NULL DEFAULT '{}' -- level-1 import diagnostics; header names only
);

-- Thresholds and switches live here, never in shared calculation code.
CREATE TABLE IF NOT EXISTS settings (
  key               TEXT PRIMARY KEY,
  value             TEXT NOT NULL,             -- JSON
  updated_at        TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('ss_coverage_threshold',       '0.95',                    '2026-09-24T00:00:00Z'),
  ('catalog_shrink_tolerance',    '0.10',                    '2026-09-24T00:00:00Z'),
  ('publication_enabled',         'false',                   '2026-09-24T00:00:00Z'),
  ('carrier_fee_priority_locked', 'false',                   '2026-09-24T00:00:00Z'),
  ('insurance_treatment',         '"awaiting_confirmation"', '2026-09-24T00:00:00Z'),
  ('store_timezone',              '"America/Los_Angeles"',   '2026-09-24T00:00:00Z');

-- Login attempts for rate limiting. The address is stored only as a keyed hash.
CREATE TABLE IF NOT EXISTS auth_attempt (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_at        TEXT NOT NULL,
  ip_hash           TEXT NOT NULL,
  outcome           TEXT NOT NULL              -- ok | fail | limited
);
CREATE INDEX IF NOT EXISTS idx_auth_attempt ON auth_attempt(ip_hash, attempt_at);

-- Sessions revoked by logout before they expire.
CREATE TABLE IF NOT EXISTS session_revocation (
  jti               TEXT PRIMARY KEY,
  revoked_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_usage (
  measured_at       TEXT PRIMARY KEY,
  bytes_used        INTEGER NOT NULL,
  pct_of_quota      REAL NOT NULL
);
