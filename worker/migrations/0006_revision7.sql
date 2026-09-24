-- 0006_revision7.sql — scheduled-week ownership and the confirmed store time zone.
-- Publication stays disabled: this migration touches no publication control.

-- ── One scheduled cycle per reporting week, owned atomically ─────────────────
-- A scheduled compute first INSERTs this row (primary key = week) in the SAME
-- batch that creates its reporting run. Exactly one request can win. A request
-- that finds the row resumes the recorded run (compare-and-swap on
-- claim_token) instead of creating a second one.
CREATE TABLE IF NOT EXISTS schedule_cycle (
  week_start        TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,             -- the cycle's reporting run (inserted in the same batch)
  claim_token       TEXT NOT NULL,             -- rotated on every (re)claim
  claimed_at        TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  last_error        TEXT
);

-- The store time zone each order was normalized under (business date and week
-- depend on it). A week whose orders were normalized in another zone cannot pass
-- the gate until they are re-ingested.
ALTER TABLE shopify_order ADD COLUMN normalized_timezone TEXT;

-- ── Store time zone: confirmed from Shopify store settings (Pacific Time (US)) ──
-- Reporting weeks: Monday 00:00 → next Monday 00:00 in America/Los_Angeles; DST
-- comes from the IANA zone, never a fixed UTC−7/−8 offset.
INSERT INTO settings_audit (key, old_value, new_value, reason, actor_class, actor_label, at)
  SELECT 'store_timezone_confirmed', value, 'true', 'Confirmed from Shopify store settings: Pacific Time (US)',
         'migration', '0006_revision7', '2026-09-24T00:00:00Z'
  FROM settings WHERE key = 'store_timezone_confirmed';
INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES
  ('store_timezone',           '"America/Los_Angeles"', '2026-09-24T00:00:00Z'),
  ('store_timezone_confirmed', 'true',                  '2026-09-24T00:00:00Z');
