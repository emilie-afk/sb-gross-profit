-- At most one published snapshot per week, enforced by the database rather
-- than by the order of statements in the publish transaction.
CREATE UNIQUE INDEX IF NOT EXISTS uq_snapshot_published_week ON snapshot(week_start) WHERE status = 'published';
