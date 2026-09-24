-- 0001_source.sql — normalized source tables
-- No customer name, email, phone, address, company or buyer note is stored
-- anywhere in this schema. Money is REAL dollars, matching the engine.

CREATE TABLE IF NOT EXISTS shopify_order (
  order_name        TEXT PRIMARY KEY,          -- '#100001'
  order_number      TEXT NOT NULL,             -- '100001', ShipStation join key
  shopify_id        TEXT,
  created_at        TEXT,                      -- ISO instant
  created_at_local  TEXT NOT NULL,             -- store-local 'YYYY-MM-DD HH:MM:SS ±HHMM'
  business_date     TEXT NOT NULL,             -- store-local YYYY-MM-DD
  week_start        TEXT NOT NULL,             -- Monday of the business week
  cancelled_at      TEXT,
  subtotal          REAL,
  shipping          REAL,
  taxes             REAL,
  total             REAL,
  duties            REAL,
  discount_amount   REAL,
  refunded_amount   REAL,
  discount_codes    TEXT NOT NULL DEFAULT '[]',   -- JSON array
  source_name       TEXT,
  tags              TEXT NOT NULL DEFAULT '[]',   -- JSON array
  note_attributes   TEXT NOT NULL DEFAULT '[]',   -- JSON, allowlisted keys only
  store             TEXT NOT NULL,
  source_system     TEXT NOT NULL,             -- shopify_graphql | shopify_csv
  content_hash      TEXT NOT NULL,
  ingest_run_id     TEXT,
  ingested_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shopify_order_line (
  order_name        TEXT NOT NULL REFERENCES shopify_order(order_name) ON DELETE CASCADE,
  line_index        INTEGER NOT NULL,
  line_id           TEXT,
  sku               TEXT,
  product_name      TEXT,
  quantity          INTEGER,
  current_quantity  INTEGER,
  unit_price        REAL,
  vendor            TEXT,
  requires_shipping TEXT,                      -- 'true' | 'false' | NULL when unknown
  line_discount     REAL,
  discount_source   TEXT NOT NULL,             -- shopify_line_allocation | historical_csv_line_discount | none
  PRIMARY KEY (order_name, line_index)
);

CREATE TABLE IF NOT EXISTS shopify_discount_allocation (
  order_name        TEXT NOT NULL,
  line_index        INTEGER NOT NULL,
  alloc_index       INTEGER NOT NULL,
  amount            REAL NOT NULL,
  application_type  TEXT,
  application_index INTEGER,
  allocation_method TEXT,
  target_selection  TEXT,
  target_type       TEXT,
  code              TEXT,
  title             TEXT,
  PRIMARY KEY (order_name, line_index, alloc_index),
  FOREIGN KEY (order_name, line_index) REFERENCES shopify_order_line(order_name, line_index) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shopify_refund (
  refund_id         TEXT PRIMARY KEY,
  order_name        TEXT NOT NULL REFERENCES shopify_order(order_name) ON DELETE CASCADE,
  processed_at      TEXT,
  amount            REAL NOT NULL DEFAULT 0,
  refund_source     TEXT NOT NULL              -- shopify_refund_line | historical_prorated_refund
);

CREATE TABLE IF NOT EXISTS shopify_refund_line (
  refund_id         TEXT NOT NULL REFERENCES shopify_refund(refund_id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  line_index        INTEGER,
  line_id           TEXT,
  quantity          INTEGER,
  subtotal          REAL,
  tax               REAL,
  PRIMARY KEY (refund_id, seq)
);

CREATE TABLE IF NOT EXISTS shopify_refund_shipping_line (
  refund_id         TEXT NOT NULL REFERENCES shopify_refund(refund_id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  subtotal          REAL,
  tax               REAL,
  PRIMARY KEY (refund_id, seq)
);

CREATE TABLE IF NOT EXISTS shopify_order_adjustment (
  refund_id         TEXT NOT NULL REFERENCES shopify_refund(refund_id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  amount            REAL,
  tax               REAL,
  reason            TEXT,
  PRIMARY KEY (refund_id, seq)
);

CREATE TABLE IF NOT EXISTS shipment (
  shipment_no       TEXT PRIMARY KEY,
  order_number      TEXT NOT NULL,
  tracking_number   TEXT,
  ship_date         TEXT,
  modify_date       TEXT,
  voided            INTEGER NOT NULL DEFAULT 0,
  void_date         TEXT,
  carrier           TEXT,
  service           TEXT,
  provider          TEXT,
  carrier_fee       REAL,                      -- NULL when absent, never 0
  legacy_rate       REAL,
  insurance_cost    REAL,
  shipping_paid     REAL,                      -- customer-paid; never expense
  carrier_txn_id    TEXT,
  internal_txn_id   TEXT,
  external_id       TEXT,
  no_postage        INTEGER NOT NULL DEFAULT 0,
  created_by        TEXT,
  store_name        TEXT,
  package_count     INTEGER,
  weight            REAL,                      -- diagnostic only; never used to estimate cost
  fields_present    TEXT NOT NULL DEFAULT '{}',
  issues            TEXT NOT NULL DEFAULT '[]',
  source_format     TEXT NOT NULL,             -- custom | legacy
  content_hash      TEXT NOT NULL,
  ingest_run_id     TEXT,
  ingested_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shipment_item (
  shipment_no       TEXT NOT NULL REFERENCES shipment(shipment_no) ON DELETE CASCADE,
  item_index        INTEGER NOT NULL,
  sku               TEXT,
  quantity          INTEGER,
  PRIMARY KEY (shipment_no, item_index)
);

CREATE TABLE IF NOT EXISTS hpd_order (
  shopify_order_number TEXT PRIMARY KEY,
  hpd_order_number  TEXT NOT NULL,
  order_date        TEXT,
  carrier_service   TEXT,
  net_terms         REAL,
  prepaid           REAL,
  cost_difference   REAL,
  content_hash      TEXT NOT NULL,
  ingest_run_id     TEXT,
  ingested_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hpd_item (
  shopify_order_number TEXT NOT NULL REFERENCES hpd_order(shopify_order_number) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  sku               TEXT,
  qty               INTEGER,
  PRIMARY KEY (shopify_order_number, seq)
);

CREATE INDEX IF NOT EXISTS idx_order_week       ON shopify_order(week_start);
CREATE INDEX IF NOT EXISTS idx_order_number     ON shopify_order(order_number);
CREATE INDEX IF NOT EXISTS idx_line_sku         ON shopify_order_line(sku);
CREATE INDEX IF NOT EXISTS idx_refund_order     ON shopify_refund(order_name);
CREATE INDEX IF NOT EXISTS idx_shipment_order   ON shipment(order_number);
CREATE INDEX IF NOT EXISTS idx_shipment_date    ON shipment(ship_date);
