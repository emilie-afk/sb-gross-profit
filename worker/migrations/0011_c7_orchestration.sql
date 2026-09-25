-- 0011 — C7: weekly orchestration. A scheduled cycle whose sources are not all
-- in waits (reporting_run.state = 'waiting_for_sources', no snapshot), retries
-- on the approved timeline and, after the cutoff, stays 'source_timeout' until a
-- later valid upload lets it resume. Status fields only: codes and timestamps.
ALTER TABLE schedule_cycle ADD COLUMN status TEXT;             -- waiting_for_sources | source_timeout | computing | computed
ALTER TABLE schedule_cycle ADD COLUMN missing TEXT;            -- JSON list of 'source:state' codes at the last attempt
ALTER TABLE schedule_cycle ADD COLUMN last_attempt_at TEXT;
ALTER TABLE schedule_cycle ADD COLUMN next_retry_at TEXT;      -- NULL after the cutoff
ALTER TABLE schedule_cycle ADD COLUMN timed_out_at TEXT;
ALTER TABLE schedule_cycle ADD COLUMN sources_changed_at TEXT; -- set by a successful upload for this cycle's week
ALTER TABLE schedule_cycle ADD COLUMN changes_seen_at TEXT;    -- the sources_changed_at value the last attempt already saw
CREATE INDEX IF NOT EXISTS schedule_cycle_status ON schedule_cycle (status);
