-- 0002_snapshot.sql — cost catalogs, reporting runs and immutable snapshots

-- ── Cost catalog versions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cost_catalog (
  catalog_rev       TEXT PRIMARY KEY,          -- content-addressed: cat_<sha256 prefix>
  captured_at       TEXT NOT NULL,
  source            TEXT NOT NULL,             -- build_push | manual
  status            TEXT NOT NULL,             -- accepted | rejected
  reject_reasons    TEXT NOT NULL DEFAULT '[]',
  table_counts      TEXT NOT NULL,             -- JSON
  vendor_counts     TEXT NOT NULL,             -- JSON
  vendor_total      INTEGER NOT NULL,
  meta              TEXT NOT NULL DEFAULT '{}' -- build commit, build time; never secrets
);

-- Table payloads, split into parts so no row approaches D1's row-size limit.
CREATE TABLE IF NOT EXISTS cost_catalog_part (
  catalog_rev       TEXT NOT NULL REFERENCES cost_catalog(catalog_rev) ON DELETE CASCADE,
  table_name        TEXT NOT NULL,
  part              INTEGER NOT NULL,
  payload           TEXT NOT NULL,
  PRIMARY KEY (catalog_rev, table_name, part)
);

-- ── Reporting runs (state machine in worker/src/runs.js) ──────────────────────
CREATE TABLE IF NOT EXISTS reporting_run (
  run_id            TEXT PRIMARY KEY,
  week_start        TEXT NOT NULL,
  state             TEXT NOT NULL,
  trigger           TEXT NOT NULL,             -- schedule | backfill | manual | recompute
  catalog_rev       TEXT,
  snapshot_id       TEXT,
  gate              TEXT,                      -- JSON: last gate evaluation
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_transition (
  run_id            TEXT NOT NULL REFERENCES reporting_run(run_id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  from_state        TEXT,
  to_state          TEXT NOT NULL,
  at                TEXT NOT NULL,
  actor_class       TEXT NOT NULL,             -- server-assigned from the auth path: admin_secret | ingest_secret | worker | migration
  actor_label       TEXT,                      -- optional caller-supplied tag; NOT verified identity
  note              TEXT,
  PRIMARY KEY (run_id, seq)
);

-- ── Snapshots: immutable once written; corrections create a new revision ─────
CREATE TABLE IF NOT EXISTS snapshot (
  snapshot_id       TEXT PRIMARY KEY,
  week_start        TEXT NOT NULL,
  revision          INTEGER NOT NULL,
  status            TEXT NOT NULL,             -- draft | published | superseded | blocked
  run_id            TEXT,
  computed_at       TEXT NOT NULL,
  engine_version    TEXT NOT NULL,
  catalog_rev       TEXT,
  policy            TEXT NOT NULL,             -- JSON expense policy, including locked flag
  profitability_status TEXT NOT NULL,
  reason            TEXT,
  published_at      TEXT,
  superseded_by     TEXT,
  UNIQUE (week_start, revision)
);

CREATE TABLE IF NOT EXISTS snapshot_totals (
  snapshot_id                         TEXT PRIMARY KEY REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
  operating_revenue                   REAL NOT NULL,
  shopify_net_revenue_incl_pass_through REAL NOT NULL,
  operating_gp_after_shipping         REAL NOT NULL,
  operating_gp_margin                 REAL,
  route_collected                     REAL NOT NULL,
  route_remitted                      REAL NOT NULL,
  route_net                           REAL NOT NULL,
  known_product_cogs                  REAL NOT NULL,
  known_cost_product_revenue          REAL NOT NULL,
  known_cost_product_gp               REAL NOT NULL,
  known_cost_product_margin           REAL,
  missing_cost_revenue                REAL NOT NULL,
  missing_cost_units                  INTEGER NOT NULL,
  missing_cost_lines                  INTEGER NOT NULL,
  cost_coverage_by_revenue            REAL,
  cost_coverage_by_units              REAL,
  shipping_collected                  REAL NOT NULL,
  shipping_expense                    REAL NOT NULL,
  shipstation_expense                 REAL NOT NULL,
  hpd_shipping_expense                REAL NOT NULL,
  orders_requiring_shipstation_rate   INTEGER NOT NULL,
  orders_with_valid_shipstation_rate  INTEGER NOT NULL,
  shipstation_expense_coverage        REAL,
  hpd_orders_actual                   INTEGER NOT NULL,
  hpd_orders_pass_through             INTEGER NOT NULL,
  insurance_disclosed                 REAL NOT NULL,
  profitability_status                TEXT NOT NULL,
  labels                              TEXT NOT NULL,   -- JSON
  revenue_bridge                      TEXT NOT NULL    -- JSON
);

CREATE TABLE IF NOT EXISTS snapshot_breakdown (
  snapshot_id       TEXT NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
  dimension         TEXT NOT NULL,             -- channel | vendor | store | sku
  key               TEXT NOT NULL,
  units             INTEGER NOT NULL,
  known_cost_revenue REAL NOT NULL,
  known_cogs        REAL NOT NULL,
  known_cost_gp     REAL NOT NULL,
  known_cost_margin REAL,
  missing_cost_revenue REAL NOT NULL,
  missing_cost_units INTEGER NOT NULL,
  missing_cost_lines INTEGER NOT NULL,
  coverage_status   TEXT NOT NULL,             -- complete | incomplete
  detail            TEXT,                      -- JSON (sku, vendor, product for the sku dimension)
  PRIMARY KEY (snapshot_id, dimension, key)
);

CREATE TABLE IF NOT EXISTS snapshot_order (
  snapshot_id       TEXT NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
  order_name        TEXT NOT NULL,
  business_date     TEXT,
  channel           TEXT,
  order_cat         TEXT,
  operating_revenue REAL,
  shopify_net_revenue REAL,
  route_collected   REAL,
  known_product_cogs REAL,
  ship_collected    REAL,
  ship_paid         REAL,
  ship_paid_ss      REAL,
  ship_paid_hp      REAL,
  operating_gp      REAL,
  missing_cost_lines INTEGER,
  requires_ss_rate  INTEGER,
  has_valid_ss_rate INTEGER,
  shipping_expense_source TEXT,
  shipping_expense_status TEXT,
  missing_reason    TEXT,
  profitability_status TEXT,
  line_count        INTEGER,
  PRIMARY KEY (snapshot_id, order_name)
);

CREATE TABLE IF NOT EXISTS snapshot_line (
  snapshot_id       TEXT NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
  order_name        TEXT NOT NULL,
  line_index        INTEGER NOT NULL,
  sku               TEXT,
  product           TEXT,
  vendor_key        TEXT,
  channel           TEXT,
  store             TEXT,
  qty               INTEGER,
  unit_price        REAL,
  unit_cost         REAL,
  contract_revenue  REAL,
  line_cogs         REAL,
  known_cost_gp     REAL,
  cost_source       TEXT,
  cost_match_type   TEXT,
  missing_cost      INTEGER NOT NULL,
  discount_allocated REAL,
  discount_source   TEXT,
  refund_allocated  REAL,
  refund_source     TEXT,
  route_collected   REAL,
  route_remitted    REAL,
  flags             TEXT NOT NULL,             -- JSON
  PRIMARY KEY (snapshot_id, order_name, line_index)
);

CREATE TABLE IF NOT EXISTS snapshot_issue (
  snapshot_id       TEXT NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  kind              TEXT NOT NULL,             -- missing_shipping | missing_cost | unallocated_residual | unmatched_shipment | excluded_by_engine
  order_name        TEXT,
  detail            TEXT NOT NULL,             -- JSON
  PRIMARY KEY (snapshot_id, seq)
);

CREATE TABLE IF NOT EXISTS snapshot_reconciliation (
  snapshot_id       TEXT NOT NULL REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
  check_name        TEXT NOT NULL,
  expected          REAL,
  actual            REAL,
  delta             REAL,
  passed            INTEGER NOT NULL,
  blocking          INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, check_name)
);

CREATE TABLE IF NOT EXISTS snapshot_narrative (
  snapshot_id       TEXT PRIMARY KEY REFERENCES snapshot(snapshot_id) ON DELETE CASCADE,
  narrative         TEXT NOT NULL               -- JSON, rule-based
);

CREATE INDEX IF NOT EXISTS idx_snapshot_week      ON snapshot(week_start, status);
CREATE INDEX IF NOT EXISTS idx_snapshot_order_gp  ON snapshot_order(snapshot_id, operating_gp);
CREATE INDEX IF NOT EXISTS idx_snapshot_line_ord  ON snapshot_line(snapshot_id, order_name);
CREATE INDEX IF NOT EXISTS idx_run_week           ON reporting_run(week_start, state);
