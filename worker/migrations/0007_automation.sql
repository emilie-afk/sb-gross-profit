-- 0007_automation.sql — Worker-owned weekly automation (replaces the Make design).
-- Operational tables only: no snapshot, run, catalog or publication table changes.
-- Publication stays disabled: this migration touches no publication control.

-- ── Sanitized uploads received from the Windows collector ────────────────────
-- One row per (source, sha256 of the sanitized payload as received). Re-sending
-- identical content is reported as `source_no_change`, not an error. Raw exports
-- never reach the Worker; their hashes stay in the collector's local manifest.
CREATE TABLE IF NOT EXISTS source_upload (
  source             TEXT NOT NULL,             -- shopify | shipstation
  sha256             TEXT NOT NULL,
  first_run_id       TEXT NOT NULL,
  first_received_at  TEXT NOT NULL,
  last_received_at   TEXT NOT NULL,
  times_received     INTEGER NOT NULL DEFAULT 1,
  row_count          INTEGER,
  PRIMARY KEY (source, sha256)
);

-- ── One sequencer tick at a time ─────────────────────────────────────────────
-- Compare-and-swap lease with expiry. Scheduled computes keep their own
-- schedule_cycle claim token; the lease only stops overlapping ticks from
-- repeating the same fetches.
CREATE TABLE IF NOT EXISTS automation_lease (
  name         TEXT PRIMARY KEY,
  holder       TEXT NOT NULL,
  acquired_at  TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

-- ── Automation and collector status (no customer data, no credentials) ───────
CREATE TABLE IF NOT EXISTS automation_event (
  event_id        TEXT PRIMARY KEY,
  week_start      TEXT,
  step            TEXT NOT NULL,               -- e.g. tick, catalog, readiness, compute, collector:shipstation
  status          TEXT NOT NULL,
  detail          TEXT,                        -- JSON; codes and counts only
  correlation_id  TEXT,
  actor_class     TEXT NOT NULL,
  actor_label     TEXT,
  at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS automation_event_week ON automation_event (week_start, at);
