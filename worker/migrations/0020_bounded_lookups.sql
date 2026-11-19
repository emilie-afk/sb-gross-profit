-- 0020: bounded lookups (2026-10-06). Production query insights showed most D1 rows read came from
-- two manifest queries that searched every stored Shipping Cost Report day's JSON groups for a
-- week's order keys (≈15k rows per call), and from order-number lookups that scanned ord_ptr.
--
-- scr_day_key: one row per order key of every stored day (scr_day rows are immutable once stored,
-- including days that keep omitted accepted costs), so "which owned dates hold these orders" reads
-- only the matching keys and joins scr_day_owner for the current owner. Ownership changes
-- (activation, rollback) need no maintenance here.
CREATE TABLE IF NOT EXISTS scr_day_key (
  order_key      TEXT NOT NULL,
  version_id     TEXT NOT NULL,
  ship_date      TEXT NOT NULL,
  PRIMARY KEY (order_key, version_id, ship_date)
) WITHOUT ROWID;

INSERT OR IGNORE INTO scr_day_key (order_key, version_id, ship_date)
  SELECT json_extract(g.value, '$[0]'), d.version_id, d.ship_date FROM scr_day d, json_each(d.groups) g;

CREATE INDEX IF NOT EXISTS idx_ord_ptr_number ON ord_ptr(order_number);
