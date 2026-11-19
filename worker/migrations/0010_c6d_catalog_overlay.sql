-- 0010 — C6d: live Products Master tabs overlaid on a pinned base catalog.
-- Audited configuration only; no cost values here. NULL keeps the C6 full
-- build (every configured source fetched). A registered base catalog
-- (cost_catalog.status = 'base', POST /v1/admin/catalog/base) is set through
-- POST /v1/admin/settings with a reason.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('catalog_overlay_base_rev', 'null', '2026-09-25T00:00:00Z');
INSERT INTO settings_audit (key, old_value, new_value, reason, actor_class, actor_label, at) VALUES
  ('catalog_overlay_base_rev', NULL, 'null', 'C6d: vendor overlay off until a base catalog is registered and chosen', 'migration', '0010_c6d_catalog_overlay', '2026-09-25T00:00:00Z');
