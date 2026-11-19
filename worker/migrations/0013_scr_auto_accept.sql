-- 0013 — Free-tier Shipping Cost Report auto-acceptance switch
-- ============================================================
-- shipping_cost_auto_accept_enabled (default false): while false, a report version that
-- would activate or hold any date goes to review whole; nothing activates by itself.
-- Turning it on is an owner decision (audited setting with a stated reason).
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('shipping_cost_auto_accept_enabled', 'false', '2026-09-30T00:00:00.000Z');
