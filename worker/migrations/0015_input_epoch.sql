-- 0015 — Free-tier input epoch
-- ============================
-- One counter that every write to a table a week's manifest reads increments (triggers,
-- so no writer can be missed, including the existing ingest routes). Finalize reads it
-- with its manifest check and commits only if it is unchanged inside the same
-- transaction, so an upload that lands between the check and the commit cannot
-- finalize stale results. Cost: one extra row written per input row written.
-- Trigger bodies stay on one line (the local harness splits statements at a semicolon
-- followed by a newline).
CREATE TABLE IF NOT EXISTS input_epoch (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO input_epoch (id, n) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS input_epoch_guard (ok INTEGER NOT NULL);

CREATE TRIGGER IF NOT EXISTS trg_epoch_settings_insert AFTER INSERT ON settings BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_settings_update AFTER UPDATE ON settings BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_settings_delete AFTER DELETE ON settings BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_ord_ptr_insert AFTER INSERT ON ord_ptr BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_ord_ptr_update AFTER UPDATE ON ord_ptr BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_ord_ptr_delete AFTER DELETE ON ord_ptr BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_scr_day_owner_insert AFTER INSERT ON scr_day_owner BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_scr_day_owner_update AFTER UPDATE ON scr_day_owner BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_scr_day_owner_delete AFTER DELETE ON scr_day_owner BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_scr_version_insert AFTER INSERT ON scr_version BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_scr_version_update AFTER UPDATE OF status, outcome ON scr_version BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_scr_version_delete AFTER DELETE ON scr_version BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_cost_catalog_insert AFTER INSERT ON cost_catalog BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_cost_catalog_update AFTER UPDATE ON cost_catalog BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_cost_catalog_delete AFTER DELETE ON cost_catalog BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_catalog_refresh_insert AFTER INSERT ON catalog_refresh BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_catalog_refresh_update AFTER UPDATE ON catalog_refresh BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_catalog_refresh_delete AFTER DELETE ON catalog_refresh BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_snapshot_insert AFTER INSERT ON snapshot BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_snapshot_update AFTER UPDATE OF status ON snapshot BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_snapshot_delete AFTER DELETE ON snapshot BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_insert AFTER INSERT ON shipment BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_update AFTER UPDATE ON shipment BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_delete AFTER DELETE ON shipment BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_item_insert AFTER INSERT ON shipment_item BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_item_update AFTER UPDATE ON shipment_item BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_shipment_item_delete AFTER DELETE ON shipment_item BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_order_insert AFTER INSERT ON hpd_order BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_order_update AFTER UPDATE ON hpd_order BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_order_delete AFTER DELETE ON hpd_order BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_item_insert AFTER INSERT ON hpd_item BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_item_update AFTER UPDATE ON hpd_item BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_hpd_item_delete AFTER DELETE ON hpd_item BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_ingest_run_insert AFTER INSERT ON ingest_run WHEN NEW.source = 'hpd' BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER IF NOT EXISTS trg_epoch_ingest_run_update AFTER UPDATE OF status ON ingest_run WHEN NEW.source = 'hpd' BEGIN UPDATE input_epoch SET n = n + 1 WHERE id = 1; END;
