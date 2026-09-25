-- 0009 — Revision 9 C3: Shipping Cost Report as the (provisional) shipping expense source.
-- Audited operator configuration. No financial amount is stored here.
--
--   vendor_first_paid_shipping_dates   vendor → first order date on which the vendor's
--                                      products no longer ship free (orders BEFORE the date
--                                      keep the old vendor free-shipping treatment)
--   mcg_free_shipping_threshold        $89 free-shipping promotion, MCG products only
--   shipping_coverage_aging_days       order-level coverage completes when every expected
--                                      order has a cost, or this many days after the week ends
--   provisional_publication_enabled    publishing with an unverified shipping source; locked
--                                      false until the publication commit (not C3)
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('vendor_first_paid_shipping_dates', '{"Air Plant Shop":"2026-08-14","Live to Give":"2026-09-15","Surfside Arrangement":"2026-09-15"}', '2026-09-25T00:00:00Z'),
  ('mcg_free_shipping_threshold',      '89',    '2026-09-25T00:00:00Z'),
  ('shipping_coverage_aging_days',     '14',    '2026-09-25T00:00:00Z'),
  ('provisional_publication_enabled',  'false', '2026-09-25T00:00:00Z');
INSERT INTO settings_audit (key, old_value, new_value, reason, actor_class, actor_label, at) VALUES
  ('vendor_first_paid_shipping_dates', NULL, '{"Air Plant Shop":"2026-08-14","Live to Give":"2026-09-15","Surfside Arrangement":"2026-09-15"}', 'Operator-confirmed: Air Plant Shop free shipping ended 2026-08-14; Live to Give and Surfside ended 2026-09-15', 'migration', '0009_c3_shipping_policy', '2026-09-25T00:00:00Z'),
  ('mcg_free_shipping_threshold', NULL, '89', 'Operator-confirmed: $89 free shipping applies to MCG products only, no other vendor', 'migration', '0009_c3_shipping_policy', '2026-09-25T00:00:00Z'),
  ('shipping_coverage_aging_days', NULL, '14', 'Revision 9 decision 1(a): 14-day aging completion rule for order-level coverage', 'migration', '0009_c3_shipping_policy', '2026-09-25T00:00:00Z'),
  ('provisional_publication_enabled', NULL, 'false', 'Publication controls stay off in C3', 'migration', '0009_c3_shipping_policy', '2026-09-25T00:00:00Z');

-- Fulfilment evidence for C3 classification (cancelled before / after
-- fulfilment, partial fulfilment, Heat Pack delays). Status words and a
-- timestamp only; no customer data.
ALTER TABLE shopify_order ADD COLUMN fulfillment_status TEXT;
ALTER TABLE shopify_order ADD COLUMN fulfilled_at TEXT;
ALTER TABLE shopify_order_line ADD COLUMN fulfillment_status TEXT;
