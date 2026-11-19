-- 0021 — Free-plan D1 budget
-- =========================
-- d1_usage: D1 rows read / written by this Worker per UTC day and scope (worker/src/usage.js), for the
-- background-work budget. One upsert per request that used D1.
CREATE TABLE IF NOT EXISTS d1_usage (
  day           TEXT NOT NULL,               -- UTC date, YYYY-MM-DD (D1's daily limits reset at 00:00 UTC)
  scope         TEXT NOT NULL,               -- 'background' (collect, ingest, verify, admin) | 'dashboard'
  rows_read     INTEGER NOT NULL DEFAULT 0,
  rows_written  INTEGER NOT NULL DEFAULT 0,
  requests      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope)
) WITHOUT ROWID;

-- A second input counter, m: like input_epoch.n it moves on every write to a manifest input EXCEPT the
-- snapshot table (results, not inputs). The snapshots a manifest reads — the week's newest and published
-- revisions and the prior week's published one — are compared by id instead, so a run's own results and
-- publications do not invalidate every other week's unchanged-week check.
ALTER TABLE input_epoch ADD COLUMN m INTEGER NOT NULL DEFAULT 0;

-- manifest_check: the last full check that found a week's newest revision computed from exactly its inputs:
-- the m counter and the snapshot ids it was made with. While they are the same, the engine and variables
-- are the same and the check is recent, GET /v1/collect/weeks/:w/manifest answers "existing" without
-- assembling the manifest. Written when a manifest finds the week unchanged and when a result is finalized.
CREATE TABLE IF NOT EXISTS manifest_check (
  week_start        TEXT PRIMARY KEY,
  m_epoch           INTEGER NOT NULL,
  env_sig           TEXT NOT NULL,           -- engine version and the Worker variables the manifest reads
  snapshot_id       TEXT NOT NULL,           -- the week's newest revision
  published_id      TEXT,                    -- the week's published revision
  prev_published_id TEXT,                    -- the prior week's published revision (the comparison)
  checked_at        TEXT NOT NULL
) WITHOUT ROWID;

-- The week's audited acceptance of its pinned catalog is a manifest input (catalogAcceptance) but had no
-- epoch trigger: an acceptance must move the counters like every other input.
CREATE TRIGGER IF NOT EXISTS trg_epoch_catalog_reuse_insert AFTER INSERT ON catalog_reuse_acceptance BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_catalog_reuse_update AFTER UPDATE ON catalog_reuse_acceptance BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_catalog_reuse_delete AFTER DELETE ON catalog_reuse_acceptance BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;

-- Every other input trigger moves m too, in the same single UPDATE (no extra row written). The snapshot
-- triggers keep moving n only.
DROP TRIGGER IF EXISTS trg_epoch_catalog_refresh_delete;
CREATE TRIGGER IF NOT EXISTS trg_epoch_catalog_refresh_delete AFTER DELETE ON catalog_refresh BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_catalog_refresh_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_catalog_refresh_insert AFTER INSERT ON catalog_refresh BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_catalog_refresh_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_catalog_refresh_update AFTER UPDATE ON catalog_refresh BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_cost_catalog_delete;
CREATE TRIGGER IF NOT EXISTS trg_epoch_cost_catalog_delete AFTER DELETE ON cost_catalog BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_cost_catalog_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_cost_catalog_insert AFTER INSERT ON cost_catalog BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_cost_catalog_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_cost_catalog_update AFTER UPDATE ON cost_catalog BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_hpd_item_delete;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_item_delete AFTER DELETE ON hpd_item BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_hpd_item_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_item_insert AFTER INSERT ON hpd_item BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_hpd_item_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_item_update AFTER UPDATE ON hpd_item BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_hpd_order_delete;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_order_delete AFTER DELETE ON hpd_order BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_hpd_order_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_order_insert AFTER INSERT ON hpd_order BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_hpd_order_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_order_update AFTER UPDATE ON hpd_order BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_ingest_run_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_ingest_run_insert AFTER INSERT ON ingest_run WHEN NEW.source = 'hpd' BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_ingest_run_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_ingest_run_update AFTER UPDATE OF status ON ingest_run WHEN NEW.source = 'hpd' BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_ord_ptr_delete;
CREATE TRIGGER IF NOT EXISTS trg_epoch_ord_ptr_delete AFTER DELETE ON ord_ptr BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_ord_ptr_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_ord_ptr_insert AFTER INSERT ON ord_ptr BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_ord_ptr_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_ord_ptr_update AFTER UPDATE ON ord_ptr BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_scr_day_owner_delete;
CREATE TRIGGER IF NOT EXISTS trg_epoch_scr_day_owner_delete AFTER DELETE ON scr_day_owner BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_scr_day_owner_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_scr_day_owner_insert AFTER INSERT ON scr_day_owner BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_scr_day_owner_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_scr_day_owner_update AFTER UPDATE ON scr_day_owner BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_scr_version_delete;
CREATE TRIGGER IF NOT EXISTS trg_epoch_scr_version_delete AFTER DELETE ON scr_version BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_scr_version_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_scr_version_insert AFTER INSERT ON scr_version BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_scr_version_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_scr_version_update AFTER UPDATE OF status, outcome ON scr_version BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_settings_delete;
CREATE TRIGGER IF NOT EXISTS trg_epoch_settings_delete AFTER DELETE ON settings BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_settings_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_settings_insert AFTER INSERT ON settings BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_settings_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_settings_update AFTER UPDATE ON settings BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_shipment_delete;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_delete AFTER DELETE ON shipment BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_shipment_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_insert AFTER INSERT ON shipment BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_shipment_item_delete;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_item_delete AFTER DELETE ON shipment_item BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_shipment_item_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_item_insert AFTER INSERT ON shipment_item BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_shipment_item_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_item_update AFTER UPDATE ON shipment_item BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_shipment_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_update AFTER UPDATE ON shipment BEGIN UPDATE input_epoch SET n = n + 1, m = m + 1, aux_n = aux_n + 1 WHERE id = 1; END;
