-- 0023_aps_map.sql — Air Plant Shop shipment mapping (scenario input only)
-- From the saved ShipStation "SB GP weekly" line-item export (mapping only; never an expense source).
-- Stored apart from every computed result: no snapshot, catalog or revision reads or writes these tables.

-- One row per distinct mapping content. A version is `pending` until every order row is stored, and only a
-- `complete` version is ever applied to the current mapping. All versions are kept.
CREATE TABLE IF NOT EXISTS aps_map_version (
  version_id        TEXT PRIMARY KEY,
  status            TEXT NOT NULL,             -- pending | complete
  window_from       TEXT NOT NULL,             -- ship dates the export covers (calendar dates)
  window_to         TEXT NOT NULL,
  exported_at       TEXT,                      -- first export with this content
  last_exported_at  TEXT,                      -- newest export with this content (re-received → re-applied)
  times_received    INTEGER NOT NULL DEFAULT 1,
  received_at       TEXT NOT NULL,
  order_count       INTEGER NOT NULL,
  sanitized_sha256  TEXT NOT NULL,             -- the export file as validated on the collector
  content_sha256    TEXT NOT NULL UNIQUE,      -- the mapping content
  schema_version    TEXT NOT NULL,
  template          TEXT NOT NULL,
  scr_sha256        TEXT,                      -- the collector's Shipping Cost Report file (split dates of one class are read from it)
  scr_from          TEXT,
  scr_to            TEXT,
  meta              TEXT NOT NULL DEFAULT '{}' -- counts only: rows, duplicate rows, shipments, voided, statuses
);

-- Per version, per order holding an Air Plant Shop item: the classification and (split orders) the matched cost.
CREATE TABLE IF NOT EXISTS aps_map_order (
  version_id        TEXT NOT NULL REFERENCES aps_map_version(version_id),
  order_key         TEXT NOT NULL,
  status            TEXT NOT NULL,
  aps_cost_cents    INTEGER,                   -- split_matched: the APS labels' report cost
  scr_order_cents   INTEGER,                   -- split_matched: all the order's matched labels
  scr_pins          TEXT,                      -- split_matched: JSON [[date, labels, cents, apsLabels, apsCents, rowVersion|null]], one per ship
                                               -- date; the reader route checks them against the rows the published snapshot pinned
  first_ship_date   TEXT,
  last_ship_date    TEXT,
  detail            TEXT NOT NULL,             -- JSON counts: shipments by class, APS units, report check
  PRIMARY KEY (version_id, order_key)
);

-- The current mapping per order: from the newest complete export that holds it. The reader route reads only this.
CREATE TABLE IF NOT EXISTS aps_map_active (
  order_key         TEXT PRIMARY KEY,
  version_id        TEXT NOT NULL,
  exported_at       TEXT,
  status            TEXT NOT NULL,
  aps_cost_cents    INTEGER,
  scr_order_cents   INTEGER,
  scr_pins          TEXT,
  first_ship_date   TEXT,
  last_ship_date    TEXT,
  detail            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS aps_map_active_ship ON aps_map_active (first_ship_date);
