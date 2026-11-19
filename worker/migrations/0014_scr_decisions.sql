-- 0014 — Free-tier Shipping Cost Report review decisions
-- ======================================================
-- scr_decision: an audit row for every decision on a Shipping Cost Report version
-- (automatic activation, accept, reject a pending version, reject the held dates of a
-- partially accepted version, rollback), with the dates and the weeks it affected.
-- Codes and dates only, never amounts.
CREATE TABLE IF NOT EXISTS scr_decision (
  decision_id    TEXT PRIMARY KEY,               -- scd_<id>
  version_id     TEXT NOT NULL,
  kind           TEXT NOT NULL,                  -- auto_activate | accept | reject_version | reject_held | rollback
  at             TEXT NOT NULL,
  actor_class    TEXT NOT NULL,
  actor_label    TEXT,
  reason         TEXT NOT NULL,
  dates          TEXT NOT NULL,                  -- JSON dates the decision activated, rejected or restored
  weeks          TEXT NOT NULL                   -- JSON weeks whose inputs changed (they need a new draft revision)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_scr_decision_version ON scr_decision(version_id);
