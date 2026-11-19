-- 0019 — Bounded manifest and order lists at peak size (Workers Free, ~750 orders per week)
-- ===================================================================================
-- 1. aux_n: a second counter on the input_epoch row, raised by the same triggers whenever a table
--    the week's ShipStation/HPD records ("aux") are read from changes. Same row, same UPDATE: no
--    extra rows written.
-- 2. aux_pin: the week's aux hashes, computed by POST /v1/collect/weeks/:week/aux-pin in its own
--    request and valid while aux_n is unchanged, so the manifest no longer loads and hashes the
--    week's shipments (the largest part of its CPU at peak size). Not an input: no epoch trigger.
-- 3. snapshot_blob.body_text: the validated JSON text of each orders:k part (the gzip body stays
--    the verified, byte-compared form). Sorted and filtered order lists run in D1 over it and the
--    Worker parses only the page's rows.
ALTER TABLE input_epoch ADD COLUMN aux_n INTEGER NOT NULL DEFAULT 0;
DROP TRIGGER IF EXISTS trg_epoch_ord_ptr_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_ord_ptr_insert AFTER INSERT ON ord_ptr BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_ord_ptr_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_ord_ptr_update AFTER UPDATE ON ord_ptr BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_ord_ptr_delete;
CREATE TRIGGER IF NOT EXISTS trg_epoch_ord_ptr_delete AFTER DELETE ON ord_ptr BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_shipment_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_insert AFTER INSERT ON shipment BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_shipment_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_update AFTER UPDATE ON shipment BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_shipment_delete;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_delete AFTER DELETE ON shipment BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_shipment_item_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_item_insert AFTER INSERT ON shipment_item BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_shipment_item_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_item_update AFTER UPDATE ON shipment_item BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_shipment_item_delete;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_item_delete AFTER DELETE ON shipment_item BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_hpd_order_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_order_insert AFTER INSERT ON hpd_order BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_hpd_order_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_order_update AFTER UPDATE ON hpd_order BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_hpd_order_delete;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_order_delete AFTER DELETE ON hpd_order BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_hpd_item_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_item_insert AFTER INSERT ON hpd_item BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_hpd_item_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_item_update AFTER UPDATE ON hpd_item BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_hpd_item_delete;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_item_delete AFTER DELETE ON hpd_item BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_ingest_run_insert;
CREATE TRIGGER IF NOT EXISTS trg_epoch_ingest_run_insert AFTER INSERT ON ingest_run WHEN NEW.source = 'hpd' BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
DROP TRIGGER IF EXISTS trg_epoch_ingest_run_update;
CREATE TRIGGER IF NOT EXISTS trg_epoch_ingest_run_update AFTER UPDATE OF status ON ingest_run WHEN NEW.source = 'hpd' BEGIN UPDATE input_epoch SET n = n + 1, aux_n = aux_n + 1 WHERE id = 1; END;
CREATE TABLE IF NOT EXISTS aux_pin (
  week_start      TEXT PRIMARY KEY,
  aux_n           INTEGER NOT NULL,             -- input_epoch.aux_n the hashes were computed at
  shipments_hash  TEXT NOT NULL,
  hpd_hash        TEXT NOT NULL,
  shipments       INTEGER NOT NULL,
  hpd_orders      INTEGER NOT NULL,
  pinned_at       TEXT NOT NULL
) WITHOUT ROWID;
ALTER TABLE snapshot_blob ADD COLUMN body_text TEXT;
