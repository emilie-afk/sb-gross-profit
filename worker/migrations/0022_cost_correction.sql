-- 0022 — Audited cost corrections for the Free-tier path
-- ======================================================
-- A correction names EXPLICIT weeks. For each, the catalog revision the week is on when the correction
-- is registered (from_catalog_rev, checked against the week's snapshot) and its corrected catalog
-- (to_catalog_rev: the same catalog with only the MCG pack table changed, checked when registered).
-- The week gets a NEW revision on to_catalog_rev while it is still on from_catalog_rev; earlier
-- revisions and their pinned catalogs are never changed. A week not named is never affected (future
-- weeks keep the normal catalog choice). A week is corrected when its newest revision is on
-- to_catalog_rev and carries the correction's id in its catalog record — never judged by timestamps.
CREATE TABLE IF NOT EXISTS cost_correction (
  correction_id   TEXT PRIMARY KEY,
  reason          TEXT NOT NULL,
  actor_class     TEXT NOT NULL,
  actor_label     TEXT,
  at              TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cost_correction_week (
  correction_id    TEXT NOT NULL REFERENCES cost_correction(correction_id),
  week_start       TEXT NOT NULL,
  from_catalog_rev TEXT NOT NULL,
  to_catalog_rev   TEXT NOT NULL,
  PRIMARY KEY (correction_id, week_start)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_cost_correction_week ON cost_correction_week(week_start, correction_id);
-- A correction is a manifest input: it moves the input epoch like every other input.
CREATE TRIGGER IF NOT EXISTS trg_epoch_cost_correction_week_insert AFTER INSERT ON cost_correction_week BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_cost_correction_week_update AFTER UPDATE ON cost_correction_week BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_cost_correction_week_delete AFTER DELETE ON cost_correction_week BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
