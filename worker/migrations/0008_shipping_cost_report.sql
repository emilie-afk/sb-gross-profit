-- 0008_shipping_cost_report.sql — ShipStation Shipping Cost Report source (Revision 9, C2).
-- Stores sanitized report imports as immutable versions. Nothing here feeds the
-- financial calculation yet (that is C3). Publication stays disabled: this
-- migration only ADDS shipping_cost_report_source_verified = false.

-- ── One row per sanitized import; never modified after its decision ──────────
CREATE TABLE IF NOT EXISTS shipping_cost_source_version (
  version_id          TEXT PRIMARY KEY,
  requested_from      TEXT NOT NULL,             -- ship-date range the collector asked for (calendar dates)
  requested_to        TEXT NOT NULL,
  exported_at         TEXT,
  imported_at         TEXT NOT NULL,
  sanitized_sha256    TEXT NOT NULL UNIQUE,      -- identical content → source_no_change, no new version
  row_count           INTEGER NOT NULL,
  cost_total_cents    INTEGER NOT NULL,          -- Σ Shipping Cost
  first_ship_date     TEXT NOT NULL,
  last_ship_date      TEXT NOT NULL,
  schema_version      TEXT NOT NULL,
  report_currency     TEXT NOT NULL,             -- from audited configuration (the CSV has no currency)
  report_timezone     TEXT NOT NULL,             -- from audited configuration (the CSV has no time zone)
  status              TEXT NOT NULL,             -- pending_review | accepted | rejected
  review_flags        TEXT NOT NULL DEFAULT '{}',-- JSON { code: count }
  comparison          TEXT NOT NULL DEFAULT '{}',-- JSON diff against the active data for the overlap
  imported_by_class   TEXT NOT NULL,
  imported_by_label   TEXT,
  decided_at          TEXT,
  decided_by_class    TEXT,
  decided_by_label    TEXT,
  decision_reason     TEXT
);

-- Sanitized rows exactly as received (15 approved columns). Identical rows stay
-- separate: two identical packages are two costs. row_hash is audit evidence
-- only, never a shipment identity (the report has none).
CREATE TABLE IF NOT EXISTS shipping_cost_row (
  version_id          TEXT NOT NULL REFERENCES shipping_cost_source_version(version_id),
  row_seq             INTEGER NOT NULL,
  ship_date_raw       TEXT NOT NULL,
  ship_date           TEXT NOT NULL,
  order_key           TEXT NOT NULL,
  provider            TEXT, service TEXT, package TEXT, items TEXT, zone TEXT,
  shipping_cost_cents INTEGER NOT NULL,
  insurance_cents     INTEGER NOT NULL DEFAULT 0,
  duties_cents        INTEGER NOT NULL DEFAULT 0,
  taxes_cents         INTEGER NOT NULL DEFAULT 0,
  import_fee_cents    INTEGER NOT NULL DEFAULT 0,
  weight TEXT, weight_unit TEXT, store TEXT,
  row_hash            TEXT NOT NULL,
  PRIMARY KEY (version_id, row_seq)
);
CREATE INDEX IF NOT EXISTS shipping_cost_row_date ON shipping_cost_row (version_id, ship_date);
CREATE INDEX IF NOT EXISTS shipping_cost_row_order ON shipping_cost_row (order_key);

-- Per-version, per-order aggregate: the principal comparison measure.
CREATE TABLE IF NOT EXISTS shipping_cost_order_agg (
  version_id          TEXT NOT NULL,
  order_key           TEXT NOT NULL,
  cost_cents          INTEGER NOT NULL,
  row_count           INTEGER NOT NULL,
  first_ship_date     TEXT NOT NULL,
  last_ship_date      TEXT NOT NULL,
  PRIMARY KEY (version_id, order_key)
);

-- Active data: NON-OVERLAPPING ship-date segments, each owned by one accepted
-- version. Effective totals read each ship date from exactly one version.
CREATE TABLE IF NOT EXISTS shipping_cost_active_segment (
  seg_from            TEXT PRIMARY KEY,
  seg_to              TEXT NOT NULL,
  version_id          TEXT NOT NULL,
  activation_id       TEXT NOT NULL
);

-- Every activation records the complete segment set it replaced, so rollback
-- reconstructs the previous active segments exactly.
CREATE TABLE IF NOT EXISTS shipping_cost_activation (
  activation_id       TEXT PRIMARY KEY,
  version_id          TEXT NOT NULL,
  range_from          TEXT NOT NULL,
  range_to            TEXT NOT NULL,
  prior_segments      TEXT NOT NULL,             -- JSON [{ segFrom, segTo, versionId, activationId }]
  activated_at        TEXT NOT NULL,
  actor_class         TEXT NOT NULL,
  actor_label         TEXT,
  reason              TEXT,
  rolled_back_at      TEXT,
  rolled_back_by_class TEXT,
  rolled_back_by_label TEXT,
  rollback_reason     TEXT
);

-- ── Audited operator configuration (the report has no currency or time zone) ──
-- Confirmed by the operator in the Revision 9 design review (2026-09-24).
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('shipping_report_currency',             '"USD"',                      '2026-09-24T00:00:00Z'),
  ('shipping_report_timezone',             '"America/Los_Angeles"',      '2026-09-24T00:00:00Z'),
  ('shipping_report_store',                '"Succulents Box (Shopify)"', '2026-09-24T00:00:00Z'),
  ('shipping_cost_report_source_verified', 'false',                      '2026-09-24T00:00:00Z');
INSERT INTO settings_audit (key, old_value, new_value, reason, actor_class, actor_label, at) VALUES
  ('shipping_report_currency', NULL, '"USD"', 'Operator-confirmed (Revision 9 design review): the Shipping Cost Report has no currency field; report currency is USD', 'migration', '0008_shipping_cost_report', '2026-09-24T00:00:00Z'),
  ('shipping_report_timezone', NULL, '"America/Los_Angeles"', 'Operator-confirmed (Revision 9 design review): Ship Date is a calendar date in America/Los_Angeles', 'migration', '0008_shipping_cost_report', '2026-09-24T00:00:00Z'),
  ('shipping_report_store', NULL, '"Succulents Box (Shopify)"', 'The only Store value in the verified Jul–Sep reports', 'migration', '0008_shipping_cost_report', '2026-09-24T00:00:00Z'),
  ('shipping_cost_report_source_verified', NULL, 'false', 'Voided, refunded, recreated and return labels and later carrier adjustments are not yet verified', 'migration', '0008_shipping_cost_report', '2026-09-24T00:00:00Z');
